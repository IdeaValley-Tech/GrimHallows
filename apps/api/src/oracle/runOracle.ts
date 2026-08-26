/**
 * The run oracle — the only module that touches a seed.
 *
 * INTERNAL. No route imports this directly; routes go through
 * `services/combatService.ts`, which exposes a run's *derived* state and never
 * the seed behind it. 04-backend-api-spec.md#5 requires this separation because
 * this module holds the signing key that, for paid runs, can move sponsor-pool
 * funds.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE
 *
 * A seed is committed before the first action and revealed only after the last
 * one. Between those two points the server knows it and the player does not —
 * that asymmetry is the entire value of commit-reveal, and it is why
 * `readSeedSecret` is a deliberate call rather than a field that rides along on
 * every run object.
 *
 * HOW AN ACTION IS VALIDATED
 *
 * By replaying it. The engine is pure, so the check for "is this legal?" is
 * literally "does `runEncounter` accept it?" — one enforcement point rather than
 * a second rule-set here that could disagree with the one the dice use. A client
 * that has been edited to submit a power it doesn't own, or to attack a corpse,
 * is refused by the same code that would have rolled the dice for it.
 *
 * FREE AND PAID RUNS DIVERGE IN EXACTLY ONE PLACE
 *
 * The fight is identical: same engine, same seed derivation, same replay. Only
 * the two endpoints differ, and only in where the record lives. A free run's
 * commitment and resolution are oracle signatures; a paid run's are transactions
 * (`commit-seed` / `reveal-and-resolve`), which is also where its reward is
 * decided and paid. So `commit()` refuses paid runs outright — they are committed
 * by `services/paidEntryService.ts` against the id the chain assigned — and
 * `resolve()` routes them to `PaidRunOracle` instead of signing.
 */

import {
  DICE_ALGO_VERSION,
  ENCOUNTER_ALGO_VERSION,
  EncounterError,
  STATS_ALGO_VERSION,
  resolveFreeRunReward,
  buildDungeonPlan,
  runEncounterVersioned,
  type CombatTurn,
  type EncounterSetup,
  type EncounterView,
  type PlayerAction,
} from '@grimhallow/shared';
import type { RunRecord, RunStore } from '../repos/runs.js';
import type { PaidRunOracle } from './paidRunOracle.js';
import {
  commitStatement,
  resolveStatement,
  transcriptHash,
  type OracleSigner,
} from './attestation.js';
import { generateSeed } from './seed.js';

/** A run's full derived state. Contains no seed unless the run has resolved. */
export interface RunView {
  readonly run: RunRecord;
  readonly turns: readonly CombatTurn[];
  readonly encounter: EncounterView;
  /**
   * The actions this replay consumed, in order.
   *
   * Carried out so the service layer can publish them: without the action list a
   * player has a signature and no way to re-run the fight it attests to.
   */
  readonly actions: readonly PlayerAction[];
  /**
   * Fingerprint of `(setup, actions)` — the non-seed half of what was signed.
   *
   * The setup here is `run.storedSetup`, the row's own bytes, not the
   * normalized `run.setup` the replay above ran on. For everything committed
   * since archetypes landed those are the same bytes; for older rows they are
   * not, and the signature already in the database was taken over the row's.
   *
   * Computed here rather than by the caller so that the value published for
   * verification and the value inside the resolve statement come from one line
   * of code. Two implementations of "what was signed" is one too many.
   */
  readonly transcriptHash: string;
}

/** Raised when a run cannot do what was asked of it. Mapped to HTTP by the caller. */
export class RunOracleError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = 'RunOracleError';
  }
}

export interface RunOracleDeps {
  readonly runs: RunStore;
  readonly signer: OracleSigner;
  /**
   * Settles paid runs on chain. Optional so a test can drive the free path with
   * no chain at all; a paid run reaching `resolve()` without it is refused
   * rather than quietly signed off-chain, which would settle a run with real
   * money at stake using the weaker of the two records.
   */
  readonly paidOracle?: PaidRunOracle;
  /** Injected so a test can pin the timestamps that go into an attestation. */
  readonly now?: () => Date;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
}

export class RunOracle {
  constructor(private readonly deps: RunOracleDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** The address players check attestations against. */
  get oracleAddress(): string {
    return this.deps.signer.address;
  }

  /**
   * Commit a seed for a pending run and freeze its setup.
   *
   * Idempotent by state, not by retry: a run already past `pending` is returned
   * untouched. Re-committing would replace a hash the player has already been
   * shown and possibly already acted under, which would make every roll since
   * unverifiable.
   */
  async commit(runId: string, setup: EncounterSetup): Promise<RunRecord> {
    const existing = await this.deps.runs.findById(runId);
    if (!existing) {
      throw new RunOracleError('RUN_NOT_FOUND', `No run with id ${runId}`, 404);
    }
    if (existing.state !== 'pending') return existing;
    if (existing.dungeonType !== 'free') {
      // A paid run's seed is committed on-chain by `commit-seed`. Signing one
      // here would create a second, weaker record of something the contract is
      // already authoritative for.
      throw new RunOracleError(
        'PAID_RUN_NOT_SUPPORTED',
        'Paid runs commit their seed on-chain, not here.',
        501,
      );
    }

    const { seed, seedHash } = generateSeed();
    const committedAt = this.now();
    const signature = this.deps.signer.sign(
      commitStatement({ runId, seedHash, committedAt: committedAt.toISOString() }),
    );

    // The same instant is signed and stored. Letting the database stamp its own
    // `now()` would leave the signature quoting a timestamp the run no longer
    // has, and a statement nobody can reconstruct is one nobody can verify.
    const committed = await this.deps.runs.commit(runId, {
      seedHash,
      seed,
      setup: { ...setup, dungeonPlan: buildDungeonPlan(seed, 'free', setup.monsterTableId) },
      encounterAlgoVersion: ENCOUNTER_ALGO_VERSION,
      commitSignature: signature,
      oracleAddress: this.deps.signer.address,
      committedAt,
    });

    // Lost the race to a concurrent commit. The other one's hash is the real
    // one; ours is discarded rather than overwriting it.
    if (!committed) return (await this.deps.runs.findById(runId))!;

    this.deps.log?.('run committed', { runId, seedHash });
    return committed;
  }

  /** Replay a run from its stored actions. The authoritative read path. */
  async view(runId: string): Promise<RunView | null> {
    const run = await this.deps.runs.findById(runId);
    if (!run) return null;
    return this.replay(run);
  }

  private async replay(
    run: RunRecord,
    extraAction?: PlayerAction,
  ): Promise<RunView> {
    if (run.state === 'pending' || !run.setup) {
      throw new RunOracleError(
        'RUN_NOT_COMMITTED',
        'This run has no committed seed yet.',
      );
    }

    const seed = await this.deps.runs.readSeedSecret(run.id);
    if (!seed) {
      // A committed run with no seed is a corrupt row, not a player error: the
      // encounter cannot be reproduced and must not be guessed at.
      throw new RunOracleError(
        'SEED_MISSING',
        'This run is committed but its seed is missing; it cannot be replayed.',
        500,
      );
    }

    const stored = await this.deps.runs.listActions(run.id);
    const actions: PlayerAction[] = stored.map((a) => ({
      powerId: a.powerId,
      targetId: a.targetId,
    }));
    if (extraAction) actions.push(extraAction);

    const { turns, view } = runEncounterVersioned(
      run.encounterAlgoVersion,
      seed,
      run.setup,
      actions,
    );
    return {
      run,
      turns,
      encounter: view,
      actions,
      // Over the setup AS STORED, not as replayed. These are the same bytes for
      // every run committed since archetypes landed; for one committed before,
      // the row still says `powerUpTiers` and `run.setup` says `powerUpItems`.
      // The oracle signed the row's bytes at resolve time, so hashing the
      // normalized form here would recompute a fingerprint that disagrees with
      // the signature stored beside it — on every read, forever, for runs that
      // were settled honestly. `run.setup` is the fallback only to satisfy the
      // compiler: the two are null together, and the guard above has already
      // refused a run with neither.
      transcriptHash: transcriptHash(run.storedSetup ?? run.setup, actions),
    };
  }

  /**
   * Submit one action and return the run's new state.
   *
   * The action is validated by replaying it, appended only if that replay
   * succeeds, and then the run is replayed again from storage — so what gets
   * returned is read back from the same rows a later `GET /runs/:id` will read,
   * not from an in-memory guess about what the append did.
   */
  async submitAction(
    runId: string,
    address: string,
    action: PlayerAction,
  ): Promise<RunView> {
    const run = await this.deps.runs.findById(runId);
    if (!run) {
      throw new RunOracleError('RUN_NOT_FOUND', `No run with id ${runId}`, 404);
    }
    if (run.state === 'resolved') {
      throw new RunOracleError(
        'RUN_ALREADY_RESOLVED',
        'This run has already been resolved.',
      );
    }

    const before = await this.replay(run);
    const active = before.encounter.activeCombatantId;
    if (!active) {
      throw new RunOracleError(
        'NOT_AWAITING_ACTION',
        'This encounter is not waiting for an action.',
      );
    }

    const actor = before.encounter.combatants.find((c) => c.id === active);
    if (!actor || actor.address !== address) {
      // Whose turn it is comes from the initiative order, which comes from the
      // seed. Acting out of turn is refused here rather than being silently
      // reordered, because reordering would change every roll after it.
      throw new RunOracleError(
        'NOT_YOUR_TURN',
        `It is ${actor?.name ?? 'another combatant'}'s turn.`,
        403,
      );
    }

    // Trial replay. An illegal action throws before anything is written.
    try {
      await this.replay(run, action);
    } catch (err) {
      if (err instanceof EncounterError) {
        throw new RunOracleError(err.code, err.message, 400);
      }
      throw err;
    }

    const expectedIndex = (await this.deps.runs.listActions(runId)).length;
    const appended = await this.deps.runs.appendAction(runId, expectedIndex, {
      address,
      powerId: action.powerId,
      targetId: action.targetId,
    });
    if (!appended) {
      // Two submissions raced for the same slot. The other one won; this one is
      // rejected rather than applied to a turn that has already happened.
      throw new RunOracleError(
        'ACTION_CONFLICT',
        'Another action for this turn was accepted first. Refresh the run.',
      );
    }

    const after = await this.replay(run);
    await this.deps.runs.putTurns(runId, after.turns);

    if (after.encounter.outcome) {
      return this.resolve(after);
    }
    return after;
  }

  /**
   * Reveal the seed and sign the resolution.
   *
   * For free runs, the outcome is signed and stored. For paid runs, it is posted
   * to `reveal-and-resolve` on chain, where the reward is decided and paid. The
   * outcome is taken from a replay computed here, never from a caller — "resolve
   * this run as a win" must not be an input to a signing function.
   */
  private async resolve(current: RunView): Promise<RunView> {
    const outcome = current.encounter.outcome;
    if (!outcome) {
      throw new RunOracleError('RUN_NOT_FINISHED', 'This encounter is still in progress.');
    }

    const seed = await this.deps.runs.readSeedSecret(current.run.id);
    if (!seed) {
      throw new RunOracleError('SEED_MISSING', 'Cannot resolve a run with no seed.', 500);
    }

    // Paid runs settle on chain. The oracle reads the sponsor pool, decides the
    // reward per the shared table, and posts `reveal-and-resolve`. The reward is
    // persisted here from the returned resolution.
    if (current.run.dungeonType === 'paid') {
      if (!this.deps.paidOracle) {
        throw new RunOracleError(
          'PAID_ORACLE_NOT_AVAILABLE',
          'Paid runs require a chain oracle, which is not configured for this instance.',
          501,
        );
      }

      // The loot recipient is party[0], which is the payer for a solo run. Party
      // runs are not enabled, so `current.run.createdBy` is that address.
      const resolution = await this.deps.paidOracle.resolveRun({
        runId: current.run.id,
        seed,
        combatOutcome: outcome,
        lootRecipient: current.run.createdBy,
      });

      const resolvedAt = this.now();
      const resolved = await this.deps.runs.resolve(current.run.id, {
        seedReveal: seed,
        combatOutcome: outcome,
        // Paid runs are settled by a transaction, not a signature.
        resolveSignature: null,
        reward: {
          kind: resolution.reward.kind,
          amountUstx: resolution.reward.amountUstx,
          // The loot NFT's token id is assigned by `character-loot-nft` inside
          // the resolve transaction, so it is a chain fact this write path has
          // not read. The indexer fills it in; recording a guess would put an id
          // in the row that no NFT necessarily has.
          lootTokenId: null,
          degraded: resolution.reward.degraded,
        },
        resolveTxId: resolution.resolveTxId,
        resolvedAt,
      });

      const run = resolved ?? (await this.deps.runs.findById(current.run.id))!;
      this.deps.log?.('paid run resolved', {
        runId: run.id,
        outcome,
        reward: resolution.reward.kind,
        resolveTxId: resolution.resolveTxId,
      });
      return { ...current, run };
    }

    // Free run: sign the resolution and store it.
    const resolvedAt = this.now();
    const reward = resolveFreeRunReward({ seed, combatOutcome: outcome });
    const signature = this.deps.signer.sign(
      resolveStatement({
        runId: current.run.id,
        seed,
        outcome,
        turnCount: current.turns.length,
        // From the replay that produced this outcome, so the fingerprint and the
        // result it attests to can't describe different action lists.
        transcriptHash: current.transcriptHash,
        algoVersions: {
          dice: DICE_ALGO_VERSION,
          encounter: current.run.encounterAlgoVersion,
          stats: STATS_ALGO_VERSION,
        },
        resolvedAt: resolvedAt.toISOString(),
      }),
    );

    const resolved = await this.deps.runs.resolve(current.run.id, {
      seedReveal: seed,
      combatOutcome: outcome,
      resolveSignature: signature,
      // Loot drops on every dungeon (docs/09 B7): it is the forge's only input
      // supply, so gating it behind the gate fee left a non-paying player unable
      // to ever forge. `resolveFreeRunReward` draws the identical loot branch a
      // paid run does and cannot return a jackpot — it takes no pool balance, so
      // a free run being unable to spend sponsor funds is structural here rather
      // than a check someone has to remember to write.
      reward: {
        kind: reward.kind,
        amountUstx: reward.amountUstx,
        // Nothing is minted yet. The NFT arrives later, from the ceremony the
        // loot minter runs on chain, and this is filled in from its resolve —
        // same reason it is null on a paid run, one step further removed.
        lootTokenId: null,
        degraded: reward.degraded,
      },
      resolvedAt,
    });

    // Null means someone else resolved it first — same outcome either way, since
    // the outcome is a function of inputs that are now frozen.
    const run = resolved ?? (await this.deps.runs.findById(current.run.id))!;
    this.deps.log?.('run resolved', { runId: run.id, outcome, reward: reward.kind });
    return { ...current, run };
  }
}

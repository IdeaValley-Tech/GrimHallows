/**
 * Runs (`runs`, `run_actions`, `combat_turns`).
 *
 * A run's persisted state is its **action list**, and nothing else. The encounter
 * engine is pure — `runEncounter(seed, setup, actions)` recomputes every roll,
 * every HP total and the outcome from those three inputs — so there is no HP
 * number in this schema that could drift from what the dice say. `combat_turns`
 * is a written-down replay, kept for fast reads and for the indexer; if it ever
 * disagreed with a replay of `run_actions`, the actions would be right.
 *
 * WHAT IS AND ISN'T AUTHORITATIVE HERE
 *
 * Free runs are off-chain content (07-glossary-and-open-questions.md#2), so for
 * those this table is the record — backed by an oracle signature over the commit
 * and the resolution, which a player can check independently.
 *
 * Paid runs are the opposite: their id *is* the on-chain run id, the contract
 * holds the real `state`/`seed-hash`/`seed-reveal`, and these rows are a mirror
 * maintained from chain facts (05-data-model.md indexing notes).
 *
 * `ingestPaidRun` is therefore not the paid twin of `createFreeRun`. Every field
 * it takes has been read back off a confirmed `enter-dungeon` transaction by
 * `services/paidEntryService.ts` — the id the contract assigned, the address the
 * chain says paid, the fee it says was paid — and it is `on conflict do nothing`
 * because ingesting the same transaction twice must produce one run, not two. A
 * run is still never recorded on the strength of this backend having been asked
 * nicely; it is recorded on the strength of a payment the chain confirms.
 *
 * `fee_paid_ustx` and `reward_amount_ustx` are two different money flows —
 * operator revenue and sponsor-pool payout — and must never be summed.
 */

import type {
  CharacterRef,
  CombatOutcome,
  CombatTurn,
  EncounterSetup,
  RewardKind,
  RunState,
  StoredEncounterSetup,
} from '@grimhallow/shared';
import { ENCOUNTER_ALGO_VERSION, normalizeStoredSetup } from '@grimhallow/shared';
import { query } from '../db.js';

export type { CharacterRef };

export interface RunRecord {
  readonly id: string;
  readonly dungeonType: 'free' | 'paid';
  /** On-chain dungeon id. Null on a free run, which has no on-chain existence. */
  readonly dungeonId: number | null;
  readonly spawnId: string | null;
  readonly partyId: string | null;
  /** Address that entered. Leaderboard credit is address-keyed, so a solo run needs one. */
  readonly createdBy: string;
  /** Null for a party run — each member's NFT lives in `party_members` instead. */
  readonly character: CharacterRef | null;
  readonly state: RunState;
  readonly seedHash: string | null;
  /**
   * The encounter's inputs, frozen at commit time, in the shape the engine takes.
   *
   * Null before commit. Pinned rather than recomputed because derived stats
   * depend on NFT metadata, which lives on somebody else's server and can change
   * mid-run — recomputing would replay a different fight from the one played.
   *
   * This is the NORMALIZED form: `storedSetup` below is what the column holds,
   * and this is that value put through `normalizeStoredSetup`. Hand this one to
   * `runEncounter` and nothing else.
   */
  readonly setup: EncounterSetup | null;
  /**
   * The same setup in the exact shape the column holds it.
   *
   * Non-null exactly when `setup` is — they are two readings of one value, not
   * two values. For every run committed since archetypes landed they are the
   * same bytes; for a run committed before, this one still carries
   * `powerUpTiers` and `setup` carries the `powerUpItems` it normalizes to.
   *
   * IT EXISTS BECAUSE THE ORACLE SIGNED THESE BYTES AND NOT THE OTHER ONES. The
   * transcript hash inside a free run's `resolve_signature` is
   * `sha256(canonicalize({actions, setup}))` over whatever the row held at the
   * time it was signed. Hashing the normalized form instead would recompute a
   * different fingerprint on every read than the signature we published
   * alongside it embeds — a run whose own two published values disagree, which
   * reads exactly like a backend caught rewriting history. So the hash and
   * `VerificationData.setup` both come from here, and only the replay comes
   * from `setup`.
   */
  readonly storedSetup: StoredEncounterSetup | null;
  readonly encounterAlgoVersion: string;
  /** Null until the run resolves. See `oracle/seed.ts` for why. */
  readonly seedReveal: string | null;
  readonly combatOutcome: CombatOutcome | null;
  /**
   * The gate fee this entry paid, in microSTX. Null on a free run.
   *
   * Operator revenue. Never added to `reward.amountUstx` below, which is paid
   * out of the separately-funded sponsor pool — they are two different money
   * flows and a query that summed them would describe a pot that doesn't exist.
   */
  readonly feePaidUstx: string | null;
  /**
   * What the reward table drew, once the run resolved. Null until then.
   *
   * Set on both dungeon types since docs/09 B7 — a free run draws the same loot
   * branch, and only the STX jackpot is gated behind the gate fee.
   */
  readonly reward: RunRewardRecord | null;
  /**
   * The three on-chain transactions behind a paid run.
   *
   * Published through `VerificationData` so a player can check the payment, the
   * commitment and the settlement themselves rather than checking a signature we
   * produced about them. All null on a free run, which has no transactions —
   * those carry the oracle signatures below instead.
   */
  readonly enterTxId: string | null;
  readonly commitTxId: string | null;
  readonly resolveTxId: string | null;
  readonly commitSignature: string | null;
  readonly resolveSignature: string | null;
  readonly oracleAddress: string | null;
  /**
   * Whether the chain agreed with this settlement, and when we checked.
   *
   * `state === 'resolved'` means the backend broadcast `reveal-and-resolve` — it
   * does not mean the transaction succeeded. A node accepts any well-formed,
   * funded transaction, and a failed `asserts!` inside the contract aborts it
   * later, on chain. The two facts are genuinely separate and only one of them
   * was ever recorded here. `settlementVerifiedAt` is when the indexer read the
   * transaction back; `settlementAbortReason` is null when it succeeded and
   * carries the chain's own `tx_status` when it did not.
   *
   * Since docs/09 B7 a free run can carry these too, about a different
   * transaction. A free fight settles by signature and has no `resolveTxId`, but
   * a free run that drew loot has a mint ceremony whose resolve can abort the
   * same way — so on a free run these describe `lootMint.resolveTxId`.
   *
   * Both null on a settlement not yet checked, and on a free run with no drop to
   * mint.
   */
  readonly settlementVerifiedAt: Date | null;
  readonly settlementAbortReason: string | null;
  /**
   * How a free run's loot drop is being minted on chain (docs/09 B7).
   *
   * All null on a paid run, which mints inside its own `reveal-and-resolve`, and
   * on a free run that drew `none`. A free run that drew loot needs an NFT the
   * forge can consume, and `character-loot-nft.mint` is reachable only through
   * `game-core` — so the drop is escorted through a synthetic on-chain run
   * (`enter-dungeon` → `commit-seed` → `reveal-and-resolve`) and these fields are
   * how far along that is.
   *
   * `lootMintChainRunId` is the id the *chain* assigned, which is not this
   * record's `id`. They come from different counters and are needed for different
   * things: `id` is the run a player has open, the chain id is what the
   * `loot-minted` print carries.
   */
  readonly lootMint: FreeRunLootMint | null;
  readonly createdAt: Date;
  /**
   * When the seed was committed. Null before commit.
   *
   * Persisted rather than derived because it is one of the lines inside the
   * signed commit statement, and a signature over a timestamp nobody kept is a
   * signature nobody can check.
   */
  readonly committedAt: Date | null;
  readonly resolvedAt: Date | null;
}

/**
 * A resolved run's reward, as recorded off-chain.
 *
 * `lootTokenId` is null here even after a loot mint: the token id is assigned by
 * `character-loot-nft` inside the resolve transaction, so it is a chain fact this
 * write path has not read. The indexer fills it in (Phase 7). Recording a guess
 * would put an id in the row that no NFT necessarily has.
 */
export interface RunRewardRecord {
  readonly kind: RewardKind;
  readonly amountUstx: string | null;
  readonly lootTokenId: string | null;
  /** True when a jackpot was downgraded because the pool couldn't cover it. */
  readonly degraded: boolean;
}

/**
 * The on-chain ceremony that mints a free run's loot drop (docs/09 B7).
 *
 * Each txid is written as its step is broadcast, so a worker restarting
 * mid-ceremony resumes from what has already happened rather than starting over
 * and minting a second NFT for one drop.
 *
 * `failedReason` is the terminal state: an aborted step, or an entry transaction
 * that did not return a run id. It stops the retry loop and marks a player as owed
 * loot the chain never minted — a thing an operator has to see, not a thing to
 * keep quietly re-attempting.
 */
export interface FreeRunLootMint {
  /** The id the chain assigned this synthetic run. Not the record's own `id`. */
  readonly chainRunId: string | null;
  readonly enterTxId: string | null;
  readonly commitTxId: string | null;
  readonly resolveTxId: string | null;
  readonly failedReason: string | null;
}

export interface NewFreeRun {
  readonly spawnId: string;
  readonly partyId: string | null;
  readonly createdBy: string;
  readonly character: CharacterRef | null;
}

/**
 * A paid run, described entirely by facts read off a confirmed transaction.
 *
 * There is no `state` field: an ingested paid run is always `pending`, because
 * the only thing that has happened is the payment. Nor is there a `partyId` —
 * party runs are not enabled, and the on-chain party list is the authority when
 * they are.
 */
export interface IngestedPaidRun {
  /** The id `enter-dungeon` returned. Read from the transaction, never supplied. */
  readonly id: string;
  readonly dungeonId: number;
  /** The chain's `sender_address` for the entry transaction. */
  readonly createdBy: string;
  readonly character: CharacterRef;
  /**
   * The gate fee the chain charged, in microSTX.
   *
   * Operator revenue (`runs.fee_paid_ustx`). Never summed with a reward amount
   * or with a pool balance — see the module note and 05-data-model.md.
   */
  readonly feePaidUstx: string;
  readonly enterTxId: string;
}

/** One submitted action, exactly as the engine consumes it. */
export interface RunActionRecord {
  readonly actionIndex: number;
  readonly address: string;
  readonly powerId: string;
  readonly targetId: string | null;
}

export interface NewRunAction {
  readonly address: string;
  readonly powerId: string;
  readonly targetId: string | null;
}

export interface CommitDetails {
  readonly seedHash: string;
  /**
   * The seed itself. Written to a column no read path serializes, and never put
   * on `RunRecord` — see `readSeedSecret`.
   */
  readonly seed: string;
  readonly setup: EncounterSetup;
  readonly encounterAlgoVersion?: string;
  /**
   * The oracle's signature over the commit statement, and the address to check
   * it against. Both null on a paid run: the commitment is a transaction there,
   * and a signature beside it would be a second, weaker record of something the
   * contract already settled.
   */
  readonly commitSignature: string | null;
  readonly oracleAddress: string | null;
  /** The `commit-seed` txid. Null on a free run, which has no transaction. */
  readonly commitTxId?: string | null;
  /** The exact instant that was signed. Passed in, never `now()` in the SQL. */
  readonly committedAt: Date;
}

export interface ResolveDetails {
  readonly seedReveal: string;
  readonly combatOutcome: CombatOutcome;
  /** Null on a paid run, for the same reason as `CommitDetails.commitSignature`. */
  readonly resolveSignature: string | null;
  /**
   * What the reward table drew.
   *
   * Set on both dungeon types since docs/09 B7: a free run draws the same loot
   * branch a paid one does (`resolveFreeRunReward`), and only the STX jackpot is
   * gated behind the gate fee. A free row therefore carries `kind = 'loot'` with
   * `amountUstx` null, and the NFT behind it is minted afterwards by the loot
   * minter — see `FreeRunLootMint`.
   */
  readonly reward?: RunRewardRecord | null;
  /** The `reveal-and-resolve` txid. Null on a free run. */
  readonly resolveTxId?: string | null;
  /** Same reasoning as `CommitDetails.committedAt`: it is inside the signature. */
  readonly resolvedAt: Date;
}

export interface RunStore {
  createFreeRun(run: NewFreeRun): Promise<RunRecord>;

  /**
   * Record a paid run from a confirmed `enter-dungeon` transaction.
   *
   * Idempotent: ingesting the same transaction twice returns the run that
   * already exists rather than creating a second one. That matters because the
   * same payment reaches this method from two directions — a player's claim and
   * a reconciliation pass — and two rows citing one payment would be one run
   * nobody paid for.
   *
   * Never called from a route. `services/paidEntryService.ts` reads the facts off
   * chain first; this method's arguments are that read's output, not a request
   * body's.
   */
  ingestPaidRun(run: IngestedPaidRun): Promise<RunRecord>;

  findById(id: string): Promise<RunRecord | null>;

  /**
   * The run recorded against an `enter-dungeon` txid, if any.
   *
   * Lets a repeated claim resolve to the run it already created without the
   * caller needing the chain-assigned id, which is what a client retrying a
   * claim conspicuously does not have.
   */
  findByEnterTxId(enterTxId: string): Promise<RunRecord | null>;

  /**
   * Move `pending` → `committed`, recording the seed commitment.
   *
   * Returns null if the run was not in `pending` — a second commit must not
   * replace the hash a player has already been shown and acted under.
   */
  commit(id: string, details: CommitDetails): Promise<RunRecord | null>;

  /**
   * The still-secret seed for a committed run.
   *
   * A method rather than a field on `RunRecord` on purpose. Every route that
   * returns a run returns the record, and a seed that rides along on that object
   * is one `return run` away from being published mid-run — at which point a
   * player can derive every remaining roll before choosing their next action.
   * Asking for it explicitly makes each read a deliberate line of code, and
   * `test/runs.repo.test.ts` asserts the record never carries it.
   *
   * Callers live under `src/oracle/`. Returns null if the run has not committed.
   */
  readSeedSecret(id: string): Promise<string | null>;

  /**
   * Move `committed` → `resolved`, revealing the seed.
   *
   * Returns null if the run was not in `committed`, which covers both resolving
   * before commit and resolving twice.
   */
  resolve(id: string, details: ResolveDetails): Promise<RunRecord | null>;

  listActions(runId: string): Promise<RunActionRecord[]>;

  /**
   * Append one action at `expectedIndex`.
   *
   * The index is passed in rather than computed inside, so two submissions that
   * race both claim the same slot and exactly one of them wins on the primary
   * key. Returns false for the loser; the caller re-reads and reports the real
   * state rather than silently applying an action to a turn that already
   * happened.
   */
  appendAction(runId: string, expectedIndex: number, action: NewRunAction): Promise<boolean>;

  /** Replace the written-down replay. Idempotent: replaying the same run rewrites it. */
  putTurns(runId: string, turns: readonly CombatTurn[]): Promise<void>;
  listTurns(runId: string): Promise<CombatTurn[]>;

  /**
   * Resolved runs that drew loot but have no token id recorded yet.
   *
   * `RunRewardRecord.lootTokenId` is deliberately null at resolve time — the id
   * is assigned by `character-loot-nft` *inside* the resolve transaction, so the
   * write path that records the reward has not read it. This is the indexer's
   * work list for filling it in from the `loot-minted` print event.
   *
   * Both dungeon types since docs/09 B7, and they carry the transaction on
   * different fields: a paid run's mint happens in its own `resolveTxId`, a free
   * run's in `lootMint.resolveTxId` from the ceremony the loot minter ran. The
   * caller has to read the right one — see `Indexer.backfillLoot`.
   */
  listAwaitingLootTokenId(limit: number): Promise<RunRecord[]>;

  /**
   * Record the loot token id read off a resolve transaction.
   *
   * Write-once by construction: the predicate requires the column to still be
   * null, so a re-index cannot rewrite an id a player has already been shown,
   * and a bad read cannot quietly replace a good one. Returns false when the run
   * already had an id or is not a resolved loot draw.
   */
  setLootTokenId(runId: string, lootTokenId: string): Promise<boolean>;

  /**
   * Settled runs whose transaction has not been read back from chain yet.
   *
   * The indexer's second work list, and the one that exists because a broadcast
   * is not a settlement: `resolve()` records a txid the moment the node accepts
   * the transaction, and a failed `asserts!` aborts it afterwards. Until someone
   * looks again, a row saying `reward_kind = 'loot'` and an NFT that was never
   * minted are indistinguishable.
   *
   * Since docs/09 B7 that applies to free runs too, on a different transaction. A
   * free fight is settled by signature and has no `resolveTxId` — but its drop is
   * minted by the loot minter's ceremony, whose resolve can abort exactly the same
   * way. The worker records that txid and stops considering the run, so this is
   * the only pass that ever looks at whether it worked.
   *
   * Ordered oldest-first: a settlement that has been unverified longest is the
   * one most likely to have actually failed, since a healthy one confirms within
   * a block or two.
   */
  listUnverifiedSettlements(limit: number): Promise<RunRecord[]>;

  /**
   * Record what the chain said about a settlement.
   *
   * `abortReason` is null for a transaction that succeeded, and the chain's own
   * `tx_status` otherwise — passed through rather than mapped to a local
   * vocabulary, so an operator reading the row can search for the same string the
   * explorer shows them.
   *
   * Write-once: the predicate requires `settlement_verified_at` to still be null.
   * A confirmed transaction is final, so a second pass has nothing to add, and
   * re-verifying could only overwrite a real answer with a worse one (a node that
   * has since forgotten the transaction, say).
   */
  markSettlementVerified(
    runId: string,
    abortReason: string | null,
    at: Date,
  ): Promise<boolean>;

  /**
   * Free runs that drew loot and have no minted NFT yet (docs/09 B7).
   *
   * The loot minter's work list. Includes runs mid-ceremony as well as ones that
   * have not started: the worker advances whatever step each is on, so "not
   * finished" is the right selection rather than "not begun". Runs marked failed
   * are excluded — a terminal state is not a work item.
   *
   * Oldest-first, so a drop that has been owed longest is minted first.
   */
  listFreeRunsAwaitingLootMint(limit: number): Promise<RunRecord[]>;

  /**
   * Record one step of the mint ceremony.
   *
   * Every field is optional and only non-undefined ones are written, because the
   * ceremony advances one step at a time and each step knows exactly one new
   * fact. Nothing here is write-once at the database level: a step that has to be
   * re-broadcast (dropped from the mempool, say) legitimately replaces its own
   * txid, and the guard against double-minting is the worker refusing to advance
   * past a step whose transaction has not confirmed.
   */
  updateLootMint(runId: string, patch: Partial<FreeRunLootMint>): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

interface RunRow {
  id: string;
  dungeon_type: 'free' | 'paid';
  dungeon_id: string | null;
  spawn_id: string | null;
  party_id: string | null;
  created_by: string;
  character_contract_id: string | null;
  character_token_id: string | null;
  state: RunState;
  seed_hash: string | null;
  encounter_setup_json: StoredEncounterSetup | null;
  encounter_algo_version: string;
  seed_reveal: string | null;
  combat_outcome: CombatOutcome | null;
  fee_paid_ustx: string | null;
  reward_kind: RewardKind | null;
  reward_amount_ustx: string | null;
  reward_loot_token_id: string | null;
  reward_degraded: boolean;
  enter_tx_id: string | null;
  commit_tx_id: string | null;
  resolve_tx_id: string | null;
  commit_signature: string | null;
  resolve_signature: string | null;
  oracle_address: string | null;
  settlement_verified_at: Date | null;
  settlement_abort_reason: string | null;
  loot_mint_chain_run_id: string | null;
  loot_mint_enter_tx_id: string | null;
  loot_mint_commit_tx_id: string | null;
  loot_mint_resolve_tx_id: string | null;
  loot_mint_failed_reason: string | null;
  created_at: Date;
  committed_at: Date | null;
  resolved_at: Date | null;
}

const RUN_COLUMNS = `id, dungeon_type, dungeon_id, spawn_id, party_id, created_by,
   character_contract_id, character_token_id, state, seed_hash,
   encounter_setup_json, encounter_algo_version, seed_reveal, combat_outcome, fee_paid_ustx,
   reward_kind, reward_amount_ustx, reward_loot_token_id, reward_degraded,
   enter_tx_id, commit_tx_id, resolve_tx_id, commit_signature,
   resolve_signature, oracle_address, settlement_verified_at,
   settlement_abort_reason, loot_mint_chain_run_id, loot_mint_enter_tx_id,
   loot_mint_commit_tx_id, loot_mint_resolve_tx_id, loot_mint_failed_reason,
   created_at, committed_at, resolved_at`;

/*
 * `StoredPartyMember`, `StoredSetup` and `normalizeSetup` used to live here and
 * are now `StoredPartyMemberSetup`, `StoredEncounterSetup` and
 * `normalizeStoredSetup` in `shared`.
 *
 * They moved because the stored shape stopped being a private detail of this
 * repo the moment `VerificationData.setup` began publishing it. An outside
 * verifier is handed these bytes — they are what the transcript hash covers —
 * so the declared way of turning them into something `runEncounter` accepts has
 * to be in the package they already have, not in a backend they cannot read.
 */

function fromRow(row: RunRow): RunRecord {
  return {
    // bigint comes back from pg as a string, and it stays a string all the way
    // to the client: run ids exceed Number.MAX_SAFE_INTEGER's comfort zone and
    // JSON has no integer type worth trusting with an identifier.
    id: String(row.id),
    dungeonType: row.dungeon_type,
    // A dungeon id is a small counter, unlike a run id — the contract's
    // `last-dungeon-id` is in the single digits — so Number is safe here and
    // matches the shared `PaidDungeon.id`.
    dungeonId: row.dungeon_id === null ? null : Number(row.dungeon_id),
    spawnId: row.spawn_id,
    partyId: row.party_id,
    createdBy: row.created_by,
    character:
      row.character_contract_id && row.character_token_id
        ? {
            contractId: row.character_contract_id,
            tokenId: String(row.character_token_id),
          }
        : null,
    state: row.state,
    seedHash: row.seed_hash,
    setup: normalizeStoredSetup(row.encounter_setup_json),
    storedSetup: row.encounter_setup_json,
    encounterAlgoVersion: row.encounter_algo_version,
    seedReveal: row.seed_reveal,
    combatOutcome: row.combat_outcome,
    // Kept as a string for the same reason as `id`: it is money, and money that
    // has been through a JS number is money you have to argue about.
    feePaidUstx: row.fee_paid_ustx === null ? null : String(row.fee_paid_ustx),
    // `reward_kind` is the presence flag — 'none' is a real draw (the table was
    // consulted and paid nothing), which is a different fact from null (no draw
    // happened, because this run has not resolved). Since docs/09 B7 a free run
    // draws too, so null no longer implies anything about the dungeon type.
    reward:
      row.reward_kind === null
        ? null
        : {
            kind: row.reward_kind,
            amountUstx:
              row.reward_amount_ustx === null ? null : String(row.reward_amount_ustx),
            lootTokenId:
              row.reward_loot_token_id === null ? null : String(row.reward_loot_token_id),
            degraded: row.reward_degraded,
          },
    enterTxId: row.enter_tx_id,
    commitTxId: row.commit_tx_id,
    resolveTxId: row.resolve_tx_id,
    commitSignature: row.commit_signature,
    resolveSignature: row.resolve_signature,
    oracleAddress: row.oracle_address,
    settlementVerifiedAt: row.settlement_verified_at,
    settlementAbortReason: row.settlement_abort_reason,
    // Presence, not truthiness: the ceremony's first recorded fact may legitimately
    // be a failure with every txid still null, and a `||`-style check would report
    // that run as having no mint at all.
    lootMint:
      row.loot_mint_chain_run_id === null &&
      row.loot_mint_enter_tx_id === null &&
      row.loot_mint_commit_tx_id === null &&
      row.loot_mint_resolve_tx_id === null &&
      row.loot_mint_failed_reason === null
        ? null
        : {
            chainRunId:
              row.loot_mint_chain_run_id === null ? null : String(row.loot_mint_chain_run_id),
            enterTxId: row.loot_mint_enter_tx_id,
            commitTxId: row.loot_mint_commit_tx_id,
            resolveTxId: row.loot_mint_resolve_tx_id,
            failedReason: row.loot_mint_failed_reason,
          },
    createdAt: row.created_at,
    committedAt: row.committed_at,
    resolvedAt: row.resolved_at,
  };
}

const isRunId = (id: string) => /^\d+$/.test(id);

export class PostgresRunStore implements RunStore {
  async createFreeRun(run: NewFreeRun): Promise<RunRecord> {
    const { rows } = await query<RunRow>(
      `insert into runs (id, dungeon_type, dungeon_id, spawn_id, party_id,
                         created_by, character_contract_id, character_token_id, state)
       values (nextval('free_run_id_seq'), 'free', null, $1, $2, $3, $4, $5, 'pending')
       returning ${RUN_COLUMNS}`,
      [
        run.spawnId,
        run.partyId,
        run.createdBy,
        run.character?.contractId ?? null,
        run.character?.tokenId ?? null,
      ],
    );
    return fromRow(rows[0]);
  }

  async findById(id: string): Promise<RunRecord | null> {
    if (!isRunId(id)) return null;
    const { rows } = await query<RunRow>(
      `select ${RUN_COLUMNS} from runs where id = $1`,
      [id],
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async ingestPaidRun(run: IngestedPaidRun): Promise<RunRecord> {
    // `on conflict do nothing` with no target, deliberately: there are two ways
    // this row can already exist — the chain-assigned id (primary key) and the
    // entry txid (`runs_enter_tx_id_key`) — and naming one of them would let a
    // re-ingest raise on the other instead of being the no-op it should be.
    const { rows } = await query<RunRow>(
      `insert into runs (id, dungeon_type, dungeon_id, created_by,
                         character_contract_id, character_token_id, state,
                         fee_paid_ustx, enter_tx_id)
       values ($1, 'paid', $2, $3, $4, $5, 'pending', $6, $7)
       on conflict do nothing
       returning ${RUN_COLUMNS}`,
      [
        run.id,
        run.dungeonId,
        run.createdBy,
        run.character.contractId,
        run.character.tokenId,
        run.feePaidUstx,
        run.enterTxId,
      ],
    );
    if (rows[0]) return fromRow(rows[0]);

    // Already ingested. Re-read by txid rather than by id: the transaction is
    // the thing this call is about, and it is what the unique index is on.
    const existing = await this.findByEnterTxId(run.enterTxId);
    if (existing) return existing;

    // No row on either key, yet the insert did nothing. That is not a race this
    // method can absorb — it means the row was removed between the two
    // statements, and returning a fabricated record would report a run the
    // database does not have.
    throw new Error(`Paid run ${run.id} vanished during ingest (tx ${run.enterTxId}).`);
  }

  async findByEnterTxId(enterTxId: string): Promise<RunRecord | null> {
    const { rows } = await query<RunRow>(
      `select ${RUN_COLUMNS} from runs where enter_tx_id = $1`,
      [enterTxId],
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async commit(id: string, details: CommitDetails): Promise<RunRecord | null> {
    if (!isRunId(id)) return null;
    // The `state = 'pending'` predicate is the lock: two concurrent commits both
    // run this UPDATE, and only the first matches a row.
    const { rows } = await query<RunRow>(
      `update runs
          set state = 'committed',
              seed_hash = $2,
              seed_secret = $3,
              encounter_setup_json = $4,
              encounter_algo_version = $5,
              commit_signature = $6,
              oracle_address = $7,
              commit_tx_id = $8,
              committed_at = $9
        where id = $1 and state = 'pending'
       returning ${RUN_COLUMNS}`,
      [
        id,
        details.seedHash,
        details.seed,
        JSON.stringify(details.setup),
        details.encounterAlgoVersion ?? ENCOUNTER_ALGO_VERSION,
        details.commitSignature,
        details.oracleAddress,
        details.commitTxId ?? null,
        details.committedAt,
      ],
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async readSeedSecret(id: string): Promise<string | null> {
    if (!isRunId(id)) return null;
    const { rows } = await query<{ seed_secret: string | null }>(
      `select seed_secret from runs where id = $1`,
      [id],
    );
    return rows[0]?.seed_secret ?? null;
  }

  async resolve(id: string, details: ResolveDetails): Promise<RunRecord | null> {
    if (!isRunId(id)) return null;
    const reward = details.reward ?? null;
    const { rows } = await query<RunRow>(
      `update runs
          set state = 'resolved',
              seed_reveal = $2,
              combat_outcome = $3,
              resolve_signature = $4,
              reward_kind = $5,
              reward_amount_ustx = $6,
              reward_loot_token_id = $7,
              reward_degraded = $8,
              resolve_tx_id = $9,
              resolved_at = $10
        where id = $1 and state = 'committed'
       returning ${RUN_COLUMNS}`,
      [
        id,
        details.seedReveal,
        details.combatOutcome,
        details.resolveSignature,
        reward?.kind ?? null,
        reward?.amountUstx ?? null,
        reward?.lootTokenId ?? null,
        // `reward_degraded` is `not null default false`, so a free run's absent
        // reward writes false rather than null — nothing was degraded, which is
        // exactly what false says.
        reward?.degraded ?? false,
        details.resolveTxId ?? null,
        details.resolvedAt,
      ],
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async listActions(runId: string): Promise<RunActionRecord[]> {
    if (!isRunId(runId)) return [];
    const { rows } = await query<{
      action_index: number;
      address: string;
      power_id: string;
      target_id: string | null;
    }>(
      `select action_index, address, power_id, target_id
         from run_actions where run_id = $1 order by action_index`,
      [runId],
    );
    return rows.map((r) => ({
      actionIndex: r.action_index,
      address: r.address,
      powerId: r.power_id,
      targetId: r.target_id,
    }));
  }

  async appendAction(
    runId: string,
    expectedIndex: number,
    action: NewRunAction,
  ): Promise<boolean> {
    if (!isRunId(runId)) return false;
    const { rowCount } = await query(
      `insert into run_actions (run_id, action_index, address, power_id, target_id)
       values ($1, $2, $3, $4, $5)
       on conflict (run_id, action_index) do nothing`,
      [runId, expectedIndex, action.address, action.powerId, action.targetId],
    );
    return (rowCount ?? 0) === 1;
  }

  async putTurns(runId: string, turns: readonly CombatTurn[]): Promise<void> {
    if (!isRunId(runId) || turns.length === 0) return;
    // One statement rather than a loop: a partially-written replay would be a
    // dice log with a hole in it.
    const values: unknown[] = [runId];
    const tuples = turns.map((t) => {
      const base = values.length;
      values.push(
        t.turnNumber,
        t.actorAddress,
        t.actorId,
        t.action,
        t.powerId,
        t.rolls.initiative ?? null,
        t.rolls.attackRoll ?? null,
        t.rolls.damageRoll ?? null,
        t.targetId,
        JSON.stringify(t),
      );
      return `($1, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5},
               $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10})`;
    });

    await query(
      `insert into combat_turns (run_id, turn_number, actor_address, actor_id, action,
                                 power_id, initiative_roll, attack_roll, damage_roll,
                                 target_id, result_json)
       values ${tuples.join(',')}
       on conflict (run_id, turn_number) do update
          set actor_address = excluded.actor_address,
              actor_id = excluded.actor_id,
              action = excluded.action,
              power_id = excluded.power_id,
              initiative_roll = excluded.initiative_roll,
              attack_roll = excluded.attack_roll,
              damage_roll = excluded.damage_roll,
              target_id = excluded.target_id,
              result_json = excluded.result_json`,
      values,
    );
  }

  async listTurns(runId: string): Promise<CombatTurn[]> {
    if (!isRunId(runId)) return [];
    // `result_json` is the whole turn; the scalar columns beside it exist so the
    // indexer and any hand-written query can filter without parsing JSON.
    const { rows } = await query<{ result_json: CombatTurn }>(
      `select result_json from combat_turns where run_id = $1 order by turn_number`,
      [runId],
    );
    return rows.map((r) => r.result_json);
  }

  async listAwaitingLootTokenId(limit: number): Promise<RunRecord[]> {
    // A mint transaction is required, not merely a resolved loot draw: the token
    // id is read off that transaction's events, so a row without one is not work
    // the indexer can do yet. Since docs/09 B7 there are two places it can be —
    // a paid run's own resolve, or the ceremony resolve the loot minter recorded
    // for a free one — and a free run has no `resolve_tx_id` at all.
    const { rows } = await query<RunRow>(
      `select ${RUN_COLUMNS} from runs
        where state = 'resolved'
          and reward_kind = 'loot'
          and reward_loot_token_id is null
          and coalesce(resolve_tx_id, loot_mint_resolve_tx_id) is not null
        order by resolved_at desc
        limit $1`,
      [limit],
    );
    return rows.map(fromRow);
  }

  async setLootTokenId(runId: string, lootTokenId: string): Promise<boolean> {
    if (!isRunId(runId)) return false;
    const { rowCount } = await query(
      `update runs set reward_loot_token_id = $2
        where id = $1 and state = 'resolved'
          and reward_kind = 'loot' and reward_loot_token_id is null`,
      [runId, lootTokenId],
    );
    return (rowCount ?? 0) === 1;
  }

  async listUnverifiedSettlements(limit: number): Promise<RunRecord[]> {
    // Oldest first, which is the opposite of `listAwaitingLootTokenId` above and
    // deliberately so. That one is chasing a value that arrives moments after the
    // transaction confirms, so newest-first gets it onto the reward screen
    // fastest. This one is looking for failures, and the longest-unconfirmed
    // settlement is the likeliest to be one.
    //
    // The OR rather than a `coalesce(...) is not null` so it matches
    // `runs_settlement_unverified_v2_idx` term for term: the planner proves a
    // partial index applies by comparing predicates, and it cannot see through
    // a function call.
    const { rows } = await query<RunRow>(
      `select ${RUN_COLUMNS} from runs
        where state = 'resolved'
          and settlement_verified_at is null
          and (resolve_tx_id is not null or loot_mint_resolve_tx_id is not null)
        order by resolved_at asc
        limit $1`,
      [limit],
    );
    return rows.map(fromRow);
  }

  async markSettlementVerified(
    runId: string,
    abortReason: string | null,
    at: Date,
  ): Promise<boolean> {
    if (!isRunId(runId)) return false;
    const { rowCount } = await query(
      `update runs set settlement_verified_at = $3, settlement_abort_reason = $2
        where id = $1 and settlement_verified_at is null`,
      [runId, abortReason, at],
    );
    return (rowCount ?? 0) === 1;
  }

  async listFreeRunsAwaitingLootMint(limit: number): Promise<RunRecord[]> {
    // Oldest first: a drop owed since yesterday is minted before one owed a
    // minute ago. Matches the settlement pass rather than the loot-token-id pass,
    // because this is chasing work that may be stuck, not a value about to arrive.
    const { rows } = await query<RunRow>(
      `select ${RUN_COLUMNS} from runs
        where dungeon_type = 'free'
          and state = 'resolved'
          and reward_kind = 'loot'
          and loot_mint_resolve_tx_id is null
          and loot_mint_failed_reason is null
        order by resolved_at asc
        limit $1`,
      [limit],
    );
    return rows.map(fromRow);
  }

  async updateLootMint(runId: string, patch: Partial<FreeRunLootMint>): Promise<boolean> {
    if (!isRunId(runId)) return false;

    // Only keys actually present are written. `undefined` means "this step learnt
    // nothing about that field"; null is a real value the caller may be clearing.
    const columns: Record<keyof FreeRunLootMint, string> = {
      chainRunId: 'loot_mint_chain_run_id',
      enterTxId: 'loot_mint_enter_tx_id',
      commitTxId: 'loot_mint_commit_tx_id',
      resolveTxId: 'loot_mint_resolve_tx_id',
      failedReason: 'loot_mint_failed_reason',
    };

    const sets: string[] = [];
    const values: unknown[] = [runId];
    for (const [key, column] of Object.entries(columns) as [keyof FreeRunLootMint, string][]) {
      const value = patch[key];
      if (value === undefined) continue;
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    }
    if (sets.length === 0) return false;

    const { rowCount } = await query(
      `update runs set ${sets.join(', ')} where id = $1 and dungeon_type = 'free'`,
      values,
    );
    return (rowCount ?? 0) === 1;
  }
}

// ---------------------------------------------------------------------------
// In-memory
// ---------------------------------------------------------------------------

/** In-memory equivalent, mirroring the sequence's starting point. */
export class MemoryRunStore implements RunStore {
  private readonly runs = new Map<string, RunRecord>();
  private readonly actions = new Map<string, RunActionRecord[]>();
  private readonly turns = new Map<string, CombatTurn[]>();
  /** Kept off `RunRecord` for the same reason the column is separate in Postgres. */
  private readonly seeds = new Map<string, string>();
  private nextId = 1_000_000_000n;

  async createFreeRun(run: NewFreeRun): Promise<RunRecord> {
    const record: RunRecord = {
      id: String(this.nextId++),
      dungeonType: 'free',
      dungeonId: null,
      spawnId: run.spawnId,
      partyId: run.partyId,
      createdBy: run.createdBy,
      character: run.character,
      state: 'pending',
      seedHash: null,
      setup: null,
      storedSetup: null,
      encounterAlgoVersion: ENCOUNTER_ALGO_VERSION,
      seedReveal: null,
      combatOutcome: null,
      feePaidUstx: null,
      reward: null,
      enterTxId: null,
      commitTxId: null,
      resolveTxId: null,
      commitSignature: null,
      resolveSignature: null,
      oracleAddress: null,
      settlementVerifiedAt: null,
      settlementAbortReason: null,
      lootMint: null,
      createdAt: new Date(),
      committedAt: null,
      resolvedAt: null,
    };
    this.runs.set(record.id, record);
    return record;
  }

  async ingestPaidRun(run: IngestedPaidRun): Promise<RunRecord> {
    // Both uniqueness rules the schema enforces, checked in the same order the
    // Postgres path resolves them: the id first, then the transaction.
    const byId = this.runs.get(run.id);
    if (byId) return byId;
    const byTx = await this.findByEnterTxId(run.enterTxId);
    if (byTx) return byTx;

    const record: RunRecord = {
      id: run.id,
      dungeonType: 'paid',
      dungeonId: run.dungeonId,
      spawnId: null,
      partyId: null,
      createdBy: run.createdBy,
      character: run.character,
      state: 'pending',
      seedHash: null,
      setup: null,
      storedSetup: null,
      encounterAlgoVersion: ENCOUNTER_ALGO_VERSION,
      seedReveal: null,
      combatOutcome: null,
      feePaidUstx: run.feePaidUstx,
      reward: null,
      enterTxId: run.enterTxId,
      commitTxId: null,
      resolveTxId: null,
      commitSignature: null,
      resolveSignature: null,
      oracleAddress: null,
      settlementVerifiedAt: null,
      settlementAbortReason: null,
      lootMint: null,
      createdAt: new Date(),
      committedAt: null,
      resolvedAt: null,
    };
    this.runs.set(record.id, record);
    return record;
  }

  async findById(id: string): Promise<RunRecord | null> {
    return this.runs.get(id) ?? null;
  }

  async findByEnterTxId(enterTxId: string): Promise<RunRecord | null> {
    for (const run of this.runs.values()) {
      if (run.enterTxId === enterTxId) return run;
    }
    return null;
  }

  async commit(id: string, details: CommitDetails): Promise<RunRecord | null> {
    const existing = this.runs.get(id);
    if (!existing || existing.state !== 'pending') return null;
    const updated: RunRecord = {
      ...existing,
      state: 'committed',
      seedHash: details.seedHash,
      // Split the same two ways `fromRow` splits a row, rather than storing one
      // object under both names. `CommitDetails.setup` is today's shape, so the
      // normalization is a no-op here and the split looks pointless — until a
      // test hands this store a pre-archetype setup to reproduce a legacy row,
      // which is the only way that case can be exercised without a database. If
      // this store skipped the split there, it would hold a `setup` no replay
      // can run and the two stores would disagree about what storage means.
      setup: normalizeStoredSetup(details.setup),
      storedSetup: details.setup,
      encounterAlgoVersion: details.encounterAlgoVersion ?? ENCOUNTER_ALGO_VERSION,
      commitSignature: details.commitSignature,
      oracleAddress: details.oracleAddress,
      commitTxId: details.commitTxId ?? null,
      committedAt: details.committedAt,
    };
    this.runs.set(id, updated);
    this.seeds.set(id, details.seed);
    return updated;
  }

  async readSeedSecret(id: string): Promise<string | null> {
    return this.seeds.get(id) ?? null;
  }

  async resolve(id: string, details: ResolveDetails): Promise<RunRecord | null> {
    const existing = this.runs.get(id);
    if (!existing || existing.state !== 'committed') return null;
    const updated: RunRecord = {
      ...existing,
      state: 'resolved',
      seedReveal: details.seedReveal,
      combatOutcome: details.combatOutcome,
      resolveSignature: details.resolveSignature,
      reward: details.reward ?? null,
      resolveTxId: details.resolveTxId ?? null,
      resolvedAt: details.resolvedAt,
    };
    this.runs.set(id, updated);
    return updated;
  }

  async listActions(runId: string): Promise<RunActionRecord[]> {
    return [...(this.actions.get(runId) ?? [])];
  }

  async appendAction(
    runId: string,
    expectedIndex: number,
    action: NewRunAction,
  ): Promise<boolean> {
    const list = this.actions.get(runId) ?? [];
    // Same rule the primary key enforces in Postgres: the slot is taken or it
    // isn't, and a mismatched index is a lost race, not an append.
    if (list.length !== expectedIndex) return false;
    list.push({ actionIndex: expectedIndex, ...action });
    this.actions.set(runId, list);
    return true;
  }

  async putTurns(runId: string, turns: readonly CombatTurn[]): Promise<void> {
    this.turns.set(runId, [...turns]);
  }

  async listTurns(runId: string): Promise<CombatTurn[]> {
    return [...(this.turns.get(runId) ?? [])];
  }

  async listAwaitingLootTokenId(limit: number): Promise<RunRecord[]> {
    return [...this.runs.values()]
      .filter(
        (r) =>
          r.state === 'resolved' &&
          r.reward?.kind === 'loot' &&
          r.reward.lootTokenId === null &&
          // The `coalesce` in the SQL: either transaction can carry the print.
          (r.resolveTxId !== null || r.lootMint?.resolveTxId != null),
      )
      .slice(0, limit);
  }

  async setLootTokenId(runId: string, lootTokenId: string): Promise<boolean> {
    const existing = this.runs.get(runId);
    // The same three-part predicate the UPDATE carries, so the two stores agree
    // on what a re-index of an already-filled row does: nothing.
    if (
      !existing ||
      existing.state !== 'resolved' ||
      existing.reward?.kind !== 'loot' ||
      existing.reward.lootTokenId !== null
    ) {
      return false;
    }
    this.runs.set(runId, {
      ...existing,
      reward: { ...existing.reward, lootTokenId },
    });
    return true;
  }

  async listUnverifiedSettlements(limit: number): Promise<RunRecord[]> {
    return [...this.runs.values()]
      .filter(
        (r) =>
          r.state === 'resolved' &&
          // Either transaction makes a run worth reading back: a paid run's own
          // settlement, or a free run's loot-mint ceremony resolve. Never both —
          // the two dungeon types settle on different paths.
          (r.resolveTxId !== null || r.lootMint?.resolveTxId != null) &&
          r.settlementVerifiedAt === null,
      )
      // Oldest first, matching the SQL. Insertion order is close enough to
      // resolved_at order here, but sorting explicitly means a test that seeds
      // runs out of order still sees the ordering the query guarantees.
      .sort((a, b) => (a.resolvedAt?.getTime() ?? 0) - (b.resolvedAt?.getTime() ?? 0))
      .slice(0, limit);
  }

  async markSettlementVerified(
    runId: string,
    abortReason: string | null,
    at: Date,
  ): Promise<boolean> {
    const existing = this.runs.get(runId);
    // Write-once, as in the UPDATE's predicate: a confirmed transaction is final.
    if (!existing || existing.settlementVerifiedAt !== null) return false;
    this.runs.set(runId, {
      ...existing,
      settlementVerifiedAt: at,
      settlementAbortReason: abortReason,
    });
    return true;
  }

  async listFreeRunsAwaitingLootMint(limit: number): Promise<RunRecord[]> {
    return [...this.runs.values()]
      .filter(
        (r) =>
          r.dungeonType === 'free' &&
          r.state === 'resolved' &&
          r.reward?.kind === 'loot' &&
          // `lootMint` is null before the first step, so both checks have to
          // survive that — a run that has never been touched is owed a mint.
          r.lootMint?.resolveTxId == null &&
          r.lootMint?.failedReason == null,
      )
      .sort((a, b) => (a.resolvedAt?.getTime() ?? 0) - (b.resolvedAt?.getTime() ?? 0))
      .slice(0, limit);
  }

  async updateLootMint(runId: string, patch: Partial<FreeRunLootMint>): Promise<boolean> {
    const existing = this.runs.get(runId);
    // Mirrors the UPDATE's `dungeon_type = 'free'` guard. Paid runs mint their
    // loot inside their own resolve; there is no ceremony to record against one.
    if (!existing || existing.dungeonType !== 'free') return false;

    const present = (Object.keys(patch) as (keyof FreeRunLootMint)[]).filter(
      (k) => patch[k] !== undefined,
    );
    // An empty patch is a caller bug, not a no-op write — the SQL returns false
    // for it too rather than issuing `set` with nothing after it.
    if (present.length === 0) return false;

    const base: FreeRunLootMint = existing.lootMint ?? {
      chainRunId: null,
      enterTxId: null,
      commitTxId: null,
      resolveTxId: null,
      failedReason: null,
    };
    const next = { ...base };
    for (const key of present) {
      // Widened deliberately: every field is `string | null`, and narrowing per
      // key here would need a switch that adds nothing but five more branches.
      (next as Record<string, string | null>)[key] = patch[key] as string | null;
    }

    this.runs.set(runId, { ...existing, lootMint: next });
    return true;
  }

  /**
   * Every run written so far, in creation order.
   *
   * Not part of `RunStore` — it exists so a test can assert that a *rejected*
   * entry wrote nothing, which is the kind of claim you can't make by querying
   * for a row you already believe doesn't exist.
   */
  all(): RunRecord[] {
    return [...this.runs.values()];
  }
}

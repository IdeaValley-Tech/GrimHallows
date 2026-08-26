/**
 * Combat service — 04-backend-api-spec.md#5.
 *
 * The public face of a run. Routes call this; this calls the oracle. The layer
 * exists so that no route holds a reference to the module that holds the signing
 * key, and so that everything crossing back out to a client is a *derived*
 * value — turns, HP, whose turn it is — rather than the seed those values came
 * from.
 *
 * What it adds on top of the oracle:
 *
 *   - building an encounter setup from a run's character, which is the one part
 *     that needs the chain (NFT metadata feeds derived stats);
 *   - shaping `RunResponse` / `ActionResponse` exactly as the spec and the web
 *     app expect them, including holding the seed back until the run resolves.
 */

import {
  DICE_ALGO_VERSION,
  ENCOUNTER_ALGO_VERSION,
  STATS_ALGO_VERSION,
  deriveCharacter as deriveCharacterCore,
  drawLootTier,
  isSupportedCollection,
  lootUriForTier,
  type ActionResponse,
  type EncounterSetup,
  type EquippedItem,
  type LootMintStatus,
  type PlayerAction,
  type RewardResult,
  type RunResponse,
  type VerificationData,
} from '@grimhallow/shared';
import type { RunOracle, RunView } from '../oracle/runOracle.js';
import type { CharacterRef, RunRecord } from '../repos/runs.js';
import type { ChainClient } from '../lib/hiro.js';
import type { CharacterMintService } from './characterMintService.js';
import type { MintSeedService } from './mintSeedService.js';
import { UNKNOWN_HOLDER_AGE, type HolderAgeService } from './holderAgeService.js';

/**
 * The solo party member's combatant id.
 *
 * `p0` because the encounter engine derives initiative from a combatant's
 * position, and position must be stable across replays. A party run numbers
 * members `p0..p3` in join order for the same reason.
 */
export const SOLO_COMBATANT_ID = 'p0';

export interface CombatServiceDeps {
  readonly oracle: RunOracle;
  readonly chain: ChainClient;
  /**
   * Optional so existing tests that only exercise the oracle path need no
   * holder-age plumbing. Absent means every character fights at holdDays 0 —
   * an underestimate, which is the safe direction (see holderAgeService.ts).
   */
  readonly holderAge?: HolderAgeService;
  /**
   * Resolves the on-chain class of our own `character-nft` tokens.
   *
   * Not optional in the same forgiving way the others are: since the curated
   * collection delta, a minted character has NO class outside this lookup — it
   * is deliberately absent from the allowlist — so without this dependency
   * `buildSetup` throws for exactly the characters players paid us for. Left
   * optional only so tests fielding a curated-collection token need not stub a
   * contract read they never reach.
   */
  readonly characterMint?: CharacterMintService;
  /**
   * Resolves the mint block hash seeding a minted character's rarity floor.
   *
   * Optional, and absent means every minted character fights with no floor —
   * an underestimate, and the same one the derivation already applies to an
   * unresolved seed. Supplying it here matters because the character LIST
   * supplies it: two services deriving one token from different inputs would
   * show a player a Rare card and then field a Common in the fight.
   */
  readonly mintSeeds?: MintSeedService;
}

export class CombatService {
  constructor(private readonly deps: CombatServiceDeps) {}

  async buildPartySetup(
    monsterTableId: string,
    members: readonly { address: string; character: CharacterRef; displayName?: string }[],
  ): Promise<EncounterSetup> {
    if (members.length < 1 || members.length > 4) throw new Error('A party encounter requires one to four members');
    const party = await Promise.all(members.map((member, index) => this.buildMember(`p${index}`, member.address, member.character, [], member.displayName)));
    return { monsterTableId, party };
  }

  /**
   * Build the encounter inputs for a run, reading metadata from chain.
   *
   * Called once, at entry, and the result is frozen onto the run by the oracle's
   * commit. Never called again: metadata can change after a run starts, and
   * rebuilding the setup later would replay a different fight from the one the
   * player actually played.
   *
   * `powerUpItems` is the equipped set, frozen at entry. Each item grants a
   * dice-formula upgrade, a defense bonus and — since archetypes — a max-HP
   * bonus and possibly a granted power, and the list is persisted in the setup
   * so a verifier can reproduce the exact damage rolls this character dealt.
   * `applyPowerUps(base, items)` is deterministic, but only if you know which
   * items were active, which now means both halves of each one: a tier alone
   * stopped being a complete description of an item when archetypes landed.
   */
  async buildSetup(
    run: RunRecord,
    monsterTableId: string,
    character: CharacterRef,
    powerUpItems: readonly EquippedItem[],
    displayName?: string,
  ): Promise<EncounterSetup> {
    return { monsterTableId, party: [await this.buildMember(SOLO_COMBATANT_ID, run.createdBy, character, powerUpItems, displayName)] };
  }

  private async buildMember(
    id: string,
    address: string,
    character: CharacterRef,
    powerUpItems: readonly EquippedItem[],
    displayName?: string,
  ): Promise<EncounterSetup['party'][number]> {
    const metadata = await this.deps.chain
      .getTokenMetadata(character.contractId, character.tokenId)
      .catch(() => null);

    // Frozen onto the run alongside everything else in the setup. Rarity moves
    // with the calendar, so reading it again mid-run would strengthen a
    // character partway through a fight it had already started.
    const age = this.deps.holderAge
      ? await this.deps.holderAge
          .forToken(address, character.contractId, character.tokenId)
          .catch(() => UNKNOWN_HOLDER_AGE)
      : UNKNOWN_HOLDER_AGE;

    // A curated-collection token gets its class from the allowlist and costs no
    // chain call. Anything else that got this far can only be one of our own
    // mints, whose class lives on chain — so that is the one case worth reading.
    const isOurMint = !isSupportedCollection(character.contractId);
    const mintedClassId = isOurMint
      ? await (this.deps.characterMint?.mintedClass(character.tokenId) ?? Promise.resolve(null))
      : null;

    // The same seed the character list derived the card from, so the fight is
    // fought at the rarity the player was shown. Resolved here rather than passed
    // in because the setup is frozen onto the run and must be reproducible from
    // chain alone by a verifier. Null degrades to no floor, exactly as it does on
    // the card — an unlucky moment for a just-minted token, and the same answer in
    // both places, which is what stops the fight and the card disagreeing.
    const mintSeed = isOurMint
      ? await (this.deps.mintSeeds
          ?.forToken(character.contractId, character.tokenId)
          .catch(() => null) ?? Promise.resolve(null))
      : null;

    const derived = deriveCharacterCore({
      contractId: character.contractId,
      tokenId: character.tokenId,
      metadata,
      holdDays: age.holdDays,
      mintedClassId,
      mintSeed,
    });

    return {
      id,
      address,
      name: displayName?.trim() || metadata?.name?.trim() || `Character #${character.tokenId}`,
      charClass: derived.classId,
      stats: derived.stats,
      powerUpItems,
    };
  }

  async get(runId: string): Promise<RunResponse | null> {
    const view = await this.deps.oracle.view(runId);
    return view ? toRunResponse(view) : null;
  }

  async submitAction(
    runId: string,
    address: string,
    action: PlayerAction,
  ): Promise<ActionResponse> {
    const before = await this.deps.oracle.view(runId);
    const alreadyLogged = before?.turns.length ?? 0;
    const after = await this.deps.oracle.submitAction(runId, address, action);

    return {
      runId,
      // Only the turns this submission caused. One action can produce several —
      // the player's own turn plus every monster that acts before their next one
      // — and the client animates exactly those rather than replaying the fight.
      turns: after.turns.slice(alreadyLogged),
      encounter: after.encounter,
      state: after.run.state,
      combatOutcome: after.run.combatOutcome,
    };
  }
}

/**
 * Everything a skeptical player needs to recompute the run.
 *
 * Takes the whole view rather than just the record because verification needs
 * the action list too: `runEncounter(seed, setup, actions)` is the function to
 * re-run, and handing over a signature without its inputs would be asking to be
 * trusted rather than checked.
 */
export function toVerification(view: RunView): VerificationData {
  const run = view.run;
  const actions: PlayerAction[] = view.actions.map((a) => ({
    powerId: a.powerId,
    targetId: a.targetId,
  }));

  return {
    // Held back until the run resolves. `RunRecord.seedReveal` is only populated
    // at that point, so this is the read that stays honest by construction
    // rather than by remembering to check the state here.
    seed: run.seedReveal,
    seedHash: run.seedHash ?? '',
    commitTxId: run.commitTxId,
    resolveTxId: run.resolveTxId,
    oracleAddress: run.oracleAddress,
    commitSignature: run.commitSignature,
    resolveSignature: run.resolveSignature,
    committedAt: run.committedAt?.toISOString() ?? null,
    resolvedAt: run.resolvedAt?.toISOString() ?? null,
    // Only meaningful once there is a resolve statement to check it against.
    // Before that it would fingerprint a transcript still being written. The
    // hash comes from the oracle rather than being recomputed here, so there is
    // one implementation of "what was signed".
    transcriptHash: run.resolveSignature ? view.transcriptHash : null,
    diceAlgoVersion: DICE_ALGO_VERSION,
    encounterAlgoVersion: run.encounterAlgoVersion,
    statsAlgoVersion: STATS_ALGO_VERSION,
    // The row's own bytes, not the normalized reading of them, because the hash
    // published one field up was taken over these. Publishing the normalized
    // form beside a hash of the stored form would hand a verifier two values
    // that cannot both be right, and the one they'd recompute is the one that
    // disagrees with our signature. `normalizeStoredSetup` in `shared` is the
    // declared way to turn this into something `runEncounter` accepts — and for
    // every run committed since archetypes landed it is a no-op.
    // A dungeon plan is derived from the secret seed. Publishing the frozen
    // setup before resolution would reveal every future enemy and wave.
    setup: run.seedReveal ? run.storedSetup : null,
    actions,
  };
}

export function toRunResponse(view: RunView): RunResponse {
  return {
    runId: view.run.id,
    dungeonType: view.run.dungeonType,
    state: view.run.state,
    combatOutcome: view.run.combatOutcome,
    turns: view.turns,
    encounter: view.encounter,
    reward: toRewardResult(view.run),
    lootMint: toLootMintStatus(view.run),
    verification: toVerification(view),
  };
}

/**
 * The stored reward, widened back to the shape the client and the verifier share.
 *
 * `runs` keeps what only the chain can tell us — the kind, the amount, the token
 * id the mint assigned, and whether a jackpot was degraded. It does not keep the
 * loot *tier* or its metadata URI, because both are functions of the revealed
 * seed: `drawLootTier(seed)` returns the same tier on the ordinary path and on
 * the degrade path, so re-deriving them here reads the same table the resolve
 * used rather than duplicating it. A column would be a second copy of a value
 * the seed already fixes, free to drift from it.
 *
 * Null for an unresolved run, and for a resolved one whose draw came up empty.
 * Tier and URI stay null if the seed is somehow absent — an unknown tier is
 * reported as unknown rather than guessed at.
 *
 * Free runs land here too since docs/09 B7. Nothing needed changing for that,
 * which is the point: they store `kind = 'loot'` like any other row, and the
 * tier is re-derived from the same seed by the same call.
 */
function toRewardResult(run: RunRecord): RewardResult | null {
  const reward = run.reward;
  if (!reward) return null;

  const tier =
    reward.kind === 'loot' && run.seedReveal ? drawLootTier(run.seedReveal) : null;

  return {
    kind: reward.kind,
    amountUstx: reward.amountUstx,
    lootUri: tier === null ? null : lootUriForTier(tier),
    tier,
    degraded: reward.degraded,
  };
}

/**
 * How far along a free run's loot mint is (docs/09 B7).
 *
 * Null on a paid run and on a run that drew no loot — a paid win's mint happens
 * inside the same `reveal-and-resolve` the settlement does, and there is no
 * second thing to report on. A free win's drop is escorted on chain minutes later
 * by its own ceremony, so between the reward screen appearing and the NFT
 * existing there is a real interval that the client has to be able to describe.
 *
 * `minted` COMES FROM THE TOKEN ID, NOT THE TXID. The txid is recorded when the
 * node accepts the broadcast, which is not the same as the mint happening — a
 * failed `asserts!` aborts afterwards. The token id is only ever written by the
 * indexer after reading a *successful* transaction's print event, so it is the
 * one field that cannot be true of a mint that did not occur.
 *
 * Both failure sources are reported the same way because they mean the same thing
 * to a player: `lootMint.failedReason` is the worker parking a ceremony it cannot
 * advance, `settlementAbortReason` is the chain refusing one it did. Either way
 * the drop shown on this screen does not exist and an operator has to intervene.
 */
function toLootMintStatus(run: RunRecord): LootMintStatus | null {
  if (run.dungeonType !== 'free' || run.reward?.kind !== 'loot') return null;

  const failedReason = run.lootMint?.failedReason ?? run.settlementAbortReason ?? null;
  const tokenId = run.reward.lootTokenId;
  const state = failedReason ? 'failed' : tokenId ? 'minted' : 'pending';

  return {
    state,
    txId: run.lootMint?.resolveTxId ?? null,
    tokenId,
    failedReason,
  };
}

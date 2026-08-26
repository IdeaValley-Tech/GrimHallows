/**
 * Shared types across api + web.
 *
 * Response shapes mirror 04-backend-api-spec.md verbatim — the frontend was
 * built against that spec, so field names here are contract, not preference.
 */

// Type-only, so it is erased at compile time and creates no runtime cycle —
// `encounter.ts` imports the other direction. The alternative was restating the
// engine's input types here, and two definitions of "what a fight was built
// from" is exactly the drift the verification story can't afford.
import type { PlayerAction, StoredEncounterSetup } from './encounter.js';

// ---------------------------------------------------------------------------
// Characters & stats
// ---------------------------------------------------------------------------

/** Derived base stats. See stats.ts for the derivation. */
export interface BaseStats {
  readonly hp: number;
  readonly str: number;
  readonly agi: number;
  readonly int: number;
  readonly vit: number;
}

/** The four stats a power can key its rolls off. HP is a pool, not a modifier. */
export type StatKey = keyof Omit<BaseStats, 'hp'>;

/** Matches the existing CharacterCard component's union. */
export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | 'mythic';
export type CharClass = 'warrior' | 'mage' | 'rogue' | 'paladin';

/**
 * How a character's class was arrived at (01-game-design.md#4a as amended by
 * the curated-collection delta). Defined here rather than next to `deriveClass`
 * so `DerivedCharacter` can reference it without types.ts importing from
 * classes.ts, which imports back from here.
 *
 * Published to players, not internal.
 *
 * `supported_collection` — token is from one of the eight allowlisted collections.
 * `mint`                 — token is from `character-nft.clar`; class was written
 *                          on chain at mint.
 *
 * There is no third value. A token from any other collection is not a playable
 * character at all.
 */
export type ClassSource = 'supported_collection' | 'mint';

/**
 * A character NFT, identified rather than described.
 *
 * The pair `(contractId, tokenId)` is all a client ever sends: stats are derived
 * from it server-side. A request that carried a stat block would be a request
 * that could carry a better one.
 */
export interface CharacterRef {
  readonly contractId: string;
  readonly tokenId: string;
}

/**
 * A character as served by `GET /characters` (04-backend-api-spec.md#2).
 *
 * SPLIT THAT MATTERS: the first group is holder-independent — a pure function
 * of the token's identity and metadata, the same for everyone forever. The
 * second group is holder-dependent — it changes when the token changes hands,
 * and resets to zero for the new owner. Only the first group is safe to cache
 * under a `(contract, token)` key; caching the second there would leave a sold
 * character showing its previous owner's rarity.
 */
export interface DerivedCharacter {
  // --- identity: holder-independent -----------------------------------------
  readonly contractId: string;
  readonly tokenId: string;
  readonly name: string;
  readonly imageUrl: string | null;
  /** Stable class id. From the NFT's contract principal, not its metadata (01-game-design.md#4a). */
  readonly classId: CharClass;
  /** Player-facing class name for `classId`. Display only. */
  readonly className: string;
  /** Which of the two derivation paths produced `classId`. */
  readonly classSource: ClassSource;

  // --- tenure: holder-dependent, resets on transfer --------------------------
  /** Current holder's tenure in days. 0 while the lookup is pending. */
  readonly holdDays: number;
  readonly rarityTier: Rarity;

  // --- deprecated aliases ----------------------------------------------------
  /**
   * @deprecated Alias of `classId`, retained so the web app keeps working
   * through the stats-v3 migration. An alias, never a second derivation — both
   * are served from one `deriveCharacter` result.
   */
  readonly charClass: CharClass;
  /** @deprecated Alias of `rarityTier`. Same rule as `charClass`. */
  readonly rarity: Rarity;

  readonly stats: BaseStats;
  /** Version of the derivation that produced `stats`. */
  readonly algoVersion: string;
}

/**
 * The holder-independent half of `DerivedCharacter` — the part that is safe to
 * cache under a `(contract, token)` key.
 *
 * Declared as a `Pick` rather than a hand-written interface so it cannot drift
 * from the fields it names, and so that adding a holder-dependent field to
 * `DerivedCharacter` does not quietly become cacheable by omission.
 */
export type CharacterIdentity = Pick<
  DerivedCharacter,
  | 'contractId'
  | 'tokenId'
  | 'name'
  | 'imageUrl'
  | 'classId'
  | 'className'
  | 'classSource'
  | 'algoVersion'
>;

/**
 * How the current holder's acquisition time was determined. Mirrors the `source`
 * column of `nft_holder_age_cache` (05-data-model.md).
 *
 * `fallback_pending` is a successful response, not an error: the lookup failed,
 * the character is served as freshly acquired, and a retry is queued. Publishing
 * it means a player whose rarity reads low can tell "not held long enough" apart
 * from "we could not find out yet".
 */
export type HolderAgeSource = 'holdings_block_height' | 'history_fallback' | 'fallback_pending';

export interface HolderAge {
  readonly holdDays: number;
  readonly source: HolderAgeSource;
}

// ---------------------------------------------------------------------------
// Powers & power-ups
// ---------------------------------------------------------------------------

/**
 * What a power does when you spend a turn on it.
 *
 * The starter kit is Attack / Guard / one class special (06-mvp-roadmap.md
 * Phase 4), and a special is still an attack — it just rolls different dice on a
 * cooldown. `heal` is the one kind no class kit contains: it arrives only from
 * an equipped `elixir`, which is why it is a `PowerKind` rather than a class
 * feature. It rolls dice like an attack and needs no target like a Guard, so it
 * is neither of the other two.
 */
export type PowerKind = 'attack' | 'guard' | 'heal';

/**
 * `cost` is deliberately present but unused for MVP — keeps the deferred
 * "STX for powers mid-run" mechanic additive later (07 open question #8).
 */
export interface Power {
  readonly id: string;
  readonly name: string;
  /** One line of player-facing flavour/rules text. */
  readonly description: string;
  readonly kind: PowerKind;
  /**
   * Damage dice, e.g. `2d6`. Null for a power that rolls nothing at all — a
   * Guard has no damage roll, and giving it a formula like `0d0` would put a
   * meaningless die in the turn log and in front of the dice animation.
   *
   * On a `heal` this is the healing roll, and it is the one formula equipped
   * items must never touch: see `powerAsRolled` in `encounter.ts`.
   */
  readonly diceFormula: string | null;
  readonly cost: number | null;
  /** Turns before the power can be used again. 0 = every turn. */
  readonly cooldown: number;
  /**
   * Uses per encounter, or null for a power that never runs out.
   *
   * Null on everything a class brings in: a kit power is a capability, and one
   * that expired mid-dungeon would leave a combatant with nothing to do. A
   * granted power can be a *consumable* — a flask has a number of swallows in
   * it — so this is the axis that makes an elixir a resource rather than a
   * permanent upgrade.
   *
   * Charges are per encounter and reset between runs. They are never persisted:
   * `runEncounter` is a replay from `(seed, setup, actions)`, so uses remaining
   * are recomputed from the action list every time rather than stored anywhere
   * that could drift from it. This is also why a potion is not burned on use —
   * a chain transaction confirming mid-fight cannot live inside a pure replay.
   */
  readonly charges: number | null;
  /** Which stat modifier applies to this power's attack/damage roll. */
  readonly stat: StatKey;
  /** Added to the user's Defense DC until their next turn. 0 for attacks. */
  readonly defenseBonus: number;
}

export interface PowerUpNft {
  readonly contractId: string;
  readonly tokenId: string;
  readonly tier: number;
  /**
   * The archetype slug, parsed from `metadataUri` — never fetched from it.
   *
   * Always a registered slug: a uri this build does not recognize resolves to
   * `relic`, which is what every token minted before archetypes existed reads
   * as. So this field is total, and a client can key art and copy off it without
   * a fallback branch of its own.
   */
  readonly archetype: string;
  /** Display name: `Legendary Chestplate #17`. Derived, never stored. */
  readonly name: string;
  readonly grantedPowerId: string | null;
  /** e.g. `attack:1d6->1d8` */
  readonly diceFormulaBonus: string | null;
  readonly mintedVia: 'dungeon_reward' | 'forge';
  readonly metadataUri: string | null;
}

/**
 * A forge recipe as the chain holds it — 03-smart-contracts-spec.md#4.
 *
 * Mirrored from the on-chain `recipes` map rather than authored off-chain, so a
 * player can plan a forge against contract state instead of a UI claim. The
 * tier names are derived from the tier numbers here rather than stored, so
 * there is one mapping and it cannot drift.
 */
export interface ForgeRecipe {
  readonly id: number;
  readonly inputTier: number;
  readonly inputTierName: string;
  /** How many inputs are burned. Every input must be exactly `inputTier`. */
  readonly inputCount: number;
  readonly outputTier: number;
  readonly outputTierName: string;
  readonly outputUri: string;
  /**
   * What `forge-v2.forge` charges for this recipe, in uSTX, as the chain holds
   * it. A decimal string rather than a number: uSTX amounts are `uint` on chain
   * and JSON numbers lose precision above 2^53, and rather than reason about
   * which amounts are small enough, every uSTX value crosses this boundary the
   * same way (see `feeUstx` on the paid-entry quote).
   *
   * Read live from `get-recipe` per request, never from `FORGE_FEE_BY_OUTPUT_TIER`
   * — that constant is what the owner *seeds*, not what the chain currently
   * charges, and a stale copy would produce a post-condition that aborts the
   * player's transaction.
   */
  readonly stxFeeUstx: string;
}

/**
 * `POST /forge` — 04-backend-api-spec.md#7.
 *
 * The unsigned payload itself, flat, with the fee restated alongside it so the
 * UI can show a price without decoding a hex post-condition. They must agree;
 * `postConditions` is the one that binds, and a screen that displayed anything
 * other than `feeUstx` would be lying with our own data.
 */
export interface ForgeTxResponse extends UnsignedTxPayload {
  readonly feeUstx: string;
}

// ---------------------------------------------------------------------------
// Character shop
// ---------------------------------------------------------------------------

/** One entry on the shop's class picker. */
export interface CharacterClassOption {
  readonly classId: CharClass;
  readonly name: string;
  readonly emphasis: readonly StatKey[];
  readonly blurb: string;
}

/**
 * `GET /characters/mint` — the shop front.
 *
 * Both `priceUstx` and `paused` are read from `character-nft` on every request
 * rather than from `CHARACTER_MINT_PRICE_USTX`. That constant is what the deploy
 * script *writes*; the contract's `mint-price` data-var is what it *charges*, and
 * the owner can change it without redeploying.
 */
export interface CharacterMintQuoteResponse {
  readonly priceUstx: string;
  /** The owner's switch for stopping sales. A paused mint refuses before signing. */
  readonly paused: boolean;
  readonly classes: readonly CharacterClassOption[];
  /**
   * Plain-language statement shown before the wallet prompt, for the same reason
   * the paid dungeon carries one: this is a purchase, not a wager, and the price
   * neither funds the prize pool nor changes anyone's odds.
   */
  readonly disclosure: string;
}

/** `POST /characters/mint` — same flat shape and same rule as `ForgeTxResponse`. */
export interface MintCharacterTxResponse extends UnsignedTxPayload {
  readonly priceUstx: string;
}

// ---------------------------------------------------------------------------
// Map & dungeons
// ---------------------------------------------------------------------------

export interface FreeDungeonSpawn {
  readonly id: string;
  readonly location: { readonly x: number; readonly y: number };
  readonly monsterTableId: string;
  readonly expiresAt: string;
}

export interface PaidDungeonSummary {
  readonly dungeonId: number;
  readonly name: string;
  readonly location: { readonly x: number; readonly y: number };
  readonly gateFeeUstx: string;
  /**
   * Owner-funded prize budget read live from `get-sponsor-pool`.
   * NOT fee revenue collected — never add these two together.
   */
  readonly sponsorPoolUstx: string;
}

export interface MapResponse {
  readonly spawns: readonly FreeDungeonSpawn[];
  /**
   * Null when the gate fee and pool balance could not be read from chain —
   * before the contracts are deployed, or during a Stacks API outage.
   *
   * Deliberately nullable rather than defaulted. Both numbers here are money
   * shown to a player before they decide to spend, so a stale constant or a
   * fallback `0` would be a lie in exactly the place a lie costs the most. The
   * spawns above need no chain access and are still returned, so a chain
   * problem costs the free half of the map nothing.
   */
  readonly paidDungeon: PaidDungeonSummary | null;
}

// ---------------------------------------------------------------------------
// Dungeon entry — 04-backend-api-spec.md#3
// ---------------------------------------------------------------------------

/**
 * Free-dungeon entry. No transaction, no fee, no signature: the run token is
 * the whole thing (06-mvp-roadmap.md Phase 3).
 *
 * The token authorises submitting turns for *this run only*. It cannot move
 * STX or an NFT, because nothing off-chain can.
 */
export interface FreeEntryResponse {
  readonly dungeonType: 'free';
  readonly runId: string;
  readonly spawnId: string;
  readonly monsterTableId: string;
  readonly runToken: string;
  readonly expiresAt: string;
  /**
   * The seed commitment, published here because this is the last moment before
   * the player can act. Handed over at entry so it is provably not chosen after
   * seeing what they do — the seed itself stays secret until the run resolves.
   */
  readonly seedHash: string;
  /** The address whose signature backs this run's commit and resolution. */
  readonly oracleAddress: string;
  readonly commitSignature: string;
  /**
   * The timestamp inside the signed commit statement.
   *
   * Published because the signature covers it: a verifier reconstructs the exact
   * statement from `runId`, `seedHash` and this, and a field they can't see is a
   * field they can't check. It is self-asserted — it proves what we said, not
   * when we said it (see the API's `oracle/attestation.ts`).
   */
  readonly committedAt: string;
  /** The opening state of the fight: roster, initiative order, whose turn it is. */
  readonly encounter: EncounterView;
}

/**
 * A contract call the player's wallet must sign, described exactly.
 *
 * The backend prepares this and never signs it (02-architecture.md ground
 * rules). `postConditions` are hex-encoded and, for anything moving STX, pin the
 * exact amount in `deny` mode — so a payload that tried to take more than
 * `summary` claims would abort on chain rather than succeed.
 */
export interface UnsignedTxPayload {
  readonly contractAddress: string;
  readonly contractName: string;
  readonly functionName: string;
  readonly functionArgs: readonly string[];
  readonly postConditionMode: 'deny' | 'allow';
  readonly postConditions: readonly string[];
  readonly network: string;
  readonly summary: string;
}

/**
 * Paid-dungeon entry — 04-backend-api-spec.md#3.
 *
 * Deliberately unlike `FreeEntryResponse`: there is no run token, no seed hash
 * and no encounter here, because at this point nothing has happened yet. The
 * player has been handed a transaction to sign. The run does not exist until
 * that transaction is mined and `enter-dungeon` assigns it an id on chain, and
 * the seed is committed against that id afterwards — committing earlier would
 * mean committing to a run that might never be paid for.
 *
 * `feeUstx` is stated separately from the post-condition inside `tx` so the UI
 * can show a number without decoding a hex blob. They must agree; the
 * post-condition is the one that binds.
 */
export interface PaidEntryResponse {
  readonly dungeonType: 'paid';
  readonly dungeonId: number;
  /** Exactly what leaves the player's wallet, to the operator, non-refundable. */
  readonly feeUstx: string;
  /**
   * Live `get-sponsor-pool` at the moment of quoting, for the confirmation
   * screen. Not a promise: the pool can move before the run resolves, and a
   * jackpot larger than it degrades per 03-smart-contracts-spec.md#3.
   */
  readonly sponsorPoolUstx: string;
  readonly party: readonly string[];
  readonly character: CharacterRef;
  readonly tx: UnsignedTxPayload;
  /**
   * Plain-language statement shown before signing, per 04-backend-api-spec.md#3
   * ("the UI copy should say plainly that this is an entry fee, not a wager").
   */
  readonly disclosure: string;
}

/** Response to `POST /admin/fund-pool` — owner-signed, never player-facing. */
export interface FundPoolResponse {
  readonly amountUstx: string;
  /** Pool balance read immediately before quoting, for a sanity check. */
  readonly sponsorPoolUstx: string;
  readonly tx: UnsignedTxPayload;
}

/**
 * A paid run, verified from chain and ready to play.
 *
 * The second half of a paid entry. `PaidEntryResponse` hands over a transaction
 * to sign; this is what comes back once that transaction is mined and the player
 * presents its txid. Between the two, the contract assigned the run an id, took
 * the fee, and the oracle committed a seed against that id on chain.
 *
 * Shaped to parallel `FreeEntryResponse` on purpose: past this point a paid run
 * and a free run are the same object to the combat loop — same run token, same
 * action endpoint, same encounter view — and the client should not need two code
 * paths to play them. The differences are all in how the commitment is evidenced.
 */
export interface PaidRunReadyResponse {
  readonly dungeonType: 'paid';
  readonly runId: string;
  /** The on-chain dungeon this run was entered against. */
  readonly dungeonId: number;
  readonly monsterTableId: string;
  readonly runToken: string;
  readonly expiresAt: string;
  /**
   * The seed commitment, as published on chain by `commit-seed`.
   *
   * Same guarantee as the free path's, established a stronger way: a free run's
   * hash is backed by the oracle's signature, and this one is backed by a
   * transaction anyone can look up. Fixed before the player's first action either
   * way.
   */
  readonly seedHash: string;
  /**
   * What the player paid, in microSTX, as read from the entry transaction.
   *
   * The amount that actually moved — not the fee the contract announced. The two
   * agree on every ordinary entry and can differ when the entrant is the contract
   * owner, whose fee transfer is skipped on chain.
   *
   * Operator revenue. Never added to a reward amount or a pool balance
   * (02-architecture.md#3).
   */
  readonly feePaidUstx: string;
  /** The `enter-dungeon` transaction that created this run. */
  readonly enterTxId: string;
  /**
   * The `commit-seed` transaction that fixed the seed hash.
   *
   * This is what a player checks the commitment against, and why a paid run
   * carries no commit signature: the chain already recorded it, and a signature
   * beside a transaction would be a second, weaker record of the same fact.
   */
  readonly commitTxId: string | null;
  /** The address that signed `commit-seed`, for cross-checking the transaction. */
  readonly oracleAddress: string | null;
  readonly committedAt: string;
  /** The opening state of the fight: roster, initiative order, whose turn it is. */
  readonly encounter: EncounterView;
}


// ---------------------------------------------------------------------------
// Runs & combat
// ---------------------------------------------------------------------------

export type RunState = 'pending' | 'committed' | 'resolved';
export type CombatOutcome = 'win' | 'loss';
export type RewardKind = 'jackpot' | 'loot' | 'none';

export interface TurnRolls {
  readonly initiative?: number;
  readonly attackRoll?: number;
  readonly damageRoll?: number;
  /** Individual die faces so the UI animates real values, not fakes. */
  readonly attackDice?: readonly number[];
  readonly damageDice?: readonly number[];
  readonly targetDc?: number;
  readonly hit?: boolean;
  /**
   * HP restored, and the faces that produced it. Present only on a `heal` turn.
   *
   * Separate from `damageRoll`/`damageDice` even though a heal rolls from the
   * same derivation slots, because the two mean opposite things to a reader: a
   * client that rendered healing as `damageDealt` would show a potion hurting
   * its drinker. The value here is the roll, not the HP actually gained — a heal
   * clamps at `maxHp`, and `targetHpAfter` is where the applied result lives.
   */
  readonly healRoll?: number;
  readonly healDice?: readonly number[];
}

/** What a combatant spent their turn doing. Mirrors `Power.kind`. */
export type CombatActionType = PowerKind;

/**
 * One resolved turn, as logged and as returned to the client.
 *
 * Everything here is reproducible from the run's seed plus the sequence of
 * player actions — nothing in a turn is invented at write time, which is what
 * makes the log checkable rather than merely readable.
 */
export interface CombatTurn {
  readonly turnNumber: number;
  /** Combatant id within the encounter, e.g. `p0` / `m1`. */
  readonly actorId: string;
  readonly actorName: string;
  /** Stacks address for a party member; null for a monster, which has none. */
  readonly actorAddress: string | null;
  readonly action: CombatActionType;
  readonly powerId: string | null;
  readonly powerName: string | null;
  readonly targetId: string | null;
  readonly targetName: string | null;
  readonly rolls: TurnRolls;
  /** Damage actually applied after the target's HP floor at 0. */
  readonly damageDealt: number;
  readonly targetHpAfter: number | null;
  readonly defeated: boolean;
  /** `i` in `hash(seed || i)` for this turn's first roll. */
  readonly derivationIndex: number;
}

/** Which team a combatant fights for. */
export type CombatSide = 'party' | 'monsters';

/** A combatant as the client sees it: identity, stats and live condition. */
export interface CombatantView {
  readonly id: string;
  readonly side: CombatSide;
  readonly name: string;
  /** Stacks address for a party member; null for a monster. */
  readonly address: string | null;
  readonly stats: BaseStats;
  readonly hp: number;
  readonly maxHp: number;
  /** `10 + VIT/2`, plus any active Guard bonus. What an attack must beat. */
  readonly defenseDc: number;
  readonly guarding: boolean;
  readonly initiative: number;
  readonly powers: readonly Power[];
  /** Power id → turns remaining before it can be used again. */
  readonly cooldowns: Readonly<Record<string, number>>;
  /**
   * Power id → uses left this encounter. Only powers with a charge limit appear.
   *
   * A power absent from this map is unlimited, which is every class power; the
   * map is not "charges for all powers, mostly Infinity". Reset each encounter
   * and never persisted — see `Power.charges`.
   */
  readonly charges: Readonly<Record<string, number>>;
}

/** The whole encounter as the client sees it. Derived, never authored. */
export interface EncounterView {
  readonly monsterTableId: string;
  /** The turn about to be taken. 1-based. */
  readonly turnNumber: number;
  /** Whose turn it is, or null once the encounter has ended. */
  readonly activeCombatantId: string | null;
  /** Combatant ids in initiative order. */
  readonly order: readonly string[];
  readonly combatants: readonly CombatantView[];
  readonly outcome: CombatOutcome | null;
  readonly algoVersion: string;
}

/** Response to `POST /runs/:runId/actions`. */
export interface ActionResponse {
  readonly runId: string;
  /**
   * The submitted turn, followed by every turn the monsters took before
   * control came back to the party. Returned as a list rather than one turn so
   * the client can animate the whole exchange from real dice.
   */
  readonly turns: readonly CombatTurn[];
  readonly encounter: EncounterView;
  readonly state: RunState;
  readonly combatOutcome: CombatOutcome | null;
}

export interface RewardResult {
  readonly kind: RewardKind;
  readonly amountUstx: string | null;
  readonly lootUri: string | null;
  readonly tier: number | null;
  /** True when a jackpot was downgraded because the pool couldn't cover it. */
  readonly degraded: boolean;
}

/** Everything a skeptical player needs to recompute the run themselves. */
export interface VerificationData {
  /**
   * The revealed seed. Null while the run is still in progress — publishing it
   * early would let a player derive every remaining roll before choosing their
   * next action, which is the one thing commit-reveal exists to prevent.
   */
  readonly seed: string | null;
  readonly seedHash: string;
  readonly commitTxId: string | null;
  readonly resolveTxId: string | null;
  /**
   * The off-chain analogue of the two tx ids above, for free runs.
   *
   * A free dungeon has no transaction to point at, so the oracle signs the
   * commit and the resolution instead and a player recovers the signer from the
   * signature and checks it against `oracleAddress`. Null on a paid run — those
   * are settled by the contract, and a signature there would be a second, weaker
   * source of truth for something the chain already decided.
   */
  readonly oracleAddress: string | null;
  readonly commitSignature: string | null;
  readonly resolveSignature: string | null;
  /**
   * The two timestamps the signatures above are taken over.
   *
   * A signature is only checkable if the verifier can rebuild the exact bytes
   * that were signed, and both statements include an instant. Null until the
   * corresponding step has happened.
   */
  readonly committedAt: string | null;
  readonly resolvedAt: string | null;
  /**
   * The transcript fingerprint inside the resolve statement. Null until resolved.
   *
   * Taken over `setup` below exactly as published — see that field. Recomputing
   * it is `sha256` of the key-sorted JSON of `{actions, setup}`.
   */
  readonly transcriptHash: string | null;
  readonly diceAlgoVersion: string;
  readonly encounterAlgoVersion: string;
  /**
   * Stat derivation's version. Present because derived stats are an input to the
   * fight, so a run is only reproducible if you know which derivation produced
   * the numbers it was played with.
   */
  readonly statsAlgoVersion: string;
  /**
   * The two non-seed inputs to `runEncounter`, published verbatim.
   *
   * Without these, "verifiable" would mean "you may check our signature on our
   * summary of what happened". With them a player recomputes the entire fight:
   * `runEncounter(seed, setup, actions)` is pure, so these three values plus the
   * shared package reproduce every roll and the outcome, or they don't and we
   * are caught.
   *
   * `setup` is null until resolution. Modern setups contain the seed-derived
   * dungeon plan, so publishing one before the seed reveal would disclose the
   * future roster while the player is still choosing actions.
   *
   * WHY THE STORED SHAPE AND NOT THE RUNNABLE ONE. `setup` is the row as it was
   * written at commit time, byte for byte, because that is what
   * `transcriptHash` above was taken over — verbatim has to mean verbatim or
   * the hash beside it is uncheckable. A row committed before archetypes
   * existed still spells a loadout `powerUpTiers: number[]`, which
   * `runEncounter` does not accept. Put it through `normalizeStoredSetup` from
   * this package first: that is the declared conversion, it is what the backend
   * replays through, and for every run committed since archetypes landed it
   * changes nothing.
   */
  readonly setup: StoredEncounterSetup | null;
  readonly actions: readonly PlayerAction[];
}

/**
 * How a free run's loot drop is getting on chain (docs/09 B7).
 *
 * A paid win mints inside its own `reveal-and-resolve`, so the mint and the
 * settlement are one transaction and `verification.resolveTxId` already points at
 * it. A free win has no such transaction — the fight settles by oracle signature,
 * and the drop is escorted on chain minutes later by a separate three-step
 * ceremony. Without this the reward screen would have to either claim a mint it
 * cannot evidence or say nothing at all about the item it just showed the player.
 */
export interface LootMintStatus {
  /**
   * `pending` — not broadcast yet, or broadcast and not yet confirmed. This is
   *   the normal state for the first minutes of a drop's life.
   * `minted` — an NFT exists and `tokenId` names it. Only reachable by reading a
   *   successful transaction back, never from a broadcast.
   * `failed` — the ceremony was parked, or the chain refused it. The player is
   *   owed a drop they do not have, which is worth saying out loud rather than
   *   leaving a spinner turning forever.
   */
  readonly state: 'pending' | 'minted' | 'failed';
  /** The ceremony's resolve transaction. Null until that step is broadcast. */
  readonly txId: string | null;
  /**
   * Assigned by `character-loot-nft` inside the mint, so it is a chain fact and
   * null until the indexer has read it back off the print event.
   */
  readonly tokenId: string | null;
  /** Why it stopped, when it stopped. Null otherwise. */
  readonly failedReason: string | null;
}

export interface RunResponse {
  readonly runId: string;
  readonly dungeonType: 'paid' | 'free';
  readonly state: RunState;
  readonly combatOutcome: CombatOutcome | null;
  readonly turns: readonly CombatTurn[];
  /** Null before the encounter has been built (i.e. before commit). */
  readonly encounter: EncounterView | null;
  readonly reward: RewardResult | null;
  /** Null on a paid run, and on any run that drew no loot. */
  readonly lootMint: LootMintStatus | null;
  readonly verification: VerificationData;
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

/**
 * One thing that happened, cited so a reader can go and check it.
 *
 * 04-backend-api-spec.md#8 asks for "enough (e.g. a source tx id per
 * contributing event) that a skeptical player could spot-check an entry". A bare
 * list of tx ids can't quite carry that, because one of the three contributing
 * event kinds has no transaction: a free dungeon is settled off chain
 * (07-glossary #2) and its evidence is an oracle signature published by
 * `GET /runs/:id`. Rather than omit free runs from the citations or invent a
 * txid for them, each source names what kind of thing it was and where to look.
 */
export interface LeaderboardSource {
  readonly kind: 'paid_dungeon' | 'free_dungeon' | 'forge';
  /** The run behind this credit. Null for a forge, which is not a run. */
  readonly runId: string | null;
  /**
   * The transaction to look up in an explorer.
   *
   * Null on a free dungeon, which has none — check `runId` against
   * `GET /runs/:id` and verify the oracle's resolve signature instead.
   */
  readonly txId: string | null;
  /** When it happened, ISO-8601. Lets a reader match a source to a window. */
  readonly at: string;
}

export interface LeaderboardEntry {
  readonly address: string;
  readonly identity?: { readonly address: string; readonly displayName: string; readonly bnsName: string | null };
  /** `freeDungeonsCompleted + paidDungeonsCompleted`, published for convenience. */
  readonly dungeonsCompleted: number;
  /**
   * The two halves of the total, kept separate because they are weighted
   * differently and because a reader recomputing `score` needs them apart.
   */
  readonly freeDungeonsCompleted: number;
  readonly paidDungeonsCompleted: number;
  readonly jackpotsWon: number;
  readonly highestForgeTier: number;
  /**
   * `leaderboardScore()` applied to the four counts above.
   *
   * Published beside its inputs on purpose: the function is exported from
   * `@grimhallow/shared`, so this number is checkable rather than assertable.
   */
  readonly score: number;
  /**
   * Sources so an entry can be spot-checked. Newest first, and capped — this is
   * evidence a reader can follow, not a full audit log.
   */
  readonly sources: readonly LeaderboardSource[];
}

export type LeaderboardWindow = 'all' | '30d' | '7d';

export interface LeaderboardResponse {
  readonly window: LeaderboardWindow;
  /** Ranked best-first. A reader's rank is their index + 1. */
  readonly entries: readonly LeaderboardEntry[];
  /**
   * The scoring table's version, so a stored screenshot of a ranking can be
   * matched to the weights that produced it.
   */
  readonly algoVersion: string;
  /**
   * When the underlying index was last recomputed, ISO-8601.
   *
   * Published rather than hidden because the table is a materialized view: a
   * player who just finished a run and doesn't see it yet is looking at a
   * staleness figure, not at a lost run.
   */
  readonly computedAt: string;
}

// ---------------------------------------------------------------------------
// Errors — 04-backend-api-spec.md#10
// ---------------------------------------------------------------------------

export interface ApiError {
  readonly error: { readonly code: string; readonly message: string };
}

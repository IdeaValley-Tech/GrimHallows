/**
 * The encounter engine — pure, deterministic, versioned.
 *
 *   runEncounter(seed, setup, playerActions) -> { turns, view }
 *
 * Combat rules are 01-game-design.md#5: an attack is `d20 + stat modifier` against
 * a target's Defense DC of `10 + VIT/2`, damage is the power's dice formula plus
 * the same modifier, and turn order is `d20 + AGI modifier` rolled once per
 * combatant at the start of the encounter.
 *
 * EVERY value here comes from `dice.ts`, i.e. from `hash(seed || i)`. Nothing in
 * this file calls `Math.random()`, reads the clock, or trusts a number from a
 * client: which monsters appear, who acts first, whether an attack lands, and how
 * hard it lands are all outcomes, and outcomes come from the committed seed
 * (02-architecture.md#5).
 *
 * WHY THIS IS A REPLAY FUNCTION RATHER THAN A MUTABLE STATE MACHINE
 *
 * The whole encounter is recomputed from `(seed, setup, actions)` on every call.
 * That makes the stored state of a run *only* its list of player actions — there
 * is no HP number persisted anywhere that could drift from what the dice say, and
 * a player handed the revealed seed and the action log can run this exact
 * function and get byte-identical results. A mutable server-side state blob would
 * be faster and strictly less checkable.
 *
 * If `actions` runs out while it is a party member's turn, the encounter stops
 * there: that is the "awaiting input" state, not an error.
 *
 * Versioned. Changing a rule below changes every historical run's verification,
 * so bump ENCOUNTER_ALGO_VERSION rather than editing a rule in place.
 *
 * The test of that rule is observable equivalence, not whether a line moved.
 * Power-up support edited `effectiveDc`, `resolveTurn` and `toView` and did NOT
 * bump the version, because an empty loadout — which is what every run recorded
 * under `encounter-v1` has — replays byte-identically, turns and view alike.
 * That claim is pinned by 'changes nothing at all when nothing is equipped' in
 * the test suite rather than left to argument, and it is the standard to hold a
 * future edit to: if you cannot write that test for your change, bump.
 *
 * ARCHETYPES held the version at v1 by the same standard, and the equivalence is
 * broader, so it is worth stating what was checked:
 *
 *   - `powerUpTiers: number[]` became `powerUpItems: EquippedItem[]`, and a
 *     stored setup carrying the old field is normalized to `relic` items on read.
 *     `relic`'s per-tier vectors are byte-identical to the pre-archetype table,
 *     so a replayed historical run rolls the same dice.
 *   - The new `maxHp` addend is `powerUpMaxHpBonus(items)`, and `relic` grants no
 *     maxHp at any tier — so it is exactly 0 for every run that exists.
 *   - `MAX_TOTAL_DEFENSE_BONUS` is 9, which is exactly the old table's maximum
 *     (three tier-4 items at +3), so the clamp cannot fire on a historical
 *     loadout.
 *
 * Pinned by 'replays a legacy tier setup byte-identically'. NOT bumping is the
 * deliberate choice and not an omission: `toVerification` publishes the LIVE
 * constant rather than a per-run stored value, so a bump would relabel every
 * historical run as `encounter-v2` and assert it was resolved under rules that
 * did not exist when it ran — a worse verification defect than the one a bump
 * would prevent. Bumping this constant needs `runs.encounter_algo_version`
 * stored per run first.
 */

import {
  DERIVATION_INDEX,
  TURN_STRIDE,
  deriveValue,
  parseDiceFormula,
  rollDie,
  rollFormula,
  turnIndex,
} from './dice.js';
import { getEncounterTable, getMonster, type MonsterBlueprint } from './monsters.js';
import {
  applyPowerUps,
  grantedPowerIds,
  legacyItems,
  powerUpDefenseBonus,
  powerUpMaxHpBonus,
} from './powerUps.js';
import type { EquippedItem } from './lootArchetypes.js';
import type { DungeonPlan } from './dungeonPlan.js';
import { GUARD_DEFENSE_BONUS, classPowerIds, getPower } from './powers.js';
import { defenseDc, statModifier } from './stats.js';
import type {
  BaseStats,
  CharClass,
  CombatOutcome,
  CombatSide,
  CombatTurn,
  CombatantView,
  EncounterView,
  Power,
  TurnRolls,
} from './types.js';

export const ENCOUNTER_ALGO_VERSION = 'encounter-v1' as const;

/**
 * Hard cap on turns in one encounter.
 *
 * A stalemate is possible in principle — a party that only ever Guards — and an
 * unbounded loop in a pure function called on every request is a denial of
 * service waiting to happen. Hitting the cap resolves as a loss: the party
 * failed to clear the dungeon, which is what a loss means.
 */
export const MAX_TURNS = 200;

/** Minimum damage on a successful hit, so a landed blow always does something. */
const MIN_DAMAGE_ON_HIT = 1;

/** Derivation slots within one turn's stride. */
const SLOT_ATTACK = 0;
const SLOT_DAMAGE = 1;
/** Last slot in the stride, used for a monster's target choice. */
const SLOT_MONSTER_TARGET = TURN_STRIDE - 1;
/**
 * How many dice a single power may roll before it overruns its turn's stride.
 *
 * Exported so the power-up cap can be checked against it in a test rather than
 * kept in sync by comment: a legal loadout that overran this would abort a run
 * mid-combat, and the two constants live in different files.
 */
export const MAX_DAMAGE_DICE = SLOT_MONSTER_TARGET - SLOT_DAMAGE;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface PartyMemberSetup {
  /** Combatant id within the encounter. Conventionally `p0`, `p1`, … */
  readonly id: string;
  readonly address: string;
  readonly name: string;
  readonly charClass: CharClass;
  readonly stats: BaseStats;
  /**
   * Loot items equipped for this run, frozen at entry.
   *
   * Each item grants a dice-formula upgrade, a defense bonus, and a max-HP bonus
   * per `archetypeBonusVector(archetype, tier)`. The applied set is persisted
   * here so a verifier can reproduce the exact damage rolls this combatant dealt:
   * `applyPowerUps(base, items)` is deterministic, but only if you know which
   * items were active.
   *
   * WAS `powerUpTiers: readonly number[]`. A stored setup from before archetypes
   * still carries that field, and `fromRow` normalizes it on read — every token
   * minted then parses to `relic`, whose vectors are byte-identical to the old
   * tier table, so a historical run replays to the same turns and the same view.
   * That equivalence is what keeps `ENCOUNTER_ALGO_VERSION` at v1, and it is
   * pinned by a test rather than asserted here.
   */
  readonly powerUpItems: readonly EquippedItem[];
}

export interface EncounterSetup {
  readonly monsterTableId: string;
  readonly party: readonly PartyMemberSetup[];
  /** Present on runs committed after dungeon-plan-v1; absent on historical v1 rows. */
  readonly dungeonPlan?: DungeonPlan;
}

/**
 * A setup as a stored row actually holds it, which is not always today's shape.
 *
 * `encounter_setup_json` is written by whatever build was running at commit time
 * and never migrated, so it is a UNION over the history of `EncounterSetup` —
 * not the current interface. Typing a row as the current one would be a lie the
 * compiler happily enforces, and the failure would land in `runEncounter`,
 * replaying a stored fight with no loadout at all.
 *
 * Exactly one field has changed shape so far: a party member carried
 * `powerUpTiers: number[]` before archetypes and carries
 * `powerUpItems: EquippedItem[]` after.
 *
 * THIS LIVES IN `shared`, NOT IN THE API, AND THAT IS THE POINT. These bytes are
 * published verbatim in `VerificationData.setup` because they are what the
 * oracle's transcript hash was taken over — so an outside verifier holds this
 * shape, not the normalized one, and needs the same declared way to run it that
 * we use. A stored-shape type private to the backend would leave them reverse
 * engineering the normalization from a hash mismatch.
 */
export interface StoredPartyMemberSetup
  extends Omit<PartyMemberSetup, 'powerUpItems'> {
  readonly powerUpItems?: PartyMemberSetup['powerUpItems'];
  /** Pre-archetype loadout. Present only on runs committed before Phase 4. */
  readonly powerUpTiers?: readonly number[];
}

export interface StoredEncounterSetup extends Omit<EncounterSetup, 'party'> {
  readonly party: readonly StoredPartyMemberSetup[];
}

/**
 * Bring a stored setup up to the shape `runEncounter` takes.
 *
 * THE ONLY REASON THIS IS A NO-OP ON HISTORY: every token minted before
 * archetypes existed carries a `tier-N.json` uri, which `parseLootUri` reads as
 * `relic`, and `relic`'s per-tier vector is byte-identical to the `powerup-v1`
 * table those runs were resolved under. So `legacyItems` is not a guess about
 * what an old loadout meant — it is the same normalization a re-read of the
 * chain would now produce for the same tokens, and
 * `'replays a legacy tier setup byte-identically'` below is what pins it.
 *
 * That is also what keeps `ENCOUNTER_ALGO_VERSION` at v1. If this function ever
 * has to do something a re-read of the chain would not do, the version has to be
 * bumped — and stored per run first, for the reason in this file's header.
 *
 * It is deliberately NOT folded into `runEncounter`. The engine takes a setup
 * that already means one thing; a normalizing engine would accept two spellings
 * of a loadout and make "what was this fight built from" answerable two ways.
 */
export function normalizeStoredSetup(setup: StoredEncounterSetup): EncounterSetup;
export function normalizeStoredSetup(setup: null): null;
export function normalizeStoredSetup(
  setup: StoredEncounterSetup | null,
): EncounterSetup | null;
export function normalizeStoredSetup(
  setup: StoredEncounterSetup | null,
): EncounterSetup | null {
  if (setup === null) return null;

  // Every member is rebuilt, including already-migrated ones, rather than
  // returning the row untouched when nothing needs converting. A "does anything
  // need work" fast path cannot be written here: `Array.prototype.some` is not a
  // type guard, so the compiler still sees the wide stored type on the other
  // side of it and the narrowing has to be redone anyway. Rebuilding
  // unconditionally also strips `powerUpTiers` from a mixed row, so no consumer
  // downstream can read the stale half of a member that has both.
  return {
    ...setup,
    party: setup.party.map((member): PartyMemberSetup => {
      const { powerUpTiers, powerUpItems, ...rest } = member;
      return { ...rest, powerUpItems: powerUpItems ?? legacyItems(powerUpTiers ?? []) };
    }),
  };
}

/** One submitted player action. `targetId` is required for an attack. */
export interface PlayerAction {
  readonly powerId: string;
  readonly targetId: string | null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type EncounterErrorCode =
  | 'UNSUPPORTED_ENCOUNTER_VERSION'
  | 'UNKNOWN_MONSTER_TABLE'
  | 'EMPTY_PARTY'
  | 'UNKNOWN_POWER'
  | 'POWER_NOT_IN_KIT'
  | 'POWER_ON_COOLDOWN'
  | 'POWER_OUT_OF_CHARGES'
  | 'INVALID_TARGET'
  | 'ENCOUNTER_ALREADY_RESOLVED';

/**
 * A rejected action, carrying the code the API maps to an error response.
 *
 * These are player mistakes or stale clients — a power that isn't in your kit, a
 * target that's already down — not server faults. They surface as 4xx and leave
 * the run exactly as it was.
 */
export class EncounterError extends Error {
  constructor(
    readonly code: EncounterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EncounterError';
  }
}

// ---------------------------------------------------------------------------
// Internal working state (never leaves this module)
// ---------------------------------------------------------------------------

interface Fighter {
  readonly id: string;
  readonly side: CombatSide;
  readonly name: string;
  readonly address: string | null;
  readonly stats: BaseStats;
  readonly powerIds: readonly string[];
  readonly powerUpItems: readonly EquippedItem[];
  readonly initiative: number;
  readonly maxHp: number;
  hp: number;
  guarding: boolean;
  cooldowns: Record<string, number>;
  /**
   * Uses left, for powers that declare a limit. Unlimited powers never appear.
   *
   * Seeded once in `buildFighters` from `Power.charges` and decremented on use.
   * A missing key means unlimited, not zero — which is why every read goes
   * through `chargesLeft` rather than indexing this directly.
   */
  charges: Record<string, number>;
}

/**
 * Uses left for a power, or null when it has no limit.
 *
 * The distinction the map alone cannot make: `charges[id]` is `undefined` both
 * for a power that never runs out and for one that has been spent down, and
 * treating those the same either grounds every class attack or makes potions
 * infinite.
 */
function chargesLeft(fighter: Fighter, chosen: Power): number | null {
  return chosen.charges === null ? null : (fighter.charges[chosen.id] ?? 0);
}

function power(id: string): Power {
  const found = getPower(id);
  if (!found) throw new EncounterError('UNKNOWN_POWER', `No such power: "${id}"`);
  return found;
}

const living = (f: Fighter) => f.hp > 0;

// ---------------------------------------------------------------------------
// Composition — which monsters, drawn from the seed
// ---------------------------------------------------------------------------

/**
 * Draw the monster roster for a table from the seed.
 *
 * Exported because it's worth being able to check a roster on its own: given the
 * revealed seed and the table id, anybody can confirm the party wasn't quietly
 * handed an easier or harder fight than the dice called for.
 */
export function drawMonsters(
  seed: string | Uint8Array,
  monsterTableId: string,
): readonly MonsterBlueprint[] {
  const table = getEncounterTable(monsterTableId);
  if (!table) {
    throw new EncounterError(
      'UNKNOWN_MONSTER_TABLE',
      `No encounter table for monster table id "${monsterTableId}"`,
    );
  }

  const span = table.maxMonsters - table.minMonsters + 1;
  const count = table.minMonsters + deriveValue(seed, DERIVATION_INDEX.COMPOSITION_BASE, span);

  const roster: MonsterBlueprint[] = [];
  for (let i = 0; i < count; i++) {
    const pick = deriveValue(seed, DERIVATION_INDEX.COMPOSITION_BASE + 1 + i, table.pool.length);
    const blueprint = getMonster(table.pool[pick]);
    // Unreachable unless a table references a deleted monster. Failing loudly
    // beats a short-handed encounter that looks intentional.
    if (!blueprint) {
      throw new Error(
        `Encounter table "${monsterTableId}" references unknown monster "${table.pool[pick]}"`,
      );
    }
    roster.push(blueprint);
  }
  return roster;
}

/**
 * Display names for a roster, suffixed only where a blueprint repeats.
 *
 * Two identically-named monsters the player can't tell apart is a targeting bug
 * waiting to be reported; a lone one shouldn't be called "Crypt Rat A".
 */
function displayNames(roster: readonly MonsterBlueprint[]): readonly string[] {
  const totals = new Map<string, number>();
  for (const m of roster) totals.set(m.id, (totals.get(m.id) ?? 0) + 1);

  const seen = new Map<string, number>();
  return roster.map((m) => {
    if ((totals.get(m.id) ?? 0) < 2) return m.name;
    const n = (seen.get(m.id) ?? 0) + 1;
    seen.set(m.id, n);
    return `${m.name} ${String.fromCharCode(64 + n)}`;
  });
}

// ---------------------------------------------------------------------------
// Roster & initiative
// ---------------------------------------------------------------------------

/** `d20 + AGI modifier`, per 01-game-design.md#5. */
function initiativeFor(seed: string | Uint8Array, ordinal: number, stats: BaseStats): number {
  return rollDie(seed, DERIVATION_INDEX.INITIATIVE_BASE + ordinal, 20) + statModifier(stats.agi);
}

/**
 * Opening charge counts for a kit, keyed by power id.
 *
 * Only limited powers get an entry, so this is `{}` for every class kit and for
 * every monster — which is the same empty object the field held before charges
 * existed, and part of why nothing historical changes.
 *
 * Two copies of the same potion do NOT stack their charges: `grantedPowerIds`
 * dedupes, so equipping two tier-1 elixirs grants one draught. Wearing the same
 * flask twice does not refill it.
 */
function initialCharges(powerIds: readonly string[]): Record<string, number> {
  const charges: Record<string, number> = {};
  for (const id of powerIds) {
    const p = getPower(id);
    if (p && p.charges !== null) charges[id] = p.charges;
  }
  return charges;
}

function buildFighters(seed: string | Uint8Array, setup: EncounterSetup): Fighter[] {
  if (setup.party.length === 0) {
    throw new EncounterError('EMPTY_PARTY', 'An encounter needs at least one party member');
  }

  const roster = drawMonsters(seed, setup.monsterTableId);
  const names = displayNames(roster);

  // An ordinal *is* the initiative derivation index, so it has to be a stable
  // function of position: party members in the order given, then monsters in
  // draw order. Reordering this reorders history.
  const fighters: Fighter[] = setup.party.map((member, i) => {
    // Added to BOTH maxHp and starting hp, so a tank walks in at full health
    // rather than at a fraction of a larger pool — and so HP stays monotonically
    // non-increasing everywhere, which the view and the outcome check rely on.
    // Zero for every historical run: `relic` grants no maxHp at any tier.
    const hpBonus = powerUpMaxHpBonus(member.powerUpItems);
    // Kit first, then whatever the loadout grants, deduped and in loadout order
    // by `grantedPowerIds`. Appending rather than interleaving keeps the three
    // kit buttons in the fixed positions the combat UI lays them out in, so a
    // player who equips a potion does not find Guard moving.
    //
    // Empty for every run committed before archetypes: `relic` grants nothing,
    // and a legacy `powerUpTiers` row normalizes to relics. That is what keeps
    // this change invisible to `ENCOUNTER_ALGO_VERSION`.
    const powerIds = [...classPowerIds(member.charClass), ...grantedPowerIds(member.powerUpItems)];
    return {
      id: member.id,
      side: 'party' as const,
      name: member.name,
      address: member.address,
      stats: member.stats,
      powerIds,
      powerUpItems: member.powerUpItems,
      initiative: initiativeFor(seed, i, member.stats),
      maxHp: member.stats.hp + hpBonus,
      hp: member.stats.hp + hpBonus,
      guarding: false,
      cooldowns: {},
      charges: initialCharges(powerIds),
    };
  });

  roster.forEach((blueprint, i) => {
    fighters.push({
      id: `m${i}`,
      side: 'monsters',
      name: names[i],
      address: null,
      stats: blueprint.stats,
      powerIds: [blueprint.powerId],
      powerUpItems: [],
      initiative: initiativeFor(seed, setup.party.length + i, blueprint.stats),
      maxHp: blueprint.stats.hp,
      hp: blueprint.stats.hp,
      guarding: false,
      cooldowns: {},
      charges: {},
    });
  });

  return fighters;
}

/**
 * Turn order: highest initiative first.
 *
 * Ties break by AGI, then by build ordinal — never by anything ambient. Two
 * combatants tied on both must still order identically on every replay, or the
 * log diverges from that tie onward and verification fails on a correct run.
 */
function initiativeOrder(fighters: readonly Fighter[]): readonly string[] {
  return fighters
    .map((f, ordinal) => ({ f, ordinal }))
    .sort(
      (a, b) =>
        b.f.initiative - a.f.initiative ||
        b.f.stats.agi - a.f.stats.agi ||
        a.ordinal - b.ordinal,
    )
    .map(({ f }) => f.id);
}

// ---------------------------------------------------------------------------
// Turn resolution
// ---------------------------------------------------------------------------

function effectiveDc(target: Fighter): number {
  const base = defenseDc(target.stats);
  const powerUpBonus = powerUpDefenseBonus(target.powerUpItems);
  const guardBonus = target.guarding ? GUARD_DEFENSE_BONUS : 0;
  return base + powerUpBonus + guardBonus;
}

function resolveTurn(
  seed: string | Uint8Array,
  turnNumber: number,
  actor: Fighter,
  chosen: Power,
  target: Fighter | null,
): CombatTurn {
  const common = {
    turnNumber,
    actorId: actor.id,
    actorName: actor.name,
    actorAddress: actor.address,
    powerId: chosen.id,
    powerName: chosen.name,
    derivationIndex: turnIndex(turnNumber, SLOT_ATTACK),
  } as const;

  if (chosen.kind === 'guard') {
    actor.guarding = true;
    return {
      ...common,
      action: 'guard',
      targetId: null,
      targetName: null,
      // A Guard rolls nothing. The acting combatant's initiative is still
      // reported — 04-backend-api-spec.md#5 lists it per turn — but there is
      // deliberately no invented attack die here to fill the gap.
      rolls: { initiative: actor.initiative },
      damageDealt: 0,
      targetHpAfter: null,
      defeated: false,
    };
  }

  if (chosen.kind === 'heal') {
    // Placed before the target check on purpose: a heal is self-only, so it must
    // not be rejected for lacking a target it never needed.
    //
    // SELF-ONLY, and that is a scope decision rather than a limitation. The party
    // is built one member long (`combatService.ts`), so a heal aimed at an ally
    // is unreachable code — and unreachable code that resolves a target is how a
    // future party build gets a silently wrong `INVALID_TARGET` semantics. When
    // parties grow, this is the branch that learns to take a target, and the
    // action log already records enough to tell the two apart.
    //
    // Parsed straight off the power, NEVER through `applyPowerUps`. An equipped
    // sword's `flatDamage` is damage; routing a heal through the damage upgrade
    // would let a weapon amplify a potion, which is both absurd and a real
    // balance hole given `flatDamage` is the one uncapped axis.
    const formula = parseDiceFormula(chosen.diceFormula!);
    // Same slots a damage roll would have used. A turn is exactly one of attack,
    // guard or heal, so within a turn only one of these branches consumes them —
    // and `turnIndex` already keeps turns from colliding with each other. No new
    // reserved indices, and `TURN_STRIDE` is unchanged.
    const heal = rollFormula(seed, turnIndex(turnNumber, SLOT_DAMAGE), formula);
    // No stat modifier: it is the flask that heals, not the drinker.
    //
    // The clamp is required, not defensive. Without it `toView` reports hp above
    // maxHp and the health bar overruns its track.
    actor.hp = Math.min(actor.maxHp, actor.hp + heal.total);

    return {
      ...common,
      action: 'heal',
      // The actor is the target. Reusing the field rather than leaving it null
      // means a client renders "X drinks, X is healed" from the same shape it
      // already uses, and `targetHpAfter` below needs no special case.
      targetId: actor.id,
      targetName: actor.name,
      rolls: { initiative: actor.initiative, healRoll: heal.total, healDice: heal.dice },
      // Zero, and not negative damage. `damageDealt` is what a fight's damage
      // totals sum over, and a heal that registered there would net out against
      // a hit somewhere else in the log.
      damageDealt: 0,
      targetHpAfter: actor.hp,
      // A heal cannot defeat anyone, and a downed fighter never gets a turn to
      // drink one — so this is false by construction, not by luck.
      defeated: false,
    };
  }

  if (!target) {
    throw new EncounterError('INVALID_TARGET', `"${chosen.name}" needs a target`);
  }

  const mod = statModifier(actor.stats[chosen.stat]);
  const attackDie = rollDie(seed, turnIndex(turnNumber, SLOT_ATTACK), 20);
  const attackRoll = attackDie + mod;
  const dc = effectiveDc(target);
  const hit = attackRoll >= dc;

  const rolls: TurnRolls = {
    initiative: actor.initiative,
    attackRoll,
    attackDice: [attackDie],
    targetDc: dc,
    hit,
  };

  if (!hit) {
    return {
      ...common,
      action: 'attack',
      targetId: target.id,
      targetName: target.name,
      rolls,
      damageDealt: 0,
      targetHpAfter: target.hp,
      defeated: false,
    };
  }

  // Non-null by construction: every attack power carries a formula, and
  // powers.ts is the only source of powers.
  const upgraded = applyPowerUps(chosen.diceFormula!, actor.powerUpItems);
  const formula = parseDiceFormula(upgraded ?? chosen.diceFormula!);
  if (formula.count > MAX_DAMAGE_DICE) {
    throw new Error(
      `Power "${chosen.id}" rolls ${formula.count} dice, which overruns its turn's derivation stride`,
    );
  }

  const damage = rollFormula(seed, turnIndex(turnNumber, SLOT_DAMAGE), formula, mod);
  const dealt = Math.max(MIN_DAMAGE_ON_HIT, damage.total);
  target.hp = Math.max(0, target.hp - dealt);

  return {
    ...common,
    action: 'attack',
    targetId: target.id,
    targetName: target.name,
    rolls: { ...rolls, damageRoll: damage.total, damageDice: damage.dice },
    damageDealt: dealt,
    targetHpAfter: target.hp,
    defeated: target.hp === 0,
  };
}

/**
 * A monster's target, derived from the seed rather than from a heuristic.
 *
 * Monsters carry one power each in the MVP kit, so the only decision is who to
 * hit. Deriving it keeps the choice both unpredictable to the player and
 * reproducible by anyone checking the log: an "always hit the weakest" rule
 * would be predictable, and a `Math.random()` one would be unverifiable.
 */
function monsterTarget(
  seed: string | Uint8Array,
  turnNumber: number,
  candidates: readonly Fighter[],
): Fighter {
  return candidates[
    deriveValue(seed, turnIndex(turnNumber, SLOT_MONSTER_TARGET), candidates.length)
  ];
}

/**
 * Start-of-turn upkeep: a Guard lasts until its owner's next turn, and a
 * cooldown ticks once per that combatant's *own* turns — not once per global
 * turn, or a four-monster fight would burn a player's cooldown five times faster
 * than a solo one would.
 */
function startTurn(actor: Fighter): void {
  actor.guarding = false;
  for (const [id, remaining] of Object.entries(actor.cooldowns)) {
    if (remaining > 0) actor.cooldowns[id] = remaining - 1;
  }
}

/**
 * A power as this combatant will actually roll it.
 *
 * The equipped bonus is folded into the formula rather than shown beside it,
 * because this field is what the combat UI prints on the button and what the
 * player reads before choosing. A screen promising 1d8 for a swing the resolver
 * rolls as 2d12+3 would make the dice illegible in exactly the way
 * 01-game-design.md#5 is trying to avoid — and legibility is the whole argument
 * for expressing bonuses on the die in the first place.
 *
 * `defenseDc` above is already reported this way, for the same reason.
 *
 * A heal is returned untouched. Its formula is healing, and `applyPowerUps` adds
 * weapon damage — printing an equipped sword's flat bonus on a potion button
 * would advertise a heal the resolver will not roll, which is the same
 * illegibility this function exists to prevent.
 */
function powerAsRolled(f: Fighter, id: string): Power {
  const base = power(id);
  if (base.kind === 'heal' || f.powerUpItems.length === 0) return base;
  const upgraded = applyPowerUps(base.diceFormula, f.powerUpItems);
  return upgraded === base.diceFormula ? base : { ...base, diceFormula: upgraded };
}

function toView(f: Fighter): CombatantView {
  return {
    id: f.id,
    side: f.side,
    name: f.name,
    address: f.address,
    stats: f.stats,
    hp: f.hp,
    maxHp: f.maxHp,
    defenseDc: effectiveDc(f),
    guarding: f.guarding,
    initiative: f.initiative,
    powers: f.powerIds.map((id) => powerAsRolled(f, id)),
    cooldowns: { ...f.cooldowns },
    charges: { ...f.charges },
  };
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export interface EncounterResult {
  /** Every turn taken, party and monster alike, in the order they happened. */
  readonly turns: readonly CombatTurn[];
  readonly view: EncounterView;
}

/** Replay using the rules frozen on the run, never the rules current at read time. */
export function runEncounterVersioned(
  algoVersion: string,
  seed: string | Uint8Array,
  setup: EncounterSetup,
  actions: readonly PlayerAction[] = [],
): EncounterResult {
  switch (algoVersion) {
    case 'encounter-v1':
      return runEncounter(seed, setup, actions);
    default:
      throw new EncounterError(
        'UNSUPPORTED_ENCOUNTER_VERSION',
        `Unsupported encounter algorithm version "${algoVersion}"`,
      );
  }
}

export function runEncounter(
  seed: string | Uint8Array,
  setup: EncounterSetup,
  actions: readonly PlayerAction[] = [],
): EncounterResult {
  const fighters = buildFighters(seed, setup);
  const order = initiativeOrder(fighters);
  const byId = new Map(fighters.map((f) => [f.id, f]));

  const partyDown = () => fighters.every((f) => f.side !== 'party' || !living(f));
  const monstersDown = () => fighters.every((f) => f.side !== 'monsters' || !living(f));

  const turns: CombatTurn[] = [];
  let outcome: CombatOutcome | null = null;
  let turnNumber = 1;
  let cursor = -1;
  let actionIndex = 0;
  /** Whose turn it is when the loop stops, or null once it has ended. */
  let activeCombatantId: string | null = null;

  while (turnNumber <= MAX_TURNS) {
    if (monstersDown()) {
      outcome = 'win';
      break;
    }
    if (partyDown()) {
      outcome = 'loss';
      break;
    }

    // Advance to the next living combatant in initiative order. Bounded by
    // order.length, and at least one fighter is alive by the checks above.
    let actor: Fighter | null = null;
    for (let step = 0; step < order.length; step++) {
      cursor = (cursor + 1) % order.length;
      const candidate = byId.get(order[cursor])!;
      if (living(candidate)) {
        actor = candidate;
        break;
      }
    }
    if (!actor) break;

    let chosen: Power;
    let target: Fighter | null = null;

    if (actor.side === 'party') {
      if (actionIndex >= actions.length) {
        // Out of submitted actions — this is the awaiting-input state. The
        // cursor stays put and no upkeep runs, because nothing has happened
        // yet: this same turn gets resolved for real on the next submission.
        activeCombatantId = actor.id;
        break;
      }

      const submitted = actions[actionIndex++];
      chosen = power(submitted.powerId);
      if (!actor.powerIds.includes(chosen.id)) {
        throw new EncounterError(
          'POWER_NOT_IN_KIT',
          `"${chosen.name}" is not one of ${actor.name}'s powers`,
        );
      }

      // Checked *before* upkeep ticks it down, so `cooldown: 3` means three of
      // this combatant's own turns pass before the power comes back — not two.
      const cooling = actor.cooldowns[chosen.id] ?? 0;
      if (cooling > 0) {
        throw new EncounterError(
          'POWER_ON_COOLDOWN',
          `"${chosen.name}" is on cooldown for ${cooling} more turn(s)`,
        );
      }
      // Same reason this sits above `startTurn` as the cooldown does: a refused
      // action must leave the encounter exactly as it was, or a client that
      // retries after an error replays a fight whose Guard has already lapsed.
      //
      // A separate code from the cooldown because the two are not the same
      // answer to the player: a cooldown says "not yet", a spent charge says
      // "not again this dungeon", and a client that showed a wait timer for the
      // second would be promising a potion that is never coming back.
      const uses = chargesLeft(actor, chosen);
      if (uses !== null && uses <= 0) {
        throw new EncounterError(
          'POWER_OUT_OF_CHARGES',
          `"${chosen.name}" has no uses left in this dungeon`,
        );
      }
      startTurn(actor);

      if (chosen.kind === 'attack') {
        const candidate = submitted.targetId ? byId.get(submitted.targetId) : undefined;
        if (!candidate || candidate.side !== 'monsters' || !living(candidate)) {
          throw new EncounterError(
            'INVALID_TARGET',
            `"${submitted.targetId ?? 'none'}" is not a living enemy in this encounter`,
          );
        }
        target = candidate;
      }
    } else {
      startTurn(actor);
      chosen = power(actor.powerIds[0]);
      if (chosen.kind === 'attack') {
        target = monsterTarget(
          seed,
          turnNumber,
          fighters.filter((f) => f.side === 'party' && living(f)),
        );
      }
    }

    turns.push(resolveTurn(seed, turnNumber, actor, chosen, target));
    if (chosen.cooldown > 0) actor.cooldowns[chosen.id] = chosen.cooldown;
    // Spent only once the turn has actually resolved. Decrementing above the
    // push would charge the player for a turn that threw on its way out.
    if (chosen.charges !== null) {
      actor.charges[chosen.id] = (actor.charges[chosen.id] ?? 0) - 1;
    }
    turnNumber++;
  }

  // Stalemate. Recorded as a loss rather than left open, so a run can never sit
  // permanently un-resolvable.
  if (!outcome && turnNumber > MAX_TURNS) {
    outcome = 'loss';
    activeCombatantId = null;
  }

  return {
    turns,
    view: {
      monsterTableId: setup.monsterTableId,
      turnNumber,
      activeCombatantId: outcome ? null : activeCombatantId,
      order,
      combatants: fighters.map(toView),
      outcome,
      algoVersion: ENCOUNTER_ALGO_VERSION,
    },
  };
}

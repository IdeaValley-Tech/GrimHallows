/**
 * Seed-derived dice, per 03-smart-contracts-spec.md#5.
 *
 *   value_i = hash(seed || i) % range
 *
 * CRITICAL — every value that affects an outcome or a payout MUST come from
 * here. Never `Math.random()`, never a client-supplied value, never block-time
 * entropy (see 02-architecture.md#5). This module is the single implementation
 * shared by the backend and any verification tooling: a player must be able to
 * recompute every roll from the publicly revealed seed and get identical
 * results, which only holds if there is exactly one implementation.
 *
 * Pure and versioned. Changing derivation changes historical verifiability, so
 * bump DICE_ALGO_VERSION rather than editing a rule in place.
 */

import { sha256 } from '@noble/hashes/sha2';

export const DICE_ALGO_VERSION = 'dice-v1' as const;

/**
 * Reserved derivation indices. Each `i` must be unique within a run, or two
 * different rolls would collide onto the same value.
 */
export const DERIVATION_INDEX = {
  /** Initiative rolls: INITIATIVE_BASE + combatant ordinal. */
  INITIATIVE_BASE: 0,
  /**
   * Encounter composition: how many monsters, and which ones.
   * COMPOSITION_BASE is the count draw; +1+n picks the nth monster.
   *
   * Composition decides whether a run is winnable, which makes it an outcome,
   * which means it comes from the seed like everything else.
   */
  COMPOSITION_BASE: 500,
  /** Versioned dungeon plan: wave count, enemy count, and ordered enemy picks. */
  DUNGEON_PLAN_BASE: 600,
  /** Per-turn rolls start here; see turnIndex(). */
  TURN_BASE: 1_000,
  /** The paid-dungeon reward-table draw. */
  REWARD_DRAW: 999_999,
  /**
   * Which loot tier a `loot` reward mints at.
   *
   * A separate index from REWARD_DRAW on purpose: reusing one draw for both
   * "did you win loot" and "how good is it" correlates the two, so the tier
   * would stop being independent of how narrowly the jackpot was missed.
   */
  REWARD_TIER_DRAW: 999_998,
} as const;

/** Stride per turn, so attack/damage dice within one turn never collide. */
export const TURN_STRIDE = 16;

export type DiceSides = 4 | 6 | 8 | 10 | 12 | 20;

export interface DiceFormula {
  /** Number of dice, e.g. 2 in `2d8`. */
  readonly count: number;
  /** Sides per die, e.g. 8 in `2d8`. */
  readonly sides: DiceSides;
  /** Flat modifier baked into the formula (stat mods are applied separately). */
  readonly modifier: number;
}

function normalizeSeed(seed: string | Uint8Array): Uint8Array {
  if (typeof seed !== 'string') return seed;
  const hex = seed.startsWith('0x') ? seed.slice(2) : seed;
  if (hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error(`Seed must be a hex string with an even length; got "${seed}"`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Big-endian u32 encoding of the derivation index, appended to the seed. */
function encodeIndex(index: number): Uint8Array {
  if (!Number.isInteger(index) || index < 0 || index > 0xff_ff_ff_ff) {
    throw new Error(`Derivation index must be a u32; got ${index}`);
  }
  return new Uint8Array([
    (index >>> 24) & 0xff,
    (index >>> 16) & 0xff,
    (index >>> 8) & 0xff,
    index & 0xff,
  ]);
}

/** `hash(seed || i)` — the raw derivation primitive. */
export function deriveHash(seed: string | Uint8Array, index: number): Uint8Array {
  const seedBytes = normalizeSeed(seed);
  const indexBytes = encodeIndex(index);
  const buf = new Uint8Array(seedBytes.length + indexBytes.length);
  buf.set(seedBytes, 0);
  buf.set(indexBytes, seedBytes.length);
  return sha256(buf);
}

/**
 * Uniform integer in [0, range) from `hash(seed || i)`.
 *
 * Uses the leading 8 bytes as a big-endian integer. Modulo bias is negligible
 * here (2^64 mod 20 over a 64-bit space) and, more importantly, matching the
 * spec's plain `% range` keeps the value independently recomputable by anyone
 * with a hex-and-modulo implementation — a rejection-sampling scheme would be
 * harder for a player to verify by hand.
 */
export function deriveValue(seed: string | Uint8Array, index: number, range: number): number {
  if (!Number.isInteger(range) || range <= 0) {
    throw new Error(`Range must be a positive integer; got ${range}`);
  }
  const digest = deriveHash(seed, index);
  let acc = 0n;
  for (let i = 0; i < 8; i++) acc = (acc << 8n) | BigInt(digest[i]);
  return Number(acc % BigInt(range));
}

/** A single die roll in [1, sides]. */
export function rollDie(seed: string | Uint8Array, index: number, sides: DiceSides): number {
  return deriveValue(seed, index, sides) + 1;
}

/** Unique derivation index for a turn's Nth roll. */
export function turnIndex(turnNumber: number, slot = 0): number {
  if (!Number.isInteger(turnNumber) || turnNumber < 1) {
    throw new Error(`turnNumber must be >= 1; got ${turnNumber}`);
  }
  if (!Number.isInteger(slot) || slot < 0 || slot >= TURN_STRIDE) {
    throw new Error(`slot must be in [0, ${TURN_STRIDE}); got ${slot}`);
  }
  return DERIVATION_INDEX.TURN_BASE + turnNumber * TURN_STRIDE + slot;
}

export interface RollResult {
  /** Individual die faces, in derivation order. */
  readonly dice: readonly number[];
  /** Sum of faces, before any modifier. */
  readonly raw: number;
  /** Modifier applied on top of `raw`. */
  readonly modifier: number;
  /** `raw + modifier` — the value shown to the player. */
  readonly total: number;
}

/** Roll a formula, consuming one derivation slot per die. */
export function rollFormula(
  seed: string | Uint8Array,
  baseIndex: number,
  formula: DiceFormula,
  extraModifier = 0,
): RollResult {
  if (!Number.isInteger(formula.count) || formula.count < 1) {
    throw new Error(`Dice count must be >= 1; got ${formula.count}`);
  }
  const dice: number[] = [];
  for (let i = 0; i < formula.count; i++) {
    dice.push(rollDie(seed, baseIndex + i, formula.sides));
  }
  const raw = dice.reduce((a, b) => a + b, 0);
  const modifier = formula.modifier + extraModifier;
  return { dice, raw, modifier, total: raw + modifier };
}

/** Parse `2d8+3` / `1d6` / `1d6-1` into a DiceFormula. */
export function parseDiceFormula(input: string): DiceFormula {
  const m = /^\s*(\d+)d(\d+)\s*(?:([+-])\s*(\d+))?\s*$/i.exec(input);
  if (!m) throw new Error(`Malformed dice formula: "${input}"`);
  const count = Number.parseInt(m[1], 10);
  const sides = Number.parseInt(m[2], 10);
  if (![4, 6, 8, 10, 12, 20].includes(sides)) {
    throw new Error(`Unsupported die size d${sides} in "${input}"`);
  }
  const modifier = m[3] ? (m[3] === '-' ? -1 : 1) * Number.parseInt(m[4], 10) : 0;
  return { count, sides: sides as DiceSides, modifier };
}

export function formatDiceFormula(f: DiceFormula): string {
  const mod = f.modifier === 0 ? '' : f.modifier > 0 ? `+${f.modifier}` : `${f.modifier}`;
  return `${f.count}d${f.sides}${mod}`;
}

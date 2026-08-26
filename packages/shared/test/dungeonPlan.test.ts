import { describe, expect, it } from 'vitest';
import { buildDungeonPlan, DUNGEON_PLAN_VERSION } from '../src/dungeonPlan.js';

const SEED = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('buildDungeonPlan', () => {
  it('is deterministic and versioned', () => {
    const first = buildDungeonPlan(SEED, 'free', 'forsaken-crypt');
    expect(buildDungeonPlan(SEED, 'free', 'forsaken-crypt')).toEqual(first);
    expect(first.version).toBe(DUNGEON_PLAN_VERSION);
  });

  it('creates 2-3 free waves and 4-6 paid waves', () => {
    expect(buildDungeonPlan(SEED, 'free', 'forsaken-crypt').waves.length).toBeGreaterThanOrEqual(2);
    expect(buildDungeonPlan(SEED, 'free', 'forsaken-crypt').waves.length).toBeLessThanOrEqual(3);
    expect(buildDungeonPlan(SEED, 'paid', 'forsaken-crypt').waves.length).toBeGreaterThanOrEqual(4);
    expect(buildDungeonPlan(SEED, 'paid', 'forsaken-crypt').waves.length).toBeLessThanOrEqual(6);
  });

  it('orders enemies uniquely and scales later waves with integer stats', () => {
    const plan = buildDungeonPlan(SEED, 'paid', 'bloodfall-ruins');
    expect(plan.waves.flatMap((wave) => wave.enemies.map((enemy) => enemy.id))).toEqual(
      plan.waves.flatMap((wave) => wave.enemies.map((_, index) => `w${wave.index + 1}e${index + 1}`)),
    );
    for (const wave of plan.waves) {
      for (const enemy of wave.enemies) {
        expect(Object.values(enemy.stats).every(Number.isInteger)).toBe(true);
      }
    }
  });

  it('rejects an unknown monster table', () => {
    expect(() => buildDungeonPlan(SEED, 'free', 'missing')).toThrow(/No encounter table/);
  });
});

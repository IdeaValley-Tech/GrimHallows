import { DERIVATION_INDEX, deriveValue } from './dice.js';
import { getEncounterTable, getMonster } from './monsters.js';
import type { BaseStats } from './types.js';

export const DUNGEON_PLAN_VERSION = 'dungeon-plan-v1' as const;

export interface PlannedEnemy {
  readonly id: string;
  readonly blueprintId: string;
  readonly name: string;
  readonly powerId: string;
  readonly stats: BaseStats;
}

export interface DungeonWave {
  readonly index: number;
  readonly enemies: readonly PlannedEnemy[];
}

export interface DungeonPlan {
  readonly version: typeof DUNGEON_PLAN_VERSION;
  readonly dungeonType: 'free' | 'paid';
  readonly monsterTableId: string;
  readonly waves: readonly DungeonWave[];
}

const SCALE_PER_WAVE_PERMILLE = 125;
const PLAN_STRIDE = 16;

function scale(value: number, waveIndex: number): number {
  const permille = 1000 + waveIndex * SCALE_PER_WAVE_PERMILLE;
  return Math.max(1, Math.floor((value * permille) / 1000));
}

function scaleStats(stats: BaseStats, waveIndex: number): BaseStats {
  return {
    hp: scale(stats.hp, waveIndex),
    str: scale(stats.str, waveIndex),
    agi: scale(stats.agi, waveIndex),
    int: scale(stats.int, waveIndex),
    vit: scale(stats.vit, waveIndex),
  };
}

/** Build the complete immutable dungeon roster from the committed seed. */
export function buildDungeonPlan(
  seed: string | Uint8Array,
  dungeonType: 'free' | 'paid',
  monsterTableId: string,
): DungeonPlan {
  const table = getEncounterTable(monsterTableId);
  if (!table) throw new Error(`No encounter table for monster table id "${monsterTableId}"`);

  const minWaves = dungeonType === 'free' ? 2 : 4;
  const maxWaves = dungeonType === 'free' ? 3 : 6;
  const waveCount = minWaves + deriveValue(seed, DERIVATION_INDEX.DUNGEON_PLAN_BASE, maxWaves - minWaves + 1);
  const waves: DungeonWave[] = [];

  for (let waveIndex = 0; waveIndex < waveCount; waveIndex++) {
    const base = DERIVATION_INDEX.DUNGEON_PLAN_BASE + 1 + waveIndex * PLAN_STRIDE;
    const enemyCount = 1 + deriveValue(seed, base, 2);
    const enemies: PlannedEnemy[] = [];
    for (let enemyIndex = 0; enemyIndex < enemyCount; enemyIndex++) {
      const blueprintId = table.pool[deriveValue(seed, base + 1 + enemyIndex, table.pool.length)];
      const blueprint = getMonster(blueprintId);
      if (!blueprint) throw new Error(`Encounter table "${monsterTableId}" references unknown monster "${blueprintId}"`);
      enemies.push({
        id: `w${waveIndex + 1}e${enemyIndex + 1}`,
        blueprintId: blueprint.id,
        name: blueprint.name,
        powerId: blueprint.powerId,
        stats: scaleStats(blueprint.stats, waveIndex),
      });
    }
    waves.push({ index: waveIndex, enemies });
  }

  return { version: DUNGEON_PLAN_VERSION, dungeonType, monsterTableId, waves };
}

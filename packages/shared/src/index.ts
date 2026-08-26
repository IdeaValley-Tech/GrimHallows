/**
 * @grimhallow/shared — versioned pure functions + types shared by the API,
 * the web app, and any independent verification tooling.
 *
 * Nothing in this package may re-implement a rule that lives in another
 * module here: drift between two implementations breaks the
 * independently-verifiable property the architecture depends on.
 */

export * from './types.js';
export * from './contracts.js';
export * from './content.js';
export * from './dice.js';
export * from './rewards.js';
export * from './classes.js';
export * from './rarity.js';
export * from './stats.js';
export * from './powers.js';
export * from './powerUps.js';
export * from './lootArchetypes.js';
export * from './monsters.js';
export * from './encounter.js';
export * from './dungeonPlan.js';
export * from './leaderboard.js';

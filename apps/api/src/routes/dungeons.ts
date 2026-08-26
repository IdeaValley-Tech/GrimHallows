/**
 * Dungeon entry — 04-backend-api-spec.md#3.
 *
 *   POST /dungeons/:id/enter  body: { partyId, character: { contractId, tokenId } }
 *
 * `character` is not in 04-backend-api-spec.md#3's body, which lists only
 * `partyId`. It is here because the encounter engine takes a stat block as
 * input, stats are derived from `(contractId, tokenId)`, and nothing else binds a
 * character to a run that has no party. Party runs will read each member's NFT
 * from `party_members` instead.
 *
 * Two completely different things share this path, and the difference is the
 * whole economic model:
 *
 *   - **Free dungeon** (`:id` is a spawn uuid from `GET /map`). No money moves,
 *     so there is nothing to sign: the response is a run token and that's it
 *     (06-mvp-roadmap.md Phase 3). Free dungeons stay off-chain for MVP per the
 *     resolved open question in 07-glossary-and-open-questions.md#2.
 *   - **Paid dungeon** (`:id` is the on-chain dungeon id). 1 STX leaves the
 *     player's wallet and goes directly to the contract owner as revenue. The
 *     response is an *unsigned* `enter-dungeon` payload plus a plain-language
 *     disclosure. No run exists yet, and none will until the player signs and
 *     the transaction is mined.
 *
 * What this route never does, in either branch: hold funds, promise a refund,
 * or credit the sponsor pool. The sponsor pool is only ever credited by the
 * owner calling `fund-pool` (03-smart-contracts-spec.md#2). The paid payload's
 * post-condition — `sender sends exactly gateFee uSTX`, in deny mode — is what
 * makes that guarantee mechanical rather than a promise: a second STX movement
 * out of the player, of any size, aborts the transaction on chain.
 */

import type { FastifyInstance } from 'fastify';
import {
  PAID_DUNGEON_ID,
  type FreeEntryResponse,
  type NetworkConfig,
  type PaidEntryResponse,
} from '@grimhallow/shared';
import { requireSession } from '../lib/authGuard.js';
import { badRequest, conflict, notFound, notImplemented } from '../lib/errors.js';
import { issueRunToken } from '../lib/jwt.js';
import { resolveLoadout } from '../lib/loadout.js';
import { buildEnterDungeonTx } from '../lib/txBuilder.js';
import type { RunOracle } from '../oracle/runOracle.js';
import type { CharacterRef, RunStore } from '../repos/runs.js';
import type { SpawnStore } from '../repos/spawns.js';
import type { CombatService } from '../services/combatService.js';
import type { MapService } from '../services/mapService.js';
import type { PowerUpService } from '../services/powerUpService.js';
import type { PartyStore } from '../repos/parties.js';
import type { CharacterService } from '../services/characterService.js';

/**
 * How long a run token stays valid.
 *
 * Generous: it bounds an abandoned run rather than a live one, and a token
 * expiring mid-encounter would lose a player their progress for no security
 * gain — the token can't spend anything in the first place.
 */
export const RUN_TOKEN_TTL_SECONDS = 2 * 60 * 60;

/**
 * Shown before the wallet prompt, per 04-backend-api-spec.md#3: "the UI copy
 * should say plainly that this is an entry fee, not a wager, before the user
 * signs".
 *
 * Worded to close off the three things a player might otherwise assume: that
 * losing gets their money back, that paying more or paying at all improves
 * their odds, and that the fee is what they might win back.
 */
export const PAID_ENTRY_DISCLOSURE =
  'This is an entry fee, not a wager. It is paid to the game operator as ' +
  'revenue the moment your transaction is mined, and there is no refund — ' +
  'not on a loss, not on a disconnect, not on an abandoned run. It does not ' +
  'go into the prize pool and it does not change your odds of a reward. The ' +
  'prize pool is funded separately by the operator.';

export interface DungeonRouteDeps {
  readonly spawns: SpawnStore;
  readonly runs: RunStore;
  readonly oracle: RunOracle;
  readonly combat: CombatService;
  /** Reads the live gate fee and sponsor pool for a paid-entry quote. */
  readonly map: MapService;
  /** Verifies an equipped loadout against chain and reads its tiers. */
  readonly powerUps: PowerUpService;
  readonly parties: PartyStore;
  readonly characters: CharacterService;
  readonly stacks: NetworkConfig;
  readonly jwtSecret: string;
}

/**
 * Read the character being fielded.
 *
 * Required, and validated rather than defaulted: the encounter engine takes a
 * stat block as input, and stats are derived from `(contractId, tokenId)`. An
 * entry with no character is an entry we cannot build a fight for.
 */
function parseCharacter(value: unknown): CharacterRef {
  const c = (value ?? {}) as Record<string, unknown>;
  const contractId = typeof c.contractId === 'string' ? c.contractId.trim() : '';
  const tokenId =
    typeof c.tokenId === 'string'
      ? c.tokenId.trim()
      : typeof c.tokenId === 'number'
        ? String(c.tokenId)
        : '';

  if (!contractId.includes('.')) {
    throw badRequest(
      'INVALID_CHARACTER',
      'character.contractId must be a fully-qualified contract id (SP….name)',
    );
  }
  if (!/^\d+$/.test(tokenId)) {
    throw badRequest('INVALID_CHARACTER', 'character.tokenId must be a non-negative integer');
  }
  return { contractId, tokenId };
}

/**
 * Quote a paid entry and hand back a transaction to sign.
 *
 * Nothing is persisted here and no run row is created. The player has been given
 * a payload, not a run — they may never sign it, and a run that exists because
 * somebody looked at a price would be a run nobody paid for. The run comes into
 * existence when `enter-dungeon` is mined and the contract assigns it an id;
 * `commit-seed` follows that, against the id the chain gave.
 *
 * The fee is read live from `get-dungeon` on every quote rather than taken from
 * a constant. A gate fee the owner has changed on chain must not be quotable at
 * the old price — the post-condition would then abort the player's transaction
 * and cost them a network fee for our stale copy.
 */
async function buildPaidEntry(args: {
  deps: DungeonRouteDeps;
  dungeonId: number;
  address: string;
  body: { character?: unknown };
}): Promise<PaidEntryResponse> {
  const { deps, dungeonId, address, body } = args;

  if (dungeonId !== PAID_DUNGEON_ID) {
    // Only one paid dungeon exists in MVP. Refusing an unknown id here means a
    // caller cannot get us to build a payload against a dungeon whose fee and
    // terms we have not read.
    throw notFound('DUNGEON_NOT_FOUND', `No paid dungeon with id ${dungeonId}`);
  }

  // Character is validated before the chain read: a malformed request should
  // not cost an upstream call, and it should fail the same way it does on the
  // free path.
  const character = parseCharacter(body.character);

  // Throws 503 rather than defaulting if the chain is unreadable. A guessed
  // gate fee is a transaction the player signs for the wrong amount.
  const dungeon = await deps.map.requirePaidDungeon();

  const party = [address];
  const tx = buildEnterDungeonTx({
    stacks: deps.stacks,
    senderAddress: address,
    dungeonId,
    party,
    gateFeeUstx: BigInt(dungeon.gateFeeUstx),
  });

  return {
    dungeonType: 'paid',
    dungeonId,
    feeUstx: dungeon.gateFeeUstx,
    // Quoted, not promised: the pool moves independently of this player, and a
    // rolled jackpot bigger than it degrades per 03-smart-contracts-spec.md#3.
    sponsorPoolUstx: dungeon.sponsorPoolUstx,
    party,
    character,
    tx,
    disclosure: PAID_ENTRY_DISCLOSURE,
  };
}

export async function registerDungeonRoutes(
  app: FastifyInstance,
  deps: DungeonRouteDeps,
): Promise<void> {
  app.post('/dungeons/:id/enter', async (request) => {
    // Entry is attributed to an address, so it needs a session — but only a
    // session. No signature, no transaction, no fee: that is the point of a
    // free dungeon.
    const session = requireSession(request, deps.jwtSecret);

    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      partyId?: unknown;
      character?: unknown;
      powerUpTokenIds?: unknown;
    };

    if (!id) {
      throw badRequest('MISSING_DUNGEON_ID', 'A dungeon or spawn id is required');
    }

    const partyId = typeof body.partyId === 'string' && body.partyId.trim() ? body.partyId.trim() : null;
    if (/^\d+$/.test(id) && partyId) {
      // Better to refuse than to quietly drop the field: a player who thinks
      // they entered with their party and finds themselves alone has been
      // misled by us, not by the network. Checked before the paid branch too —
      // a party entry that silently became a solo entry would have cost real
      // STX by the time the player noticed.
      throw notImplemented(
        'PARTY_RUNS_NOT_ENABLED',
        'Party runs are not enabled yet — enter without a partyId to run solo.',
      );
    }

    // A numeric id is an on-chain dungeon id, which means the paid dungeon.
    if (/^\d+$/.test(id)) {
      return buildPaidEntry({ deps, dungeonId: Number(id), address: session.sub, body });
    }

    const spawn = await deps.spawns.findById(id);
    if (!spawn) {
      throw notFound('SPAWN_NOT_FOUND', `No dungeon spawn with id ${id}`);
    }
    if (spawn.expiresAt <= new Date()) {
      // Expired spawns are kept for historical integrity but are not enterable.
      throw conflict(
        'SPAWN_EXPIRED',
        'That dungeon has closed. Pick another one from the map.',
      );
    }

    if (partyId) {
      const prepared = await deps.parties.prepareEntry(partyId, session.sub);
      if (prepared.kind === 'not_found') throw notFound('PARTY_NOT_FOUND', 'Party not found.');
      if (prepared.kind === 'not_leader') throw conflict('PARTY_LEADER_REQUIRED', 'Only the party leader can enter a dungeon.');
      if (prepared.kind === 'characters_missing') throw conflict('PARTY_CHARACTERS_REQUIRED', 'Every party member must select a character.');
      if (prepared.kind === 'members_not_ready') throw conflict('PARTY_NOT_READY', 'Every party member must be ready.');
      if (prepared.kind !== 'ready') throw conflict('PARTY_NOT_READY', 'The party cannot enter yet.');
      const members = await Promise.all(prepared.party.members.map(async (member) => {
        const owned = await deps.characters.listForAddress(member.address);
        const character = owned.find((candidate) => candidate.contractId === member.nftContractId && candidate.tokenId === member.nftTokenId);
        if (!character) throw conflict('PARTY_CHARACTER_NOT_HELD', `${member.address} no longer holds the selected character.`);
        return { address: member.address, character: { contractId: character.contractId, tokenId: character.tokenId }, displayName: character.name };
      }));
      const run = await deps.runs.createFreeRun({ spawnId: spawn.id, partyId, createdBy: session.sub, character: null });
      const setup = await deps.combat.buildPartySetup(spawn.monsterTableId, members);
      const committed = await deps.oracle.commit(run.id, setup);
      const view = await deps.oracle.view(run.id);
      if (!view || !committed.seedHash || !committed.commitSignature || !committed.committedAt) throw conflict('RUN_NOT_READY', 'The run could not be started. Try again.');
      const { token, claims } = issueRunToken({ address: session.sub, runId: run.id, secret: deps.jwtSecret, ttlSeconds: RUN_TOKEN_TTL_SECONDS });
      return { dungeonType: 'free', runId: run.id, spawnId: spawn.id, monsterTableId: spawn.monsterTableId, runToken: token, expiresAt: new Date(claims.exp * 1000).toISOString(), seedHash: committed.seedHash, oracleAddress: committed.oracleAddress ?? deps.oracle.oracleAddress, commitSignature: committed.commitSignature, committedAt: committed.committedAt.toISOString(), encounter: view.encounter } satisfies FreeEntryResponse;
    }

    const character = parseCharacter(body.character);
    const powerUpItems = await resolveLoadout(deps.powerUps, session.sub, body.powerUpTokenIds);

    const run = await deps.runs.createFreeRun({
      spawnId: spawn.id,
      partyId: null,
      createdBy: session.sub,
      character,
    });

    // Commit before the player can act. The seed hash goes out in this same
    // response, so it is provably fixed before the first action rather than
    // chosen once we know what they did.
    const setup = await deps.combat.buildSetup(run, spawn.monsterTableId, character, powerUpItems);
    const committed = await deps.oracle.commit(run.id, setup);

    const view = await deps.oracle.view(run.id);
    if (!view || !committed.seedHash || !committed.commitSignature || !committed.committedAt) {
      // Refuse rather than hand back a run the player can't act on: an entry
      // that half-worked is worse than one that visibly didn't.
      throw conflict('RUN_NOT_READY', 'The run could not be started. Try again.');
    }

    const { token, claims } = issueRunToken({
      address: session.sub,
      runId: run.id,
      secret: deps.jwtSecret,
      ttlSeconds: RUN_TOKEN_TTL_SECONDS,
    });

    const response: FreeEntryResponse = {
      dungeonType: 'free',
      runId: run.id,
      spawnId: spawn.id,
      monsterTableId: spawn.monsterTableId,
      runToken: token,
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      seedHash: committed.seedHash,
      oracleAddress: committed.oracleAddress ?? deps.oracle.oracleAddress,
      commitSignature: committed.commitSignature,
      committedAt: committed.committedAt.toISOString(),
      encounter: view.encounter,
    };
    return response;
  });
}

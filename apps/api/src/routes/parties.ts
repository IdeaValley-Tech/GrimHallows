import type { FastifyInstance } from 'fastify';
import { requireSession } from '../lib/authGuard.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import type { PartyStore } from '../repos/parties.js';
import type { CharacterService } from '../services/characterService.js';
import type { NotificationStore } from '../repos/notifications.js';
import type { IdentityService } from '../services/identityService.js';

export async function registerPartyRoutes(app: FastifyInstance, deps: { parties: PartyStore; notifications: NotificationStore; characters: CharacterService; identity: IdentityService; jwtSecret: string }) {
  const withIdentity = async <T extends { members: readonly { address: string }[] }>(party: T | null) => party ? { ...party, members: await Promise.all(party.members.map(async (member) => ({ ...member, identity: await deps.identity.resolve(member.address) }))) } : null;
  app.post('/parties', async (request, reply) => {
    const { sub } = requireSession(request, deps.jwtSecret);
    const result = await deps.parties.create(sub);
    if (result.kind === 'already_member') throw conflict('PARTY_ALREADY_MEMBER', 'Leave your current party before creating another.');
    return reply.status(201).send({ party: await withIdentity(result.party) });
  });

  app.get('/parties/current', async (request) => {
    const { sub } = requireSession(request, deps.jwtSecret);
    return { party: await withIdentity(await deps.parties.current(sub)) };
  });

  app.post('/parties/:id/leave', async (request) => {
    const { sub } = requireSession(request, deps.jwtSecret);
    const { id } = request.params as { id: string };
    const outcome = await deps.parties.leave(id, sub);
    if (outcome === 'not_member') throw notFound('PARTY_NOT_FOUND', 'Party not found.');
    return { outcome };
  });

  app.post('/parties/:id/invites', async (request, reply) => {
    const { sub } = requireSession(request, deps.jwtSecret);
    const { id } = request.params as { id: string };
    const address = (request.body as { address?: unknown } | null)?.address;
    if (typeof address !== 'string' || !address.trim()) throw badRequest('INVITEE_REQUIRED', 'An invitee address is required.');
    const result = await deps.parties.invite(id, sub, address.trim());
    if (result.kind === 'not_leader') throw forbidden('PARTY_LEADER_REQUIRED', 'Only the party leader can invite members.');
    if (result.kind === 'already_member') throw conflict('INVITEE_ALREADY_IN_PARTY', 'That wallet is already in a party.');
    if (result.kind === 'self') throw badRequest('CANNOT_INVITE_SELF', 'You cannot invite yourself.');
    if (result.kind === 'party_full') throw conflict('PARTY_FULL', 'The party already has four members.');
    if (result.kind !== 'created' && result.kind !== 'existing') throw conflict('PARTY_INVITE_FAILED', 'The invite could not be created.');
    if (result.kind === 'created') await deps.notifications.create(address.trim(), 'party_invite', { partyId: id, inviteId: result.invite.id, inviterAddress: sub });
    return reply.status(result.kind === 'created' ? 201 : 200).send({ invite: result.invite });
  });

  app.get('/party-invites', async (request) => {
    const { sub } = requireSession(request, deps.jwtSecret);
    return { invites: await deps.parties.pendingInvites(sub) };
  });

  app.post('/party-invites/:id/respond', async (request) => {
    const { sub } = requireSession(request, deps.jwtSecret);
    const { id } = request.params as { id: string };
    const accept = (request.body as { accept?: unknown } | null)?.accept;
    if (typeof accept !== 'boolean') throw badRequest('INVITE_RESPONSE_REQUIRED', 'The accept field must be a boolean.');
    const invite = (await deps.parties.pendingInvites(sub)).find((candidate) => candidate.id === id);
    const outcome = await deps.parties.respondToInvite(id, sub, accept);
    if (outcome === 'not_found') throw notFound('PARTY_INVITE_NOT_FOUND', 'Party invite not found.');
    if (outcome === 'expired') throw conflict('PARTY_INVITE_EXPIRED', 'This party invite has expired.');
    if (outcome === 'party_full') throw conflict('PARTY_FULL', 'The party already has four members.');
    if (outcome === 'already_member') throw conflict('PARTY_ALREADY_MEMBER', 'Leave your current party before accepting another invite.');
    if (invite) await deps.notifications.create(invite.inviterAddress, accept ? 'party_invite_accepted' : 'party_invite_declined', { partyId: invite.partyId, inviteId: invite.id, address: sub });
    return { outcome };
  });

  app.post('/parties/:id/ready', async (request) => {
    const { sub } = requireSession(request, deps.jwtSecret);
    const { id } = request.params as { id: string };
    const ready = (request.body as { ready?: unknown } | null)?.ready;
    if (typeof ready !== 'boolean') throw badRequest('READY_REQUIRED', 'The ready field must be a boolean.');
    const outcome = await deps.parties.setReady(id, sub, ready);
    if (outcome === 'not_member') throw notFound('PARTY_NOT_FOUND', 'Party or member not found.');
    if (outcome === 'character_required') throw conflict('PARTY_CHARACTER_REQUIRED', 'Select a character before marking yourself ready.');
    return { ready };
  });

  app.post('/parties/:id/kick', async (request) => {
    const { sub } = requireSession(request, deps.jwtSecret);
    const { id } = request.params as { id: string };
    const address = (request.body as { address?: unknown } | null)?.address;
    if (typeof address !== 'string' || !address.trim()) throw badRequest('MEMBER_REQUIRED', 'A member address is required.');
    const outcome = await deps.parties.kick(id, sub, address.trim());
    if (outcome === 'forbidden') throw forbidden('PARTY_LEADER_REQUIRED', 'Only the party leader can remove members.');
    if (outcome === 'invalid_target') throw badRequest('CANNOT_KICK_SELF', 'The party leader cannot kick themselves.');
    if (outcome === 'not_member') throw notFound('PARTY_MEMBER_NOT_FOUND', 'Party member not found.');
    await deps.notifications.create(address.trim(), 'party_kicked', { partyId: id, address: sub });
    return { kicked: address.trim() };
  });

  app.post('/parties/:id/character', async (request) => {
    const { sub } = requireSession(request, deps.jwtSecret);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { contractId?: unknown; tokenId?: unknown };
    const contractId = typeof body.contractId === 'string' ? body.contractId.trim() : '';
    const tokenId = typeof body.tokenId === 'string' || typeof body.tokenId === 'number' ? String(body.tokenId).trim() : '';
    if (!contractId || !/^\d+$/.test(tokenId)) throw badRequest('INVALID_CHARACTER', 'A character contractId and numeric tokenId are required.');
    const owned = (await deps.characters.listForAddress(sub)).some((character) => character.contractId === contractId && character.tokenId === tokenId);
    if (!owned) throw badRequest('CHARACTER_NOT_HELD', 'That character is not held by the authenticated wallet.');
    const outcome = await deps.parties.setCharacter(id, sub, contractId, tokenId);
    if (outcome === 'not_member') throw notFound('PARTY_NOT_FOUND', 'Party or member not found.');
    return { character: { contractId, tokenId }, ready: false };
  });

  app.post('/parties/:id/prepare-entry', async (request) => {
    const { sub } = requireSession(request, deps.jwtSecret);
    const { id } = request.params as { id: string };
    const result = await deps.parties.prepareEntry(id, sub);
    if (result.kind === 'not_found') throw notFound('PARTY_NOT_FOUND', 'Party not found.');
    if (result.kind === 'not_leader') throw forbidden('PARTY_LEADER_REQUIRED', 'Only the party leader can start a dungeon.');
    if (result.kind === 'characters_missing') throw conflict('PARTY_CHARACTERS_REQUIRED', 'Every party member must select a character.');
    if (result.kind === 'members_not_ready') throw conflict('PARTY_NOT_READY', 'Every party member must be ready.');
    if (result.kind !== 'ready') throw conflict('PARTY_NOT_READY', 'The party cannot enter yet.');
    return { partyId: result.party.id, members: result.party.members.map((member) => ({ address: member.address, character: { contractId: member.nftContractId!, tokenId: member.nftTokenId! } })) };
  });
}

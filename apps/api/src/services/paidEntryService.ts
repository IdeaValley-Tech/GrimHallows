/**
 * Paid-run ingestion — reads the facts off a confirmed `enter-dungeon` transaction.
 *
 * INTERNAL. Routes call this to turn a submitted txid into a run the player can
 * act on. It never trusts the claim; every field is verified from chain: the run
 * id the contract assigned, the payer, the dungeon, the fee, and the character.
 *
 * The route shape is still to be determined (see 06-mvp-roadmap.md Phase 5
 * notes), but the mechanics here are fixed: a claim carries a txid as a hint,
 * and every fact about the entry is read back from `chain.getTransaction`.
 */

import { ClarityType, hexToCV } from '@stacks/transactions';
import {
  buildDungeonPlan,
  type CharacterRef,
  type EncounterSetup,
  type EquippedItem,
  type NetworkConfig,
  contractId as buildContractId,
  PAID_DUNGEON_MONSTER_TABLE_ID,
} from '@grimhallow/shared';
import type { ChainClient } from '../lib/hiro.js';
import { conflict, forbidden, upstreamUnavailable } from '../lib/errors.js';
import { normalizeTxId } from '../lib/hiro.js';
import type { PaidRunOracle } from '../oracle/paidRunOracle.js';
import type { IngestedPaidRun, RunRecord, RunStore } from '../repos/runs.js';
import type { CombatService } from './combatService.js';
import type { PowerUpService } from './powerUpService.js';
import { generateSeed } from '../oracle/seed.js';

export interface PaidEntryServiceDeps {
  readonly chain: ChainClient;
  readonly runs: RunStore;
  readonly oracle: PaidRunOracle;
  readonly combat: CombatService;
  readonly powerUps: PowerUpService;
  readonly stacks: NetworkConfig;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
}

/**
 * What a paid entry resolved to once verified and ingested.
 *
 * Everything here is a chain fact, not a client claim. The run exists, the seed
 * is committed, and the encounter is ready — a player can act on it.
 */
export interface VerifiedPaidEntry {
  readonly run: RunRecord;
  readonly setup: EncounterSetup;
}

export class PaidEntryService {
  constructor(private readonly deps: PaidEntryServiceDeps) {}

  private get gameCoreId(): string {
    return buildContractId(this.deps.stacks, 'gameCore');
  }

  /**
   * Verify a claimed `enter-dungeon` and ingest the run it created.
   *
   * Idempotent: repeated claims for the same transaction return the same run
   * rather than creating a second one. That matters because a player retrying a
   * claim and a later reconciliation pass both describe the same entry, and two
   * runs citing one payment would be one run nobody paid for.
   *
   * The loadout is validated here at claim time, not at quote time, because the
   * quote returns an unsigned transaction — no run exists yet and no money has
   * moved. The wallet's holdings can only be verified once the player has
   * actually paid, which is what the confirmed `enter-dungeon` proves.
   */
  async verifyAndIngest(args: {
    readonly enterTxId: string;
    readonly claimedBy: string;
    readonly character: CharacterRef;
    readonly powerUpItems: readonly EquippedItem[];
  }): Promise<VerifiedPaidEntry> {
    const { enterTxId, claimedBy, character, powerUpItems } = args;
    const normalized = normalizeTxId(enterTxId);

    // Already ingested? Re-read by txid rather than by id, which is what the
    // unique index is on and what a retry supplies.
    const existing = await this.deps.runs.findByEnterTxId(normalized);
    if (existing) {
      if (!existing.setup) {
        throw conflict(
          'RUN_NOT_COMMITTED',
          'This entry was recorded but its seed has not been committed yet. Try again shortly.',
        );
      }
      return { run: existing, setup: existing.setup };
    }

    const tx = await this.deps.chain.getTransaction(normalized);
    if (!tx) {
      throw conflict(
        'TX_NOT_CONFIRMED',
        'This transaction has not been confirmed yet. Wait a moment and try again.',
      );
    }

    // The chain's word on what happened. Every field below is read from here,
    // not from the claim.
    //
    // A mempool transaction is returned with `pending`, which is the same
    // "not yet" as `getTransaction` returning nothing — so it reports as
    // TX_NOT_CONFIRMED. Reporting it as a failure would tell a player who has
    // already paid that their entry died, when it is merely queued.
    if (tx.txStatus === 'pending') {
      throw conflict(
        'TX_NOT_CONFIRMED',
        'This transaction is still pending. Wait a moment and try again.',
      );
    }
    if (tx.txStatus !== 'success') {
      throw conflict(
        'TX_NOT_SUCCESS',
        `This transaction did not succeed (status: ${tx.txStatus}). No run was created.`,
      );
    }
    if (tx.txType !== 'contract_call') {
      throw conflict('TX_WRONG_TYPE', 'This transaction is not a contract call.');
    }
    if (tx.contractId !== this.gameCoreId) {
      throw conflict(
        'TX_WRONG_CONTRACT',
        `This transaction called ${tx.contractId}, not ${this.gameCoreId}.`,
      );
    }
    if (tx.functionName !== 'enter-dungeon') {
      throw conflict(
        'TX_WRONG_FUNCTION',
        `This transaction called ${tx.functionName}, not enter-dungeon.`,
      );
    }

    // The contract returned `(ok run-id)`. Parse the id.
    if (!tx.resultRepr) {
      // A mined success with no result is a node inconsistency, not a player error.
      throw upstreamUnavailable('Transaction result is missing. Try again shortly.');
    }
    const runIdMatch = /^\(ok u(\d+)\)$/.exec(tx.resultRepr.trim());
    if (!runIdMatch) {
      throw conflict(
        'UNEXPECTED_RESULT',
        `enter-dungeon returned ${tx.resultRepr}, not (ok u<run-id>).`,
      );
    }
    const runId = runIdMatch[1];

    // The dungeon id is the first argument.
    if (tx.functionArgsRepr.length < 1) {
      throw conflict('MISSING_DUNGEON_ARG', 'enter-dungeon was called with no arguments.');
    }
    const dungeonIdMatch = /^u(\d+)$/.exec(tx.functionArgsRepr[0].trim());
    if (!dungeonIdMatch) {
      throw conflict(
        'MALFORMED_DUNGEON_ID',
        `First argument to enter-dungeon is ${tx.functionArgsRepr[0]}, not a uint.`,
      );
    }
    const dungeonId = Number(dungeonIdMatch[1]);

    // The fee paid is in the `run-entered` print event. Find it.
    const printEvent = tx.events.find(
      (e) => e.eventType === 'smart_contract_log' && e.contractId === this.gameCoreId,
    );
    if (!printEvent || !printEvent.valueHex) {
      throw conflict(
        'MISSING_PRINT_EVENT',
        'The run-entered event is missing from this transaction.',
      );
    }

    let printedGateFeeUstx: string;
    try {
      const eventValue = hexToCV(printEvent.valueHex);
      if (eventValue.type !== ClarityType.Tuple) {
        throw new Error('Print event is not a tuple.');
      }
      const tuple = eventValue.value;
      if (!tuple['gate-fee'] || tuple['gate-fee'].type !== ClarityType.UInt) {
        throw new Error('Print event has no gate-fee field.');
      }
      printedGateFeeUstx = BigInt(tuple['gate-fee'].value).toString();
    } catch (err) {
      this.deps.log?.('failed to parse run-entered event', {
        txId: normalized,
        valueHex: printEvent.valueHex,
        error: err instanceof Error ? err.message : String(err),
      });
      throw conflict(
        'MALFORMED_EVENT',
        'The run-entered event could not be parsed. This is unusual; the entry may still be valid.',
      );
    }

    // The fee the operator was actually paid is the STX that moved, not the fee
    // the contract announced. They agree on every ordinary entry, and disagree
    // on one real case: when the entrant is the contract owner, `transfer-gate-fee`
    // skips the transfer (stx-transfer? rejects paying yourself) and the operator
    // received nothing — crediting the printed fee there would be revenue that
    // never left their wallet.
    const stxTransfer = tx.events.find(
      (e) => e.eventType === 'stx_asset' && e.stxTransfer?.recipient === this.deps.stacks.deployer,
    );
    const gateFeeUstx = stxTransfer?.stxTransfer?.amountUstx ?? '0';

    // The payer is `tx-sender`, which is `sender_address` on the transaction.
    // Compare to the session — only the payer can claim their own run.
    if (tx.senderAddress !== claimedBy) {
      throw forbidden(
        'NOT_YOUR_ENTRY',
        `This transaction was sent by ${tx.senderAddress}, not by you.`,
      );
    }

    // The character is validated on the second argument (the party list). Party
    // runs are not enabled, so the list has exactly one member and it must match
    // the character the claim supplied.
    if (tx.functionArgsRepr.length < 2) {
      throw conflict('MISSING_PARTY_ARG', 'enter-dungeon was called with only one argument.');
    }
    const partyRepr = tx.functionArgsRepr[1].trim();
    // The second arg is a `(list 4 principal)`. Clarity renders each principal
    // with a leading apostrophe — the chain returns `(list 'SP1… 'SP2…)`, not
    // `(list SP1… SP2…)`. An earlier parser matched `[A-Z0-9]+` with no quote and
    // so rejected every real entry as malformed while the fixtures (hand-written
    // without the apostrophe) passed. Parse the list generically and strip the
    // quote from each member.
    const listMatch = /^\(list\s+(.+)\)$/.exec(partyRepr);
    if (!listMatch) {
      throw conflict(
        'MALFORMED_PARTY',
        `Second argument to enter-dungeon is ${partyRepr}, not a list of principals.`,
      );
    }
    const party = listMatch[1].trim().split(/\s+/).map((member) => member.replace(/^'/, ''));
    // Every member must look like a Stacks principal (`S` + c32 body). This is
    // what rejects a list whose contents are not principals at all, e.g. `(list u5)`.
    if (!party.every((member) => /^S[0-9A-Z]+$/.test(member))) {
      throw conflict(
        'MALFORMED_PARTY',
        `Second argument to enter-dungeon is ${partyRepr}, not a list of principals.`,
      );
    }
    // Party runs are not enabled yet: the list must be exactly the payer. Naming
    // other principals is allowed on chain — paying for another player is not an
    // attack — but this path expects solo entries only.
    if (party.length !== 1 || party[0] !== tx.senderAddress) {
      throw conflict(
        'PARTY_MISMATCH',
        'This entry names a party other than you alone. Multi-party entries are not yet supported.',
      );
    }

    // All facts verified. Ingest.
    const ingested: IngestedPaidRun = {
      id: runId,
      dungeonId,
      createdBy: tx.senderAddress,
      character,
      feePaidUstx: gateFeeUstx,
      enterTxId: normalized,
    };
    const run = await this.deps.runs.ingestPaidRun(ingested);
    this.deps.log?.('paid run ingested from chain', {
      runId,
      dungeonId,
      enterTxId: normalized,
      createdBy: tx.senderAddress,
      feePaidUstx: gateFeeUstx,
    });

    // Commit the seed on chain. The paid dungeon's monster table id is a
    // constant for MVP; when multiple paid dungeons exist this would be read
    // from the dungeon's own metadata.
    const setup = await this.deps.combat.buildSetup(
      run,
      PAID_DUNGEON_MONSTER_TABLE_ID,
      character,
      powerUpItems,
    );
    const { seed, seedHash } = generateSeed();

    // Post `commit-seed` and wait for the txid — commit-seed does not require
    // confirmation to write the row, but it does need to succeed or the run is
    // stuck in `pending` forever. A broadcast failure here is retryable.
    const commitTxId = await this.deps.oracle.commitSeed({ runId, seedHash });

    const committedAt = new Date();
    const committed = await this.deps.runs.commit(runId, {
      seedHash,
      seed,
      setup: { ...setup, dungeonPlan: buildDungeonPlan(seed, 'paid', setup.monsterTableId) },
      commitSignature: null,
      oracleAddress: null,
      commitTxId,
      committedAt,
    });

    if (!committed) {
      // Another caller committed it first. Re-read.
      const refetched = await this.deps.runs.findById(runId);
      if (!refetched || !refetched.setup) {
        throw conflict(
          'COMMIT_RACE',
          'Another commit won the race but the run is not readable yet. Try again shortly.',
        );
      }
      return { run: refetched, setup: refetched.setup };
    }

    this.deps.log?.('paid run seed committed', { runId, seedHash, commitTxId });
    return { run: committed, setup };
  }
}

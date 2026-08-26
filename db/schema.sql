-- GrimHallow off-chain schema — docs/05-data-model.md, verbatim in structure.
--
-- EVERYTHING HERE IS A CACHE. It is rebuildable from chain state plus game
-- logs, and it is never the source of truth for money or ownership. Two numbers
-- in particular must never be added together or conflated:
--
--   runs.fee_paid_ustx        operator revenue from a paid entry (Flow A)
--   sponsor_pool_snapshots    the owner-funded prize budget (Flow B)
--
-- They are separate money flows by design (docs/02-architecture.md#3). A query
-- that sums them is a bug.
--
-- Applied by `npm run db:migrate`, which is idempotent — every statement here
-- must stay re-runnable (if not exists / or replace).

-- gen_random_uuid() is built in from Postgres 13; pgcrypto is not required.

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  address text not null,
  jwt_issued_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists sessions_address_idx on sessions (address);
create index if not exists sessions_expires_at_idx on sessions (expires_at);

-- Single-use login challenges. Not in 05-data-model.md, which models the issued
-- session but not the challenge that precedes it: POST /auth/challenge has to
-- remember what it handed out, or POST /auth/verify would have to accept any
-- string the client claims it was asked to sign — which is the whole attack.
-- Rows are consumed on first successful verify and swept once expired.
create table if not exists auth_challenges (
  challenge text primary key,
  address text,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create index if not exists auth_challenges_expires_at_idx on auth_challenges (expires_at);

create table if not exists parties (
  id uuid primary key default gen_random_uuid(),
  invite_code text unique not null,
  created_by text not null,
  created_at timestamptz not null default now()
);

create table if not exists party_members (
  party_id uuid references parties(id) on delete cascade,
  address text not null,
  nft_contract_id text,
  nft_token_id bigint,
  role text not null default 'member' check (role in ('leader','member')),
  ready boolean not null default false,
  joined_at timestamptz not null default now(),
  primary key (party_id, address),
  check ((nft_contract_id is null) = (nft_token_id is null))
);

-- A wallet may only participate in one active party. The partial unique index
-- guarantees one leader while still allowing the other three member slots.
alter table party_members alter column nft_contract_id drop not null;
alter table party_members alter column nft_token_id drop not null;
alter table party_members add column if not exists role text not null default 'member';
alter table party_members add column if not exists ready boolean not null default false;
do $$ begin
  alter table party_members add constraint party_members_role_check
    check (role in ('leader','member'));
exception when duplicate_object then null;
end $$;
do $$ begin
  alter table party_members add constraint party_members_character_pair_check
    check ((nft_contract_id is null) = (nft_token_id is null));
exception when duplicate_object then null;
end $$;
create unique index if not exists party_members_address_idx on party_members (address);
create unique index if not exists party_members_one_leader_idx
  on party_members (party_id) where role = 'leader';

create table if not exists party_invites (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references parties(id) on delete cascade,
  inviter_address text not null,
  invitee_address text not null,
  status text not null default 'pending'
    check (status in ('pending','accepted','declined','expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  responded_at timestamptz,
  check (inviter_address <> invitee_address)
);

create unique index if not exists party_invites_pending_idx
  on party_invites (party_id, invitee_address) where status = 'pending';
create index if not exists party_invites_invitee_idx
  on party_invites (invitee_address, status, created_at desc);

-- Free dungeon spawns on the world map (off-chain content, no gate fee).
create table if not exists dungeon_spawns (
  id uuid primary key default gen_random_uuid(),
  map_x int not null,
  map_y int not null,
  monster_table_id text not null,
  spawned_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- Expired spawns are excluded from /map but retained for historical integrity
-- (05-data-model.md indexing notes) — never hard-deleted.
create index if not exists dungeon_spawns_expires_at_idx on dungeon_spawns (expires_at);

-- Runs: paid (mirrors the on-chain runs map) and free (server-signed).
create table if not exists runs (
  id bigint primary key, -- on-chain run-id for paid runs; server sequence for free
  dungeon_type text not null check (dungeon_type in ('paid','free')),
  dungeon_id bigint,
  spawn_id uuid references dungeon_spawns(id),
  party_id uuid references parties(id),
  -- Who entered. Leaderboard credit is address-keyed (04-backend-api-spec.md#8),
  -- so a solo run with no party row still has to name somebody to credit.
  created_by text not null,
  -- The character fielded on a solo run. Party runs carry one NFT per member in
  -- party_members instead; these columns are how a run with no party still knows
  -- whose stats to fight with. Not in 05-data-model.md's original DDL — added
  -- because the encounter engine takes stats as input and nothing else in the
  -- schema binds a character to a party-less run.
  character_contract_id text,
  character_token_id bigint,
  state text not null check (state in ('pending','committed','resolved')),
  seed_hash text,
  -- The seed itself, while it is still secret.
  --
  -- Deliberately a separate column from seed_reveal, and deliberately not part
  -- of the RunRecord the API layer passes around: the server needs the seed to
  -- roll each turn, but publishing it before the run ends would let a player
  -- derive every remaining roll before choosing their next action, which is the
  -- one thing commit-reveal exists to prevent. Only `src/oracle/` reads it.
  seed_secret text,
  -- The same value, republished at resolve time. Safe to serve.
  seed_reveal text,
  -- The encounter's inputs, frozen at commit time: party ids, names, classes and
  -- the exact stat block each member fought with.
  --
  -- Derived stats depend partly on NFT metadata (01-game-design.md#6), and
  -- metadata is a file on somebody else's server that can change after a run
  -- starts. Recomputing stats at resolve time would then produce a different
  -- fight from the one the player played, and the replay would "fail" on an
  -- honest run. Pinning the setup is what makes `runEncounter(seed, setup,
  -- actions)` reproducible for good.
  encounter_setup_json jsonb,
  -- Frozen with the setup so future encounter rules can replay historical
  -- runs under the version that actually produced them.
  encounter_algo_version text not null default 'encounter-v1',
  combat_outcome text check (combat_outcome in ('win','loss')),
  fee_paid_ustx bigint,        -- operator revenue; NOT pool-related
  reward_kind text check (reward_kind in ('jackpot','loot','none')),
  reward_amount_ustx bigint,   -- paid from the sponsor pool; unrelated to fee_paid_ustx
  reward_loot_token_id bigint,
  reward_degraded boolean not null default false,
  enter_tx_id text,
  -- The `commit-seed` transaction, on a paid run.
  --
  -- Not in 05-data-model.md's DDL, which lists only enter/resolve. Added because
  -- VerificationData publishes a commitTxId and a paid run's commitment lives on
  -- chain: without this column the one thing a player would check the seed hash
  -- against — the transaction that fixed it, before they acted — is unciteable,
  -- and "verifiable" would quietly mean "take our word for the hash".
  commit_tx_id text,
  resolve_tx_id text,
  -- Off-chain analogue of the two tx ids above, for free runs only. A free
  -- dungeon has no transaction to point at (07-glossary #2), so the oracle signs
  -- the commit and the resolution instead and a player checks the signature
  -- against oracle_address. Never populated for a paid run: those are settled by
  -- the contract, and a signature here would look like a second, weaker source
  -- of truth for something the chain already decided.
  commit_signature text,
  resolve_signature text,
  oracle_address text,
  created_at timestamptz not null default now(),
  -- Written by the API, not defaulted to now(), because both timestamps are
  -- lines inside the signed statements above. A signature over an instant the
  -- database picked independently would quote a time the row does not have, and
  -- a statement nobody can reconstruct is a statement nobody can verify.
  committed_at timestamptz,
  resolved_at timestamptz,
  -- A character is either fully identified or not identified at all.
  constraint runs_character_pair check (
    (character_contract_id is null) = (character_token_id is null)
  )
);

-- `create table if not exists` does not modify production tables. Existing runs
-- all predate versioned plans and therefore replay under encounter-v1.
alter table runs add column if not exists encounter_algo_version text not null default 'encounter-v1';

-- Whether the chain agreed with what we recorded.
--
-- WHY THESE ARE NOT PART OF `state`. A run reaches 'resolved' when the backend
-- has broadcast `reveal-and-resolve` — and a broadcast is not a settlement. The
-- node accepts any well-formed, funded transaction; a failed `asserts!` inside
-- the contract aborts it *later*, on chain, and nothing in the request path looks
-- again. So 'resolved' honestly means "we did our part", and these two columns
-- carry the separate question of whether the chain then agreed.
--
-- This is not hypothetical. On mainnet the contract's `oracle` var still pointed
-- at the deployer while the backend signed as its own key, so every
-- `reveal-and-resolve` aborted with `(err u201)` — and three paid entries read as
-- settled here with rewards that were never minted. The indexer's
-- `verifySettlements` pass is what closes that gap; see apps/api/src/indexer.
--
-- Added by `alter`, not by editing the `create table` above: `create table if not
-- exists` converges a missing table, never a changed one, so an edit up there
-- would silently do nothing to a live database (see scripts/db-migrate.mjs).
alter table runs add column if not exists settlement_verified_at timestamptz;
-- Null on a settlement the chain accepted. Set to the chain's own tx_status
-- (e.g. 'abort_by_response') when it did not, which is the operator's cue that a
-- reward row here describes something that does not exist on chain.
alter table runs add column if not exists settlement_abort_reason text;

-- Minting a free run's loot drop on chain (docs/09 B7).
--
-- WHY A FREE RUN NEEDS ON-CHAIN COLUMNS AT ALL. Loot is the forge's input supply,
-- so a free-run drop has to be a real NFT — and `character-loot-nft.mint` is
-- reachable only through `game-core`, which mints only inside
-- `reveal-and-resolve`, which only settles a run the chain already knows about.
-- So a free run that draws loot is escorted through a synthetic on-chain run:
-- `enter-dungeon(FREE_DUNGEON_ID, [player])` → `commit-seed` → `reveal-and-resolve`.
-- Three sequential confirmations, which is why it is a background worker
-- (apps/api/src/oracle/freeRunLootMinter.ts) and why each step is persisted: a
-- restart mid-ceremony has to resume, not start over and mint twice.
--
-- THAT ON-CHAIN RUN IS A MINT VEHICLE, NOT A FAIRNESS RECORD. The fight already
-- happened and was attested off-chain by the oracle signature; nobody acts on the
-- chain run and its combat-outcome is dictated. The seed it commits is this run's
-- own already-revealed seed, so the drop stays recomputable from the one seed the
-- player was shown — there is no second secret, and nothing here is a second,
-- weaker record of the encounter.
--
-- The gate fee is zero and the dungeon is `is-paid false`, so no STX moves and
-- the sponsor pool is untouched: a free run cannot pay a jackpot (B7 keeps STX
-- rewards behind the fee, enforced in packages/shared/src/rewards.ts).
alter table runs add column if not exists loot_mint_chain_run_id bigint;
-- The chain-assigned run id above is NOT this row's `id`: free ids come from
-- free_run_id_seq and the chain assigns its own from run-nonce. Both are needed —
-- `id` is what a player's run URL says, the chain id is what the `loot-minted`
-- print carries, and conflating them would attach one run's token to another.
alter table runs add column if not exists loot_mint_enter_tx_id text;
alter table runs add column if not exists loot_mint_commit_tx_id text;
alter table runs add column if not exists loot_mint_resolve_tx_id text;
-- Set when the ceremony cannot proceed — an aborted step, or a chain run id the
-- entry transaction did not return. Stops the worker retrying forever and is the
-- operator's cue that a player is owed loot the chain never minted.
alter table runs add column if not exists loot_mint_failed_reason text;

-- The loot minter's work list: free runs that drew loot and have no mint under
-- way. Partial and narrow for the same reason as the settlement index — each run
-- leaves this set after one step and never returns to it.
create index if not exists runs_free_loot_unminted_idx
  on runs (resolved_at)
  where dungeon_type = 'free' and reward_kind = 'loot'
    and loot_mint_resolve_tx_id is null and loot_mint_failed_reason is null;

create index if not exists runs_party_id_idx on runs (party_id);
create index if not exists runs_state_idx on runs (state);
create index if not exists runs_created_by_idx on runs (created_by);

-- The indexer's settlement work list: resolved runs whose transaction has not
-- been checked yet. Partial and narrow because each settlement is verified once
-- and then never selected again, so this index stays small no matter how many
-- runs accumulate.
--
-- Since docs/09 B7 the predicate covers `loot_mint_resolve_tx_id` as well. A
-- free run settles by signature and never has a `resolve_tx_id`, but its drop is
-- minted by a ceremony whose resolve aborts exactly the way a paid settlement
-- does, and that transaction needs reading back too. Renamed rather than edited
-- in place: `create index if not exists` matches on name, so an existing
-- deployment would keep the old narrow predicate and silently stop answering
-- this query.
drop index if exists runs_settlement_unverified_idx;
create index if not exists runs_settlement_unverified_v2_idx
  on runs (resolved_at)
  where state = 'resolved' and settlement_verified_at is null
    and (resolve_tx_id is not null or loot_mint_resolve_tx_id is not null);

-- The leaderboard's access pattern: resolved runs, newest first, optionally
-- bounded by a window. Partial because a pending or committed run can never
-- contribute to a rank, so there is no reason to carry it in the index.
create index if not exists runs_resolved_at_idx
  on runs (resolved_at desc) where state = 'resolved';

-- One run per `enter-dungeon` transaction.
--
-- A uniqueness constraint rather than a plain index, because paid rows are
-- ingested from chain (05-data-model.md indexing notes) and the same txid can
-- arrive more than once: a player retrying a claim, and a later reconciliation
-- pass, both describe the same paid entry. The chain-assigned run id in `id`
-- already dedupes that, and this is the second, independent way of saying so —
-- two runs citing one payment would be one run the player did not pay for.
create unique index if not exists runs_enter_tx_id_key
  on runs (enter_tx_id) where enter_tx_id is not null;

-- Free runs get server-issued ids from this sequence. Paid runs take their id
-- from the chain instead, so the two id spaces must not overlap: free ids start
-- high enough that the on-chain run nonce will not reach them in this game's
-- lifetime.
create sequence if not exists free_run_id_seq as bigint start with 1000000000;

-- Periodic snapshots of the owner-funded sponsor pool, for operational
-- visibility (so it is never discovered empty by a player instead of by you).
create table if not exists sponsor_pool_snapshots (
  id bigserial primary key,
  balance_ustx bigint not null,
  observed_at timestamptz not null default now()
);

create index if not exists sponsor_pool_snapshots_observed_at_idx
  on sponsor_pool_snapshots (observed_at desc);

-- The player's submitted actions, in submission order.
--
-- This is the *input* to the encounter, and it is the only persisted state a run
-- actually has. `runEncounter(seed, setup, actions)` is pure, so replaying these
-- rows reproduces every roll, every HP total and the outcome exactly — which is
-- why no HP number is stored anywhere: a stored one could drift from what the
-- dice say, and then there would be two answers to "what happened".
--
-- combat_turns below is the *output* of that replay, written for fast reads and
-- for the indexer. If the two ever disagree, this table is right.
create table if not exists run_actions (
  run_id bigint not null references runs(id) on delete cascade,
  action_index int not null,   -- 0-based; the order actions were submitted in
  address text not null,       -- who submitted it, for party attribution
  power_id text not null,
  target_id text,              -- null for a power that takes no target (Guard)
  created_at timestamptz not null default now(),
  primary key (run_id, action_index)
);

create table if not exists combat_turns (
  id bigserial primary key,
  run_id bigint references runs(id) on delete cascade,
  turn_number int not null,
  -- Nullable, unlike 05-data-model.md's DDL: monsters take turns too, and a
  -- monster has no principal. The alternative was inventing a placeholder
  -- address, which would put a string that looks like a wallet in a column
  -- players and the leaderboard indexer both read. actor_id carries the
  -- combatant (`p0`/`m1`) in either case.
  actor_address text,
  actor_id text not null,
  action text not null,
  power_id text,
  initiative_roll int,
  attack_roll int,
  damage_roll int,
  target_id text,
  result_json jsonb not null,
  created_at timestamptz not null default now()
);

-- One row per turn number per run. A replay rewrites turns rather than appending
-- duplicates, and a unique key is what makes that an upsert instead of a leak.
create unique index if not exists combat_turns_run_turn_key
  on combat_turns (run_id, turn_number);

create index if not exists combat_turns_run_id_idx on combat_turns (run_id, turn_number);

-- Power-up NFTs mirrored for fast lookup. Source of truth is
-- character-loot-nft.clar — a disagreement means this cache is wrong, not the chain.
create table if not exists power_up_nfts (
  contract_id text not null,
  token_id bigint not null,
  owner_address text not null,
  tier int not null,
  granted_power_id text,
  dice_formula_bonus text,
  minted_via text not null check (minted_via in ('dungeon_reward','forge')),
  primary key (contract_id, token_id)
);

create index if not exists power_up_nfts_owner_idx on power_up_nfts (owner_address);

create table if not exists forge_recipes (
  id int primary key,
  input_tier int not null,
  input_count int not null,
  output_tier int not null
);

create table if not exists forge_history (
  id bigserial primary key,
  address text not null,
  recipe_id int references forge_recipes(id),
  burned_token_ids bigint[] not null,
  minted_token_id bigint not null,
  tx_id text not null,
  created_at timestamptz not null default now()
);

create index if not exists forge_history_address_idx on forge_history (address);

-- One row per forge transaction.
--
-- These rows are written by the indexer walking `forge`'s chain history, and
-- that walk deliberately re-reads recent transactions every pass rather than
-- trusting a stored cursor. Without this constraint a re-walk would append a
-- second copy of every forge it re-saw, and `highest_forge_tier` would climb on
-- nothing but the indexer running twice.
create unique index if not exists forge_history_tx_id_key on forge_history (tx_id);

create index if not exists forge_history_created_at_idx on forge_history (created_at desc);

-- A verifiable index over on-chain + server-signed events, not a trusted claim.
-- `score` is derived and recomputable from the other tables at any time.
create table if not exists player_stats (
  address text primary key,
  dungeons_completed int not null default 0,
  free_dungeons_completed int not null default 0,
  paid_dungeons_completed int not null default 0,
  jackpots_won int not null default 0,
  highest_forge_tier int not null default 0,
  score numeric not null default 0,
  updated_at timestamptz not null default now()
);

create index if not exists player_stats_score_idx on player_stats (score desc);

create table if not exists chat_messages (
  id bigserial primary key,
  channel text not null,
  address text not null,
  body text not null,
  created_at timestamptz not null default now()
);

-- HOLDER-INDEPENDENT derivation only: name, image, classId/className/classSource.
--
-- The key here is (contract, token, algo) with no owner column, which is only
-- sound for values that are the same no matter who holds the token. Under
-- stats-v3 rarity and stats are NOT such values — they come from the current
-- holder's tenure and reset on transfer (01-game-design.md#4b) — so they are
-- computed per request and deliberately never written here. Caching them under
-- this key would show a buyer the seller's rarity, which is precisely the bug
-- the transfer-reset test exists to catch.
--
-- What this saves is the Hiro metadata round trip. The arithmetic it no longer
-- caches costs microseconds; the HTTP call it still caches costs hundreds of ms.
--
-- Keyed by algo_version so each derivation's rows land beside its predecessor's
-- rather than silently rewriting history — which also means superseded rows are
-- never read again and never have to be migrated. That matters for v2 as much as
-- v1: a v1 payload had a different shape, and a v2 identity can carry a hashed
-- fallback class that the curated-collection allowlist no longer admits at all.
create table if not exists character_stats_cache (
  nft_contract_id text not null,
  nft_token_id bigint not null,
  algo_version text not null,
  stats_json jsonb not null,
  computed_at timestamptz not null default now(),
  primary key (nft_contract_id, nft_token_id, algo_version)
);

-- Block height -> burn-block timestamp. PERMANENT: a mined block's timestamp
-- never changes, so rows here never expire and are shared across every token and
-- every wallet. Separate table per 02-architecture.md#4 precisely because its
-- lifetime is unbounded while the holder-age cache's is not.
create table if not exists block_timestamps (
  block_height bigint primary key,
  burn_block_time timestamptz not null,
  fetched_at timestamptz not null default now()
);

-- When the CURRENT holder acquired a specific token. The basis for rarity.
--
-- OWNER-SCOPED ON PURPOSE: `owner_address` is part of the primary key, so a
-- transfer cannot hit a stale row — the new owner simply has no entry and gets a
-- fresh lookup, and the old owner's row becomes unreachable rather than wrong.
-- This is the whole mechanism by which rarity resets, expressed as a key.
--
-- `source` records how the acquisition block was found; `fallback_pending` means
-- the lookup failed and the token is being served as freshly acquired (holdDays
-- 0) while a background retry runs. That degrade never blocks a response
-- (02-architecture.md#4), so a flaky Hiro call costs a player rarity for a few
-- minutes, never a character-select screen.
create table if not exists nft_holder_age_cache (
  owner_address text not null,
  nft_contract_id text not null,
  nft_token_id text not null,
  acquired_block_height bigint,
  acquired_at timestamptz,
  source text not null check (source in ('holdings_block_height', 'history_fallback', 'fallback_pending')),
  checked_at timestamptz not null default now(),
  primary key (owner_address, nft_contract_id, nft_token_id)
);

-- Sweeping failed lookups for background retry without scanning the whole table.
create index if not exists nft_holder_age_pending_idx
  on nft_holder_age_cache (checked_at)
  where source = 'fallback_pending';

-- The block that minted one of our own `character-nft` tokens, with its hash.
-- PERMANENT, for the same reason `block_timestamps` is: a mint happens once and
-- no later transaction can move it.
--
-- The hash is what the mint-rarity floor is rolled from (stats-v4;
-- `mintFloorFromSeed` in packages/shared/src/rarity.ts). It is seeded from chain
-- rather than derived from `(contract, token)` because token ids are sequential
-- and `get-last-token-id` is public: a floor computable from identity alone lets
-- anyone hash `lastId + 1` off chain, learn the outcome before paying, and mint
-- only on a Rare. A block hash is not knowable when the mint is signed and not
-- choosable by the minter, so the published 60/30/10 table describes the odds
-- everyone actually faces.
--
-- Permanence here is correctness, not speed. A seed that could resolve to a
-- different value later would be a rarity floor that changed under a player who
-- had already been shown it, so the row is written once (`do nothing` on
-- conflict) and read forever.
--
-- Only rows for RESOLVED seeds exist. An unresolved token is simply absent, and
-- absence already means "serve no floor and ask again" — unlike the holder-age
-- cache, which stores its failures because they need a retry worklist.
create table if not exists nft_mint_seeds (
  nft_contract_id text not null,
  nft_token_id text not null,
  mint_block_height bigint not null,
  mint_seed text not null,
  resolved_at timestamptz not null default now(),
  primary key (nft_contract_id, nft_token_id)
);

-- Cross-instance mutual exclusion for scheduled jobs (docs/09 B7).
--
-- One row per job, held for a lease rather than for a session. The free-run loot
-- ceremony is the only user: it is driven over HTTP by two schedulers against a
-- deployment that can have several warm instances, and each instance's in-process
-- guard knows nothing about the others. Two passes on two instances read the same
-- run at the same recorded step and both broadcast it; the loser aborts, and if
-- its txid is the one recorded, a player is owed a drop the chain never minted.
--
-- Deliberately NOT `pg_try_advisory_lock`, which is the natural fit and cannot be
-- used here: advisory locks are session-scoped, and the transaction pooler this
-- API connects through does not guarantee two statements land on the same backend
-- (see src/db.ts). Acquire and release are one statement each, which it does.
--
-- `lease_until` in the past means the holder is gone — frozen mid-pass, killed,
-- or replaced by a deploy — and the lease is free. That is the only recovery
-- mechanism there is, because nothing runs a release in those cases.
--
-- This table holds no game state. Truncating it releases every lease, which is
-- safe when nothing is mid-pass and is a way to reintroduce the race when
-- something is.
create table if not exists job_leases (
  job text primary key,
  -- Which instance holds it. Diagnostic, and load-bearing on release: a pass that
  -- overran its lease has already lost it, and an unscoped delete would release
  -- the new holder's claim on its way out.
  holder text not null,
  lease_until timestamptz not null
);

create table if not exists notifications (
  id uuid primary key,
  address text not null,
  type text not null,
  payload_json jsonb not null default '{}'::jsonb,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists notifications_address_unread_idx
  on notifications (address, read, created_at desc);

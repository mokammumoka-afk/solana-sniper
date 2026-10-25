-- Solana Sniper — core schema.
-- Run this against your Supabase project (SQL Editor, or `supabase db push` with the CLI) before first
-- start. See README.md "إعداد Supabase" for step-by-step setup and backup instructions.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- tokens (discovered on-chain)
create table if not exists public.tokens (
  mint            text primary key,
  symbol          text,
  name            text,
  source          text not null,
  pool            text,
  creator         text,
  bonding_curve   text,
  discovered_at   bigint not null,          -- epoch ms (app-assigned, matches orders/positions timestamps)
  state           text not null,            -- discovered|watching|accepted|rejected|dropped|skipped|bought|buy_failed
  risk_score      double precision,
  quality_score   double precision,
  decision        text,                     -- accept|reject
  reasons         jsonb,                    -- array of human-readable strings
  checks          jsonb,                    -- array of {id,status,evidence,critical,detail}
  market_cap_sol  double precision,
  updated_at      bigint not null
);
create index if not exists idx_tokens_discovered on public.tokens (discovered_at desc);
create index if not exists idx_tokens_state on public.tokens (state);

-- ---------------------------------------------------------------- positions (one row per buy/sell cycle)
create table if not exists public.positions (
  id                  bigserial primary key,
  mint                text not null,
  symbol              text,
  mode                text not null,              -- paper|live — NEVER mixed in any aggregate query
  state               text not null,               -- opening|open|closing|stuck|closed|failed
  pool                text,
  decimals            integer not null default 6,
  token_raw           text not null default '0',   -- raw token amount as text (can exceed 2^53)
  cost_lamports       bigint not null default 0,    -- total SOL out of the wallet for the buy, incl. all fees
  proceeds_lamports   bigint not null default 0,    -- total SOL back from the sell, net of fees
  entry_price         double precision not null default 0,  -- SOL per whole token
  entry_value_lamports bigint not null default 0,
  peak_pnl_pct        double precision not null default 0,
  last_value_lamports bigint not null default 0,
  last_pnl_pct        double precision not null default 0,
  creator             text,
  creator_token_raw   text,
  entry_real_sol      double precision not null default 0,
  peak_real_sol       double precision not null default 0,
  breach_ticks        integer not null default 0,
  blind_since         bigint not null default 0,
  sell_attempts       integer not null default 0,
  buy_sig             text,
  sell_sig            text,
  exit_reason         text,
  opened_at           bigint not null,
  closed_at           bigint,
  note                text,
  rent_lamports       bigint not null default 0,   -- token-account rent paid at entry (recoverable on exit)
  curve               text                          -- bonding curve account address, if applicable
);
-- The core anti-double-buy guard: at most one position may be "active" for a given mint at a time.
create unique index if not exists uq_positions_active_mint on public.positions (mint)
  where state in ('opening', 'open', 'closing', 'stuck');
create index if not exists idx_positions_state on public.positions (state);
create index if not exists idx_positions_mode_state on public.positions (mode, state);

-- ---------------------------------------------------------------- orders (every buy/sell/close-account attempt)
create table if not exists public.orders (
  id                  bigserial primary key,
  position_id         bigint not null references public.positions(id) on delete cascade,
  side                text not null,          -- buy|sell
  route               text not null,          -- portal|jupiter|paper|close_account
  mode                text not null,          -- paper|live
  state               text not null,          -- created|submitted|confirmed|failed|unknown
  signature           text,
  slippage_pct        double precision,
  requested           text,
  error               text,
  sol_delta_lamports  bigint,
  fee_lamports        bigint,
  created_at          bigint not null,
  updated_at          bigint not null
);
create index if not exists idx_orders_position on public.orders (position_id);
create index if not exists idx_orders_pending on public.orders (state, mode);

-- ---------------------------------------------------------------- withdrawals (SOL out to an external address)
create table if not exists public.withdrawals (
  id              bigserial primary key,
  destination     text not null,
  amount_lamports bigint not null,
  fee_lamports    bigint not null default 0,
  status          text not null default 'draft',   -- draft|submitted|confirmed|failed|expired
  signature       text,
  error           text,
  requested_at    bigint not null,
  expires_at      bigint not null,
  confirmed_at    bigint
);
create index if not exists idx_withdrawals_status on public.withdrawals (status);
-- Deliberately NO unique constraint on (destination) or similar: the anti-double-withdrawal guard is the
-- draft -> submitted atomic transition in application code (Db.tryTransitionWithdrawal), not a schema
-- constraint, because a person may legitimately withdraw to the same address more than once over time.

-- ---------------------------------------------------------------- balance snapshots (audit trail / backup aid)
create table if not exists public.balance_snapshots (
  id                  bigserial primary key,
  mode                text not null,
  sol_lamports        bigint not null,
  reserved_lamports   bigint not null default 0,
  source              text not null,     -- periodic|manual_refresh|...
  created_at          bigint not null
);
create index if not exists idx_balance_snapshots_created on public.balance_snapshots (created_at desc);

-- ---------------------------------------------------------------- events (errors, warnings and notable actions)
create table if not exists public.events (
  id        bigserial primary key,
  ts        bigint not null,
  level     text not null,     -- debug|info|warn|error|critical
  source    text not null,
  message   text not null
);
create index if not exists idx_events_ts on public.events (ts desc);

-- ---------------------------------------------------------------- settings (runtime-tunable bot parameters)
create table if not exists public.settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  bigint not null
);

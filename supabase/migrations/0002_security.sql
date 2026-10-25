-- Solana Sniper — Row Level Security.
--
-- Design: the bot's backend is the ONLY client that ever talks to this database, authenticating with the
-- Supabase service_role key (see README "إعداد Supabase" — never the anon/public key). The service_role
-- role bypasses Row Level Security entirely; this is standard, built-in Postgres/Supabase behavior, not a
-- policy defined here. Everyone else — the anon key, any authenticated Supabase-Auth user, and in
-- particular a browser calling the Supabase REST API directly — gets ZERO access to every table in this
-- schema: no SELECT, no INSERT, no UPDATE, no DELETE.
--
-- This is deliberate defense in depth. The dashboard (web/) never talks to Supabase directly; it only
-- calls this bot's own HTTP API (src/server.ts), which is protected by DASHBOARD_TOKEN. Enabling RLS with
-- no permissive policies for anon/authenticated means that even if the anon key were ever leaked or
-- embedded somewhere by mistake, it could not read or write a single row of trading data, settings,
-- balances, or withdrawal history. There is deliberately no "add a policy later" escape hatch here: the
-- correct way to expose any of this data to a browser is through the bot's own authenticated API, not by
-- loosening RLS.

alter table public.tokens             enable row level security;
alter table public.positions          enable row level security;
alter table public.orders             enable row level security;
alter table public.withdrawals        enable row level security;
alter table public.balance_snapshots  enable row level security;
alter table public.events             enable row level security;
alter table public.settings           enable row level security;

-- Belt and suspenders: even a future bug that accidentally creates a permissive policy for anon or
-- authenticated still can't grant access, because the underlying table privilege is revoked outright.
revoke all on
  public.tokens, public.positions, public.orders, public.withdrawals,
  public.balance_snapshots, public.events, public.settings
from anon, authenticated;

-- No CREATE POLICY statements follow, on purpose: with RLS enabled and zero policies, every role other
-- than service_role (and the table owner) is denied by default. If you ever need a second, more limited
-- credential (e.g. a read-only reporting role), add it explicitly here with its own narrow policies rather
-- than relaxing anon/authenticated.

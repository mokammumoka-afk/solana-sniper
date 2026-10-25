import { DbConflictError, SupabaseRest, type SupabaseConfig } from './db/supabase-client.js';

export type PositionState = 'opening' | 'open' | 'closing' | 'stuck' | 'closed' | 'failed';
export const ACTIVE_STATES: PositionState[] = ['opening', 'open', 'closing', 'stuck'];

export interface PositionRow {
  id: number;
  mint: string;
  symbol: string;
  mode: 'paper' | 'live';
  state: PositionState;
  pool: string;
  decimals: number;
  token_raw: string;
  cost_lamports: number;
  proceeds_lamports: number;
  entry_price: number;
  entry_value_lamports: number;
  peak_pnl_pct: number;
  last_value_lamports: number;
  last_pnl_pct: number;
  creator: string | null;
  creator_token_raw: string | null;
  entry_real_sol: number;
  peak_real_sol: number;
  breach_ticks: number;
  blind_since: number;
  sell_attempts: number;
  buy_sig: string | null;
  sell_sig: string | null;
  exit_reason: string | null;
  opened_at: number;
  closed_at: number | null;
  note: string | null;
  rent_lamports: number;
  curve: string | null;
}

export interface OrderRow {
  id: number;
  position_id: number;
  side: 'buy' | 'sell';
  route: string;
  mode: 'paper' | 'live';
  state: 'created' | 'submitted' | 'confirmed' | 'failed' | 'unknown';
  signature: string | null;
  slippage_pct: number;
  requested: string;
  error: string | null;
  sol_delta_lamports: number | null;
  fee_lamports: number | null;
  created_at: number;
  updated_at: number;
}

export type WithdrawalStatus = 'draft' | 'submitted' | 'confirmed' | 'failed' | 'expired';
export interface WithdrawalRow {
  id: number;
  destination: string;
  amount_lamports: number;
  fee_lamports: number;
  status: WithdrawalStatus;
  signature: string | null;
  error: string | null;
  requested_at: number;
  expires_at: number;
  confirmed_at: number | null;
}

export interface BalanceSnapshotRow {
  id: number;
  mode: 'paper' | 'live';
  sol_lamports: number;
  reserved_lamports: number;
  source: string;
  created_at: number;
}

export interface ErrorRow {
  id: number;
  ts: number;
  level: string;
  source: string;
  message: string;
}

/** Thin async wrapper over Supabase/PostgREST. Every method mirrors the previous SQLite API 1:1 in shape,
 *  but now returns a Promise, since every call is a network round-trip. See supabase/migrations for schema. */
export class Db {
  private readonly sb: SupabaseRest;
  constructor(cfg: SupabaseConfig) {
    this.sb = new SupabaseRest(cfg);
  }

  get health() {
    return this.sb.stats;
  }

  /** Checks connectivity at startup. Throws with a clear message if Supabase/the schema is unreachable. */
  async connect(): Promise<void> {
    const ok = await this.sb.ping();
    if (!ok) throw new Error(`cannot reach Supabase at the configured URL, or the "settings" table/migrations are missing (${this.sb.stats.lastError})`);
  }

  close(): void {
    /* no persistent connection to close over HTTP; kept for API parity with the previous SQLite backend */
  }

  // ---- kv / settings
  async getKv(k: string): Promise<string | null> {
    const rows = await this.sb.select<{ value: unknown }>('settings', `key=eq.${encodeURIComponent(k)}&select=value`);
    return rows.length ? JSON.stringify(rows[0].value) : null;
  }
  async setKv(k: string, v: string): Promise<void> {
    await this.sb.insert('settings?on_conflict=key', { key: k, value: JSON.parse(v), updated_at: Date.now() }, 'resolution=merge-duplicates,return=minimal');
  }

  // ---- tokens
  async insertTokenIfNew(t: { mint: string; symbol?: string; name?: string; source: string; pool?: string; creator?: string; bondingCurve?: string; discoveredAt: number; marketCapSol?: number }): Promise<boolean> {
    // on_conflict=mint is explicit even though mint is already the primary key, so PostgREST never has to
    // guess the conflict target; the response body is empty (0 rows) exactly when the row was a duplicate.
    const rows = await this.sb.insert(
      'tokens?on_conflict=mint',
      {
        mint: t.mint, symbol: t.symbol ?? null, name: t.name ?? null, source: t.source, pool: t.pool ?? null,
        creator: t.creator ?? null, bonding_curve: t.bondingCurve ?? null, discovered_at: t.discoveredAt,
        state: 'discovered', market_cap_sol: t.marketCapSol ?? null, updated_at: t.discoveredAt,
      },
      'resolution=ignore-duplicates,return=representation',
    );
    return rows.length > 0;
  }
  async setTokenState(mint: string, f: { state: string; risk?: number; quality?: number; decision?: string; reasons?: string[]; checks?: unknown; marketCapSol?: number }): Promise<void> {
    const patch: Record<string, unknown> = { state: f.state, updated_at: Date.now() };
    if (f.risk !== undefined) patch.risk_score = f.risk;
    if (f.quality !== undefined) patch.quality_score = f.quality;
    if (f.decision !== undefined) patch.decision = f.decision;
    if (f.reasons !== undefined) patch.reasons = f.reasons;
    if (f.checks !== undefined) patch.checks = f.checks;
    if (f.marketCapSol !== undefined) patch.market_cap_sol = f.marketCapSol;
    await this.sb.update('tokens', `mint=eq.${encodeURIComponent(mint)}`, patch);
  }
  async getToken(mint: string): Promise<Record<string, any> | undefined> {
    const rows = await this.sb.select<Record<string, any>>('tokens', `mint=eq.${encodeURIComponent(mint)}&select=*`);
    return rows[0];
  }
  async listTokens(limit = 100): Promise<Record<string, any>[]> {
    return this.sb.select('tokens', `select=*&order=discovered_at.desc&limit=${limit}`);
  }
  async tokenCounts(): Promise<Record<string, number>> {
    const states = ['discovered', 'watching', 'accepted', 'rejected', 'dropped', 'skipped', 'bought', 'buy_failed'];
    const out: Record<string, number> = {};
    await Promise.all(
      states.map(async (s) => {
        const n = await this.sb.count('tokens', `state=eq.${s}`);
        if (n > 0) out[s] = n;
      }),
    );
    return out;
  }

  // ---- positions
  /** Throws DbConflictError on the partial-unique-index violation = the guard against double-buying the same mint. */
  async insertPosition(p: { mint: string; symbol: string; mode: 'paper' | 'live'; pool: string; creator?: string | null; curve?: string | null }): Promise<number> {
    const rows = await this.sb.insert<{ id: number }>('positions', {
      mint: p.mint, symbol: p.symbol, mode: p.mode, state: 'opening', pool: p.pool, creator: p.creator ?? null, curve: p.curve ?? null, opened_at: Date.now(),
    });
    return rows[0].id;
  }
  async updatePosition(id: number, f: Partial<Omit<PositionRow, 'id'>>): Promise<void> {
    if (!Object.keys(f).length) return;
    await this.sb.update('positions', `id=eq.${id}`, f);
  }
  async getPosition(id: number): Promise<PositionRow | undefined> {
    const rows = await this.sb.select<PositionRow>('positions', `id=eq.${id}&select=*`);
    return rows[0];
  }
  async listPositions(states?: PositionState[], limit = 200): Promise<PositionRow[]> {
    const filter = states?.length ? `state=in.(${states.join(',')})&` : '';
    return this.sb.select('positions', `${filter}select=*&order=id.desc&limit=${limit}`);
  }
  async activePositions(mode?: 'paper' | 'live'): Promise<PositionRow[]> {
    const rows = await this.listPositions(ACTIVE_STATES);
    return mode ? rows.filter((r) => r.mode === mode) : rows;
  }
  async hasEverTraded(mint: string): Promise<boolean> {
    const rows = await this.sb.select('positions', `mint=eq.${encodeURIComponent(mint)}&select=id&limit=1`);
    return rows.length > 0;
  }

  // ---- orders
  async insertOrder(o: { position_id: number; side: 'buy' | 'sell'; route: string; mode: 'paper' | 'live'; slippage_pct: number; requested: string }): Promise<number> {
    const now = Date.now();
    const rows = await this.sb.insert<{ id: number }>('orders', { ...o, state: 'created', created_at: now, updated_at: now });
    return rows[0].id;
  }
  async updateOrder(id: number, f: Partial<Omit<OrderRow, 'id'>>): Promise<void> {
    await this.sb.update('orders', `id=eq.${id}`, { ...f, updated_at: Date.now() });
  }
  async listOrders(limit = 100, positionId?: number): Promise<OrderRow[]> {
    if (positionId !== undefined) return this.sb.select('orders', `position_id=eq.${positionId}&select=*&order=id.desc`);
    return this.sb.select('orders', `select=*&order=id.desc&limit=${limit}`);
  }
  async pendingOrders(): Promise<OrderRow[]> {
    return this.sb.select('orders', `state=in.(submitted,unknown)&mode=eq.live&select=*`);
  }

  // ---- withdrawals
  async insertWithdrawalDraft(w: { destination: string; amountLamports: number; feeLamports: number; expiresAt: number }): Promise<WithdrawalRow> {
    const now = Date.now();
    const rows = await this.sb.insert<WithdrawalRow>('withdrawals', {
      destination: w.destination, amount_lamports: w.amountLamports, fee_lamports: w.feeLamports,
      status: 'draft', requested_at: now, expires_at: w.expiresAt,
    });
    return rows[0];
  }
  /** Atomic compare-and-swap: only succeeds if the row is still exactly `fromStatus`. Returns the updated
   *  row, or null if someone/something else already moved it on — the guard against a duplicate withdrawal. */
  async tryTransitionWithdrawal(id: number, fromStatus: WithdrawalStatus, patch: Partial<Omit<WithdrawalRow, 'id'>>): Promise<WithdrawalRow | null> {
    const rows = await this.sb.update<WithdrawalRow>('withdrawals', `id=eq.${id}&status=eq.${fromStatus}`, patch);
    return rows[0] ?? null;
  }
  async updateWithdrawal(id: number, patch: Partial<Omit<WithdrawalRow, 'id'>>): Promise<void> {
    await this.sb.update('withdrawals', `id=eq.${id}`, patch);
  }
  async getWithdrawal(id: number): Promise<WithdrawalRow | undefined> {
    const rows = await this.sb.select<WithdrawalRow>('withdrawals', `id=eq.${id}&select=*`);
    return rows[0];
  }
  async listWithdrawals(limit = 50): Promise<WithdrawalRow[]> {
    return this.sb.select('withdrawals', `select=*&order=id.desc&limit=${limit}`);
  }
  async pendingWithdrawals(): Promise<WithdrawalRow[]> {
    return this.sb.select('withdrawals', `status=in.(submitted)&select=*`);
  }

  // ---- balance snapshots
  async recordBalanceSnapshot(s: { mode: 'paper' | 'live'; solLamports: number; reservedLamports: number; source: string }): Promise<void> {
    await this.sb.insert('balance_snapshots', { mode: s.mode, sol_lamports: s.solLamports, reserved_lamports: s.reservedLamports, source: s.source, created_at: Date.now() }, 'return=minimal');
  }
  async listBalanceSnapshots(limit = 200): Promise<BalanceSnapshotRow[]> {
    return this.sb.select('balance_snapshots', `select=*&order=created_at.desc&limit=${limit}`);
  }

  // ---- events / errors
  async logError(level: string, source: string, message: string): Promise<void> {
    try {
      await this.sb.insert('events', { ts: Date.now(), level, source, message: message.slice(0, 2000) }, 'return=minimal');
    } catch {
      /* logging must never throw and take down the caller */
    }
  }
  logEvent = this.logError.bind(this);
  async listErrors(limit = 100): Promise<ErrorRow[]> {
    return this.sb.select('events', `select=*&order=id.desc&limit=${limit}`);
  }

  // ---- pnl aggregates (live and paper never mixed)
  async realizedLamports(mode: 'paper' | 'live', sinceMs = 0): Promise<number> {
    const rows = await this.sb.select<{ cost_lamports: number; proceeds_lamports: number }>(
      'positions',
      `mode=eq.${mode}&state=eq.closed&closed_at=gte.${sinceMs}&select=cost_lamports,proceeds_lamports`,
    );
    return rows.reduce((s, r) => s + (r.proceeds_lamports - r.cost_lamports), 0);
  }
  async stats(mode: 'paper' | 'live'): Promise<{ closed: number; wins: number; feesLamports: number }> {
    const rows = await this.sb.select<{ cost_lamports: number; proceeds_lamports: number }>('positions', `mode=eq.${mode}&state=eq.closed&select=cost_lamports,proceeds_lamports`);
    const fees = await this.sb.select<{ fee_lamports: number | null }>('orders', `mode=eq.${mode}&select=fee_lamports`);
    return {
      closed: rows.length,
      wins: rows.filter((r) => r.proceeds_lamports > r.cost_lamports).length,
      feesLamports: fees.reduce((s, r) => s + (r.fee_lamports ?? 0), 0),
    };
  }

  // ---- idempotent raw passthrough, used by test helpers / ops scripts only
  get rest(): SupabaseRest {
    return this.sb;
  }
}

export { DbConflictError };

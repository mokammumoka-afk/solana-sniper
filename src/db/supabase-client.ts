/**
 * Minimal PostgREST (Supabase REST) client built on the standard `fetch`, consistent with this project's
 * zero-runtime-dependency approach. Talks to `${SUPABASE_URL}/rest/v1/<table>` using the service-role key.
 *
 * The service-role key is a DATABASE credential, scoped by Postgres role and Row Level Security — it has
 * no relationship whatsoever to the Solana wallet's private key, which never leaves util/keypair.ts and is
 * never sent to Supabase. See supabase/migrations/0002_security.sql for the RLS policy that keeps this key
 * from ever granting access to anyone but this backend.
 */
import { log } from '../util/log.js';

export class DbError extends Error {
  constructor(message: string, public readonly status?: number, public readonly retryable = false) {
    super(message);
  }
}
/** A unique-constraint / conflict response (HTTP 409) from Postgres — e.g. "position already open for this mint". */
export class DbConflictError extends DbError {}

export interface SupabaseConfig {
  url: string;
  serviceRoleKey: string;
  timeoutMs?: number;
  retries?: number;
  fetchFn?: typeof fetch;
}

export interface RequestOpts {
  body?: unknown;
  prefer?: string;
  accept?: string;
}

export class SupabaseRest {
  readonly stats = { calls: 0, errors: 0, lastOkAt: 0, lastErrorAt: 0, lastError: '' };
  private readonly base: string;
  constructor(private readonly cfg: SupabaseConfig) {
    this.base = `${cfg.url.replace(/\/+$/, '')}/rest/v1`;
  }

  private headers(opts: RequestOpts): Record<string, string> {
    const h: Record<string, string> = {
      apikey: this.cfg.serviceRoleKey,
      authorization: `Bearer ${this.cfg.serviceRoleKey}`,
      'content-type': 'application/json',
    };
    if (opts.prefer) h.prefer = opts.prefer;
    if (opts.accept) h.accept = opts.accept;
    return h;
  }

  /** `path` is `table?query=string` using raw PostgREST filter syntax (e.g. `positions?id=eq.5&select=*`). */
  async request<T = unknown>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'HEAD', path: string, opts: RequestOpts = {}): Promise<{ data: T; headers: Headers; status: number }> {
    const retries = this.cfg.retries ?? 3;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const r = await this.once<T>(method, path, opts);
        this.stats.lastOkAt = Date.now();
        return r;
      } catch (e) {
        lastErr = e;
        this.stats.errors++;
        this.stats.lastErrorAt = Date.now();
        this.stats.lastError = (e as Error).message;
        const retryable = e instanceof DbError ? e.retryable : true;
        if (!retryable || attempt === retries) break;
        const wait = 300 * 2 ** attempt + Math.random() * 150;
        log.debug(`supabase ${method} ${path} retry ${attempt + 1} in ${Math.round(wait)}ms: ${(e as Error).message}`);
        await new Promise((res) => setTimeout(res, wait));
      }
    }
    throw lastErr;
  }

  private async once<T>(method: string, path: string, opts: RequestOpts): Promise<{ data: T; headers: Headers; status: number }> {
    this.stats.calls++;
    const f = this.cfg.fetchFn ?? fetch;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 10_000);
    try {
      const res = await f(`${this.base}/${path}`, {
        method,
        headers: this.headers(opts),
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: ctrl.signal,
      });
      if (res.status === 429 || res.status >= 500) throw new DbError(`Supabase HTTP ${res.status}: ${await safeText(res)}`, res.status, true);
      if (res.status === 409) throw new DbConflictError(`Supabase conflict: ${await safeText(res)}`, 409, false);
      if (!res.ok) throw new DbError(`Supabase HTTP ${res.status}: ${await safeText(res)}`, res.status, false);
      if (method === 'HEAD') return { data: undefined as T, headers: res.headers, status: res.status };
      const text = await res.text();
      const data = text ? (JSON.parse(text) as T) : (undefined as T);
      return { data, headers: res.headers, status: res.status };
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw new DbError('Supabase request timeout', undefined, true);
      if (e instanceof DbError) throw e;
      throw new DbError(`Supabase network error: ${(e as Error).message}`, undefined, true);
    } finally {
      clearTimeout(timer);
    }
  }

  async select<T>(table: string, query: string): Promise<T[]> {
    const r = await this.request<T[]>('GET', `${table}?${query}`);
    return r.data ?? [];
  }

  /** `prefer` defaults to returning the inserted rows; pass `resolution=ignore-duplicates` for insert-if-new. */
  async insert<T>(table: string, rows: unknown, prefer = 'return=representation'): Promise<T[]> {
    const r = await this.request<T[]>('POST', table, { body: rows, prefer });
    return r.data ?? [];
  }

  /** Conditional update: returns the rows that actually matched `query` and were changed — an empty array
   *  means nothing matched (useful as an atomic compare-and-swap, e.g. "only if status still = draft"). */
  async update<T>(table: string, query: string, patch: unknown): Promise<T[]> {
    const r = await this.request<T[]>('PATCH', `${table}?${query}`, { body: patch, prefer: 'return=representation' });
    return r.data ?? [];
  }

  async delete(table: string, query: string): Promise<void> {
    await this.request('DELETE', `${table}?${query}`);
  }

  /** Exact row count for `query` via a HEAD request + the `Content-Range` header, without transferring rows. */
  async count(table: string, query: string): Promise<number> {
    const r = await this.request('HEAD', `${table}?${query}&limit=0`, { prefer: 'count=exact' });
    const range = r.headers.get('content-range'); // format: "*/<n>" or "0-0/<n>"
    const n = range ? Number(range.split('/')[1]) : NaN;
    return Number.isFinite(n) ? n : 0;
  }

  /** Lightweight connectivity probe used at startup and by the health watchdog. */
  async ping(): Promise<boolean> {
    try {
      await this.request('HEAD', 'settings?limit=0');
      return true;
    } catch {
      return false;
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}

export const qs = {
  eq: (v: string | number) => `eq.${v}`,
  in: (vals: Array<string | number>) => `in.(${vals.join(',')})`,
  gte: (v: string | number) => `gte.${v}`,
  encode: (v: string) => encodeURIComponent(v),
};

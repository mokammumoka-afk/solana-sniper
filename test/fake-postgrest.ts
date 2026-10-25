import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';

/**
 * A small, honest, real HTTP server that implements the exact subset of PostgREST's wire protocol this
 * project's SupabaseRest client uses: eq/in/gte filters, order, limit, select, Prefer (return=
 * representation|minimal, resolution=ignore-duplicates|merge-duplicates, count=exact), Content-Range on
 * HEAD, and 409 on unique-constraint conflicts (including a partial-unique "one active position per mint"
 * constraint, mirroring supabase/migrations/0001_schema.sql).
 *
 * This is NOT a mock of fetch — tests that use it make real HTTP requests over a real socket to a real
 * node:http server, so the client's networking code (retries, timeouts, header handling, JSON parsing) is
 * genuinely exercised. It is also not real Supabase/Postgres: see README "Testing against Supabase" for
 * what that does and doesn't prove.
 */
export interface TableSpec {
  pk: string;
  serial?: boolean; // auto-increment integer id
  unique?: Array<{ column: string; where: (row: any) => boolean }>;
  /** Mirrors each column's `DEFAULT` in supabase/migrations/0001_schema.sql — applied to any column the
   *  insert payload omits, exactly like real Postgres (so the app can rely on column defaults here too,
   *  not just against real Supabase). */
  defaults?: Record<string, unknown>;
}

const SCHEMA: Record<string, TableSpec> = {
  tokens: { pk: 'mint' },
  positions: {
    pk: 'id', serial: true,
    unique: [{ column: 'mint', where: (r) => ['opening', 'open', 'closing', 'stuck'].includes(r.state) }],
    defaults: {
      decimals: 6, token_raw: '0', cost_lamports: 0, proceeds_lamports: 0, entry_price: 0, entry_value_lamports: 0,
      peak_pnl_pct: 0, last_value_lamports: 0, last_pnl_pct: 0, creator: null, creator_token_raw: null,
      entry_real_sol: 0, peak_real_sol: 0, breach_ticks: 0, blind_since: 0, sell_attempts: 0,
      buy_sig: null, sell_sig: null, exit_reason: null, closed_at: null, note: null, rent_lamports: 0, curve: null, pool: null,
    },
  },
  orders: { pk: 'id', serial: true, defaults: { signature: null, slippage_pct: null, error: null, sol_delta_lamports: null, fee_lamports: null } },
  withdrawals: { pk: 'id', serial: true, defaults: { status: 'draft', fee_lamports: 0, signature: null, error: null, confirmed_at: null } },
  balance_snapshots: { pk: 'id', serial: true, defaults: { reserved_lamports: 0 } },
  events: { pk: 'id', serial: true },
  settings: { pk: 'key' },
};

type Row = Record<string, unknown>;

function matchOp(value: unknown, op: string): boolean {
  const [kind, raw] = op.split(/\.(.*)/s).filter((_, i) => i < 2) as [string, string];
  if (kind === 'eq') return String(value) === raw;
  if (kind === 'gte') return Number(value) >= Number(raw);
  if (kind === 'in') {
    const set = raw.replace(/^\(|\)$/g, '').split(',');
    return set.includes(String(value));
  }
  throw new Error(`unsupported filter op: ${op}`);
}

export class FakePostgrest {
  tables: Record<string, Row[]> = Object.fromEntries(Object.keys(SCHEMA).map((t) => [t, []]));
  private seq: Record<string, number> = Object.fromEntries(Object.keys(SCHEMA).map((t) => [t, 0]));
  server: Server;
  url = '';
  down = false; // simulate an outage: every request fails at the socket level
  failNext = 0; // simulate N consecutive 500s then recover (retry behavior)
  requests: Array<{ method: string; path: string }> = [];

  constructor() {
    this.server = createServer((req, res) => {
      if (this.down) {
        req.socket.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          this.handle(req.method!, req.url!, req.headers as Record<string, string>, Buffer.concat(chunks), res);
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: (e as Error).message }));
        }
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const addr = this.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    this.url = `http://127.0.0.1:${port}`;
  }
  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(method: string, url: string, headers: Record<string, string>, body: Buffer, res: import('node:http').ServerResponse): void {
    if (this.failNext > 0) {
      this.failNext--;
      res.writeHead(500, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ message: 'simulated transient failure' }));
    }
    const u = new URL(url, 'http://x');
    const path = u.pathname.replace(/^\/rest\/v1\//, '');
    const [table, ocPart] = path.split('?')[0].split('&')[0].split('?'); // table name only (query is in u.searchParams)
    const tableName = table;
    this.requests.push({ method, path: u.pathname + u.search });
    if (!SCHEMA[tableName]) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ message: `unknown table ${tableName}` }));
    }
    if (!headers.apikey || !headers.authorization) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ message: 'missing apikey' }));
    }
    const spec = SCHEMA[tableName];
    const rows = this.tables[tableName];
    const prefer = (headers.prefer ?? '').split(',').map((s) => s.trim());
    const wantsRepresentation = prefer.includes('return=representation');
    const resolution = prefer.find((p) => p.startsWith('resolution='))?.split('=')[1];
    const onConflictCol = u.searchParams.get('on_conflict');

    const filters: Array<[string, string]> = [];
    for (const [k, v] of u.searchParams.entries()) if (!['select', 'order', 'limit', 'on_conflict'].includes(k)) filters.push([k, v]);
    const matchesFilters = (row: Row) => filters.every(([k, v]) => matchOp(row[k], v));

    if (method === 'HEAD') {
      const n = rows.filter(matchesFilters).length;
      res.writeHead(200, { 'content-range': `0-0/${n}` });
      return void res.end();
    }

    if (method === 'GET') {
      let out = rows.filter(matchesFilters);
      const order = u.searchParams.get('order');
      if (order) {
        const [col, dir] = order.split('.');
        out = [...out].sort((a, b) => (a[col] as any) < (b[col] as any) ? -1 : (a[col] as any) > (b[col] as any) ? 1 : 0);
        if (dir === 'desc') out.reverse();
      }
      const limit = u.searchParams.get('limit');
      if (limit) out = out.slice(0, Number(limit));
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify(out));
    }

    if (method === 'POST') {
      const payload = body.length ? JSON.parse(body.toString('utf8')) : {};
      const incoming: Row[] = Array.isArray(payload) ? payload : [payload];
      const inserted: Row[] = [];
      for (const r of incoming) {
        const row: Row = { ...(spec.defaults ?? {}), ...r };
        if (spec.serial) row.id = ++this.seq[tableName];
        const conflictSpecs = onConflictCol ? [{ column: onConflictCol, where: () => true }] : spec.unique ?? (spec.pk && !spec.serial ? [{ column: spec.pk, where: () => true }] : []);
        let conflictRow: Row | undefined;
        for (const c of conflictSpecs) {
          if (!c.where(row)) continue;
          conflictRow = rows.find((existing) => c.where(existing) && existing[c.column] === row[c.column]);
          if (conflictRow) break;
        }
        if (conflictRow) {
          if (resolution === 'ignore-duplicates') continue; // not inserted, not returned
          if (resolution === 'merge-duplicates') {
            Object.assign(conflictRow, r);
            inserted.push(conflictRow);
            continue;
          }
          res.writeHead(409, { 'content-type': 'application/json' });
          return void res.end(JSON.stringify({ code: '23505', message: `duplicate key value violates unique constraint` }));
        }
        rows.push(row);
        inserted.push(row);
      }
      res.writeHead(201, { 'content-type': 'application/json', 'content-range': `*/${inserted.length}` });
      return void res.end(JSON.stringify(wantsRepresentation ? inserted : []));
    }

    if (method === 'PATCH') {
      const patch = JSON.parse(body.toString('utf8'));
      const matched = rows.filter(matchesFilters);
      for (const row of matched) Object.assign(row, patch);
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify(wantsRepresentation ? matched : []));
    }

    if (method === 'DELETE') {
      const keep = rows.filter((r) => !matchesFilters(r));
      const removed = rows.length - keep.length;
      this.tables[tableName] = keep;
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify([]));
    }

    res.writeHead(405, {});
    res.end();
  }
}

export async function withFakeDb<T>(fn: (url: string, fake: FakePostgrest) => Promise<T>): Promise<T> {
  const fake = new FakePostgrest();
  await fake.start();
  try {
    return await fn(fake.url, fake);
  } finally {
    await fake.stop();
  }
}

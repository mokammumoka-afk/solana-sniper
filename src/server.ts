import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Engine } from './engine.js';
import type { Db } from './db.js';
import { log } from './util/log.js';

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const STATIC: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
};

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8'): void {
  const payload = typeof body === 'string' ? body : JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 16_384) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('body must be a JSON object');
  return v as Record<string, unknown>;
}

export function createApp(engine: Engine, db: Db, token: string): Server {
  const failures = new Map<string, { n: number; at: number }>();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      const st = STATIC[url.pathname];
      if (req.method === 'GET' && st) return send(res, 200, readFileSync(join(WEB_DIR, st[0]), 'utf8'), st[1]);
      if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });

      const ip = req.socket.remoteAddress ?? '?';
      const f = failures.get(ip);
      if (f && f.n >= 8 && Date.now() - f.at < 60_000) return send(res, 429, { error: 'too many failed attempts' });
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Bearer ') || !safeEqual(auth.slice(7), token)) {
        failures.set(ip, { n: (f && Date.now() - f.at < 60_000 ? f.n : 0) + 1, at: Date.now() });
        return send(res, 401, { error: 'unauthorized' });
      }
      failures.delete(ip);
      if (req.method === 'POST' && req.headers['x-requested-with'] !== 'sniper-ui') return send(res, 403, { error: 'missing x-requested-with header' });

      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 100) || 100));
      if (req.method === 'GET') {
        switch (url.pathname) {
          case '/api/state':
            return send(res, 200, await engine.status());
          case '/api/tokens':
            return send(res, 200, (await db.listTokens(limit)).map((t) => ({ ...t, reasons: t.reasons ?? [], checks: t.checks ?? [] })));
          case '/api/positions': {
            const positions = await db.listPositions(undefined, limit);
            const withOrders = await Promise.all(positions.map(async (p) => ({ ...p, orders: await db.listOrders(0, p.id) })));
            return send(res, 200, withOrders);
          }
          case '/api/orders':
            return send(res, 200, await db.listOrders(limit));
          case '/api/errors':
            return send(res, 200, await db.listErrors(limit));
          case '/api/wallet':
            return send(res, 200, await engine.walletInfo());
          case '/api/withdrawals':
            return send(res, 200, await db.listWithdrawals(limit));
        }
        return send(res, 404, { error: 'not found' });
      }
      if (req.method === 'POST') {
        const body = await readJson(req);
        switch (url.pathname) {
          case '/api/settings': {
            const r = await engine.updateSettings(body);
            return send(res, r.ok ? 200 : 400, r);
          }
          case '/api/kill':
            await engine.kill(body.closeAll === true);
            return send(res, 200, { ok: true });
          case '/api/resume': {
            const r = await engine.resume();
            return send(res, r.ok ? 200 : 409, r);
          }
          case '/api/arm': {
            const r = engine.arm(String(body.phrase ?? ''));
            return send(res, r.ok ? 200 : 400, r);
          }
          case '/api/disarm':
            engine.disarm();
            return send(res, 200, { ok: true });
          case '/api/close': {
            const id = Number(body.id);
            if (!Number.isInteger(id)) return send(res, 400, { error: 'id must be an integer' });
            return send(res, 200, await engine.manualClose(id));
          }
          case '/api/withdraw/prepare': {
            const destination = String(body.destination ?? '').trim();
            const amount = body.amount === 'max' ? 'max' : Number(body.amount);
            if (!destination) return send(res, 400, { ok: false, error: 'destination is required' });
            if (amount !== 'max' && (!Number.isFinite(amount) || amount <= 0)) return send(res, 400, { ok: false, error: 'amount must be a positive number or "max"' });
            const r = await engine.prepareWithdrawal(destination, amount as number | 'max');
            return send(res, r.ok ? 200 : 400, r);
          }
          case '/api/withdraw/confirm': {
            const id = Number(body.id);
            if (!Number.isInteger(id)) return send(res, 400, { ok: false, error: 'id must be an integer' });
            const r = await engine.confirmWithdrawal(id);
            return send(res, r.ok ? 200 : 400, r);
          }
        }
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      log.error('http error', (e as Error).message);
      send(res, 400, { error: (e as Error).message });
    }
  });
  return server;
}

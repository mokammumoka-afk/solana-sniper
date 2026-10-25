import { isValidSolanaAddress } from '../util/base58.js';
import { log } from '../util/log.js';

export interface NewTokenEvent {
  mint: string;
  symbol?: string;
  name?: string;
  creator: string | null;
  bondingCurve: string | null;
  pool: string;
  marketCapSol: number | null;
  devInitialBuyPct: number | null;
  signature?: string;
  discoveredAt: number;
  source: 'pumpportal:subscribeNewToken';
}

export interface FeedStatus {
  connected: boolean;
  lastMessageAt: number;
  connectedAt: number;
  reconnects: number;
  received: number;
  duplicates: number;
  invalid: number;
  lastError: string;
}

type WsCtor = new (url: string) => WebSocket;

/** Parses one PumpPortal message. Returns null for non-creation messages (acks, errors) and for malformed events. */
export function parseNewToken(raw: unknown, now = Date.now()): NewTokenEvent | null | 'invalid' {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, any>;
  if (m.txType !== 'create' || m.mint === undefined) return null;
  if (!isValidSolanaAddress(m.mint)) return 'invalid';
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const initialBuy = num(m.initialBuy);
  return {
    mint: m.mint,
    symbol: typeof m.symbol === 'string' ? m.symbol.slice(0, 32) : undefined,
    name: typeof m.name === 'string' ? m.name.slice(0, 64) : undefined,
    creator: isValidSolanaAddress(m.traderPublicKey) ? m.traderPublicKey : null,
    bondingCurve: isValidSolanaAddress(m.bondingCurveKey) ? m.bondingCurveKey : null,
    pool: typeof m.pool === 'string' ? m.pool : 'pump',
    marketCapSol: num(m.marketCapSol),
    // initialBuy is the creator's first purchase in whole tokens; pump.fun supply is 1,000,000,000
    devInitialBuyPct: initialBuy === null ? null : (initialBuy / 1_000_000_000) * 100,
    signature: typeof m.signature === 'string' ? m.signature : undefined,
    discoveredAt: now,
    source: 'pumpportal:subscribeNewToken',
  };
}

/** One shared WebSocket (PumpPortal bans clients that open many). Auto-reconnect with backoff, stale-stream watchdog, de-duplication. */
export class NewTokenFeed {
  readonly status: FeedStatus = { connected: false, lastMessageAt: 0, connectedAt: 0, reconnects: 0, received: 0, duplicates: 0, invalid: 0, lastError: '' };
  private ws: WebSocket | null = null;
  private stopped = true;
  private attempt = 0;
  private seen = new Set<string>();
  private watchdog?: ReturnType<typeof setInterval>;
  private retryTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly url: string,
    private readonly onToken: (e: NewTokenEvent) => void,
    private readonly opts: { apiKey?: string; staleMs?: number; wsCtor?: WsCtor; maxSeen?: number } = {},
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
    this.watchdog = setInterval(() => {
      const stale = this.opts.staleMs ?? 90_000;
      if (this.status.connected && Date.now() - Math.max(this.status.lastMessageAt, this.status.connectedAt) > stale) {
        log.warn('feed: no messages, forcing reconnect');
        this.status.lastError = 'stale stream';
        this.ws?.close();
      }
    }, 10_000);
    this.watchdog.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close();
    this.status.connected = false;
  }

  private connect(): void {
    if (this.stopped) return;
    const Ctor = this.opts.wsCtor ?? (globalThis.WebSocket as unknown as WsCtor);
    const url = this.opts.apiKey ? `${this.url}?api-key=${encodeURIComponent(this.opts.apiKey)}` : this.url;
    let ws: WebSocket;
    try {
      ws = new Ctor(url);
    } catch (e) {
      this.status.lastError = (e as Error).message;
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.attempt = 0;
      this.status.connected = true;
      this.status.connectedAt = Date.now();
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
      log.info('feed: connected, subscribed to new tokens');
    });
    ws.addEventListener('message', (ev: MessageEvent) => {
      this.status.lastMessageAt = Date.now();
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        this.status.invalid++;
        return;
      }
      const e = parseNewToken(parsed);
      if (e === null) return;
      if (e === 'invalid') {
        this.status.invalid++;
        return;
      }
      if (this.seen.has(e.mint)) {
        this.status.duplicates++;
        return;
      }
      this.seen.add(e.mint);
      if (this.seen.size > (this.opts.maxSeen ?? 20_000)) this.seen.delete(this.seen.values().next().value as string);
      this.status.received++;
      try {
        this.onToken(e);
      } catch (err) {
        log.error('feed: handler error', err);
      }
    });
    ws.addEventListener('error', () => {
      this.status.lastError = 'websocket error';
    });
    ws.addEventListener('close', () => {
      if (this.ws === ws) this.status.connected = false;
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer) return;
    this.status.reconnects++;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt++, 5)) + Math.random() * 500;
    log.warn(`feed: reconnecting in ${Math.round(delay)}ms`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, delay);
  }
}

/** Jupiter Swap API (Metis v1): GET /quote, POST /swap. Base URL and API key are configurable because Jupiter has been migrating hosts. */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export interface JupQuote {
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  [k: string]: unknown;
}

export interface JupiterLike {
  quote(inputMint: string, outputMint: string, amountRaw: bigint, slippageBps: number): Promise<JupQuote>;
  swapTx(quote: JupQuote, userPublicKey: string, priorityLamports: number): Promise<Uint8Array>;
}

export class JupiterClient implements JupiterLike {
  constructor(private readonly base: string, private readonly apiKey?: string, private readonly fetchFn: typeof fetch = fetch) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) h['x-api-key'] = this.apiKey;
    return h;
  }

  private async req(url: string, init: RequestInit): Promise<any> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await this.fetchFn(url, { ...init, signal: ctrl.signal });
      const text = await res.text();
      if (!res.ok) throw new Error(`Jupiter ${res.status}: ${text.slice(0, 300)}`);
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
    }
  }

  async quote(inputMint: string, outputMint: string, amountRaw: bigint, slippageBps: number): Promise<JupQuote> {
    const qs = new URLSearchParams({ inputMint, outputMint, amount: amountRaw.toString(), slippageBps: String(Math.round(slippageBps)), restrictIntermediateTokens: 'true' });
    const q = await this.req(`${this.base}/quote?${qs}`, { headers: this.headers() });
    if (!q || typeof q.outAmount !== 'string') throw new Error('Jupiter returned no route');
    return q as JupQuote;
  }

  async swapTx(quote: JupQuote, userPublicKey: string, priorityLamports: number): Promise<Uint8Array> {
    const body = {
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: Math.max(0, Math.round(priorityLamports)),
    };
    const r = await this.req(`${this.base}/swap`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) });
    if (typeof r.swapTransaction !== 'string') throw new Error('Jupiter swap response missing swapTransaction');
    return new Uint8Array(Buffer.from(r.swapTransaction, 'base64'));
  }
}

/** SOL/USD from Jupiter itself (1 SOL -> USDC quote), cached. Returns null when unavailable: callers must refuse USD-dependent actions. */
export class SolUsdPrice {
  private cached: { v: number; at: number } | null = null;
  constructor(private readonly jup: JupiterLike, private readonly ttlMs = 30_000) {}
  async get(): Promise<number | null> {
    if (this.cached && Date.now() - this.cached.at < this.ttlMs) return this.cached.v;
    try {
      const q = await this.jup.quote(WSOL_MINT, USDC_MINT, 1_000_000_000n, 50);
      const v = Number(q.outAmount) / 1e6;
      if (!Number.isFinite(v) || v <= 0) throw new Error('bad price');
      this.cached = { v, at: Date.now() };
      return v;
    } catch {
      // keep serving a recent value for up to 5 minutes, then report unavailable
      if (this.cached && Date.now() - this.cached.at < 300_000) return this.cached.v;
      return null;
    }
  }
  lastKnown(): { v: number; ageMs: number } | null {
    return this.cached ? { v: this.cached.v, ageMs: Date.now() - this.cached.at } : null;
  }
}

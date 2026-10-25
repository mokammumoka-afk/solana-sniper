/** PumpPortal Local Transaction API: https://pumpportal.fun/local-trading-api/trading-api  (returns an unsigned serialized tx; we sign locally). */
export interface PortalTradeParams {
  publicKey: string;
  action: 'buy' | 'sell';
  mint: string;
  /** SOL amount (denominatedInSol=true), token amount, or a percentage string like "100%" when selling. */
  amount: number | string;
  denominatedInSol: boolean;
  slippage: number; // percent
  priorityFee: number; // SOL
  pool: string; // pump | raydium | pump-amm | launchlab | raydium-cpmm | bonk | auto
}

export interface PortalClient {
  buildTrade(p: PortalTradeParams): Promise<Uint8Array>;
}

export class HttpPortalClient implements PortalClient {
  constructor(private readonly baseUrl = 'https://pumpportal.fun/api/trade-local', private readonly fetchFn: typeof fetch = fetch) {}

  async buildTrade(p: PortalTradeParams): Promise<Uint8Array> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await this.fetchFn(this.baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          publicKey: p.publicKey,
          action: p.action,
          mint: p.mint,
          amount: p.amount,
          denominatedInSol: p.denominatedInSol ? 'true' : 'false',
          slippage: p.slippage,
          priorityFee: p.priorityFee,
          pool: p.pool,
        }),
        signal: ctrl.signal,
      });
      if (res.status !== 200) {
        const text = (await res.text().catch(() => '')).slice(0, 300);
        throw new Error(`PumpPortal ${res.status}: ${text || res.statusText}`);
      }
      return new Uint8Array(await res.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
  }
}

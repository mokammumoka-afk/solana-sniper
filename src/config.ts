import { existsSync, readFileSync } from 'node:fs';

/** Tiny .env loader (no dependency). Real environment variables win over the file. */
export function loadDotEnv(path = '.env', env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (env[m[1]] === undefined) env[m[1]] = v;
  }
}

export type Mode = 'observe' | 'paper' | 'live';

export interface EnvConfig {
  rpcUrl: string;
  portalApiKey?: string;
  privateKey?: string;
  dashboardToken: string;
  host: string;
  port: number;
  mode: Mode;
  liveConfirm: string;
  jupiterBase: string;
  jupiterApiKey?: string;
  wsUrl: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
}

export const LIVE_CONFIRM_PHRASE = 'I-UNDERSTAND-I-CAN-LOSE-ALL-FUNDS';

export function readEnv(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  const mode = (env.MODE ?? 'paper').toLowerCase() as Mode;
  if (!['observe', 'paper', 'live'].includes(mode)) throw new Error(`MODE must be observe|paper|live (got ${env.MODE})`);
  const token = env.DASHBOARD_TOKEN ?? '';
  if (token.length < 12) throw new Error('DASHBOARD_TOKEN is required and must be at least 12 characters');
  const supabaseUrl = env.SUPABASE_URL ?? '';
  const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!/^https:\/\/.+\.supabase\.co$/.test(supabaseUrl) && !/^https?:\/\/127\.0\.0\.1/.test(supabaseUrl) && !/^https?:\/\/localhost/.test(supabaseUrl)) {
    throw new Error('SUPABASE_URL is required (e.g. https://xxxx.supabase.co) — see README "إعداد Supabase"');
  }
  if (supabaseServiceRoleKey.length < 20) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required — the service_role key from Supabase project settings, NEVER the anon key');
  return {
    rpcUrl: env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com',
    portalApiKey: env.PUMPPORTAL_API_KEY || undefined,
    privateKey: env.PRIVATE_KEY || undefined,
    dashboardToken: token,
    host: env.DASHBOARD_HOST ?? '127.0.0.1',
    port: Number(env.DASHBOARD_PORT ?? 8787),
    mode,
    liveConfirm: env.LIVE_CONFIRM ?? '',
    jupiterBase: env.JUPITER_BASE_URL ?? 'https://lite-api.jup.ag/swap/v1',
    jupiterApiKey: env.JUPITER_API_KEY || undefined,
    wsUrl: env.PUMPPORTAL_WS_URL ?? 'wss://pumpportal.fun/api/data',
    supabaseUrl,
    supabaseServiceRoleKey,
  };
}

// ---------------------------------------------------------------- runtime settings

export interface Settings {
  // capital (USD figures are converted with the live SOL/USD price; nothing is hard-coded)
  initialCapitalUsd: number;
  tradeSizeUsd: number;
  maxTradeUsd: number;
  maxOpenPositions: number;
  feeReserveSol: number;
  dailyLossLimitUsd: number;
  totalLossLimitUsd: number;
  stopBalanceUsd: number;
  maxCostPctOfTrade: number;
  maxOverheadPctOfTrade: number;
  // execution
  slippageBuyPct: number;
  slippageSellPct: number;
  priorityFeeSol: number;
  pumpFeeBps: number;
  portalFeePct: number;
  maxSellAttempts: number;
  txConfirmTimeoutSec: number;
  // entry rules
  minAgeSec: number;
  maxAgeSec: number;
  minMarketCapSol: number;
  maxMarketCapSol: number;
  maxTop10Pct: number;
  maxTopHolderPct: number;
  maxCreatorPct: number;
  maxDevInitialBuyPct: number;
  minTxInWindow: number;
  minGrowthPct: number;
  maxGrowthPct: number;
  maxRoundTripCostPct: number;
  maxBuyImpactPct: number;
  minQuality: number;
  maxRisk: number;
  // exit rules
  takeProfitPct: number;
  stopLossPct: number;
  hardStopPct: number;
  trailingActivatePct: number;
  trailingDropPct: number;
  confirmTicks: number;
  maxHoldSec: number;
  liquidityDropExitPct: number;
  creatorSellExitPct: number;
  monitorIntervalMs: number;
}

export const DEFAULT_SETTINGS: Settings = {
  initialCapitalUsd: 25,
  tradeSizeUsd: 4,
  maxTradeUsd: 5,
  maxOpenPositions: 2,
  feeReserveSol: 0.01,
  dailyLossLimitUsd: 6,
  totalLossLimitUsd: 12,
  stopBalanceUsd: 10,
  maxCostPctOfTrade: 12,
  maxOverheadPctOfTrade: 25,
  slippageBuyPct: 15,
  slippageSellPct: 25,
  priorityFeeSol: 0.0003,
  pumpFeeBps: 125,
  portalFeePct: 0.5,
  maxSellAttempts: 5,
  txConfirmTimeoutSec: 45,
  minAgeSec: 12,
  maxAgeSec: 90,
  minMarketCapSol: 30,
  maxMarketCapSol: 90,
  maxTop10Pct: 40,
  maxTopHolderPct: 20,
  maxCreatorPct: 10,
  maxDevInitialBuyPct: 10,
  minTxInWindow: 15,
  minGrowthPct: 2,
  maxGrowthPct: 150,
  maxRoundTripCostPct: 9,
  maxBuyImpactPct: 6,
  minQuality: 55,
  maxRisk: 45,
  takeProfitPct: 40,
  stopLossPct: 20,
  hardStopPct: 32,
  trailingActivatePct: 25,
  trailingDropPct: 15,
  confirmTicks: 2,
  maxHoldSec: 600,
  liquidityDropExitPct: 35,
  creatorSellExitPct: 50,
  monitorIntervalMs: 2000,
};

/** [min, max] for every setting. Anything outside is rejected, so the dashboard cannot disable a safety limit by accident. */
export const SETTING_BOUNDS: Record<keyof Settings, [number, number]> = {
  initialCapitalUsd: [1, 100000],
  tradeSizeUsd: [0.5, 500],
  maxTradeUsd: [0.5, 500],
  maxOpenPositions: [1, 20],
  feeReserveSol: [0.002, 1],
  dailyLossLimitUsd: [0.5, 100000],
  totalLossLimitUsd: [0.5, 100000],
  stopBalanceUsd: [0, 100000],
  maxCostPctOfTrade: [1, 50],
  maxOverheadPctOfTrade: [1, 80],
  slippageBuyPct: [1, 50],
  slippageSellPct: [1, 80],
  priorityFeeSol: [0, 0.05],
  pumpFeeBps: [0, 500],
  portalFeePct: [0, 5],
  maxSellAttempts: [1, 15],
  txConfirmTimeoutSec: [10, 180],
  minAgeSec: [0, 600],
  maxAgeSec: [10, 3600],
  minMarketCapSol: [0, 100000],
  maxMarketCapSol: [1, 1000000],
  maxTop10Pct: [1, 100],
  maxTopHolderPct: [1, 100],
  maxCreatorPct: [0, 100],
  maxDevInitialBuyPct: [0, 100],
  minTxInWindow: [0, 10000],
  minGrowthPct: [-100, 1000],
  maxGrowthPct: [0, 10000],
  maxRoundTripCostPct: [1, 50],
  maxBuyImpactPct: [0.1, 50],
  minQuality: [0, 100],
  maxRisk: [0, 100],
  takeProfitPct: [1, 10000],
  stopLossPct: [1, 95],
  hardStopPct: [1, 99],
  trailingActivatePct: [1, 10000],
  trailingDropPct: [1, 95],
  confirmTicks: [1, 10],
  maxHoldSec: [30, 86400],
  liquidityDropExitPct: [1, 99],
  creatorSellExitPct: [1, 100],
  monitorIntervalMs: [500, 30000],
};

export function validateSettings(patch: Record<string, unknown>, base: Settings): { ok: true; settings: Settings } | { ok: false; error: string } {
  const next: Settings = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in SETTING_BOUNDS)) return { ok: false, error: `Unknown setting: ${k}` };
    if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, error: `${k} must be a finite number` };
    const [lo, hi] = SETTING_BOUNDS[k as keyof Settings];
    if (v < lo || v > hi) return { ok: false, error: `${k} must be between ${lo} and ${hi}` };
    (next as unknown as Record<string, number>)[k] = v;
  }
  if (next.tradeSizeUsd > next.maxTradeUsd) return { ok: false, error: 'tradeSizeUsd cannot exceed maxTradeUsd' };
  if (next.minAgeSec >= next.maxAgeSec) return { ok: false, error: 'minAgeSec must be below maxAgeSec' };
  if (next.minMarketCapSol >= next.maxMarketCapSol) return { ok: false, error: 'minMarketCapSol must be below maxMarketCapSol' };
  if (next.stopLossPct >= next.hardStopPct) return { ok: false, error: 'hardStopPct must be above stopLossPct' };
  return { ok: true, settings: next };
}

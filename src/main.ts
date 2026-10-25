import { loadDotEnv, readEnv, LIVE_CONFIRM_PHRASE } from './config.js';
import { Db } from './db.js';
import { Rpc } from './solana/rpc.js';
import { walletFromSecret, type Wallet } from './util/keypair.js';
import { log, logSink, registerSecret } from './util/log.js';
import { HttpPortalClient } from './exchange/pumpportal.js';
import { JupiterClient, SolUsdPrice } from './exchange/jupiter.js';
import { NewTokenFeed } from './feeds/pumpportal-ws.js';
import { Engine } from './engine.js';
import { createApp } from './server.js';

async function main(): Promise<void> {
  loadDotEnv();
  const env = readEnv();
  // Everything registered here is a SECRET and is redacted from every log line and error message —
  // see util/log.ts. The Solana private key never appears in this list because it never becomes a log
  // value in the first place: walletFromSecret() consumes the raw string once below and nothing else
  // in the process ever holds it as a string again (the Wallet object only exposes a sign() function).
  for (const s of [env.privateKey, env.portalApiKey, env.jupiterApiKey, env.dashboardToken, env.supabaseServiceRoleKey, env.rpcUrl]) registerSecret(s);

  let wallet: Wallet | null = null;
  if (env.privateKey) {
    wallet = walletFromSecret(env.privateKey);
    // the key string is no longer needed; drop every reference to it
    env.privateKey = undefined;
    delete process.env.PRIVATE_KEY;
  }
  if (env.mode === 'live') {
    if (!wallet) throw new Error('MODE=live requires PRIVATE_KEY (a dedicated, small-balance bot wallet)');
    if (env.liveConfirm !== LIVE_CONFIRM_PHRASE) throw new Error(`MODE=live requires LIVE_CONFIRM=${LIVE_CONFIRM_PHRASE}`);
    if (!process.env.SOLANA_RPC_URL) log.warn('Using the public Solana RPC in live mode: it is rate-limited and slow. Use a dedicated RPC provider.');
    log.warn('MODE=live: trading is still OFF until you click "Arm live trading" in the dashboard for this session. It is never enabled automatically.');
  }

  // The Supabase service_role key is a DATABASE credential (read/write on this project's tables, subject
  // to the RLS policies in supabase/migrations/0002_security.sql). It is a completely separate secret from
  // the Solana private key above, issued by a different system, and grants no access whatsoever to the
  // wallet or to any Solana account — a leak of one does not compromise the other.
  const db = new Db({ url: env.supabaseUrl, serviceRoleKey: env.supabaseServiceRoleKey });
  try {
    await db.connect();
  } catch (e) {
    throw new Error(`Supabase is not reachable: ${(e as Error).message}\nRun the migrations in supabase/migrations/ against your project first — see README "إعداد Supabase".`);
  }
  logSink.fn = (level, msg) => {
    if (level === 'warn' || level === 'error') void db.logError(level, 'log', msg);
  };

  const rpc = new Rpc({ url: env.rpcUrl, concurrency: 6 });
  const jupiter = new JupiterClient(env.jupiterBase, env.jupiterApiKey);
  const solPrice = new SolUsdPrice(jupiter);
  const engine = new Engine({
    db, env, rpc, wallet, portal: new HttpPortalClient(), jupiter, solPrice,
    feedFactory: (onToken) => new NewTokenFeed(env.wsUrl, onToken, { apiKey: env.portalApiKey }),
  });
  await engine.start();

  const server = createApp(engine, db, env.dashboardToken);
  server.listen(env.port, env.host, () => log.info(`dashboard on http://${env.host}:${env.port}  (mode=${env.mode})`));
  if (env.host !== '127.0.0.1' && env.host !== 'localhost') log.warn('Dashboard is bound to a non-local address: put it behind HTTPS/VPN; the token is the only protection.');

  const shutdown = () => {
    log.info('shutting down…');
    engine.stop();
    server.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (e) => {
    log.error('unhandledRejection', e);
    void db.logError('error', 'process', String(e));
  });
}

main().catch((e) => {
  console.error('Fatal:', (e as Error).message);
  process.exit(1);
});

/** Central logger with secret redaction. Register secrets once at startup; they never reach stdout or the dashboard. */
const secrets = new Set<string>();

export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 6) secrets.add(value);
}
export function clearSecrets(): void {
  secrets.clear();
}

export function redact(input: string): string {
  let out = input;
  for (const s of secrets) out = out.split(s).join('[REDACTED]');
  out = out.replace(/(api[-_]?key=)[^&\s"']+/gi, '$1[REDACTED]');
  out = out.replace(/(x-api-key["']?\s*[:=]\s*["']?)[^\s"',]+/gi, '$1[REDACTED]');
  return out;
}

type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let minLevel: Level = 'info';
export const logSink: { fn?: (level: Level, msg: string) => void } = {};
export function setLogLevel(l: Level): void {
  minLevel = l;
}

function stringify(a: unknown): string {
  if (a instanceof Error) return a.stack ?? a.message;
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

function emit(level: Level, args: unknown[]): void {
  if (order[level] < order[minLevel]) return;
  const msg = redact(args.map(stringify).join(' '));
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`;
  (level === 'error' ? console.error : console.log)(line);
  logSink.fn?.(level, msg);
}

export const log = {
  debug: (...a: unknown[]) => emit('debug', a),
  info: (...a: unknown[]) => emit('info', a),
  warn: (...a: unknown[]) => emit('warn', a),
  error: (...a: unknown[]) => emit('error', a),
};

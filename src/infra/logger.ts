import pino from 'pino';
import { Writable } from 'node:stream';

/**
 * D-05 / T-02-01: redaction is one sink-level serializer, never a per-call-site
 * convention. Two independent halves:
 *  - key-pattern redaction (formatters.log): catches `{ authorization: '...' }`
 *    regardless of which call site produced the shape.
 *  - value redaction (SecretScrubbingStream): catches a known secret value
 *    embedded inside an unrelated string (e.g. an error message quoting a
 *    failed request header), which key-name-only redaction would miss.
 */
const SECRET_KEY_PATTERN = /(token|secret|key|authorization)/i;

/**
 * Field names that CONTAIN a word from the pattern above and are not secrets.
 *
 * The pattern is a deliberate substring match, because over-redaction is the safe error
 * for a log sink and under-redaction leaks a credential. It also means `tokensUsed` — a
 * token COUNT — logged as `"[REDACTED]"`, which was caught the moment gap D6 gave it a
 * non-zero value to report. The fix is an explicit exception list, not a looser pattern:
 * anything new still fails closed.
 *
 * Add to this only for a field you can name and have checked. `issueKey` is deliberately
 * absent — nothing logs it today (the notify path uses `issueIdentifier`), and an entry
 * for a field with no call site is an assertion nobody is testing.
 */
const NOT_SECRET_KEYS: ReadonlySet<string> = new Set(['tokensUsed']);

/**
 * TRAPS T48, closed by 07-06.
 *
 * The walker recursed over `Object.entries` with no cycle guard, so a genuinely circular
 * payload overflowed the stack. That matters more than it reads: this is the LOG SINK, the
 * one call every layer makes on every path, and a throw here takes the daemon down on the
 * strength of a field somebody put a back-reference in.
 *
 * `value.map(redact)` was a second, quieter defect — `Array.prototype.map` passes
 * `(element, index, array)`, so the index arrived as the second argument. Harmless while
 * there was no second parameter; a silent seeding bug the moment there is one.
 *
 * ponytail: `seen` is never un-marked on the way back up, so a DAG (the same object
 * referenced twice in sibling branches) renders the second occurrence as `[CIRCULAR]` too.
 * That is the safe error for a log line. Track a path set instead if a real payload ever
 * needs the distinction.
 */
function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
  }
  if (Array.isArray(value)) {
    return value.map((element) => redact(element, seen));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const isSecret = !NOT_SECRET_KEYS.has(key) && SECRET_KEY_PATTERN.test(key);
      out[key] = isSecret ? '[REDACTED]' : redact(val, seen);
    }
    return out;
  }
  return value;
}

class SecretScrubbingStream extends Writable {
  // Explicit field, not a constructor parameter property: `erasableSyntaxOnly` is on
  // (tsconfig), and Node's type stripping only accepts the erasable subset. A parameter
  // property compiles under some settings and then fails to load at runtime.
  private readonly secrets: Set<string>;

  constructor(secrets: Set<string>) {
    super();
    this.secrets = secrets;
  }

  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    let line = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    for (const secret of this.secrets) {
      if (secret) line = line.split(secret).join('[REDACTED]');
    }
    process.stdout.write(line);
    callback();
  }
}

export interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  info(objOrMsg: unknown, msg?: string, ...args: unknown[]): void;
  warn(objOrMsg: unknown, msg?: string, ...args: unknown[]): void;
  error(objOrMsg: unknown, msg?: string, ...args: unknown[]): void;
  debug(objOrMsg: unknown, msg?: string, ...args: unknown[]): void;
}

export interface LoggerWithSecretRegistration extends Logger {
  /** Register a secret discovered after boot (e.g. Phase 3's webhook signing secret). */
  registerSecret(value: string): void;
}

function wrap(base: pino.Logger, secrets: Set<string>): LoggerWithSecretRegistration {
  return {
    child(bindings: Record<string, unknown>) {
      return wrap(base.child(bindings), secrets);
    },
    info: (...args: unknown[]) => (base.info as (...a: unknown[]) => void)(...args),
    warn: (...args: unknown[]) => (base.warn as (...a: unknown[]) => void)(...args),
    error: (...args: unknown[]) => (base.error as (...a: unknown[]) => void)(...args),
    debug: (...args: unknown[]) => (base.debug as (...a: unknown[]) => void)(...args),
    registerSecret(value: string) {
      secrets.add(value);
    },
  };
}

/**
 * Exactly one pino() instantiation lives here. Every other logger in the
 * process is a child() of this one, so redaction cannot be bypassed by
 * constructing a second instance elsewhere.
 */
export function createLogger(initialSecrets: readonly string[] = []): LoggerWithSecretRegistration {
  const secrets = new Set(initialSecrets.filter(Boolean));
  const stream = new SecretScrubbingStream(secrets);

  const base = pino(
    {
      formatters: {
        log(object: Record<string, unknown>) {
          return redact(object) as Record<string, unknown>;
        },
      },
    },
    stream
  );

  return wrap(base, secrets);
}

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

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : redact(val);
    }
    return out;
  }
  return value;
}

class SecretScrubbingStream extends Writable {
  constructor(private readonly secrets: Set<string>) {
    super();
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

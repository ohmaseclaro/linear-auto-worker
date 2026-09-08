/**
 * `law say` — speaking to a running agent mid-flight.
 *
 * The wire, the registry and BOTH ends of the socket live in this one module, deliberately:
 * the envelope and the reply shape cannot then drift into two copies, which is the defect
 * T72/T92/T96 all are.
 *
 * ## T-VOH-01, and it is the reason this file exists in this shape
 *
 * **NO HTTP ROUTE MAY EVER BE ADDED FOR THIS.** `src/ingress/receiver.ts` is published to
 * the open internet through the ngrok tunnel, and the agent this channel writes into runs
 * `--permission-mode dontAsk` with `Write`/`Edit`/`Bash` inside the operator's real clones
 * — which include private client repositories. An injection endpoint on that tunnel is
 * unauthenticated arbitrary prompt injection into a process with write access to them.
 *
 * The channel is therefore a Unix domain socket at `<root>/say.sock`, mode 0600, inside a
 * 0700 directory. Filesystem permissions are the whole authentication story, which is
 * appropriate for a single-operator daemon and is why the mode is asserted by both a unit
 * test and the boot smoke rather than described in a comment.
 */
import * as net from 'node:net';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import { userMessageLine } from './agent-args.js';
import type { Logger } from '../infra/logger.js';

export const SOCKET_NAME = 'say.sock';

/** T-VOH-04. One line, one reply, connection closed. Anything larger is refused unread. */
export const MAX_SAY_BYTES = 8 * 1024;

/** `sendInjection` resolves as a failure rather than hanging. Never blocks the operator. */
const CONNECT_TIMEOUT_MS = 2_000;

export function socketPath(root: string): string {
  return path.join(root, SOCKET_NAME);
}

export type SayOutcome = { ok: true } | { ok: false; error: string };

export interface Injector {
  /** Returns its own unregister. */
  register(runId: string, send: (text: string) => boolean): () => void;
  send(runId: string, text: string): SayOutcome;
}

/**
 * Which live runs can currently be spoken to. An in-memory `Map` and nothing more — a
 * `law say` is ephemeral by design (the durable channel is the Linear Q&A path, which this
 * does not replace and cannot be used for; see the plan's `<design>`).
 */
export function createInjector(): Injector {
  const sends = new Map<string, (text: string) => boolean>();

  return {
    register(runId, send) {
      sends.set(runId, send);
      return () => {
        // Only if it is still ours: a re-registration for the same run id (a resumed
        // session) must not be torn down by the previous registration's unregister.
        if (sends.get(runId) === send) sends.delete(runId);
      };
    },

    send(runId, text) {
      const send = sends.get(runId);
      if (!send) {
        return {
          ok: false,
          error: `no live agent for run ${runId.slice(0, 8)} — it has not started yet, or it has finished`,
        };
      }
      if (!send(text)) {
        return {
          ok: false,
          error:
            'the agent has finished its turn and is no longer accepting input — ' +
            'reply on the Linear ticket instead',
        };
      }
      return { ok: true };
    },
  };
}

interface SayRequest {
  runId?: unknown;
  text?: unknown;
}

export interface ServeInjectionsOptions {
  injector: Injector;
  root: string;
  log: Logger;
}

export interface InjectionServer {
  close(): Promise<void>;
}

/**
 * T-VOH-05, with FLAG-E's correction.
 *
 * A path that exists is not necessarily a live daemon. Probe it, and treat EVERY failure to
 * reach a listener as "leftovers": ECONNREFUSED is the documented case (a dead daemon's
 * socket file), but on macOS a leftover REGULAR FILE at this path answers `ENOTSOCK`, and a
 * dangling path can answer `ENOENT` in the window between the exists-check and the connect.
 * Naming only ECONNREFUSED and treating anything else as "another daemon owns this root"
 * turns a stale file into a BOOT-BLOCKING false positive.
 *
 * A SUCCESSFUL connect is the only thing that means another daemon is here, and that is
 * what refuses to boot rather than stealing the socket.
 */
async function claimSocketPath(file: string): Promise<void> {
  if (!existsSync(file)) return;

  const live = await new Promise<boolean>((resolve) => {
    const probe = net.connect(file);
    const done = (answer: boolean): void => {
      probe.destroy();
      resolve(answer);
    };
    probe.setTimeout(CONNECT_TIMEOUT_MS, () => done(false));
    probe.once('connect', () => done(true));
    probe.once('error', () => done(false));
  });

  if (live) {
    throw new Error(
      `another law daemon is already listening on ${file} — refusing to boot and steal ` +
        `its socket. Stop it first, or point this one at a different root.`,
    );
  }
  try {
    unlinkSync(file);
  } catch {
    /* raced with something else cleaning it up */
  }
}

export async function serveInjections(o: ServeInjectionsOptions): Promise<InjectionServer> {
  const file = socketPath(o.root);

  // FLAG-D. The DIRECTORY is tightened BEFORE `listen()`, not on `'listening'`.
  //
  // `listen()` creates the socket file at the ambient umask, so a chmod that runs on the
  // `'listening'` event leaves a window in which the path is both bindable and connectable
  // by anyone — inside a directory that is also not yet 0700. Tightening the directory
  // first closes the window on both halves: nothing can traverse into it to reach the
  // socket, whatever mode the socket briefly has.
  chmodSync(o.root, 0o700);

  await claimSocketPath(file);

  const server = net.createServer((socket) => {
    let buffer = '';
    let answered = false;

    const reply = (outcome: SayOutcome): void => {
      if (answered) return;
      answered = true;
      try {
        socket.end(`${JSON.stringify(outcome)}\n`);
      } catch {
        /* the client hung up; nothing to report */
      }
    };

    socket.setEncoding('utf8');
    // A bad client must never throw INTO the daemon. Everything below returns a reply.
    socket.on('error', () => reply({ ok: false, error: 'connection error' }));
    socket.on('data', (chunk: string) => {
      if (answered) return;
      buffer += chunk;
      if (buffer.length > MAX_SAY_BYTES) {
        reply({ ok: false, error: `message too large (max ${MAX_SAY_BYTES} bytes)` });
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;

      let parsed: SayRequest;
      try {
        parsed = JSON.parse(buffer.slice(0, newline)) as SayRequest;
      } catch {
        reply({ ok: false, error: 'malformed request' });
        return;
      }
      if (typeof parsed.runId !== 'string' || typeof parsed.text !== 'string') {
        reply({ ok: false, error: 'malformed request: runId and text must both be strings' });
        return;
      }
      reply(o.injector.send(parsed.runId, parsed.text));
    });
    socket.on('end', () => reply({ ok: false, error: 'no message was sent' }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(file, () => {
      chmodSync(file, 0o600);
      resolve();
    });
  });

  o.log.info({ socket: file }, 'law say socket listening');

  return {
    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        server.close(() => {
          try {
            unlinkSync(file);
          } catch {
            /* already gone */
          }
          resolve();
        });
      });
    },
  };
}

/**
 * The client half. Connects, writes one line, reads one line, resolves.
 *
 * T-VOH-06, and it is deliberate and the opposite of what `prompt.ts` does to ticket text:
 * this text is NOT run through `sanitizeUntrustedText` and is NOT wrapped in
 * `<untrusted-ticket-data>`. Ticket text is attacker-controlled; `law say` text comes from
 * the operator, typed at a 0600 socket on their own machine — the same trust level as the
 * config file. Wrapping the operator's own instruction as untrusted data would make it
 * INERT, which is the entire feature. Do not "fix" this later.
 *
 * (The opposite direction is not the same question: `law watch` DOES sanitize on the way
 * out, because what it renders is agent output derived from ticket text.)
 */
export async function sendInjection(o: {
  root: string;
  runId: string;
  text: string;
}): Promise<SayOutcome> {
  const file = socketPath(o.root);
  const line = `${JSON.stringify({ runId: o.runId, text: o.text })}\n`;
  if (line.length > MAX_SAY_BYTES) {
    return { ok: false, error: `message too large (max ${MAX_SAY_BYTES} bytes)` };
  }

  return new Promise<SayOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: SayOutcome): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(outcome);
    };

    const socket = net.connect(file);
    socket.setEncoding('utf8');
    // Never hangs. A daemon that accepted the connection and then died mid-answer must
    // still give the operator a line and a non-zero exit.
    socket.setTimeout(CONNECT_TIMEOUT_MS, () =>
      finish({ ok: false, error: 'the daemon accepted the connection but did not answer' }),
    );
    socket.once('error', () =>
      finish({ ok: false, error: 'the daemon is not running — start it with `law start`' }),
    );
    socket.once('connect', () => socket.write(line));

    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        finish(JSON.parse(buffer.slice(0, newline)) as SayOutcome);
      } catch {
        finish({ ok: false, error: 'the daemon sent an unreadable reply' });
      }
    });
    socket.on('end', () =>
      finish({ ok: false, error: 'the daemon closed the connection without answering' }),
    );
  });
}

/** Re-exported so callers of this module never reach for a second copy of the envelope. */
export { userMessageLine };

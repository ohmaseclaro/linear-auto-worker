/**
 * The per-run activity log: every parsed stream event, one JSON object per line.
 *
 * `~/.linear-auto-worker/runs/<runId>.jsonl`. This is what makes a 45-minute spawned run
 * something other than a black box between pickup and pull request — `law watch` reads it
 * live and reads it back afterwards, and `jq` reads it too.
 *
 * T-VOH-02: this file holds RAW agent output. Anything the agent read is in here, including
 * a `.env` it happened to `cat`. It deliberately bypasses the logger's secret scrubbing —
 * a redacted trace is not a trace — so the containment is filesystem permissions and
 * nothing else: 0600 inside a 0700 directory, never transmitted anywhere, age-pruned. It
 * must never be attached to a PR body, a Linear comment or a Slack message.
 */
import { chmodSync, createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

/**
 * T-VOH-03. A real GSD run emits a lot; 64 MiB is far past any honest run and well short
 * of filling a disk. Past it, one marker line is written and appending stops — the run is
 * unaffected, only its trace is.
 */
export const MAX_RUN_LOG_BYTES = 64 * 1024 * 1024;

/** T-VOH-03. Pruned at boot beside the stale-worktree collection, never fatal. */
export const RUN_LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface RunLog {
  /** Never throws. A failed sink is a lost trace, not a lost run. */
  write(event: unknown): void;
  close(): void;
}

export function runLogDir(root: string): string {
  return path.join(root, 'runs');
}

export function runLogPath(root: string, runId: string): string {
  return path.join(runLogDir(root), `${runId}.jsonl`);
}

export function openRunLog(root: string, runId: string): RunLog {
  const dir = runLogDir(root);
  const file = runLogPath(root, runId);

  let bytes = 0;
  let disabled = false;
  let truncated = false;
  let stream: ReturnType<typeof createWriteStream> | undefined;

  try {
    mkdirSync(dir, { recursive: true });
    // chmod SEPARATELY from mkdir, for two independent reasons: mkdir's `mode` is masked
    // by the process umask, and the directory may already exist from an earlier boot with
    // looser permissions. Either one alone leaves the trace world-readable.
    chmodSync(dir, 0o700);
    stream = createWriteStream(file, { flags: 'a', mode: 0o600 });
    stream.on('error', () => {
      disabled = true;
    });
  } catch {
    disabled = true;
  }

  function put(line: string): void {
    try {
      stream?.write(line);
    } catch {
      disabled = true;
    }
  }

  return {
    write(event: unknown): void {
      // `truncated` is checked BEFORE the byte arithmetic, not inside it: the counter is
      // frozen at the cap, so a small event arriving after a huge one would otherwise fit
      // under the limit again and append past the marker.
      if (disabled || truncated) return;
      let line: string;
      try {
        line = `${JSON.stringify(event)}\n`;
      } catch {
        // A circular or otherwise unserialisable event. Not a reason to lose the run.
        return;
      }
      if (bytes + line.length > MAX_RUN_LOG_BYTES) {
        truncated = true;
        put(`${JSON.stringify({ type: 'law.truncated', bytes })}\n`);
        return;
      }
      bytes += line.length;
      put(line);
    },
    close(): void {
      try {
        stream?.end();
      } catch {
        /* a sink that cannot be closed is already gone */
      }
    },
  };
}

/**
 * Delete `runs/*.jsonl` older than `ttlMs`. Returns what it deleted.
 *
 * A missing directory is an empty list, not an error: the first boot of a fresh install
 * has no `runs/` and must not log a failure for it.
 */
export function pruneRunLogs(root: string, ttlMs: number, now: number): string[] {
  const dir = runLogDir(root);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const cutoff = now - ttlMs;
  const deleted: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    try {
      if (statSync(file).mtimeMs >= cutoff) continue;
      unlinkSync(file);
      deleted.push(name);
    } catch {
      /* raced with something else deleting it; nothing to report */
    }
  }
  return deleted;
}

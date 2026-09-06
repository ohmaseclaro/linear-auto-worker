/**
 * The throwaway world a boot smoke or an integration test boots the REAL daemon inside.
 *
 * Two rules, both load-bearing:
 *
 *  1. **Nothing here touches `~/.linear-auto-worker/`.** A test that writes to the
 *     operator's config root destroys real run history and a real webhook secret. Every
 *     caller gets its own `mkdtemp` directory holding its own config, its own `.env` and
 *     its own SQLite file, and removes it afterwards.
 *  2. **The database is real.** `sqlite-store.ts` had three statements against columns that
 *     do not exist, and they survived a green `tsc` and a green unit suite because the unit
 *     suite runs against `InMemoryStore` (07-RUNTIME-EVIDENCE, T53). A fixture that fakes
 *     the store reproduces exactly that blind spot.
 *
 * It lives under `src/` rather than `test/` for the same reason `ingress/fixtures.ts` does:
 * `tsconfig`'s `rootDir` is the compile surface and the gate runs the compiled output.
 */
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { LINEAR_WEBHOOK_SIGNATURE_HEADER } from '@linear/sdk/webhooks';

import { FakeLinearClient } from '../domain/fakes.js';
import type { IssueId, LinearIssue, TunnelManager } from '../domain/ports.js';
import { defaultRunCommand } from '../execution/execute-run.js';
import { createSqliteStore } from '../infra/store/sqlite-store.js';
import { openStore } from '../infra/store/db.js';
import { KEY_SECRET } from '../ingress/registrar.js';

export const BOT_USER_ID = 'bot-user-id';
export const TEAM_ID = 'T-smoke';
export const ISSUE_ID = 'issue-uuid';

export function smokeIssue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: ISSUE_ID,
    identifier: 'SMK-1',
    title: 'Smoke: a signed webhook becomes a queued run',
    description: null,
    url: 'https://linear.app/smoke/issue/SMK-1',
    branchName: 'smoke/smk-1',
    assigneeId: BOT_USER_ID,
    projectId: null,
    teamId: TEAM_ID,
    stateId: 'state-todo',
    stateType: 'unstarted',
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

export interface Workspace {
  dir: string;
  /** The signing secret seeded into kv under the registrar's own key, before boot. */
  secret: string;
  remove(): Promise<void>;
}

/**
 * A complete throwaway config root: `config.json`, a mode-0600 `.env`, and a migrated
 * `store.db` carrying the webhook signing secret in `kv`.
 *
 * Seeding the secret through the real store on the real file is deliberate — it is the
 * first thing the daemon reads out of `kv` at boot, and the kv read is precisely what T53
 * broke while every automated signal stayed green.
 */
export async function makeWorkspace(secret: string): Promise<Workspace> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'law-smoke-'));

  const config = {
    botUserId: BOT_USER_ID,
    teamId: TEAM_ID,
    concurrency: 3,
    maxQuestionRounds: 3,
    maxTurns: 40,
    worktreeRoot: path.join(dir, 'worktrees'),
    dbPath: path.join(dir, 'store.db'),
    defaults: {
      postLinearComments: true,
      notifySlack: false,
      baseBranch: 'main',
      draftPr: true,
      questionsEnabled: true,
      maxRunMs: 30 * 60_000,
      questionTimeoutMs: 60 * 60_000,
    },
    mappings: {
      [TEAM_ID]: {
        linearProjectId: null,
        linearTeamId: TEAM_ID,
        repos: [
          {
            repoDir: path.join(dir, 'repo'),
            repoSlug: 'smoke/repo',
            baseBranch: 'main',
            enabled: true,
          },
        ],
      },
    },
  };

  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
  // `loadSecrets` refuses anything but 0600, so the mode is part of what boot exercises.
  await fs.writeFile(
    path.join(dir, '.env'),
    'LINEAR_API_KEY=smoke-not-a-real-key\nNGROK_AUTHTOKEN=smoke-not-a-real-token\n',
    { mode: 0o600 },
  );
  await fs.chmod(path.join(dir, '.env'), 0o600);

  const db = openStore(path.join(dir, 'store.db'));
  createSqliteStore(db).kvSet(KEY_SECRET, secret);
  db.close();

  return { dir, secret, remove: () => fs.rm(dir, { recursive: true, force: true }) };
}

/**
 * `LinearClient` fake that records every canonical issue fetch.
 *
 * The recording is the assertion: the router must decide from a fresh fetch and never from
 * the delivery body (INTK-05). A router that trusted `payload.data` would produce the same
 * run and leave this array empty.
 */
export class RecordingLinear extends FakeLinearClient {
  readonly fetched: IssueId[] = [];

  /**
   * Seeds the bot user to `BOT_USER_ID` by default.
   *
   * This is not cosmetic. Since 07-04 the composition root takes the bot's identity from
   * `viewer()` rather than from `config.json`, so a fixture whose fake viewer reports a
   * DIFFERENT id than the one the fixture's issue is assigned to makes the router refuse
   * every delivery — which is exactly what it should do, and exactly what the smoke caught
   * the first time this ran.
   */
  constructor(seed?: { issues?: LinearIssue[]; botUser?: { id: string; name: string } }) {
    super({ botUser: { id: BOT_USER_ID, name: 'Smoke Bot' }, ...seed });
  }

  override getIssue(id: IssueId): Promise<LinearIssue> {
    this.fetched.push(id);
    return super.getIssue(id);
  }
}

/**
 * The HOOK-01 assertion, as a runtime probe rather than a comment.
 *
 * `open(port)` opens a real TCP connection to the port it was handed and rejects if the
 * connection is refused. Boot the tunnel before the bind and this fails the run; leave the
 * ordering as an intention in a comment and a later refactor violates it silently, opening
 * a window where Linear delivers to a live public URL backed by nothing.
 */
export function probingTunnel(): TunnelManager & { probes: number[] } {
  const probes: number[] = [];
  let url: string | null = null;
  return {
    probes,
    open(port: number): Promise<string> {
      return new Promise((resolve, reject) => {
        const socket = net.connect({ port, host: '127.0.0.1' });
        socket.once('connect', () => {
          probes.push(port);
          socket.destroy();
          url = `https://smoke-${port}.invalid`;
          resolve(url);
        });
        socket.once('error', (err) => {
          socket.destroy();
          reject(
            new Error(
              `HOOK-01 violated: nothing is listening on 127.0.0.1:${port} when the tunnel ` +
                `was asked to open (${err.message}). The bind must happen before the tunnel.`,
            ),
          );
        });
      });
    },
    url: () => url,
    close: () => Promise.resolve(),
  };
}

export interface DeliveryResponse {
  status: number;
  body: string;
  /** Wall time from request start to response end — HOOK-08's acknowledge-then-work budget. */
  ms: number;
}

/** POST one delivery. `raw` is sent verbatim: the bytes signed are the bytes sent. */
export function postDelivery(
  port: number,
  d: { raw: Buffer; signature: string; deliveryId: string },
): Promise<DeliveryResponse> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/linear/webhook',
        headers: {
          'content-type': 'application/json',
          'content-length': d.raw.length,
          'linear-delivery': d.deliveryId,
          [LINEAR_WEBHOOK_SIGNATURE_HEADER]: d.signature,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            ms: Date.now() - startedAt,
          }),
        );
      },
    );
    req.once('error', reject);
    req.end(d.raw);
  });
}

/** Poll until `check` returns a value, or give up. Ingress acknowledges before it works. */
export async function until<T>(
  check: () => T | undefined,
  opts: { timeoutMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = check();
    if (got !== undefined) return got;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${opts.label ?? 'condition'}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * A real git repository at `${dir}/repo`, matching the path `makeWorkspace` maps.
 *
 * Real, not a double: `prepareWorktree` shells out to `git worktree add`, and the whole
 * point of exercising it is that no fake can tell you whether the branch was created, the
 * HEAD is attached, or the directory landed where the containment check expects. Cheap
 * enough — one `init` and one empty commit.
 *
 * Committer identity is passed per command rather than written to a config file, so this
 * cannot pick up (or disturb) the operator's own git identity.
 */
export async function makeScratchRepo(dir: string, branch = 'main'): Promise<string> {
  const repo = path.join(dir, 'repo');
  await fs.mkdir(repo, { recursive: true });
  const git = (...args: string[]): Promise<unknown> => defaultRunCommand('git', ['-C', repo, ...args]);

  await defaultRunCommand('git', ['init', '--quiet', `--initial-branch=${branch}`, repo]);
  await git('config', 'user.email', 'smoke@example.invalid');
  await git('config', 'user.name', 'Smoke');
  await fs.writeFile(path.join(repo, 'README.md'), '# scratch\n', 'utf8');
  await git('add', 'README.md');
  await git('commit', '--quiet', '-m', 'initial');
  return repo;
}

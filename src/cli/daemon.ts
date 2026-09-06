/**
 * The composition root. Every wire in the daemon is made here and nowhere else.
 *
 * ## The injection seam, and why it is exactly two ports wide
 *
 * `BootOptions` can override the tunnel and the Linear client. Nothing else. The rule is
 * not "make it testable" — it is: **a port is overridable only if it crosses a process or
 * network boundary this machine cannot cross offline.** ngrok needs an account and the
 * internet; Linear needs a workspace and an API key. Everything else — config loading, the
 * SQLite store, the migration, the receiver, the router, the scheduler, the run engine, the
 * question correlator, the recovery sweep — is constructed real, always, in every caller
 * including the boot smoke. A container with a slot per dependency would let the smoke boot
 * a graph of doubles and prove nothing about the graph that actually runs.
 *
 * ## Boot order (07-CONTEXT D-01, D-02)
 *
 *   1. config + secrets + logger + an open, migrated database
 *   2. the store
 *   3. the recovery sweep — BEFORE ingress binds. A delivery landing while the database
 *      still shows a phantom `running` row from a crashed process is dropped as
 *      already-running, and the ticket sits In Progress forever.
 *   4. `listen(127.0.0.1, 0)` — the socket is accepting connections...
 *   5. ...BEFORE the tunnel is opened against it (D-02, HOOK-01). Reversed, there is a
 *      window where Linear can deliver to a live public URL backed by nothing; the 502s
 *      burn Linear's retry budget and move the webhook toward auto-disable. The boot
 *      smoke's tunnel stub TCP-probes the port it is handed, so a reorder fails the run.
 *   6. router → engine. Execution stays FAKE in this plan (D-01): a real signed webhook
 *      producing a persisted `queued` run proves the whole ingress seam while the
 *      expensive half is still cheap to iterate on.
 *
 * ## What this plan deliberately does not do
 *
 * The scheduler is constructed and immediately **paused**, so no run can leave `queued` and
 * nothing can spawn a child process. Plan 05 owns starting it, signal handling and drain.
 * Plan 04 replaces the three execution fakes with the real worktree manager, agent runner
 * and deliverer.
 */
import * as http from 'node:http';
import { randomBytes } from 'node:crypto';

import { loadFoundation } from '../infra/index.js';
import { defaultRoot } from '../infra/config.js';
import { createSqliteStore } from '../infra/store/sqlite-store.js';
import { asDomainStore } from '../infra/store/domain-store.js';
import { createReceiver } from '../ingress/receiver.js';
import { createRouter, type Router } from '../ingress/router.js';
import { KEY_SECRET } from '../ingress/registrar.js';
import { closeTunnel, openTunnel } from '../ingress/tunnel.js';
import { createScheduler } from '../orchestration/scheduler.js';
import { createQuestions, type Questions } from '../orchestration/questions.js';
import { createRunEngine, type RunEngine } from '../orchestration/run-engine.js';
import { recoverAtBoot } from '../orchestration/recovery.js';
// Plan 04 replaces these three imports with the real execution layer. Until then they are
// what makes D-01's ordering possible: the ingress seam is provable without a `claude`
// process, a git worktree or a `gh` call.
import { FakeAgentRunner, FakeDeliverer, FakeWorktreeManager } from '../domain/fakes.js';
import type {
  Config,
  DomainEvent,
  EngineEvent,
  IngressEvent,
  LinearClient,
  Logger,
  Store,
  TunnelManager,
} from '../domain/ports.js';

export interface BootOptions {
  /** Config root. Defaults to `~/.linear-auto-worker`; the smoke passes a `mkdtemp` dir. */
  configDir?: string;
  /** Crosses the network. Overridable. */
  tunnel?: TunnelManager;
  /** Crosses the network. Overridable. */
  linear?: LinearClient;
}

export interface DaemonHandle {
  /** The ephemeral loopback port the receiver bound. */
  port: number;
  /** The tunnel's public URL, or null if the tunnel returned none. */
  publicUrl: string;
  config: Config;
  store: Store;
  engine: RunEngine;
  log: Logger;
  /** Plan 05 fills this in with drain + reverse-order shutdown (D-03/D-06). */
  shutdown(): Promise<void>;
}

/** The real ngrok tunnel, expressed as the `TunnelManager` port. */
function ngrokTunnel(): TunnelManager {
  let open: Awaited<ReturnType<typeof openTunnel>> | null = null;
  return {
    async open(port: number): Promise<string> {
      open = await openTunnel(port);
      return open.url;
    },
    url: () => open?.url ?? null,
    async close(): Promise<void> {
      if (open) await closeTunnel(open.listener);
      open = null;
    },
  };
}

/**
 * The ingress→engine translation (TRAPS **T45**, 07-CONTEXT hard deliverable #1).
 *
 * Ingress names what Linear did; the engine switches on what the daemon should do. The two
 * vocabularies share no `kind`, and since 07-02 they are no longer one union — so this
 * function is the reason `bootDaemon` compiles at all. Do not "simplify" it away by
 * re-merging the unions: that is precisely T45, where the daemon boots green, verifies
 * green and processes nothing because the ingress event falls through the engine's switch.
 *
 * The mapping table lives on the `IngressEvent` doc comment in `domain/ports.ts`.
 * Exported so it is testable without booting a daemon.
 */
export function createIngressMapper(deps: { store: Store; linear: LinearClient }) {
  const { store, linear } = deps;

  return async function toEngineEvent(e: IngressEvent): Promise<EngineEvent> {
    switch (e.kind) {
      case 'issue.assigned':
        return { kind: 'run.requested', issueId: e.issueId };

      case 'issue.unassigned':
        return { kind: 'run.cancelled', issueId: e.issueId, reason: 'bot unassigned in Linear' };

      case 'comment.created': {
        // D-05 tier 1: a threaded reply correlates by the parent comment's id, which is
        // the id `questions.openQuestion` stored when it posted the question.
        if (!e.parentId) return { kind: 'ignored', reason: 'comment is not a threaded reply' };
        const q = store.findQuestionByCommentId(e.parentId);
        if (!q || q.status !== 'open') {
          return { kind: 'ignored', reason: 'comment does not reply to an open question' };
        }
        // The router hands over identifiers, never content (INTK-05). The body is read
        // here, from the canonical fetch.
        const comment = (await linear.listComments(e.issueId)).find((c) => c.id === e.commentId);
        if (!comment) return { kind: 'ignored', reason: 'comment not found on re-fetch' };
        return {
          kind: 'question.answered',
          questionId: q.id,
          answer: comment.body,
          authorName: comment.authorName,
        };
      }
    }
  };
}

/** The router only ever emits these three; the guard is what lets the mapper be total. */
function isIngressEvent(e: DomainEvent): e is IngressEvent {
  return (
    e.kind === 'issue.assigned' || e.kind === 'issue.unassigned' || e.kind === 'comment.created'
  );
}

export async function bootDaemon(opts: BootOptions = {}): Promise<DaemonHandle> {
  const root = opts.configDir ?? defaultRoot();

  // ── 1. config, secrets, logger, migrated database ──────────────────────────
  const { config, logger, db } = loadFoundation(root);
  const log = logger.child({ component: 'daemon' });

  // ── 2. the store ───────────────────────────────────────────────────────────
  const store = asDomainStore(createSqliteStore(db));

  // 07-04 owns the outbound facade seam: `outbound/linear-client.ts` declares its own
  // `LinearClient` that does not match the port (three unimplemented methods, a different
  // `setIssueState` arity). Failing loudly here beats booting a daemon that cannot talk to
  // Linear and reports healthy.
  const linear = opts.linear;
  if (!linear) {
    throw new Error(
      'bootDaemon: no LinearClient. The real outbound facade does not yet satisfy the ' +
        'domain port — 07-04 owns that seam. Pass `opts.linear` until it lands.',
    );
  }

  const scheduler = createScheduler({ config, log });
  // D-01: no run may leave `queued` in this plan, and nothing may spawn a child process.
  // Plan 05 starts it as part of the boot lifecycle it owns.
  scheduler.pause();

  // Late binding: questions calls back into the engine and the engine calls into
  // questions. The thunk is the port's own answer to that cycle.
  let questions: Questions;
  const engine = createRunEngine({
    store,
    scheduler,
    linear,
    config,
    log,
    // ponytail: fakes, on purpose (D-01). Plan 04 swaps in the real three.
    agent: new FakeAgentRunner(),
    worktrees: new FakeWorktreeManager(config.worktreeRoot),
    deliverer: new FakeDeliverer(),
    questions: () => questions,
  });
  questions = createQuestions({ store, engine, config, linear, log });

  // ── 3. recovery sweep, BEFORE anything can deliver ─────────────────────────
  // `recoverAtBoot` logs its own report; a second line here would only duplicate it.
  await recoverAtBoot({ store, engine, scheduler, questions, linear, config, log });

  // The signing secret is OURS (HOOK-03 / 03-02 D-03): generated locally, persisted to kv
  // before any remote call, and never read back from Linear. Generating-and-persisting here
  // under the registrar's own key means plan 05's `reconcile()` reuses this one rather than
  // minting a second that the receiver would then reject every delivery against.
  let secret = store.kvGet(KEY_SECRET);
  if (!secret) {
    secret = randomBytes(32).toString('hex');
    store.kvSet(KEY_SECRET, secret);
    log.info({}, 'generated a webhook signing secret; it will be registered on reconcile');
  }

  // ── 6a. the router, wired to the engine THROUGH the mapper ─────────────────
  // Constructed before the bind because the receiver needs it, but it cannot fire before
  // the bind either: nothing can deliver to a socket that is not listening.
  const toEngineEvent = createIngressMapper({ store, linear });
  const router: Router = createRouter({
    log,
    botUserId: config.botUserId,
    // The router asks Linear for the canonical issue; the port speaks `assigneeId`, the
    // router wants an `assignee` object. This projection is that seam and nothing more.
    client: {
      issue: async (id: string) => {
        const issue = await linear.getIssue(id);
        return { id: issue.id, assignee: issue.assigneeId ? { id: issue.assigneeId } : undefined };
      },
    },
    onEvent: (e: DomainEvent) => {
      if (!isIngressEvent(e)) return;
      void (async () => {
        try {
          await engine.handle(await toEngineEvent(e));
        } catch (err) {
          log.error(
            { kind: e.kind, err: err instanceof Error ? err.message : String(err) },
            'engine failed to handle an ingress event',
          );
        }
      })();
    },
  });

  // ── 4. bind the loopback socket ────────────────────────────────────────────
  const server = http.createServer(
    createReceiver({ secret, store, log, botUserId: config.botUserId, router }),
  );
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('receiver bound to a non-TCP address'));
        return;
      }
      resolve(addr.port);
    });
  });
  log.info({ port }, 'receiver listening on loopback');

  // ── 5. and only now, the tunnel ────────────────────────────────────────────
  const tunnel = opts.tunnel ?? ngrokTunnel();
  const publicUrl = await tunnel.open(port);
  log.info({ port }, 'tunnel open');

  return {
    port,
    publicUrl,
    config,
    store,
    engine,
    log,
    async shutdown(): Promise<void> {
      // Reverse boot order (D-03). Plan 05 adds child-process kill and the in-flight
      // requeue that makes Ctrl-C free (D-06); this is the minimum that releases the port
      // and the database file.
      scheduler.pause();
      await tunnel.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      store.close();
    },
  };
}

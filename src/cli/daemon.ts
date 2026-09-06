/**
 * The composition root. Every wire in the daemon is made here and nowhere else.
 *
 * ## The injection seam, and the one rule that decides what belongs in it
 *
 * **A port is overridable only if it crosses a process or network boundary this machine
 * cannot cross in a test.** That is the whole rule, and it is not "make it testable":
 * ngrok needs an account and the internet, Linear needs a workspace and an API key, the
 * agent runner spawns `claude`, the deliverer pushes a ref to a remote the operator owns.
 * Four ports meet it; `BootOptions` has four slots.
 *
 * Everything else — config loading, the SQLite store, the migration, the receiver, the
 * router, the scheduler, the run engine, the question correlator, the recovery sweep, the
 * WORKTREE MANAGER and the NOTIFIER — is constructed real, always, in every caller
 * including the boot smoke. The worktree manager is the interesting one: `git` is local, so
 * a test that wants a worktree creates a scratch repository rather than a double. A
 * container with a slot per dependency would let the smoke boot a graph of doubles and
 * prove nothing about the graph that actually runs, which is why every future plan must
 * argue a fifth slot past the rule above rather than simply adding one.
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
 */
import * as http from 'node:http';
import { randomBytes } from 'node:crypto';

import { loadFoundation } from '../infra/index.js';
import { LinearClientImpl } from '../outbound/linear-client.js';
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
import {
  createAgentRunner,
  createDeliverer,
  createWorktreeManager,
  mappingIndex,
} from './adapters.js';
import type { AgentSpawn } from '../execution/supervisor.js';
import { nonTerminalStates } from '../orchestration/recovery.js';
import type {
  AgentRunner,
  Config,
  Deliverer,
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
  /** Crosses a PROCESS boundary — spawns `claude`. Overridable. */
  agent?: AgentRunner;
  /** Crosses the network — pushes a ref and opens a pull request. Overridable. */
  deliverer?: Deliverer;
  /**
   * The `claude` spawn itself, when the default agent runner is wanted but the binary is
   * not. Narrower than `agent`: the run-path test scripts a session while still exercising
   * the real argv construction, env allowlist and stream routing.
   */
  spawn?: AgentSpawn;
}

export interface DaemonHandle {
  /** The ephemeral loopback port the receiver bound. */
  port: number;
  /**
   * The bot's Linear user id as the API KEY reports it, not as `config.json` claims it.
   * Loop guard L1 compares every delivery's actor against this; an unresolved or stale
   * value disables the guard silently rather than failing.
   */
  botUserId: string;
  /** `teamId -> the id of that team's In Progress state`, resolved once, here. */
  startedStateIds: ReadonlyMap<string, string>;
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

/**
 * The bot's own user id, from the key that will do the writing.
 *
 * Taken from `viewer()` rather than from `config.botUserId` because the config value is
 * whatever the wizard wrote once, and the key is what actually authenticates today. A
 * disagreement between them means the operator swapped `LINEAR_API_KEY` without re-running
 * setup: loop guard L1 would then compare every actor against an id the bot no longer has,
 * and the daemon's own first comment would come back in as a human event and start a loop.
 * That is why an empty id is fatal here rather than warned about downstream.
 */
async function resolveBotUserId(
  linear: LinearClient,
  config: Config,
  log: Logger,
): Promise<string> {
  const me = await linear.viewer();
  if (!me.id) {
    throw new Error(
      'bootDaemon: Linear viewer() returned no user id. Loop guard L1 compares every ' +
        'delivery actor against it, so binding ingress without it would let the bot ' +
        "answer its own comments. Check LINEAR_API_KEY in the config root's .env.",
    );
  }
  if (config.botUserId && config.botUserId !== me.id) {
    log.warn(
      { configured: config.botUserId, authenticated: me.id },
      'config.botUserId disagrees with the authenticated user; using the authenticated one',
    );
  }
  return me.id;
}

/**
 * Every configured team's In Progress state, resolved by TYPE and cached before ingress
 * binds (05-CONTEXT D-06 / INTK-04).
 *
 * Never by name — teams rename "In Progress" to "Doing" freely — and never a hardcoded id,
 * because state ids are per-team. Doing it here rather than on the first ticket means a
 * team with no `started` state fails `law start` with the team named, instead of failing
 * the acknowledgement of the first real run thirty seconds in.
 */
async function resolveStartedStates(
  linear: LinearClient,
  config: Config,
  log: Logger,
): Promise<ReadonlyMap<string, string>> {
  const teamIds = new Set<string>();
  if (config.teamId) teamIds.add(config.teamId);
  for (const mapping of Object.values(config.mappings)) {
    if (mapping.linearTeamId) teamIds.add(mapping.linearTeamId);
  }

  const resolved = new Map<string, string>();
  for (const teamId of teamIds) {
    const stateId = await linear.resolveWorkflowStateId(teamId, 'started');
    if (!stateId) {
      throw new Error(
        `bootDaemon: Linear team ${teamId} resolved no "started" workflow state. Every ` +
          `run moves its ticket to In Progress at pickup, so this would fail every run.`,
      );
    }
    resolved.set(teamId, stateId);
  }
  log.info({ teams: resolved.size }, 'resolved the In Progress state for every mapped team');
  return resolved;
}

export async function bootDaemon(opts: BootOptions = {}): Promise<DaemonHandle> {
  const root = opts.configDir ?? defaultRoot();

  // ── 1. config, secrets, logger, migrated database ──────────────────────────
  const { config, secrets, logger, db } = loadFoundation(root);
  const log = logger.child({ component: 'daemon' });

  // ── 2. the store ───────────────────────────────────────────────────────────
  const store = asDomainStore(createSqliteStore(db));

  // The seam 07-03 left throwing is closed: `LinearClientImpl` now `implements` the domain
  // port rather than declaring a rival of it, so the five divergences 07-02 listed are
  // compile errors if any of them comes back.
  //
  // The `log` argument is hard deliverable #4 and not optional in practice: it defaults to
  // a no-op, and with a no-op every `linear.ratelimited` and every complexity-budget line
  // is silently dropped. With no dashboard the log IS the UI (D-04).
  const linear =
    opts.linear ??
    new LinearClientImpl({
      apiKey: secrets.linearApiKey,
      log: (fields, msg) => log.info(fields, msg),
    });

  // ── 2b. the two identities the rest of boot assumes are already resolved ───
  // Both go through the substitutable client, so the smoke exercises this path offline
  // against its seeded fake. Both are wrong to do per-event: the viewer id never changes
  // within a process, and a per-event workflow-state lookup is a Linear round-trip on the
  // acknowledgement's 10-second budget.
  const botUserId = await resolveBotUserId(linear, config, log);
  const startedStateIds = await resolveStartedStates(linear, config, log);

  const scheduler = createScheduler({ config, log });
  // D-01: no run may leave `queued` in this plan, and nothing may spawn a child process.
  // Plan 05 starts it as part of the boot lifecycle it owns.
  scheduler.pause();

  // Late binding: questions calls back into the engine and the engine calls into
  // questions. The thunk is the port's own answer to that cycle.
  let questions: Questions;
  // The repoSlug -> mapping-key index the toggles, the deliverer and the notifier all
  // read. One pass over config, at boot, instead of a Linear round-trip per lookup.
  const index = mappingIndex(config);
  const adapterDeps = { store, config, log, index };

  const worktrees = createWorktreeManager(adapterDeps);
  const agent = opts.agent ?? createAgentRunner({ ...adapterDeps, spawn: opts.spawn });
  const deliverer = opts.deliverer ?? createDeliverer(adapterDeps);

  // P5, closed. `event-router.ts` has routed `task_summary` / `post_turn_summary` into a
  // progress callback since Phase 4, but nothing threaded it out of the supervisor, so a
  // 40-minute run said nothing between its acknowledgement and its terminal comment and
  // read as hung. It goes to the log and not to a Linear comment on purpose: 05-CONTEXT
  // D-01 caps the ticket at 4-6 milestone comments, and every comment the bot posts is an
  // event the four ingress loop guards then have to drop.
  agent.onProgress((runId, line) => log.info({ runId, progress: line }, 'agent progress'));

  const engine = createRunEngine({
    store,
    scheduler,
    linear,
    config,
    log,
    agent,
    worktrees,
    deliverer,
    questions: () => questions,
  });
  questions = createQuestions({ store, engine, config, linear, log });

  // ── 3. recovery sweep, BEFORE anything can deliver ─────────────────────────
  // `recoverAtBoot` logs its own report; a second line here would only duplicate it.
  await recoverAtBoot({ store, engine, scheduler, questions, linear, config, log });

  // ── 3b. stale worktree collection, AFTER the sweep (04-CONTEXT D-11) ───────
  // Order is the point: recovery is what decides which runs are still alive. Collecting
  // first would prune the worktree of a run recovery was about to requeue, and the requeued
  // run would then resume into a directory that no longer exists.
  const live = new Set(store.listByState(...nonTerminalStates()).map((r) => r.id));
  const pruned = await worktrees.gc(live).catch((err: unknown) => {
    // Never fatal. A daemon that refuses to boot because a mapped clone moved is worse
    // than one carrying a few orphaned directories it will report again next boot.
    log.warn({ err: String(err) }, 'stale worktree collection failed; continuing');
    return [] as string[];
  });
  if (pruned.length > 0) log.info({ pruned }, 'pruned worktrees with no non-terminal run');

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
    botUserId,
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
    createReceiver({ secret, store, log, botUserId, router }),
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
    botUserId,
    startedStateIds,
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

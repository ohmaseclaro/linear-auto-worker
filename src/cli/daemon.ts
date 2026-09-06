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
import { Notifier, type RunEvent as NotifyEvent } from '../outbound/notify/notifier.js';
import { SlackChannel } from '../outbound/notify/slack-channel.js';
import { defaultRoot } from '../infra/config.js';
import { resolveToggles } from '../domain/types.js';
import { createSqliteStore } from '../infra/store/sqlite-store.js';
import { asDomainStore } from '../infra/store/domain-store.js';
import { createReceiver } from '../ingress/receiver.js';
import { createRouter, type Router } from '../ingress/router.js';
import { disable as disableWebhook, KEY_SECRET, reconcile } from '../ingress/registrar.js';
import { closeTunnel, openTunnel } from '../ingress/tunnel.js';
import { createScheduler, type Scheduler } from '../orchestration/scheduler.js';
import { createQuestions, type Questions } from '../orchestration/questions.js';
import { createRunEngine, type RunEngine } from '../orchestration/run-engine.js';
import { recoverAtBoot, reconcile as sweepMissedWork } from '../orchestration/recovery.js';
import { defaultRunCommand, type RunCommand } from '../execution/execute-run.js';
import {
  createAgentRunner,
  createDeliverer,
  createWorktreeManager,
  mappingIndex,
} from './adapters.js';
import type { AgentSpawn } from '../execution/supervisor.js';
import { nonTerminalStates } from '../orchestration/recovery.js';
import { canTransition, holdsSlot, isTerminal } from '../domain/state-machine.js';
import type { RepoRun, RunState } from '../domain/types.js';
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
  /**
   * Every `gh` / `git` / `claude` invocation, including PREFLIGHT. The fifth slot, and it
   * meets the rule: `gh auth status` crosses the network and the other two cross a process
   * boundary. It exists so preflight is code the boot smoke RUNS rather than code the boot
   * smoke skips — an unexercised preflight is a boot step whose failure messages have
   * never been seen, which is the whole reason it exists.
   *
   * The same runner reaches the worktree manager and the deliverer, which already took it.
   */
  runCommand?: RunCommand;
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
  /**
   * Paused at boot and left that way (07-CONTEXT D-01): nothing may leave `queued` here.
   * Exposed rather than hidden because plan 05 owns starting it as part of the boot
   * lifecycle, and the run-path test starts it to walk one run end to end.
   */
  scheduler: Scheduler;
  log: Logger;
  /**
   * Reverse-order shutdown (07-CONTEXT D-03 / OPS-05). Idempotent: a second call resolves
   * without re-signalling a process group whose pid may since have been reused.
   */
  shutdown(reason?: string): Promise<void>;
}

/**
 * The note written onto every in-flight run at a clean stop.
 *
 * Exported because it is the marker the boot smoke and the lifecycle test assert on, and
 * because "some string containing 'shutdown'" is not a contract.
 */
export const SHUTDOWN_NOTE = 'daemon shut down cleanly while this run was in flight';

/**
 * How long the whole child-reap step may take before shutdown proceeds without it.
 *
 * The supervisor's ladder is SIGINT + 15s, SIGTERM + 10s, then SIGKILL, so a group that
 * ignores everything short of SIGKILL takes 25 seconds. This bounds the wait rather than
 * shortening the ladder: shortening it would cost the resumable-session property SIGINT
 * buys (04-CONTEXT D-10), and an operator who does not want to wait has the second signal.
 */
const CHILD_REAP_BUDGET_MS = 30_000;

/** Linear is a courtesy during shutdown, never a blocker. */
const WEBHOOK_DISABLE_BUDGET_MS = 3_000;

/** Resolve `p`, or resolve anyway after `ms`. Never rejects — this is a shutdown path. */
async function within(p: Promise<unknown>, ms: number, what: string, log: Logger): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const bell = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
    // Do not hold the event loop open on the way out.
    timer.unref?.();
  });
  const outcome = await Promise.race([p.then(() => 'done' as const).catch((err: unknown) => {
    log.warn({ step: what, err: String(err) }, 'shutdown step failed; continuing');
    return 'done' as const;
  }), bell]);
  if (timer) clearTimeout(timer);
  if (outcome === 'timeout') log.warn({ step: what, ms }, 'shutdown step timed out; continuing');
}

/**
 * The real ngrok tunnel, expressed as the `TunnelManager` port.
 *
 * ## The authtoken (T10)
 *
 * `@ngrok/ngrok` reads NEITHER the bare `NGROK_AUTHTOKEN` environment variable NOR the
 * macOS agent's YAML on its own — `authtoken_from_env: true` is what makes it look, and
 * `openTunnel` passes it. But this daemon's authtoken lives in the config root's `.env`,
 * which `loadSecrets` reads into memory and does NOT export, so with the operator's shell
 * clean the SDK finds nothing and fails `ERR_NGROK_4018` — which is byte-identical to a
 * revoked account. Publishing the loaded secret into the environment here is the explicit
 * pass the SDK's only supported channel accepts.
 *
 * It does not overwrite an authtoken the operator already exported: theirs is the more
 * specific intent, and silently substituting a stale one from `.env` is a failure they
 * cannot see.
 *
 * ## The retry
 *
 * One retry, then out. A tunnel is the daemon's only ingress, so failing to open one is
 * fatal by definition; retrying forever would leave a process that looks alive, logs
 * hopefully and can never receive anything.
 */
function ngrokTunnel(authtoken: string, log: Logger): TunnelManager {
  let open: Awaited<ReturnType<typeof openTunnel>> | null = null;
  return {
    async open(port: number): Promise<string> {
      process.env.NGROK_AUTHTOKEN ??= authtoken;
      for (let attempt = 1; ; attempt += 1) {
        try {
          open = await openTunnel(port);
          return open.url;
        } catch (err) {
          // T24: the ngrok failure message can ECHO the operator's authtoken. `openTunnel`
          // already extracts the code and drops the rest; nothing here may re-widen that.
          if (attempt >= 2) throw err;
          log.warn({ attempt }, 'tunnel failed to open; retrying once');
          await new Promise((r) => setTimeout(r, 2_000));
        }
      }
    },
    url: () => open?.url ?? null,
    async close(): Promise<void> {
      if (open) await closeTunnel(open.listener);
      open = null;
    },
  };
}

/**
 * The tools this daemon shells out to, checked BEFORE the socket binds.
 *
 * Every message names the fix rather than the failure. This is `law start` on a machine
 * the operator set up weeks ago, so "gh: command not found" three minutes into the first
 * real ticket — after the ticket has already been moved to In Progress and a worktree
 * created — is the outcome this exists to prevent.
 *
 * It never prompts and never writes: acquiring a credential is the wizard's job, and a
 * daemon that can prompt is a daemon that hangs when run under a supervisor.
 */
const PREFLIGHT: ReadonlyArray<{
  what: string;
  file: string;
  args: readonly string[];
  fix: string;
}> = [
  {
    what: 'git',
    file: 'git',
    args: ['--version'],
    fix: 'install git (xcode-select --install on macOS) — every run creates a worktree',
  },
  {
    what: 'claude',
    file: 'claude',
    args: ['--version'],
    fix: 'install the Claude Code CLI and make sure `claude` is on PATH — it is what does the work',
  },
  {
    what: 'gh',
    file: 'gh',
    args: ['auth', 'status'],
    fix: 'run `gh auth login` — the daemon opens pull requests with your gh credentials',
  },
];

async function preflight(run: RunCommand, log: Logger): Promise<void> {
  for (const check of PREFLIGHT) {
    let ok = false;
    try {
      // `reject: false` so a non-zero exit is a value rather than an exception: a missing
      // binary and a failed check must produce the SAME actionable message.
      const res = await run(check.file, check.args, { reject: false });
      ok = res.exitCode === 0;
    } catch {
      ok = false;
    }
    if (!ok) {
      throw new Error(`law start: ${check.what} is not usable. Fix: ${check.fix}`);
    }
    log.info({ tool: check.what }, 'preflight ok');
  }
}

/**
 * The team `webhookCreate` is registered against.
 *
 * Resolved here rather than inside the registrar so the failure is one actionable line at
 * boot instead of a GraphQL validation error from inside reconciliation.
 */
function webhookTeamId(config: Config): string {
  const teamId =
    config.teamId ||
    Object.values(config.mappings)
      .map((m) => m.linearTeamId)
      .find((t): t is string => Boolean(t));
  if (!teamId) {
    throw new Error(
      'law start: no Linear team is configured. Linear requires a team on webhook ' +
        'creation. Set `teamId`, or give at least one mapping a `linearTeamId`, in ' +
        'config.json — or re-run `law setup`.',
    );
  }
  return teamId;
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

/**
 * The fan-out, built here and reached ONLY through the run engine.
 *
 * ## Why the Linear comment channel is not in this array
 *
 * 05-CONTEXT lists three channels and this constructs two. That is a deliberate deviation,
 * not an omission: the run engine already posts every Linear comment this product makes,
 * and it posts them with things `LinearCommentChannel` structurally cannot do — the
 * acknowledgement is EDITED in place as the queue moves (D-10 / INTK-06), a question is a
 * threaded reply whose comment id is stored for tier-1 answer correlation, and a
 * multi-repo ticket gets one rollup instead of one comment per child (D-12 / DELV-07).
 * `LinearCommentChannel.enabled()` gates on the mapping toggle alone and fires on every
 * kind, so adding it here would post a SECOND, poorer comment for every milestone on every
 * ticket — the wall of bot noise D-10 exists to prevent.
 *
 * The right resolution is to move the engine's four comment sites onto the channel, which
 * is a Phase 5/6 redesign and not a wiring change. Recorded in WINDOWS.md.
 *
 * ## What is NOT deviated from
 *
 * The log channel. `Notifier` constructs its own and emits to it first, unretried and
 * ungated; there is no argument that removes it (05-CONTEXT D-04 / NOTF-01). That is the
 * half of the fan-out that matters most here, because it is the half the engine does not
 * already do.
 */
function createDaemonNotifier(o: {
  config: Config;
  index: ReadonlyMap<string, string>;
  log: Logger;
}): Notifier {
  const logFn = (fields: Record<string, unknown>, msg: string): void => o.log.info(fields, msg);
  return new Notifier({
    log: logFn,
    channels: [
      new SlackChannel({
        // Per-mapping (Phase 1 D-09): a mapping with `notifySlack` off, or with no webhook
        // configured, returns undefined and the channel gates itself out.
        webhookUrl: (mappingId: string) => {
          const mapping = o.config.mappings[mappingId];
          if (!mapping) return undefined;
          return resolveToggles(o.config.defaults, mapping).notifySlack
            ? mapping.slackWebhookUrl
            : undefined;
        },
        log: logFn,
      }),
    ],
  });
}

/**
 * `(RepoRun, RunState)` → the notifier's own vocabulary.
 *
 * The two sets do not line up and this is where that is admitted. Four of the nine states
 * are terminal and collapse to one kind; `delivering` reports nothing, because a run that
 * has begun pushing has not yet done anything a human needs told; and `worktree_ready` has
 * no state of its own, since the engine transitions straight to `running` once the worktree
 * exists — one event per transition beats two events for one write.
 */
const NOTIFY_KIND: Partial<Record<RunState, 'picked_up' | 'agent_started' | 'question_asked'>> = {
  preparing: 'picked_up',
  running: 'agent_started',
  awaiting_answer: 'question_asked',
};

function toNotifyEvent(
  run: RepoRun,
  detail: string | undefined,
  index: ReadonlyMap<string, string>,
): NotifyEvent | null {
  const base = {
    runId: run.id,
    issueId: run.issueId,
    issueIdentifier: run.issueKey,
    issueUrl: run.issueUrl,
    mappingId: index.get(run.repoSlug) ?? '',
    at: run.updatedAt,
  };

  if (isTerminal(run.state)) {
    return {
      ...base,
      kind: 'terminal',
      // The four terminal RunStates ARE the four TerminalRunStates, in the same spelling.
      state: run.state as 'delivered' | 'partial' | 'failed' | 'cancelled',
      // ponytail: zero, and honestly so — there is no cost or token column on `runs`, and
      // inventing one here would be a schema change wearing a wiring change's clothes.
      // Ceiling: Slack and the log report `$0.0000` on every run until the run row carries
      // what `classifyOutcome` already computes. Recorded in WINDOWS.md.
      costUsd: 0,
      tokensUsed: 0,
      ...(run.prUrl ? { prUrl: run.prUrl } : {}),
      ...(run.failureReason ?? detail ? { reason: run.failureReason ?? detail } : {}),
    };
  }

  const kind = NOTIFY_KIND[run.state];
  if (!kind) return null;
  if (kind === 'question_asked') {
    return { ...base, kind, question: detail ?? 'a question is waiting on the ticket' };
  }
  return { ...base, kind };
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

  // ── 2a. preflight, before anything binds or registers ─────────────────────
  // `gh`, `claude` and `git` first because they are pure local checks, then the Linear
  // viewer call below, which is the fourth preflight and the network one.
  const runCommand = opts.runCommand ?? defaultRunCommand;
  await preflight(runCommand, log);

  // ── 2b. the two identities the rest of boot assumes are already resolved ───
  // Both go through the substitutable client, so the smoke exercises this path offline
  // against its seeded fake. Both are wrong to do per-event: the viewer id never changes
  // within a process, and a per-event workflow-state lookup is a Linear round-trip on the
  // acknowledgement's 10-second budget.
  const botUserId = await resolveBotUserId(linear, config, log);
  const startedStateIds = await resolveStartedStates(linear, config, log);

  const scheduler = createScheduler({ config, log });
  // Paused for the whole of boot and started at the very LAST step (07-CONTEXT D-01).
  // Nothing before that line may leave `queued`, which is what makes "no child process
  // is spawned until the daemon is fully wired" a property of the code rather than of
  // how long each preceding step happens to take.
  scheduler.pause();

  // Late binding: questions calls back into the engine and the engine calls into
  // questions. The thunk is the port's own answer to that cycle.
  let questions: Questions;
  // The repoSlug -> mapping-key index the toggles, the deliverer and the notifier all
  // read. One pass over config, at boot, instead of a Linear round-trip per lookup.
  const index = mappingIndex(config);
  const adapterDeps = { store, config, log, index, runCommand };

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

  const notifier = createDaemonNotifier({ config, index, log });

  const engine = createRunEngine({
    store,
    scheduler,
    linear,
    config,
    log,
    agent,
    worktrees,
    deliverer,
    // The ONE notification site. `transition()` is the only writer of `runs.state`, so
    // hanging the fan-out off it makes "every transition is reported" structural rather
    // than a convention every future edit has to remember.
    notify: (run, detail) => {
      const event = toNotifyEvent(run, detail, index);
      // `emit` never rejects by contract, which is what makes a bare `void` safe here and
      // is why a transition cannot fail because Slack is down.
      if (event) void notifier.emit(event);
    },
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
  // OPS-02 / 02-CONTEXT D-05. The logger was constructed with the two secrets that exist
  // at boot; this third one is generated at RUNTIME, so redaction has to be told about it.
  // Registering it at the sink rather than at each call site is what makes it impossible
  // to forget in one place — and one place is all it takes.
  logger.registerSecret(secret);

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
  // The bind above is not a style choice (D-02, HOOK-01). Reversed, there is a window in
  // which Linear can deliver to a live public URL backed by nothing; each 502 is a failed
  // delivery, Linear allows three, and the fourth disables the webhook. The boot smoke's
  // tunnel stub TCP-connects to the port it is handed and fails on ECONNREFUSED, so this
  // ordering is asserted from both sides rather than described in a comment.
  const tunnel = opts.tunnel ?? ngrokTunnel(secrets.ngrokAuthtoken, log);
  // Asserted from THIS side too, not only from the stub's. The stub proves the socket
  // answers; this proves the daemon believes it does, and it holds for the real ngrok
  // tunnel as well — where nothing probes anything and a reorder would otherwise be
  // caught by nobody until Linear's third failed delivery.
  if (!server.listening) {
    throw new Error(
      'HOOK-01: refusing to open a tunnel — the receiver is not accepting connections. ' +
        'The bind must complete before the tunnel opens (07-CONTEXT D-02).',
    );
  }
  const publicUrl = await tunnel.open(port);
  log.info({ port }, 'tunnel open');

  // ── 6. reconcile the webhook against the URL the tunnel just handed back ───
  // Never a blind create: the label is matched against the full listing first, and an
  // existing registration is updated AND re-enabled in one call. With an ephemeral domain
  // every restart guarantees failed deliveries, so finding our webhook auto-disabled is
  // the normal case here (03-CONTEXT D-02).
  const registration = await reconcile(linear, store, log, {
    tunnelUrl: publicUrl,
    teamId: webhookTeamId(config),
    secret,
  });

  // ── 7. the missed-work sweep ───────────────────────────────────────────────
  // This is what makes an ephemeral URL safe. While the daemon was down, Linear delivered
  // to a URL that will never answer and spent its retries doing it; those deliveries are
  // gone. Polling for ground truth is the only recovery, and `reconcile` covers BOTH
  // halves — assignments whose webhook never arrived, and threaded ANSWERS whose webhook
  // never arrived, which an issue-level `updatedAt` diff structurally cannot see.
  //
  // It already degrades rather than throws: a slow or failing Linear leaves the watermark
  // where it was and logs, so the daemon comes up missing backlog instead of not coming up.
  await sweepMissedWork(
    { store, engine, scheduler, questions, linear, config, log },
    Date.now(),
  );

  // ── 8. and only now may anything spawn a child process ─────────────────────
  scheduler.start();
  /** The idempotence memo. See `shutdown` below. */
  let shuttingDown: Promise<void> | null = null;
  log.info({ port, publicUrl, webhookId: registration.id }, 'daemon ready');

  return {
    port,
    botUserId,
    startedStateIds,
    publicUrl,
    config,
    store,
    engine,
    scheduler,
    log,
    shutdown: (reason = 'signal') => shutdown(reason),
  };

  /**
   * Boot, backwards (07-CONTEXT D-03 / OPS-05).
   *
   * The order is not tidiness. Closing the tunnel while children are still writing, or
   * closing the store before marking what was in flight, produces exactly the zombie run
   * with a stuck In Progress ticket that OPS-01 forbids.
   *
   * Idempotent by construction: the promise is memoised, so a second call — a SIGTERM
   * arriving behind a SIGINT, a test asserting it — awaits the first rather than
   * re-signalling a process group whose pid may since have been reused by the OS.
   */
  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return shuttingDown;
    shuttingDown = (async () => {
      log.info({ reason }, 'shutting down');

      // 1. Nothing new is claimed. Parked waiters stay parked and are marked below.
      scheduler.pause();

      // 2. The children, by PROCESS GROUP. `engine.stop()` aborts every live run, and the
      //    supervisor's abort listener runs the escalation: SIGINT, then SIGTERM, then
      //    SIGKILL, each to the NEGATED pid (`process.kill(-pid, sig)`), with a fresh
      //    liveness check between steps. The negation is the whole point — signalling the
      //    leader alone kills `claude` and ORPHANS the agent's own Bash subprocesses,
      //    which then survive the daemon, keep writing into a worktree nothing owns, and
      //    leave the supervisor's promise permanently pending because the survivor holds
      //    the stdout pipe open (T29, measured).
      //
      //    `stop()` also tells every driver to stop writing run state, which is what makes
      //    step 6 possible: without it, a reaped child comes back as `cancelled`, the
      //    driver transitions the run to a terminal state and posts a comment saying so,
      //    and the requeue below would find nothing left to requeue.
      await engine.stop();
      await within(engine.settle(), CHILD_REAP_BUDGET_MS, 'reap children', log);

      // 3. Politeness, time-boxed (T-07-23). The URL is about to stop answering; leaving
      //    the webhook enabled spends Linear's three retries on deliveries that cannot
      //    land. Never fatal — `disable` returns false rather than throwing.
      await within(
        disableWebhook(linear, store, log),
        WEBHOOK_DISABLE_BUDGET_MS,
        'disable webhook',
        log,
      );

      // 4. The tunnel, then 5. the server — in that order, so the public URL stops
      //    resolving before the thing behind it stops answering. Reversed, the last
      //    deliveries in flight get a 502 from a live URL, which is the same failed
      //    delivery step 3 just spent a call avoiding.
      await within(tunnel.close(), 5_000, 'close tunnel', log);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();

      // 6. Mark what was in flight — BEFORE the store closes, which is the whole reason
      //    this step is here and not earlier.
      await markInFlight();

      // 7. The database, last. Everything above may still need to read or write it.
      store.close();
      log.info({ reason }, 'shutdown complete');
    })();
    return shuttingDown;
  }

  /**
   * 07-CONTEXT D-06, and the part that is easy to read as bookkeeping and is not.
   *
   * 06-CONTEXT D-07 fails a `running` row found at boot, because after an UNCLEAN exit the
   * push status is unknowable and replaying the run would open a second pull request for
   * work that already shipped. That rule is correct and stays. What makes it *narrow* is
   * this function: a clean stop moves those runs back to `queued` before exiting, so a
   * `running` row surviving to the next boot genuinely means a crash. Without this write,
   * every Ctrl-C would cost a manual re-assignment of every live ticket (TRAPS T18, T26).
   *
   * Which runs move is asked of the domain state table, not decided here:
   *
   *   - `holdsSlot` IS "in flight" — `preparing`, `running`, `delivering`. `queued` and
   *     `awaiting_answer` are already correct for the next boot and are left alone; an
   *     `awaiting_answer` run's deadline is a column in SQLite, so there is no timer to
   *     re-arm and nothing to mark.
   *   - of those, whichever the transition table permits back to `queued` are requeued.
   *     `preparing` and `running` are; `delivering` deliberately is NOT, and that refusal
   *     is the same one D-07 makes — a run that reached `delivering` may already have
   *     pushed, so the next boot fails it with a diagnosis and leaves the branch for the
   *     operator (T-07-26, accepted). Reading the answer off `canTransition` rather than
   *     writing a second list here is what keeps the two from drifting apart.
   */
  async function markInFlight(): Promise<void> {
    const marked: string[] = [];
    const requeued: string[] = [];
    for (const run of store.listByState(...nonTerminalStates())) {
      // A ticket parent has no state of its own; its children are marked individually.
      if (run.kind !== 'repo' || !holdsSlot(run.state)) continue;
      try {
        store.updateRun(run.id, { failureReason: SHUTDOWN_NOTE, updatedAt: Date.now() });
        marked.push(run.id);
        if (canTransition(run.state, 'queued')) {
          await engine.transition(run.id, 'queued', SHUTDOWN_NOTE);
          requeued.push(run.id);
        }
      } catch (err) {
        // One row must not abandon the rest: an unmarked run is a stuck ticket.
        log.error({ runId: run.id, err: String(err) }, 'could not mark an in-flight run');
      }
    }
    log.info({ marked: marked.length, requeued: requeued.length }, 'in-flight runs marked');
  }
}

/**
 * Install the signal handlers on this process, and hand back a remover.
 *
 * Deliberately NOT done inside `bootDaemon`. Signal handlers are process-wide state, and a
 * boot that installs them means the smoke and every integration test accumulate a handler
 * per booted daemon on a process they share — so the second test's Ctrl-C would shut down
 * the first test's daemon. `law start` calls this; a test calls it and calls the remover.
 *
 * A SECOND signal while a shutdown is already running exits immediately rather than being
 * swallowed. The graceful path can legitimately take half a minute (the child escalation
 * ladder is SIGINT + 15s then SIGTERM + 10s), and an operator pressing Ctrl-C twice is
 * asking for exactly that trade: they get the daemon dead now, and the next boot's
 * recovery sweep cleans up what this shutdown did not reach.
 */
export function installSignalHandlers(
  handle: Pick<DaemonHandle, 'shutdown' | 'log'>,
  exit: (code: number) => void = (code) => process.exit(code),
): () => void {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  let stopping = false;

  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopping) {
      handle.log.warn({ signal }, 'second signal during shutdown; exiting now');
      exit(1);
      return;
    }
    stopping = true;
    handle.log.info({ signal }, 'signal received');
    void handle.shutdown(signal).then(
      () => exit(0),
      (err: unknown) => {
        handle.log.error({ signal, err: String(err) }, 'shutdown failed');
        exit(1);
      },
    );
  };

  const listeners = signals.map((sig) => {
    const fn = (): void => onSignal(sig);
    process.on(sig, fn);
    return [sig, fn] as const;
  });

  return () => {
    for (const [sig, fn] of listeners) process.off(sig, fn);
  };
}

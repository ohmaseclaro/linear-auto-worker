/**
 * The boot smoke test — 07-CONTEXT D-04, and the only mechanism in this milestone that can
 * see a wiring break.
 *
 * `tsc --noEmit` checks types and the unit suite instantiates against fakes, so a module
 * that never wires up what it depends on passes both. This boots the REAL module graph on a
 * throwaway config directory, pushes one HMAC-signed delivery through the whole ingress
 * seam, asserts a `queued` run landed in a real SQLite file, and then STOPS the daemon and
 * asserts the stop was correct.
 *
 * What it proves, in the order it proves it:
 *
 *   1. The composition root boots without touching `~/.linear-auto-worker/` (mkdtemp).
 *   2. Preflight ran, and ran before the socket bound.
 *   3. The HTTP server is bound BEFORE the tunnel opens, asserted from both sides — the
 *      daemon checks `server.listening`, and the tunnel stub TCP-connects to the port it
 *      is handed and fails the run on ECONNREFUSED (HOOK-01).
 *   4. The webhook was reconciled by label against the URL the tunnel returned, and the id
 *      and secret are both on disk.
 *   5. The missed-work sweep ran and correctly enqueued nothing for an unassigned issue.
 *   6. A signature over the exact request body bytes verifies (T6/T14).
 *   7. The 200 comes back inside the acknowledge-then-work budget (HOOK-08).
 *   8. The router re-fetched the canonical issue rather than trusting the delivery body.
 *   9. A `queued` run and its genesis `run_events` row are in the database — through the
 *      real store, against the real schema (T53).
 *  10. Shutdown runs BACKWARDS: the tunnel closes while the server is still accepting, the
 *      port refuses connections afterwards, a second shutdown is safe, and a run left in
 *      flight is requeued with a shutdown reason that is durable on disk (OPS-05, D-06).
 *
 * Exits 0 on success, 1 with a readable diagnosis on any failure.
 */
import * as net from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';

import {
  bootDaemon,
  installSignalHandlers,
  SHUTDOWN_NOTE,
  type DaemonHandle,
} from '../src/cli/daemon.js';
import {
  BOT_USER_ID,
  ISSUE_ID,
  makeWorkspace,
  postDelivery,
  probingTunnel,
  RecordingLinear,
  smokeIssue,
  until,
  type Workspace,
} from '../src/cli/daemon-fixture.js';
import { issuePayload, signed } from '../src/ingress/fixtures.js';
import { KEY_ID, KEY_SECRET, WEBHOOK_LABEL } from '../src/ingress/registrar.js';
import { createSqliteStore } from '../src/infra/store/sqlite-store.js';
import { openStore } from '../src/infra/store/db.js';
import type { RunCommandResult } from '../src/execution/execute-run.js';
import type { Run } from '../src/domain/ports.js';

/** Linear's own budget is five seconds; anything that awaits real work blows past this. */
const ACK_BUDGET_MS = 1_000;

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(what);
  console.log(`  ok  ${what}`);
}

/** True iff something is accepting on the port. Used to prove the server actually closed. */
function accepting(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function main(): Promise<void> {
  const secret = randomBytes(32).toString('hex');
  let workspace: Workspace | undefined;
  let daemon: DaemonHandle | undefined;

  try {
    workspace = await makeWorkspace(secret);
    console.log(`workspace: ${workspace.dir}`);

    // NOT assigned to the bot at boot. The boot sweep is supposed to find nothing here,
    // and the assignment below is the event the delivery announces — which is the real
    // sequence, and the one that keeps the two producers of `run.requested` from racing.
    const issue = smokeIssue({ assigneeId: null });
    const linear = new RecordingLinear({ issues: [issue] });
    const tunnel = probingTunnel();

    // Preflight, exercised rather than skipped. `gh auth status` must not be the operator's
    // real gh in a smoke run, but the code path that reads its exit code must be.
    const toolCalls: string[] = [];
    const runCommand = (file: string, args: readonly string[]): Promise<RunCommandResult> => {
      toolCalls.push(`${file} ${args.join(' ')}`);
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    };

    daemon = await bootDaemon({ configDir: workspace.dir, linear, tunnel, runCommand });

    check(
      toolCalls.some((c) => c.startsWith('gh auth status')) &&
        toolCalls.some((c) => c.startsWith('claude ')) &&
        toolCalls.some((c) => c.startsWith('git ')),
      `preflight checked gh, claude and git (${toolCalls.length} calls)`,
    );

    // The two boot resolutions, asserted BEFORE anything about ingress — the daemon has
    // already bound and already registered by the time the handle comes back, so a bot id
    // that resolved empty would have disabled loop guard L1 by now. What this can still
    // prove is that the resolution HAPPENED and produced a real value, and the daemon
    // throws rather than continuing if either did not.
    check(
      daemon.botUserId === BOT_USER_ID,
      `the bot user id was resolved from viewer(), not from config (got ${daemon.botUserId})`,
    );
    check(
      daemon.startedStateIds.size > 0 &&
        [...daemon.startedStateIds.values()].every((id) => id.length > 0),
      `the In Progress state resolved for every mapped team (${daemon.startedStateIds.size} team(s))`,
    );
    check(
      linear.stateLookups.every((l) => l.stateType === 'started'),
      'the state was resolved by TYPE, never by name (05-CONTEXT D-06)',
    );

    check(tunnel.probes.length === 1, 'the tunnel opened exactly once');
    check(
      tunnel.probes[0] === daemon.port,
      `the tunnel's TCP probe reached the bound port (HOOK-01: bind before tunnel)`,
    );

    // The webhook reconcile — the one boot step that mutates workspace configuration, and
    // until 07-05 the one boot step nothing exercised.
    const hooks = await linear.listWebhooks();
    check(hooks.length === 1, `exactly one webhook is registered (got ${hooks.length})`);
    check(hooks[0]?.label === WEBHOOK_LABEL, 'the registration carries our label, not a bare URL');
    check(
      hooks[0]?.url === `${daemon.publicUrl}/linear/webhook`,
      'the webhook points at the URL this tunnel just returned',
    );
    check(hooks[0]?.enabled === true, 'the registration is enabled (03-CONTEXT D-02)');
    check(
      daemon.store.kvGet(KEY_ID) === hooks[0]?.id &&
        daemon.store.kvGet(KEY_SECRET) === workspace.secret,
      'the webhook id and the signing secret are both on disk (T-07-22)',
    );

    // The missed-work sweep. Nothing to find: the issue is not assigned yet.
    check(
      daemon.store.listByState('queued').length === 0,
      'the boot sweep enqueued nothing for an issue the bot is not assigned to',
    );

    // From here the smoke wants to observe a run sitting at `queued`, so it re-pauses the
    // scheduler that boot correctly started. Driving a run to completion is the run-path
    // integration test's job — it has a scratch git repository and a scripted agent, and
    // this file deliberately has neither.
    daemon.scheduler.pause();

    // The assignment the delivery is about to announce. The fake hands back this very
    // object, so mutating it IS the workspace changing under the daemon.
    issue.assigneeId = BOT_USER_ID;

    // One delivery: the bot was just assigned to SMK-1. `updatedFrom` carries the
    // assigneeId KEY, which is the edge the router detects; the value is a hint it then
    // refuses to trust.
    const deliveryId = randomUUID();
    const fixture = signed(
      issuePayload({
        actor: { id: 'human-user-id', type: 'user' },
        data: { id: ISSUE_ID, assigneeId: BOT_USER_ID },
        updatedFrom: { assigneeId: null },
        webhookTimestamp: Date.now(),
      }),
      { secret, deliveryId },
    );

    const res = await postDelivery(daemon.port, fixture);
    check(res.status === 200, `a validly signed delivery is accepted (got ${res.status})`);
    check(
      res.ms < ACK_BUDGET_MS,
      `the acknowledgement came back in ${res.ms}ms, inside the ${ACK_BUDGET_MS}ms budget`,
    );

    const store = daemon.store;
    const queued = await until<Run[]>(
      () => {
        const runs = store.listByState('queued');
        return runs.length > 0 ? runs : undefined;
      },
      { label: 'a queued run for the delivered issue' },
    );

    check(queued.length === 1, `exactly one run was created (got ${queued.length})`);
    const run = queued[0]!;
    check(run.issueId === ISSUE_ID, 'the run is for the issue the delivery named');
    check(run.state === 'queued', `the run is queued (got ${String(run.state)})`);

    const events = store.listRunEvents(run.id);
    check(events.length === 1, `one run_events row was appended (got ${events.length})`);
    check(
      events[0]!.from === null && events[0]!.to === 'queued',
      'the genesis run_events row records the insert at queued',
    );

    check(
      linear.fetched.includes(ISSUE_ID),
      'the router decided from a canonical issue fetch, not from the delivery body',
    );

    // ── shutdown (OPS-05) ────────────────────────────────────────────────────
    // Walk the run into a state that holds a slot, so there is something genuinely in
    // flight for the stop to deal with. `running` is the state 06-CONTEXT D-07 fails at
    // boot, which is precisely why a CLEAN stop has to get it out of there first.
    await daemon.engine.transition(run.id, 'preparing', 'smoke: manufacture an in-flight run');
    await daemon.engine.transition(run.id, 'running', 'smoke: manufacture an in-flight run');

    const port = daemon.port;

    // Through the SIGNAL path, not by calling shutdown directly — that is the path an
    // operator actually takes, and the only one that also exercises the handler. `exit` is
    // injected so the smoke does not take the process down with it.
    const exits: number[] = [];
    const before = {
      int: process.listenerCount('SIGINT'),
      term: process.listenerCount('SIGTERM'),
    };
    const uninstall = installSignalHandlers(daemon, (code) => exits.push(code));
    // BOTH signals, counted rather than grepped. `SIGTERM` appears in prose in this
    // codebase (the supervisor's escalation ladder is documented in several places), so a
    // source grep for the string passes even with the handler removed. A listener count
    // cannot be satisfied by a comment.
    check(
      process.listenerCount('SIGINT') === before.int + 1 &&
        process.listenerCount('SIGTERM') === before.term + 1,
      'installSignalHandlers registered a handler for SIGINT AND for SIGTERM',
    );
    process.emit('SIGINT', 'SIGINT');
    await until(() => (exits.length > 0 ? exits : undefined), { label: 'SIGINT to shut down' });
    check(exits[0] === 0, `SIGINT ran a clean shutdown and exited 0 (got ${String(exits[0])})`);

    // The second signal is NOT swallowed. The graceful path can legitimately take half a
    // minute reaping a child that ignores SIGINT, and an operator pressing Ctrl-C twice is
    // asking to stop waiting — so it exits non-zero immediately rather than politely.
    process.emit('SIGINT', 'SIGINT');
    check(
      exits.length === 2 && exits[1] === 1,
      `a second signal escalates to an immediate exit (got ${JSON.stringify(exits)})`,
    );
    uninstall();
    check(
      process.listenerCount('SIGINT') === before.int &&
        process.listenerCount('SIGTERM') === before.term,
      'the remover leaves the process exactly as it found it',
    );

    check(
      tunnel.closeProbes.length === 1 && tunnel.closeProbes[0] === port,
      'the tunnel closed while the server was still accepting (reverse boot order)',
    );
    check(!(await accepting(port)), `the bound port refuses connections after shutdown`);
    await daemon.shutdown('smoke again');
    check(true, 'a second shutdown resolves without error (idempotent)');

    // Read the run back through a FRESH connection to the same file. If the mark had
    // happened after `store.close()` the write would have thrown; if it had not happened
    // at all, the next boot would fail this run with a crash diagnosis it never earned.
    const reopened = createSqliteStore(openStore(`${workspace.dir}/store.db`));
    const after = reopened.getRun(run.id);
    check(after !== undefined, 'the in-flight run is still in the database after shutdown');
    check(
      after?.kind === 'repo' && after.state === 'queued',
      `the in-flight run was requeued for the next boot (got ${String(
        after?.kind === 'repo' ? after.state : 'ticket',
      )})`,
    );
    check(
      after?.failureReason === SHUTDOWN_NOTE,
      'the requeued run carries the shutdown reason (07-CONTEXT D-06)',
    );
    reopened.close();
    daemon = undefined;

    console.log('\nSMOKE PASSED — a signed webhook became a persisted queued run, and the stop was clean.');
  } finally {
    if (daemon) await daemon.shutdown('smoke cleanup');
    if (workspace) await workspace.remove();
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error('\nSMOKE FAILED');
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  },
);

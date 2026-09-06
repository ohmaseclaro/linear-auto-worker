/**
 * The boot smoke test — 07-CONTEXT D-04, and the only mechanism in this milestone that can
 * see a wiring break.
 *
 * `tsc --noEmit` checks types and the unit suite instantiates against fakes, so a module
 * that never wires up what it depends on passes both. This boots the REAL module graph on a
 * throwaway config directory, pushes one HMAC-signed delivery through the whole ingress
 * seam, and asserts a `queued` run landed in a real SQLite file.
 *
 * What it proves, in the order it proves it:
 *
 *   1. The composition root boots without touching `~/.linear-auto-worker/` (mkdtemp).
 *   2. The HTTP server is bound BEFORE the tunnel opens — the tunnel stub TCP-connects to
 *      the port it is handed and fails the run if the connection is refused (HOOK-01).
 *   3. A signature over the exact request body bytes verifies (T6/T14).
 *   4. The 200 comes back inside the acknowledge-then-work budget (HOOK-08).
 *   5. The router re-fetched the canonical issue rather than trusting the delivery body.
 *   6. A `queued` run and its genesis `run_events` row are in the database — through the
 *      real store, against the real schema (T53).
 *
 * Execution is still faked and the scheduler is paused, deliberately: 07-CONTEXT D-01 wires
 * router→engine before engine→execution so an ingress bug costs a poll loop rather than a
 * full Claude session.
 *
 * Exits 0 on success, 1 with a readable diagnosis on any failure.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import { bootDaemon, type DaemonHandle } from '../src/cli/daemon.js';
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
import type { Run } from '../src/domain/ports.js';

/** Linear's own budget is five seconds; anything that awaits real work blows past this. */
const ACK_BUDGET_MS = 1_000;

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(what);
  console.log(`  ok  ${what}`);
}

async function main(): Promise<void> {
  const secret = randomBytes(32).toString('hex');
  let workspace: Workspace | undefined;
  let daemon: DaemonHandle | undefined;

  try {
    workspace = await makeWorkspace(secret);
    console.log(`workspace: ${workspace.dir}`);

    const linear = new RecordingLinear({ issues: [smokeIssue()] });
    const tunnel = probingTunnel();

    daemon = await bootDaemon({ configDir: workspace.dir, linear, tunnel });

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

    console.log('\nSMOKE PASSED — a signed webhook became a persisted queued run.');
  } finally {
    if (daemon) await daemon.shutdown();
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

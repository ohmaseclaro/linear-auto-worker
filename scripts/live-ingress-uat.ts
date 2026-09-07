/**
 * The live ingress UAT: everything up to the agent, against a REAL ngrok tunnel.
 *
 * `npm run smoke` proves the same chain against a fake tunnel, in-process. This proves the
 * part a fake structurally cannot: that a real ngrok tunnel opens with the operator's own
 * authtoken, that the public URL it issues resolves from the internet back to the loopback
 * receiver, and that HMAC verification behaves correctly on a request that actually
 * crossed the network.
 *
 * Everything Linear-facing is a fake client, deliberately. This script CANNOT reach a real
 * Linear workspace — no key is read, no API call is made, no webhook is registered against
 * anything real. It is safe to run against a company workspace's machine because it never
 * touches the workspace.
 *
 * Requires: an ngrok authtoken in the operator's own ngrok config (or NGROK_AUTHTOKEN).
 * Requires no Linear credentials, no bot user, and no `law setup`.
 *
 * Two traps were walked into while writing it, both now commented in place: loop guard L1
 * drops a delivery with no human actor (T-06 self-event), and a blanket exit-0 command
 * runner answers "yes" to `git show-ref --verify`, so every branch name reads as taken
 * (T87). Both are the product being right.
 */
import { randomBytes } from 'node:crypto';
import { LINEAR_WEBHOOK_SIGNATURE_HEADER } from '@linear/sdk/webhooks';
import { createHmac } from 'node:crypto';

import { acquireNgrokToken } from '../src/cli/wizard/secrets.js';
import { openTunnel, closeTunnel } from '../src/ingress/tunnel.js';
import { bootDaemon } from '../src/cli/daemon.js';
import {
  makeWorkspace, smokeIssue, RecordingLinear, ISSUE_ID, BOT_USER_ID, makeScratchRepo, okTools,
} from '../src/cli/daemon-fixture.js';

let pass = 0, fail = 0;
const check = (ok, what) => { ok ? (pass++, console.log(`  ok  ${what}`)) : (fail++, console.log(`  FAIL ${what}`)); };

const secret = randomBytes(32).toString('hex');
const workspace = await makeWorkspace(secret);
await makeScratchRepo(workspace.dir);
let daemon, listener;

try {
  // 1. The token, from the operator's own ngrok config (T39: macOS Application Support).
  const tok = await acquireNgrokToken({});
  check(tok.ok !== false, 'ngrok authtoken lifted from the operator config');
  process.env.NGROK_AUTHTOKEN = tok.value.token;

  // 2. A daemon whose tunnel is REAL. Linear stays fake.
  const linear = new RecordingLinear({ issues: [smokeIssue({ assigneeId: null })] });
  const realTunnel = {
    async open(port) {
      const t = await openTunnel(port);
      listener = t.listener;
      return t.url;
    },
    async close() { if (listener) await closeTunnel(listener); listener = undefined; },
  };
  // `okTools`, not a blanket exit-0 runner. TRAPS T87: answering 0 to everything answers
  // "yes" to `git show-ref --verify refs/heads/<b>`, so every candidate branch reads as
  // taken and the run dies with "could not find a free branch name after 50 attempts". The
  // first version of this probe did exactly that — the trap, in the file that documents it.
  const runCommand = okTools;
  daemon = await bootDaemon({ configDir: workspace.dir, linear, tunnel: realTunnel, runCommand });

  check(/^https:\/\/.+\.ngrok/.test(daemon.publicUrl), `a real public URL was issued (${daemon.publicUrl})`);

  // 3. The assignment actually happens in Linear FIRST, then the webhook announces it.
  //     Ingress never decides from the payload — it re-fetches and decides from fresh
  //     state — so a fake that still says "unassigned" is correctly ignored. That is the
  //     product being right and my first version of this probe being wrong.
  linear.putIssue(smokeIssue({ assigneeId: BOT_USER_ID }));

  // A signed delivery, sent over the PUBLIC internet to that URL.
  const body = JSON.stringify({
    action: 'update', type: 'Issue',
    // Loop guard L1: a delivery with no identifiable human actor is treated as possibly
    // the bot's own write and dropped. Omitting this is what made the first run of this
    // probe report "self-event dropped" — the guard working, over the real network.
    actor: { id: 'human-user-id', type: 'user' },
    data: { id: ISSUE_ID, assigneeId: BOT_USER_ID },
    updatedFrom: { assigneeId: null },
    webhookTimestamp: Date.now(),
    webhookId: 'wh-live', organizationId: 'org-live',
  });
  const sig = createHmac('sha256', secret).update(body).digest('hex');
  const res = await fetch(`${daemon.publicUrl}/linear/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [LINEAR_WEBHOOK_SIGNATURE_HEADER]: sig,
               'Linear-Delivery': 'live-delivery-1' },
    body,
  });
  check(res.status === 200, `the public URL accepted a correctly signed delivery (${res.status})`);

  // 4. And a forged one, over the same path.
  const bad = await fetch(`${daemon.publicUrl}/linear/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [LINEAR_WEBHOOK_SIGNATURE_HEADER]: 'deadbeef',
               'Linear-Delivery': 'live-delivery-2' },
    body,
  });
  check(bad.status === 400, `a forged signature is refused over the public URL (${bad.status}, T6: 400 not 401)`);

  // 5. The delivery became a persisted run. Asserted over ALL states, not the transient
  //     ones: the run moves through `queued -> preparing` in milliseconds, so a snapshot
  //     taken 500ms later can legitimately find it already past them.
  await new Promise((r) => setTimeout(r, 1500));
  const runs = daemon.store.listByState(
    'queued', 'preparing', 'running', 'awaiting_answer', 'delivering',
    'delivered', 'partial', 'failed', 'cancelled',
  );
  check(runs.length >= 1, `the signed delivery became a persisted run (${runs.length})`);
  const events = runs[0] ? daemon.store.listRunEvents(runs[0].id) : [];
  check(
    events.some((e) => e.from === 'queued' && e.to === 'preparing'),
    'the run was picked up and began work (queued -> preparing)',
  );
} finally {
  if (daemon) await daemon.shutdown('live-uat');
  if (listener) await closeTunnel(listener);
}

console.log(`\n${fail === 0 ? 'LIVE INGRESS PASSED' : 'LIVE INGRESS FAILED'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

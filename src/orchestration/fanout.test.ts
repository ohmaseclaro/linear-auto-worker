/**
 * Multi-repo fan-out (D-12, DELV-06, DELV-07).
 *
 * The assertion this file exists for is the partial-success one: a parent with
 * one delivered child and one failed child derives `partial`, and reading the
 * parent leaves the delivered child's pull request URL exactly where it was.
 * That is the failure the whole design is built to prevent, so it is written
 * out explicitly rather than left implied by the type of `deriveParentStatus`.
 *
 * The purity claim is also asserted rather than assumed: the children handed to
 * `deriveParentStatus` are frozen, so a write would throw instead of quietly
 * succeeding, and the call is made twice over the same input with a
 * before/after snapshot compared in between.
 *
 * T41: this file lives beside its source under `src/`, because `tsconfig` is
 * `rootDir: "src"` and the gate is `node --test dist`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveParentStatus, planSubRuns } from './fanout.js';
import type { RunState } from '../domain/types.js';

const ISSUE = {
  id: 'issue-1',
  identifier: 'ENG-1',
  title: 'Rename the widget across services',
  url: 'https://linear.app/x/issue/ENG-1',
  branchName: 'eng-1-rename-the-widget',
};

const ONE_REPO = { repos: [{ repoDir: '/repo/api', repoSlug: 'org/api' }] };

const THREE_REPOS = {
  repos: [
    { repoDir: '/repo/api', repoSlug: 'org/api' },
    { repoDir: '/repo/web', repoSlug: 'org/web' },
    { repoDir: '/repo/infra', repoSlug: 'org/infra' },
  ],
};

/** Only the field `deriveParentStatus` reads, plus what a DELV-07 test needs. */
function child(state: RunState, prUrl: string | null = null) {
  return Object.freeze({ id: `run-${state}-${prUrl ?? 'none'}`, state, prUrl });
}

// ---------------------------------------------------------------------------
// planSubRuns — arity, parentage, and per-child identity
// ---------------------------------------------------------------------------

test('a ticket mapped to one repo produces one run with no parent', () => {
  const plan = planSubRuns(ISSUE, ONE_REPO);

  assert.equal(plan.parent, null, 'the common case is not wrapped in a parent of one');
  assert.equal(plan.children.length, 1);

  const [only] = plan.children;
  assert.equal(only.parentRunId, null);
  assert.equal(only.kind, 'repo');
  assert.equal(only.state, 'queued');
  assert.equal(only.repoDir, '/repo/api');
  assert.equal(
    only.branch,
    ISSUE.branchName,
    "Linear's own branch name is used unchanged -- the single-repo path is what plans 01-02 already produced",
  );
});

test('a ticket mapped to three repos produces one parent and three children', () => {
  const plan = planSubRuns(ISSUE, THREE_REPOS);

  assert.ok(plan.parent, 'three repos means a parent exists');
  assert.equal(plan.parent!.kind, 'ticket');
  assert.equal(plan.children.length, 3, 'one child per repo (D-12, DELV-06)');

  for (const c of plan.children) {
    assert.equal(c.kind, 'repo');
    assert.equal(c.parentRunId, plan.parent!.id, 'every child names its parent');
    assert.equal(c.issueId, ISSUE.id, 'every child carries the ticket it came from');
    assert.equal(c.state, 'queued', 'a child is a first-class run and enters the queue as one');
  }

  assert.deepEqual(
    plan.children.map((c) => c.repoDir),
    ['/repo/api', '/repo/web', '/repo/infra'],
    'each child owns exactly one repo, in mapping order',
  );
});

test('the parent row carries no state, no repo, no branch and no session', () => {
  const plan = planSubRuns(ISSUE, THREE_REPOS);
  const parent = plan.parent!;

  // D-12 / Phase 1 D-04. The absence is the whole design: a column that is
  // never written cannot disagree with the children it would summarise.
  assert.equal(parent.state, null, 'the parent row has no stored state');
  assert.equal(parent.repoDir, null);
  assert.equal(parent.repoSlug, null);
  assert.equal(parent.branch, null);
  assert.equal(parent.worktreePath, null);
  assert.equal(parent.sessionId, null, 'the parent never spawns a process, so it needs no session');
  assert.equal(parent.pid, null);
});

test('each child gets its own session id and its own run id', () => {
  const plan = planSubRuns(ISSUE, THREE_REPOS);

  const runIds = new Set(plan.children.map((c) => c.id));
  const sessionIds = new Set(plan.children.map((c) => c.sessionId));

  assert.equal(runIds.size, 3, 'three distinct run ids');
  assert.equal(sessionIds.size, 3, 'three distinct pre-assigned session ids (T4)');
  assert.ok(!runIds.has(plan.parent!.id), 'the parent is not one of its own children');

  // A shared session id would resume one child into another child's
  // conversation, in the wrong repository.
  for (const c of plan.children) {
    assert.ok(c.sessionId, 'the session id is assigned up front, never parsed out of the stream');
  }
});

test('child branch names are distinct across repos', () => {
  const plan = planSubRuns(ISSUE, THREE_REPOS);
  const branches = plan.children.map((c) => c.branch);

  assert.equal(new Set(branches).size, 3, 'two children of one ticket cannot share a branch name');
  for (const b of branches) {
    assert.ok(b!.startsWith(ISSUE.branchName), "each branch still carries Linear's branch name");
  }
  assert.deepEqual(branches, [
    'eng-1-rename-the-widget-org-api',
    'eng-1-rename-the-widget-org-web',
    'eng-1-rename-the-widget-org-infra',
  ]);
});

test('two repos whose slugs share a trailing segment still get distinct branches', () => {
  // `orgA/api` and `orgB/api` are different repositories. Deriving the suffix
  // from the trailing segment alone would collide them (T-06-25).
  const plan = planSubRuns(ISSUE, {
    repos: [
      { repoDir: '/repo/a-api', repoSlug: 'orgA/api' },
      { repoDir: '/repo/b-api', repoSlug: 'orgB/api' },
    ],
  });

  const branches = plan.children.map((c) => c.branch);
  assert.equal(new Set(branches).size, 2);
  assert.deepEqual(branches, ['eng-1-rename-the-widget-orga-api', 'eng-1-rename-the-widget-orgb-api']);
});

test('the plan names every repo, so a child can be told it is one of several', () => {
  // This asserted `ticketBriefRepos(plan)`, a helper whose only caller was this line. Its
  // title was the promise — "so a child knows it is one of several" — and the child never
  // knew: the prompt builder never took the list. The list now reaches the agent through
  // `buildAgentPrompt`'s `siblingRepos` (asserted in `execution/prompt.test.ts`, and
  // sourced at runtime from `store.childRuns`). What remains this file's job is that the
  // plan names them all in the first place.
  assert.deepEqual(
    planSubRuns(ISSUE, THREE_REPOS).children.map((c) => c.repoSlug),
    ['org/api', 'org/web', 'org/infra'],
  );
  assert.deepEqual(planSubRuns(ISSUE, ONE_REPO).children.map((c) => c.repoSlug), ['org/api']);
});

// ---------------------------------------------------------------------------
// deriveParentStatus — the derived ticket outcome (D-12, Phase 1 D-04)
// ---------------------------------------------------------------------------

test('every child delivered derives delivered', () => {
  assert.deepEqual(deriveParentStatus([child('delivered'), child('delivered'), child('delivered')]), {
    settled: true,
    state: 'delivered',
  });
});

test('every child failed derives failed', () => {
  assert.deepEqual(deriveParentStatus([child('failed'), child('failed')]), {
    settled: true,
    state: 'failed',
  });
});

test('every child cancelled derives cancelled', () => {
  assert.deepEqual(deriveParentStatus([child('cancelled'), child('cancelled')]), {
    settled: true,
    state: 'cancelled',
  });
});

test('nothing shipped but not all cancelled derives failed', () => {
  // Cancelled plus failed shipped nothing, and something genuinely failed.
  // Calling it `partial` would claim a delivery that does not exist.
  assert.deepEqual(deriveParentStatus([child('cancelled'), child('failed')]), {
    settled: true,
    state: 'failed',
  });
});

test('a child still in flight leaves the parent unsettled rather than terminal', () => {
  for (const live of ['queued', 'preparing', 'running', 'awaiting_answer', 'delivering'] as RunState[]) {
    assert.deepEqual(
      deriveParentStatus([child('delivered'), child(live)]),
      { settled: false },
      `a ${live} child means the ticket is still in flight`,
    );
  }

  // Notably `awaiting_answer`: a ticket with one repo waiting on a human is
  // not a terminal ticket, and it must not be reported as one.
  assert.deepEqual(deriveParentStatus([]), { settled: false }, 'no children is not an outcome');
});

test('a child that shipped something incomplete makes the ticket partial', () => {
  assert.deepEqual(deriveParentStatus([child('delivered'), child('partial')]), {
    settled: true,
    state: 'partial',
  });
});

// ---------------------------------------------------------------------------
// DELV-07 — the assertion the whole design exists for
// ---------------------------------------------------------------------------

test('one delivered child and one failed child derive partial, and the delivered PR survives the read', () => {
  const shipped = child('delivered', 'https://github.com/org/api/pull/42');
  const broke = child('failed');
  const children = Object.freeze([shipped, broke]);

  const before = JSON.stringify(children);

  const status = deriveParentStatus(children);
  assert.deepEqual(status, { settled: true, state: 'partial' }, 'partial success is the normal case');

  // The point of DELV-07: repo A keeps its pull request even though repo B
  // failed. Reading the parent must not alter, clear or reclassify it.
  assert.equal(
    shipped.prUrl,
    'https://github.com/org/api/pull/42',
    "the delivered child's pull request url is untouched by reading the parent",
  );
  assert.equal(shipped.state, 'delivered', 'the delivered child is not reclassified by its failing sibling');
  assert.equal(broke.state, 'failed', 'and the failed child is not laundered by its delivered sibling');
  assert.equal(JSON.stringify(children), before, 'nothing anywhere in the child set changed');
});

test('deriveParentStatus is pure: called twice over the same children it writes nothing', () => {
  // Frozen, so a write throws rather than quietly succeeding. This is the
  // mechanical form of "never stored" (D-12, Phase 1 D-04): there is no writer
  // for the parent's status, so there is nothing to keep in sync with it.
  const children = Object.freeze([
    child('delivered', 'https://github.com/org/api/pull/42'),
    child('failed'),
    child('cancelled'),
  ]);

  const before = JSON.stringify(children);
  const first = deriveParentStatus(children);
  const between = JSON.stringify(children);
  const second = deriveParentStatus(children);

  assert.deepEqual(first, second, 'the same children always derive the same status');
  assert.equal(between, before, 'nothing was written between the two reads');
  assert.equal(JSON.stringify(children), before, 'and nothing was written by either of them');
});

// ---------------------------------------------------------------------------
// Fan-out at the engine's pickup (D-03, D-12, DELV-06, DELV-07)
//
// These drive the real engine rather than asserting on `planSubRuns` output,
// because the claims are about arity and independence at runtime: how many
// slots three children occupy, how many acknowledgements one ticket produces,
// and -- the one that matters -- what happens to a delivered child's pull
// request when its sibling fails.
// ---------------------------------------------------------------------------

import { InMemoryStore } from '../domain/fakes.js';
import { createScheduler } from './scheduler.js';
import { createRunEngine } from './run-engine.js';
import { createQuestions } from './questions.js';
import type {
  AgentResult,
  AgentRunner,
  Config,
  Deliverer,
  LinearClient,
  Logger,
  Run,
  Store,
  WorktreeManager,
} from '../domain/ports.js';

const silent: Logger = {
  child: () => silent,
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const ALL_STATES: RunState[] = [
  'queued',
  'preparing',
  'running',
  'awaiting_answer',
  'delivering',
  'delivered',
  'partial',
  'failed',
  'cancelled',
];

/**
 * `Store.listRunsByParent(parentRunId)` is requested from Phase 1 under
 * `Contract additions requested`. Supplied here from `listByState` so this
 * test does not block on it landing -- and note what it enumerates: the nine
 * CHILD states. The parent has no state, so it can never appear in its own
 * child list.
 */
function withParentLookup(store: InMemoryStore): Store {
  const s = store as unknown as Record<string, unknown>;
  s.listRunsByParent ??= (parentRunId: string) =>
    ALL_STATES.flatMap((state) => store.listByState(state)).filter(
      (r) => r.parentRunId === parentRunId,
    );
  return store as unknown as Store;
}

function issueN(n: number) {
  return {
    id: `issue-${n}`,
    identifier: `ENG-${n}`,
    title: `Ticket ${n}`,
    description: null,
    url: `https://linear.app/x/issue/ENG-${n}`,
    branchName: `eng-${n}-ticket`,
    assigneeId: 'bot',
    projectId: `proj-${n}`,
    teamId: 'team-1',
    stateId: 'state-todo',
    stateType: 'unstarted',
  };
}

/** `proj-1` -> three repos, `proj-2` -> one repo. Shaped against the ADDENDUM. */
function multiRepoConfig(concurrency: number): Config {
  return {
    operatorUserId: 'operator-1',
    logDir: '/home/op/.linear-auto-worker/logs',
    defaults: {
      concurrency,
      questionTimeoutMs: 4 * 60 * 60 * 1000,
      baseBranch: 'main',
      postLinearComments: true,
      draftPr: true,
      questionsEnabled: true,
      maxRunMs: 60 * 60 * 1000,
    },
    mappings: {
      'proj-1': {
        repos: [
          { repoDir: '/repo/api', repoSlug: 'org/api', baseBranch: 'main', enabled: true },
          { repoDir: '/repo/web', repoSlug: 'org/web', baseBranch: 'main', enabled: true },
          { repoDir: '/repo/infra', repoSlug: 'org/infra', baseBranch: 'main', enabled: true },
        ],
      },
      'proj-2': {
        repos: [{ repoDir: '/repo/solo', repoSlug: 'org/solo', baseBranch: 'main', enabled: true }],
      },
    },
  } as unknown as Config;
}

const DELIVERS: AgentResult = {
  status: 'complete',
  summary: 'Shipped it.',
  prTitle: 'ENG: do the thing',
  prBody: 'Does the thing.',
};

const BREAKS: AgentResult = {
  status: 'failed',
  summary: 'could not build',
  failureReason: 'tsc exited 2',
};

/**
 * Scripted per repo rather than per call, because with three children running
 * concurrently a call-ordered script decides nothing reliably -- and the whole
 * point of these tests is which repo got which outcome.
 */
function agentByRepo(
  byRepo: Record<string, AgentResult>,
  gate?: Promise<void>,
): AgentRunner {
  return {
    async run(req: { env: Record<string, string> }) {
      if (gate) await gate;
      const result = byRepo[req.env.LAW_REPO];
      if (!result) throw new Error(`no scripted result for ${req.env.LAW_REPO}`);
      return result;
    },
  } as unknown as AgentRunner;
}

function fanoutHarness(opts: {
  agent: AgentRunner;
  issues: Array<ReturnType<typeof issueN>>;
  concurrency?: number;
}) {
  const config = multiRepoConfig(opts.concurrency ?? 3);
  const raw = new InMemoryStore();
  const store = withParentLookup(raw);
  const scheduler = createScheduler({ config, log: silent });

  const comments: Array<{ issueId: string; body: string }> = [];
  const order: string[] = [];
  let n = 0;
  const linear = {
    async getIssue(id: string) {
      const found = opts.issues.find((i) => i.id === id);
      if (!found) throw new Error(`no such issue: ${id}`);
      return found;
    },
    async createComment(issueId: string, body: string) {
      order.push('comment.create');
      comments.push({ issueId, body });
      return { id: `comment-${++n}` };
    },
    async updateComment() {},
    async setIssueState() {
      order.push('issue.state');
    },
    async addSubscriber() {
      order.push('issue.subscribe');
    },
  } as unknown as LinearClient;

  // The worktree port fails the test if it is reached before the ticket-level
  // acknowledgement has finished -- plan 02's ordering constraint still binds,
  // and fan-out must not have moved the ack inside the per-child loop.
  const worktrees = {
    async create(runId: string, repo: { repoDir: string }, branch: string) {
      for (const step of ['comment.create', 'issue.state', 'issue.subscribe']) {
        if (!order.includes(step)) throw new Error(`worktree reached before ${step}`);
      }
      return { runId, repoDir: repo.repoDir, path: `/wt/${runId}`, branch, baseBranch: 'main' };
    },
    async remove() {},
    async exists() {
      return true;
    },
    async gc() {
      return [];
    },
  } as unknown as WorktreeManager;

  const deliverer = {
    async deliver(_wt: unknown, repo: { repoSlug: string }) {
      return { url: `https://github.com/${repo.repoSlug}/pull/7` };
    },
  } as unknown as Deliverer;

  let questions: ReturnType<typeof createQuestions>;
  const engine = createRunEngine({
    store,
    scheduler,
    agent: opts.agent,
    worktrees,
    deliverer,
    linear,
    config,
    log: silent,
    questions: () => questions,
  });
  questions = createQuestions({ store, engine, config, linear, log: silent });

  /**
   * Every row for an issue, INCLUDING the stateless ticket parent.
   *
   * `listByState` structurally cannot return a parent: D-12 gives it no state, which is the
   * whole point of the row. The parents are therefore recovered from the children's
   * `parentRunId`. Without this step the parent is invisible here, and "the parent row
   * exists" fails against an implementation that is doing exactly what D-12 asks.
   */
  const runsOf = (issueId: string): Run[] => {
    const children = ALL_STATES.flatMap((s) => raw.listByState(s)).filter(
      (r) => r.issueId === issueId,
    );
    const parentIds = new Set(
      children.map((c) => c.parentRunId).filter((id): id is string => id !== null),
    );
    const parents = [...parentIds]
      .map((id) => raw.getRun(id))
      .filter((r): r is Run => r !== undefined);
    return [...children, ...parents];
  };

  return { store: raw, scheduler, engine, comments, order, runsOf, config };
}

test('one ticket over three repos inserts one parent, three children, and one acknowledgement', async () => {
  const h = fanoutHarness({
    agent: agentByRepo({
      'org/api': DELIVERS,
      'org/web': DELIVERS,
      'org/infra': DELIVERS,
    }),
    issues: [issueN(1)],
  });

  await h.engine.handle({ kind: 'run.requested', trigger: 'assignment', issueId: 'issue-1' });

  // The acknowledgement is per TICKET, not per child: three children must not
  // produce three ack comments, three In Progress transitions and three
  // subscriptions on one issue (plan 02's D-09 ordering, unchanged).
  assert.deepEqual(
    h.order.slice(0, 3),
    ['comment.create', 'issue.state', 'issue.subscribe'],
    'acknowledge, In Progress, subscribe -- once, in order, before any worktree work',
  );
  assert.equal(h.order.filter((o) => o === 'issue.state').length, 1, 'one In Progress transition');
  assert.equal(h.order.filter((o) => o === 'issue.subscribe').length, 1, 'one subscription');

  await h.engine.settle();

  const rows = h.runsOf('issue-1');
  const children = rows.filter((r) => r.kind === 'repo');
  assert.equal(children.length, 3, 'one child run per repo (DELV-06)');
  assert.equal(new Set(children.map((c) => c.parentRunId)).size, 1, 'all three name one parent');
  assert.deepEqual(
    children.map((c) => c.repoSlug).sort(),
    ['org/api', 'org/infra', 'org/web'],
    'each child owns exactly one repo',
  );
  assert.equal(new Set(children.map((c) => c.branch)).size, 3, 'three distinct branches');
  assert.equal(new Set(children.map((c) => c.worktreePath)).size, 3, 'three distinct worktrees');
  assert.equal(new Set(children.map((c) => c.sessionId)).size, 3, 'three distinct sessions');
});

test('a ticket mapped to one repo is unchanged: one run, no parent', async () => {
  const h = fanoutHarness({ agent: agentByRepo({ 'org/solo': DELIVERS }), issues: [issueN(2)] });

  await h.engine.handle({ kind: 'run.requested', trigger: 'assignment', issueId: 'issue-2' });
  await h.engine.settle();

  const rows = h.runsOf('issue-2');
  assert.equal(rows.length, 1, 'the common case is not wrapped in a parent of one');
  assert.equal(rows[0].parentRunId, null);
  assert.equal(rows[0].state, 'delivered');
});

test('three children occupy three slots, and a fourth unrelated run waits (D-03)', async () => {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });

  const h = fanoutHarness({
    agent: agentByRepo(
      { 'org/api': DELIVERS, 'org/web': DELIVERS, 'org/infra': DELIVERS, 'org/solo': DELIVERS },
      gate,
    ),
    issues: [issueN(1), issueN(2)],
    concurrency: 3,
  });

  await h.engine.handle({ kind: 'run.requested', trigger: 'assignment', issueId: 'issue-1' });
  // Let the three drivers reach the agent, where they park on the gate.
  await new Promise((r) => setImmediate(r));

  assert.equal(
    h.scheduler.inUse(),
    3,
    'each child is a real claude process, so each costs a slot -- the cap bounds local RAM',
  );

  await h.engine.handle({ kind: 'run.requested', trigger: 'assignment', issueId: 'issue-2' });
  const [fourth] = h.runsOf('issue-2');
  assert.equal(h.scheduler.positionOf(fourth.id), 1, 'the fourth run waits; the cap is not exceeded');
  assert.equal(h.scheduler.inUse(), 3);

  open();
  await h.engine.settle();
  assert.equal(h.scheduler.inUse(), 0, 'and every slot comes back');
});

// ---------------------------------------------------------------------------
// DELV-07 at the engine — the deliverable
// ---------------------------------------------------------------------------

test('a failing child leaves its delivered sibling untouched, and the ticket derives partial', async () => {
  const h = fanoutHarness({
    agent: agentByRepo({
      'org/api': DELIVERS,
      'org/web': BREAKS,
      'org/infra': BREAKS,
    }),
    issues: [issueN(1)],
  });

  await h.engine.handle({ kind: 'run.requested', trigger: 'assignment', issueId: 'issue-1' });
  await h.engine.settle();

  const children = h.runsOf('issue-1').filter((r) => r.kind === 'repo');
  const api = children.find((c) => c.repoSlug === 'org/api')!;
  const web = children.find((c) => c.repoSlug === 'org/web')!;

  // The failure this whole phase exists to prevent: repo B failing must not
  // discard repo A's already-shipped pull request.
  assert.equal(api.state, 'delivered', 'the delivered child is not reclassified by its siblings');
  assert.equal(
    api.prUrl,
    'https://github.com/org/api/pull/7',
    "the delivered child's pull request url is untouched by two failing siblings",
  );
  assert.equal(web.state, 'failed');
  assert.equal(web.prUrl, null, 'and the failed child never claims a pull request it does not have');

  // Independent per-repo outcomes: no fail-fast, no sibling abort, no cleanup
  // triggered by one child's failure.
  assert.equal(
    children.filter((c) => c.state === 'cancelled').length,
    0,
    'a failing child cancels nobody -- "abort the rest on first failure" is the bug, not the fix',
  );

  // And the ticket-level answer is derived, on this read, from exactly those rows.
  assert.deepEqual(deriveParentStatus(children), { settled: true, state: 'partial' });
  const apiAfter = h.store.getRun(api.id)!;
  assert.equal(
    apiAfter.kind === 'repo' ? apiAfter.prUrl : null,
    'https://github.com/org/api/pull/7',
    'reading the parent status changed nothing about the delivered child',
  );
});

test('the parent row still carries no state after every child has settled', async () => {
  const h = fanoutHarness({
    agent: agentByRepo({ 'org/api': DELIVERS, 'org/web': BREAKS, 'org/infra': DELIVERS }),
    issues: [issueN(1)],
  });

  await h.engine.handle({ kind: 'run.requested', trigger: 'assignment', issueId: 'issue-1' });
  await h.engine.settle();

  const parent = h.runsOf('issue-1').find((r) => r.kind === 'ticket');
  assert.ok(parent, 'the parent row exists');
  assert.equal(
    parent!.state,
    null,
    'nothing wrote a parent state at any point -- D-12, and the reason parent and children cannot disagree',
  );
  assert.equal(h.store.listRunEvents(parent!.id).length, 0, 'the parent never transitioned');
});

test('Linear gets one rollup for the ticket, not one terminal comment per child', async () => {
  const h = fanoutHarness({
    agent: agentByRepo({ 'org/api': DELIVERS, 'org/web': BREAKS, 'org/infra': DELIVERS }),
    issues: [issueN(1)],
  });

  await h.engine.handle({ kind: 'run.requested', trigger: 'assignment', issueId: 'issue-1' });
  await h.engine.settle();

  // One acknowledgement plus one rollup. Three children posting three terminal
  // comments is how an operator learns to mute the bot.
  assert.equal(h.comments.length, 2, 'one ack, one rollup');
  const rollup = h.comments[1].body;
  assert.match(rollup, /partial/, 'the rollup carries the derived ticket status');
  for (const slug of ['org/api', 'org/web', 'org/infra']) {
    assert.ok(rollup.includes(slug), `the rollup names ${slug} and its own outcome`);
  }
  assert.match(rollup, /pull\/7/, 'and the delivered repos keep their pull request urls in the rollup');
});

// ---------------------------------------------------------------------------
// Cancellation across children (D-11, INTK-08)
// ---------------------------------------------------------------------------

test('cancelling the ticket cancels every non-terminal child and leaves terminal ones alone', async () => {
  const h = fanoutHarness({
    agent: agentByRepo({ 'org/api': DELIVERS, 'org/web': DELIVERS, 'org/infra': DELIVERS }),
    issues: [issueN(1)],
    concurrency: 1,
  });
  // One slot, held by an outsider, so all three children park at `queued`.
  const releaseHolder = await h.scheduler.acquire('outsider');

  await h.engine.handle({ kind: 'run.requested', trigger: 'assignment', issueId: 'issue-1' });
  const children = h.runsOf('issue-1').filter((r) => r.kind === 'repo');
  assert.equal(children.length, 3);

  // Drive one child terminal by hand, so the cancel has a mixed set to face.
  h.store.updateRun(children[0].id, { state: 'delivered', prUrl: 'https://github.com/org/api/pull/7' });

  await h.engine.handle({ kind: 'run.cancelled', issueId: 'issue-1', reason: 'bot unassigned' });

  const after = h.runsOf('issue-1').filter((r) => r.kind === 'repo');
  const shipped = after.find((c) => c.id === children[0].id)!;
  assert.equal(shipped.state, 'delivered', 'terminal is terminal -- a cancel does not claw back a PR');
  assert.equal(shipped.prUrl, 'https://github.com/org/api/pull/7', 'and its url is untouched');
  for (const c of after.filter((c) => c.id !== children[0].id)) {
    assert.equal(c.state, 'cancelled', 'every non-terminal child stops (INTK-08)');
  }

  // The parent needs no cancel handling of its own: its status is derived from
  // exactly these children, which is now delivered + cancelled + cancelled.
  assert.deepEqual(deriveParentStatus(after), { settled: true, state: 'partial' });

  releaseHolder();
  await h.engine.settle();
  assert.equal(
    h.runsOf('issue-1').filter((r) => r.kind === 'repo' && r.state === 'cancelled').length,
    2,
    'taking their turn in the queue does not revive them',
  );
});

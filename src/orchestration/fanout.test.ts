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

import { deriveParentStatus, planSubRuns, ticketBriefRepos } from './fanout.js';
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

test('the ticket brief gets the full repo list, so a child knows it is one of several', () => {
  const plan = planSubRuns(ISSUE, THREE_REPOS);
  assert.deepEqual(ticketBriefRepos(plan), ['org/api', 'org/web', 'org/infra']);

  // Composing the brief is Phase 4's prompt work; this plan supplies the list.
  assert.deepEqual(ticketBriefRepos(planSubRuns(ISSUE, ONE_REPO)), ['org/api']);
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

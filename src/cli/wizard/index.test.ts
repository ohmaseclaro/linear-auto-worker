/**
 * One test that walks the whole wizard — the anti-T72 gate.
 *
 * Nothing had ever executed `runSetupWizard` end to end, which is how four defects shipped
 * in one function: a step that could not complete, a config its own loader rejects, that
 * config at mode 0644, and a blank `teamId` for a project-keyed mapping. Every one of them
 * is visible from here, at the level the operator hit them.
 *
 * **No module mocking (T88).** Every seam below is a default parameter or a `??` fallback.
 * An ESM namespace binding is non-configurable by specification, so `mock.method(ns, …)`
 * cannot work and never could — 22 of this milestone's first 56 gate failures were that
 * one line.
 */
import assert from 'node:assert/strict';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { LinearClient } from '@linear/sdk';

import { loadConfig } from '../../infra/config.js';
import type { RunCommand, WizardPrompts } from './deps.js';
import type { PreflightResult } from './preflight.js';
import type { registerAtSetup, SetupContext } from './register.js';
import { runSetupWizard } from './index.js';

const PUBLIC_URL = 'https://e2e-abc123.ngrok-free.app';
const TEAM_ID = 'team-abc';

/** Every preflight check passing, without touching git/gh/claude on this machine. */
const passingPreflight = async (): Promise<PreflightResult[]> => [
  { name: 'node', status: 'pass', detail: 'v24.0.0' },
];

/**
 * The SDK surface the wizard actually touches: `viewer` (a getter, not a method — v93),
 * `webhooks` (the admin probe), `teams`/`projects` (mapping candidates) and `users` (the
 * operator step).
 */
function fakeSdkClient(): LinearClient {
  const page = <N>(nodes: N[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
  return {
    get viewer() {
      return Promise.resolve({ id: 'bot-user-1' });
    },
    webhooks: async () => page([]),
    teams: async () => page([{ id: TEAM_ID, name: 'Team ABC' }]),
    projects: async () =>
      page([
        {
          id: 'proj-1',
          name: 'Project One',
          // A PROJECT-keyed mapping whose owning team is the only source of `teamId` —
          // exactly the operator's live config, which had `teamId: ""`.
          teams: async () => page([{ id: TEAM_ID, name: 'Team ABC' }]),
        },
      ]),
    users: async () => page([{ id: 'human-1', name: 'Augusto', active: true }]),
  } as unknown as LinearClient;
}

/** `git remote -v`, `gh repo view`, `gh api …/protection` — answered without a network. */
const fakeRun: RunCommand = async (file, args) => {
  const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' });
  if (file === 'git') return ok('origin\thttps://github.com/org/repo.git (fetch)');
  if (file === 'gh' && args[0] === 'repo') {
    return ok(JSON.stringify({ defaultBranchRef: { name: 'main' }, nameWithOwner: 'org/repo' }));
  }
  return ok('{}');
};

/** Pops the next queued answer; an unqueued prompt REJECTS rather than returning undefined. */
function scripted(script: {
  select?: readonly unknown[];
  checkbox?: readonly unknown[];
  input?: readonly string[];
  confirm?: readonly boolean[];
}): WizardPrompts {
  const next = <T>(name: string, values: readonly T[] = []) => {
    let i = 0;
    return () =>
      i < values.length
        ? Promise.resolve(values[i++] as T)
        : Promise.reject(new Error(`${name}() called more times than queued (call #${i + 1})`));
  };
  const select = next('select', script.select);
  const checkbox = next('checkbox', script.checkbox);
  const input = next('input', script.input);
  const confirm = next('confirm', script.confirm);
  return {
    select: <T>() => select() as Promise<T>,
    checkbox: <T>() => checkbox() as Promise<T[]>,
    input,
    confirm,
  };
}

/** Two throwaway git repos, one of which the operator will map. */
function makeRepoRoot(base: string): string {
  const root = join(base, 'repos');
  for (const name of ['alpha', 'beta']) {
    mkdirSync(join(root, name, '.git'), { recursive: true });
    // Present so the agent-docs check passes silently and asks no extra confirm.
    writeFileSync(join(root, name, 'CLAUDE.md'), `# ${name}\n`, 'utf8');
  }
  return root;
}

test('runSetupWizard walks end to end and leaves a config `loadConfig` accepts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-wizard-e2e-'));
  try {
    const configPath = join(dir, 'config.json');
    const envPath = join(dir, '.env');
    // Both secrets already present, so neither is prompted and neither is re-written.
    writeFileSync(envPath, 'LINEAR_API_KEY=lin_api_fake\nNGROK_AUTHTOKEN=ngrok_fake\n', {
      mode: 0o600,
    });
    const repoRoot = makeRepoRoot(dir);

    const lines: string[] = [];
    const registerCalls: SetupContext[] = [];
    const register: typeof registerAtSetup = async (ctx) => {
      registerCalls.push(ctx);
      return { ok: true, webhookId: 'wh-1', secret: 'never-printed', publicUrl: PUBLIC_URL };
    };

    const code = await runSetupWizard({
      configPath,
      envPath,
      promptRoot: async () => repoRoot,
      preflight: passingPreflight,
      runCommand: fakeRun,
      makeLinearClient: fakeSdkClient,
      report: (m) => lines.push(m),
      register,
      prompts: scripted({
        select: [
          'proj-1', // which Linear project this mapping keys off
          'human-1', // which Linear user the operator is
        ],
        checkbox: [[join(repoRoot, 'alpha')]],
        input: [''], // Slack webhook URL: none
        confirm: [
          false, // override any default behaviour for this mapping?
          false, // add another mapping?
        ],
      }),
    });

    // 1 — it completes, and D-08 holds: no stack trace ever reaches the operator.
    assert.equal(code, 0, `wizard should succeed; output was:\n${lines.join('\n')}`);
    for (const line of lines) {
      assert.doesNotMatch(line, /at Object\.|^\s*at /, `stack frame leaked: ${line}`);
      assert.doesNotMatch(line, /Error:/, `raw error leaked: ${line}`);
    }

    // 2 — registration is reached exactly once, on the live path, with a real team id.
    //     This is defect 1 (setup could not complete) and defect 4 (teamId: "") together.
    assert.equal(registerCalls.length, 1, 'registerAtSetup must be called exactly once');
    assert.equal(registerCalls[0]?.config.teamId, TEAM_ID, 'derived from the project owner');

    // 3 — defect 2, asserted by EXECUTING the daemon's own loader rather than by
    //     re-describing the schema. This is the assertion the live run failed.
    const loaded = loadConfig(dir);
    assert.equal(loaded.teamId, TEAM_ID);
    assert.deepEqual(Object.keys(loaded.mappings), ['proj-1']);
    assert.equal(loaded.mappings['proj-1']?.repos[0]?.repoSlug, 'org/repo');

    // 4 — defect 3: config.json holds a Slack posting credential.
    assert.equal(statSync(configPath).mode & 0o777, 0o600);

    // 5 — D1's honesty requirement: the URL, and what it does NOT mean.
    const output = lines.join('\n');
    assert.ok(output.includes(PUBLIC_URL), 'the registered URL is printed');
    assert.match(output, /fresh tunnel/, 'the caveat that this URL dies with the command');
    assert.match(output, /restart it/, 'and that a running daemon must be restarted');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

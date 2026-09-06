import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LogChannel } from './log-channel.js';
import { Notifier, withBoundedRetry } from './notifier.js';
import type { NotifyChannel, RunEvent } from './notifier.js';

interface LogLine {
  fields: Record<string, unknown>;
  msg: string;
}

function recorder(): { lines: LogLine[]; log: (f: Record<string, unknown>, m: string) => void } {
  const lines: LogLine[] = [];
  return {
    lines,
    log: (fields, msg) => {
      lines.push({ fields, msg });
    },
  };
}

/** Injectable delay that records what it was asked to wait instead of waiting. */
function delayRecorder(): { waits: number[]; delay: (ms: number) => Promise<void> } {
  const waits: number[] = [];
  return {
    waits,
    delay: async (ms: number) => {
      waits.push(ms);
    },
  };
}

const BASE = {
  runId: 'run-1',
  issueId: 'issue-uuid-1',
  issueIdentifier: 'ENG-42',
  issueUrl: 'https://linear.app/acme/issue/ENG-42',
  mappingId: 'map-1',
  at: 1_700_000_000_000,
};

const pickedUp: RunEvent = { ...BASE, kind: 'picked_up' };

const terminal: RunEvent = {
  ...BASE,
  kind: 'terminal',
  state: 'delivered',
  costUsd: 0.4231,
  tokensUsed: 12_345,
  prUrl: 'https://github.com/acme/app/pull/7',
};

const FAST = { attempts: 3, baseDelayMs: 10, maxDelayMs: 15 };

describe('withBoundedRetry', () => {
  it('resolves on the first attempt without waiting at all', async () => {
    const { waits, delay } = delayRecorder();
    const value = await withBoundedRetry(async () => 'ok', FAST, delay);
    assert.equal(value, 'ok');
    assert.deepEqual(waits, []);
  });

  it('backs off exponentially and caps a single delay at maxDelayMs', async () => {
    const { waits, delay } = delayRecorder();
    let calls = 0;
    await withBoundedRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('transient');
        return 'ok';
      },
      FAST,
      delay,
    );
    // 10, then 20 clamped to the 15ms cap — this clamp is the "bounded" half of D-03.
    assert.deepEqual(waits, [10, 15]);
  });

  it('gives up after exactly `attempts` tries and rethrows the last error', async () => {
    const { waits, delay } = delayRecorder();
    let calls = 0;
    await assert.rejects(
      withBoundedRetry(
        async () => {
          calls += 1;
          throw new Error(`boom ${calls}`);
        },
        FAST,
        delay,
      ),
      /boom 3/,
    );
    assert.equal(calls, 3);
    assert.equal(waits.length, 2, 'n attempts means n-1 waits — the budget is bounded');
  });
});

describe('Notifier — the always-on log channel (D-04)', () => {
  it('writes exactly one structured entry carrying the run id and the issue id', async () => {
    const { lines, log } = recorder();
    const notifier = new Notifier({ log });

    await notifier.emit(pickedUp);

    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.msg, 'run.picked_up');
    assert.equal(lines[0]!.fields.runId, 'run-1');
    assert.equal(lines[0]!.fields.issueId, 'issue-uuid-1');
    assert.equal(lines[0]!.fields.kind, 'picked_up');
  });

  it('still logs when every other channel is disabled — NOTF-05: turning Linear off costs zero logging', async () => {
    const { lines, log } = recorder();
    const off: NotifyChannel = {
      name: 'linear',
      enabled: () => false,
      emit: async () => assert.fail('a disabled channel must not be emitted to'),
    };
    const notifier = new Notifier({ log, channels: [off] });

    await notifier.emit(pickedUp);

    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.msg, 'run.picked_up');
  });

  it('carries cost and token usage on a terminal event, alongside the PR url (DELV-05, NOTF-06)', async () => {
    const { lines, log } = recorder();
    await new Notifier({ log }).emit(terminal);

    assert.equal(lines[0]!.fields.costUsd, 0.4231);
    assert.equal(lines[0]!.fields.tokensUsed, 12_345);
    assert.equal(lines[0]!.fields.prUrl, 'https://github.com/acme/app/pull/7');
    assert.equal(lines[0]!.fields.state, 'delivered');
  });

  it('LogChannel.enabled() takes no config and is unconditionally true', () => {
    const channel = new LogChannel(() => {});
    assert.equal(channel.enabled(pickedUp), true);
    assert.equal(channel.enabled(terminal), true);
  });
});

describe('Notifier — bounded retry, then continue (D-03)', () => {
  it('retries a channel that rejects twice then succeeds, and still resolves', async () => {
    const { lines, log } = recorder();
    const { waits, delay } = delayRecorder();
    let calls = 0;
    const flaky: NotifyChannel = {
      name: 'slack',
      enabled: () => true,
      emit: async () => {
        calls += 1;
        if (calls < 3) throw new Error('503 from slack');
      },
    };

    const notifier = new Notifier({ log, channels: [flaky], retry: FAST, delay });
    await notifier.emit(pickedUp);

    assert.equal(calls, 3);
    assert.deepEqual(waits, [10, 15]);
    assert.equal(
      lines.filter((l) => l.msg === 'notify.channel_failed').length,
      0,
      'a channel that eventually succeeded is not a failure',
    );
  });

  it('resolves rather than rejects when a channel always fails, and logs a warning naming it', async () => {
    const { lines, log } = recorder();
    const { delay } = delayRecorder();
    const dead: NotifyChannel = {
      name: 'slack',
      enabled: () => true,
      emit: async () => {
        throw new Error('slack is down');
      },
    };

    const notifier = new Notifier({ log, channels: [dead], retry: FAST, delay });
    // The assertion is the absence of a rejection: a Slack outage must not discard a run
    // that already produced a working PR.
    await notifier.emit(terminal);

    const failures = lines.filter((l) => l.msg === 'notify.channel_failed');
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.fields.channel, 'slack');
    assert.equal(failures[0]!.fields.runId, 'run-1');
    assert.equal(failures[0]!.fields.error, 'slack is down');
    // The log line for the event itself still went out, first and unretried.
    assert.equal(lines[0]!.msg, 'run.terminal');
  });

  it('a channel whose enabled() throws is skipped, not fatal', async () => {
    const { lines, log } = recorder();
    const broken: NotifyChannel = {
      name: 'linear',
      enabled: () => {
        throw new Error('mapping lookup exploded');
      },
      emit: async () => assert.fail('must not emit to a channel that could not be gated'),
    };

    await new Notifier({ log, channels: [broken], retry: FAST, delay: async () => {} }).emit(
      pickedUp,
    );

    assert.equal(lines.filter((l) => l.msg === 'notify.channel_failed').length, 1);
  });

  it('one dead channel does not stop a healthy sibling', async () => {
    const { log } = recorder();
    const seen: string[] = [];
    const dead: NotifyChannel = {
      name: 'slack',
      enabled: () => true,
      emit: async () => {
        throw new Error('down');
      },
    };
    const healthy: NotifyChannel = {
      name: 'linear',
      enabled: () => true,
      emit: async () => {
        seen.push('linear');
      },
    };

    await new Notifier({
      log,
      channels: [dead, healthy],
      retry: FAST,
      delay: async () => {},
    }).emit(terminal);

    assert.deepEqual(seen, ['linear']);
  });

  it('surfaces a linearCommentId returned by whichever channel produced one', async () => {
    const { log } = recorder();
    const linear: NotifyChannel = {
      name: 'linear',
      enabled: () => true,
      emit: async () => ({ linearCommentId: 'comment-abc' }),
    };

    const result = await new Notifier({ log, channels: [linear] }).emit({
      ...BASE,
      kind: 'question_asked',
      question: 'Which database should the new table live in?',
    });

    assert.equal(result.linearCommentId, 'comment-abc');
  });
});

describe('Notifier — terminal emission from a finally (D-05 / NOTF-02)', () => {
  it('produces exactly one terminal notification even when the surrounding work throws', async () => {
    const { lines, log } = recorder();
    const notifier = new Notifier({ log, retry: FAST, delay: async () => {} });

    // This is the shape every caller of a run must use: real work in the try, the terminal
    // event in the matching finally. It is only safe because emit() never rejects — a
    // rejecting notifier inside a finally would replace the original error with its own.
    let thrown: unknown;
    try {
      try {
        throw new Error('the agent process died mid-run');
      } finally {
        await notifier.emit({
          ...BASE,
          kind: 'terminal',
          state: 'failed',
          costUsd: 0.11,
          tokensUsed: 900,
          reason: 'agent process died',
        });
      }
    } catch (err) {
      thrown = err;
    }

    const terminals = lines.filter((l) => l.msg === 'run.terminal');
    assert.equal(terminals.length, 1, 'exactly one terminal notification');
    assert.equal(terminals[0]!.fields.state, 'failed');
    assert.equal(terminals[0]!.fields.costUsd, 0.11);
    assert.equal(terminals[0]!.fields.tokensUsed, 900);
    // The original failure still propagates — the notifier neither swallowed nor replaced it.
    assert.match(String((thrown as Error).message), /agent process died mid-run/);
  });

  it('a permanently failing channel inside the finally still does not mask the original error', async () => {
    const { log } = recorder();
    const dead: NotifyChannel = {
      name: 'slack',
      enabled: () => true,
      emit: async () => {
        throw new Error('slack is down');
      },
    };
    const notifier = new Notifier({ log, channels: [dead], retry: FAST, delay: async () => {} });

    await assert.rejects(
      (async () => {
        try {
          throw new Error('original failure');
        } finally {
          await notifier.emit({
            ...BASE,
            kind: 'terminal',
            state: 'failed',
            costUsd: 0,
            tokensUsed: 0,
          });
        }
      })(),
      /original failure/,
    );
  });
});

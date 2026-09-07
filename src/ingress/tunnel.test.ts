// RUSH mode: written, not run. No node_modules on this branch yet — a single
// integration gate runs `node --test dist` at the end of the milestone.
//
// Located next to the module (not under a top-level test/) because tsconfig sets
// rootDir/include to "src" and the verify script is `tsc && node --test dist`:
// a test outside src is never compiled and therefore never runs.
import test from 'node:test';
import assert from 'node:assert/strict';

import type { Listener } from '@ngrok/ngrok';
import { TunnelError } from '../domain/errors.js';
import { closeTunnel, createTunnelManager, openTunnel, type NgrokApi } from './tunnel.js';

const TOKEN = '2fAkEaUtHtOkEn_do_not_leak';

/** Runs `fn` with NGROK_AUTHTOKEN set, restoring the previous value afterwards. */
async function withToken(fn: () => Promise<void>): Promise<void> {
  const previous = process.env.NGROK_AUTHTOKEN;
  process.env.NGROK_AUTHTOKEN = TOKEN;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.NGROK_AUTHTOKEN;
    else process.env.NGROK_AUTHTOKEN = previous;
  }
}

interface FakeListener {
  handle: Listener;
  closes: number;
}

function fakeListener(url: string | null): FakeListener {
  const fake: FakeListener = {
    closes: 0,
    handle: {
      url: () => url,
      close: async () => {
        fake.closes += 1;
      },
    } as unknown as Listener,
  };
  return fake;
}

interface FakeNgrok extends NgrokApi {
  connectCalls: Array<{ addr: number; authtoken_from_env: boolean }>;
  kills: number;
}

function fakeNgrok(options: {
  connect: () => Promise<Listener>;
  listeners?: Listener[];
}): FakeNgrok {
  const api: FakeNgrok = {
    connectCalls: [],
    kills: 0,
    async connect(config) {
      api.connectCalls.push(config);
      return options.connect();
    },
    async listeners() {
      return options.listeners ?? [];
    },
    async kill() {
      api.kills += 1;
    },
  };
  return api;
}

test('an unset NGROK_AUTHTOKEN throws before any network call and names the .env file', async () => {
  const previous = process.env.NGROK_AUTHTOKEN;
  delete process.env.NGROK_AUTHTOKEN;
  const ngrok = fakeNgrok({ connect: async () => fakeListener('https://x.ngrok.app').handle });
  try {
    await assert.rejects(
      () => openTunnel(4567, ngrok),
      (error: unknown) => {
        assert.ok(error instanceof TunnelError);
        assert.match(error.message, /NGROK_AUTHTOKEN/);
        assert.match(error.message, /~\/\.linear-auto-worker\/\.env/);
        return true;
      }
    );
    assert.equal(ngrok.connectCalls.length, 0, 'must not reach the network');
  } finally {
    if (previous !== undefined) process.env.NGROK_AUTHTOKEN = previous;
  }
});

test('an ERR_NGROK_4018 rejection surfaces the code and nothing else from the original', async () => {
  await withToken(async () => {
    const ngrok = fakeNgrok({
      connect: async () => {
        const error = new Error('failed to start tunnel: ERR_NGROK_4018 authentication failed');
        (error as Error & { code: string }).code = 'GenericFailure';
        throw error;
      },
    });
    await assert.rejects(
      () => openTunnel(4567, ngrok),
      (error: unknown) => {
        assert.ok(error instanceof TunnelError);
        assert.match(error.message, /ERR_NGROK_4018/);
        assert.doesNotMatch(error.message, /authentication failed/);
        return true;
      }
    );
  });
});

test('an ERR_NGROK_105 rejection that echoes the authtoken never leaks it (T24)', async () => {
  await withToken(async () => {
    const ngrok = fakeNgrok({
      connect: async () => {
        throw new Error(
          `ERR_NGROK_105: the authtoken you specified is properly formed, but invalid. authtoken: ${TOKEN}`
        );
      },
    });
    await assert.rejects(
      () => openTunnel(4567, ngrok),
      (error: unknown) => {
        assert.ok(error instanceof TunnelError);
        assert.match(error.message, /ERR_NGROK_105/);
        assert.ok(!error.message.includes(TOKEN), 'authtoken must never reach the message');
        assert.doesNotMatch(error.message, /properly formed/);
        assert.equal((error as Error).cause, undefined, 'must not attach the caught error');
        return true;
      }
    );
  });
});

test('a null url() closes the listener and fails boot (T19)', async () => {
  await withToken(async () => {
    const listener = fakeListener(null);
    const ngrok = fakeNgrok({ connect: async () => listener.handle, listeners: [listener.handle] });
    await assert.rejects(
      () => openTunnel(4567, ngrok),
      (error: unknown) => {
        assert.ok(error instanceof TunnelError);
        assert.match(error.message, /null tunnel URL/);
        return true;
      }
    );
    assert.equal(listener.closes, 1, 'the dead listener must be closed');
  });
});

test('two listeners after connect throws and names the observed count (TUN-01)', async () => {
  await withToken(async () => {
    const first = fakeListener('https://a.ngrok.app');
    const second = fakeListener('https://b.ngrok.app');
    const ngrok = fakeNgrok({
      connect: async () => first.handle,
      listeners: [first.handle, second.handle],
    });
    await assert.rejects(
      () => openTunnel(4567, ngrok),
      (error: unknown) => {
        assert.ok(error instanceof TunnelError);
        assert.match(error.message, /found 2/);
        return true;
      }
    );
  });
});

test('the happy path returns the listener and a non-empty ephemeral url', async () => {
  await withToken(async () => {
    const listener = fakeListener('https://abc123.ngrok.app');
    const ngrok = fakeNgrok({ connect: async () => listener.handle, listeners: [listener.handle] });

    const result = await openTunnel(4567, ngrok);

    assert.equal(result.url, 'https://abc123.ngrok.app');
    assert.equal(result.listener, listener.handle);
    assert.equal(listener.closes, 0);
    assert.deepEqual(ngrok.connectCalls, [{ addr: 4567, authtoken_from_env: true }]);
    // D-01 — an ephemeral URL means no domain key was passed. deepEqual above proves it.
  });
});

test('closeTunnel delegates to listener.close()', async () => {
  const listener = fakeListener('https://abc123.ngrok.app');
  await closeTunnel(listener.handle);
  assert.equal(listener.closes, 1);
});

// The `installTunnelShutdownHooks` case was removed with the function it tested. It
// asserted that two signal handlers got registered — and those handlers called
// `process.exit(0)`, which would have raced `daemon.ts`'s ordered shutdown and abandoned
// the in-flight run marking. The test had to detach them again in a `finally` to avoid
// killing the test runner, which was the clue. `daemon.test.ts` owns signal handling now.

// ---------------------------------------------------------------------------
// createTunnelManager — the composition that moved here out of `cli/daemon.ts`
// ---------------------------------------------------------------------------

const silentLog = {
  child: () => silentLog,
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

test('createTunnelManager returns the listener url and closing it clears url()', async () => {
  await withToken(async () => {
    const listener = fakeListener('https://abc123.ngrok.app');
    const ngrok = fakeNgrok({ connect: async () => listener.handle, listeners: [listener.handle] });

    const tunnel = createTunnelManager(TOKEN, silentLog, ngrok);
    assert.equal(tunnel.url(), null, 'no url before open()');
    assert.equal(await tunnel.open(4000), 'https://abc123.ngrok.app');
    assert.equal(tunnel.url(), 'https://abc123.ngrok.app');

    await tunnel.close();
    assert.equal(listener.closes, 1, 'close() closed the listener');
    assert.equal(tunnel.url(), null, 'url() goes null again after close()');
  });
});

test('createTunnelManager retries a failed open exactly once, then succeeds', async () => {
  await withToken(async () => {
    const listener = fakeListener('https://retry.ngrok.app');
    let calls = 0;
    const ngrok = fakeNgrok({
      connect: async () => {
        calls += 1;
        if (calls === 1) throw new Error('ERR_NGROK_108 tunnel session failed');
        return listener.handle;
      },
      listeners: [listener.handle],
    });

    const url = await createTunnelManager(TOKEN, silentLog, ngrok).open(4000);

    assert.equal(url, 'https://retry.ngrok.app');
    assert.equal(ngrok.connectCalls.length, 2, 'exactly two connect attempts: one, then one retry');
  });
});

test('createTunnelManager gives up after the retry and never leaks the authtoken (T24)', async () => {
  await withToken(async () => {
    const ngrok = fakeNgrok({
      connect: async () => {
        throw new Error(`ERR_NGROK_105 invalid authtoken: ${TOKEN}`);
      },
    });

    await assert.rejects(
      () => createTunnelManager(TOKEN, silentLog, ngrok).open(4000),
      (error: unknown) => {
        assert.ok(error instanceof TunnelError);
        assert.match(error.message, /ERR_NGROK_105/);
        assert.doesNotMatch(error.message, new RegExp(TOKEN));
        return true;
      },
    );
    assert.equal(ngrok.connectCalls.length, 2, 'one attempt plus one retry, then out');
  });
});

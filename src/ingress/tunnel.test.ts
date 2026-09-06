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
import { closeTunnel, installTunnelShutdownHooks, openTunnel, type NgrokApi } from './tunnel.js';

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

test('installTunnelShutdownHooks registers SIGINT and SIGTERM handlers', () => {
  const before = {
    SIGINT: process.listeners('SIGINT'),
    SIGTERM: process.listeners('SIGTERM'),
  };
  const ngrok = fakeNgrok({ connect: async () => fakeListener('https://x.ngrok.app').handle });

  installTunnelShutdownHooks(ngrok);

  try {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      assert.equal(
        process.listeners(signal).length,
        before[signal].length + 1,
        `${signal} handler must be registered`
      );
    }
  } finally {
    // These call process.exit(0); leaving them attached would kill the test runner.
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      for (const handler of process.listeners(signal)) {
        if (!before[signal].includes(handler)) process.removeListener(signal, handler);
      }
    }
  }
});

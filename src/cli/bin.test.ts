/**
 * The `law` binary must actually be executable.
 *
 * `package.json` gained a `bin` entry at the release pass (T79) and `--help` was fixed
 * (T88) — and the command still died with `zsh: permission denied: law`. Two things
 * combine: `tsc` emits 0644, and every build starts with `clean` deleting `dist/`. So the
 * executable bit npm sets on the bin target at `npm link` time is destroyed by the very
 * next `npm run build` or `npm run verify`. Install worked; the first rebuild broke it.
 *
 * Asserted on the BUILT artifact rather than on the npm script, because the script is not
 * the claim — "the thing on the operator's PATH runs" is.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('the compiled CLI entry is executable and keeps its shebang', () => {
  const entry = fileURLToPath(new URL('./index.js', import.meta.url));
  const mode = statSync(entry).mode;

  // 0o111 — executable by owner, group and other. `npm link` symlinks this file straight
  // onto PATH, so the owner bit alone is not the whole story on a shared machine.
  assert.equal(
    (mode & 0o111).toString(8),
    '111',
    `dist/src/cli/index.js is ${(mode & 0o777).toString(8)}, not executable — ` +
      '`law` will fail with "permission denied". `npm run assets` chmods it; check that it ran.',
  );
});

/**
 * 260909-nh6 — `--config-dir` must REACH each command, not merely parse.
 *
 * Executed against the built binary rather than asserted against `parseArgs`, because the
 * defect this guards is precisely a flag that parses and then does not arrive: `main()` is
 * not exported (importing it would boot a daemon), so a unit test could only re-implement
 * the threading it is supposed to check. Each command below names the root it read in its
 * own output, so the assertion is on the value that actually got there.
 */
test('--config-dir reaches status, watch, say and start', async () => {
  const entry = fileURLToPath(new URL('./index.js', import.meta.url));
  const root = await mkdtemp(join(tmpdir(), 'law-configdir-'));

  try {
    const run = (args: string[]): { code: number; out: string } => {
      const r = spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8' });
      return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
    };

    for (const args of [
      ['status', '--config-dir', root],
      ['watch', '--config-dir', root],
      ['say', '--config-dir', root, 'LAW-1', 'hello'],
    ]) {
      const { code, out } = run(args);
      assert.equal(code, 1, `${args[0]} exits 1 with no store: ${out}`);
      assert.ok(
        out.includes(join(root, 'store.db')),
        `${args[0]} read the root it was given, not the operator's: ${out}`,
      );
      assert.ok(!out.includes('.linear-auto-worker'), `${args[0]} must not touch the real root`);
    }

    // `start` cannot be asserted through a clean exit — it boots a daemon. What it CAN be
    // asserted through is the first thing it reads: the config file under the given root.
    const started = run(['start', '--config-dir', join(root, 'nope')]);
    assert.ok(
      started.out.includes(join(root, 'nope')),
      `start read the root it was given: ${started.out}`,
    );

    // T88 is not disturbed: an unknown option is still an actionable message, not a stack.
    const unknown = run(['status', '--config-dirr', root]);
    assert.equal(unknown.code, 1);
    assert.ok(!unknown.out.includes('at Object.'), `no stack trace: ${unknown.out}`);
    assert.ok(unknown.out.includes('usage: law'), `and USAGE is printed: ${unknown.out}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

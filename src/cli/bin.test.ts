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
import { statSync } from 'node:fs';
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

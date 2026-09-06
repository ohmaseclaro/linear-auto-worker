# Deferred Items — Phase 2 Foundation

Out-of-scope discoveries logged per the executor's SCOPE BOUNDARY rule: pre-existing
issues in files not touched by the current task's changes are logged here, not fixed.

## 1. `logger.ts`'s `redact()` has no cycle guard (found while executing 02-02, task 2)

**File:** `src/infra/logger.ts` (owned by plan `02-01`, not touched by `02-02` per its
`files_modified` scope)

**Issue:** `redact()` recurses over `Object.entries()` with no visited-set/cycle
protection:

```ts
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : redact(val);
    }
    return out;
  }
  return value;
}
```

A genuinely circular object (`const o = {}; o.self = o;`) passed to `logger.info(o)`
recurses forever and overflows the call stack (`RangeError: Maximum call stack size
exceeded`), rather than redacting cleanly. `02-02-PLAN.md`'s Task 2 `<behavior>` block
requires a written test proving "a circular object logged through the redaction walker
does not throw and does not hang" — `logger.test.ts`'s last test asserts exactly this,
and is expected to fail once actually run until this gap is closed.

**Suggested fix (small, for whoever owns `logger.ts` next — Phase 1/7 integration or a
follow-up to plan 02-01):** thread a `WeakSet<object>` of visited objects through
`redact()`; short-circuit to `'[CIRCULAR]'` (or similar) when a value is already in the
set.

**Why not fixed here:** `02-02-PLAN.md`'s own `<verification>` states "No file outside
`src/infra/store/` and `src/infra/logger.test.ts` was created or modified" — `logger.ts`
is a different plan's (02-01, already merged) deliverable, and the executor's SCOPE
BOUNDARY rule excludes pre-existing bugs in files the current task did not change.

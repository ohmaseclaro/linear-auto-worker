---
task: "`law watch` and `law say` — live run observability and mid-flight interaction"
id: 260907-voh
type: quick
severity: P2
completed: 2026-09-07
status: complete
gate: "654/654 + boot smoke (598/598 before)"
commits:
  - 24bf09c  feat(watch)  Task 1 — the run log and `law watch`
  - 9712297  feat(agent)  Task 2 — the prompt on stdin, stdin closed on the first result
  - 7e97c67  feat(say)    Task 3 — the 0600 socket, the injector, the T109 proofs
  - 5ffc811  docs(traps)  Task 4 — T113-T115 and both commands documented
  - 22c857d  test(say)    coverage for `say.ts`, added during validation
---

# Quick task 260907-voh: `law watch` and `law say` — Summary

A spawned run is no longer a black box between pickup and pull request. Every parsed
stream event is appended to a durable per-run NDJSON log that `law watch` follows live and
replays afterwards, and the prompt now travels on the child's stdin rather than in argv —
which is what makes `law say` able to speak to a session that is still working.

`npm run verify`: **598/598 + boot smoke before, 654/654 + boot smoke after.** Four planned
commits plus one added during validation, all on `main`.

## What shipped

| | |
|---|---|
| `law watch [target]` | Follows `~/.linear-auto-worker/runs/<runId>.jsonl` off the existing `makeLineParser`, resolving the run by "the active one", issue key, or a 4+ character id prefix. |
| `law say <target> <text...>` | One NDJSON `user` message into a live agent's stdin, over a Unix socket at mode 0600 in a 0700 directory. |
| Streaming input | Every session spawns with `--input-format stream-json --replay-user-messages` and a bare trailing `-p`. stdin closes on the FIRST `result`; the run still ends on process exit. |
| T113-T115 | Filed in `.planning/TRAPS.md` (five columns) and `docs/TRAPS.md` (prose). |

## The four checker flags that required code, and what each became

**FLAG-A — the M2 containment nothing else provides.** `AGENT_ACK_TIMEOUT_MS = 60_000` in
`supervisor.ts`. Nothing in `npm run verify` can see M2; the only instrument that can is the
human-run probe, and nothing runs it on a schedule. Our regressions are contained by the
suite, vendor regressions are not. The router's `userEchoes` tally already existed but was
read only post-hoc; it is now read LIVE beside `routed.init`, and neither arriving within
the deadline calls `beginEscalation('no-agent-ack')`. **60 seconds**, chosen against the
measurement: the hook burst lands in 0.7s and a healthy session reaches `system/init` in
2.6s and its first echo in 4.2s (measured cold, 113 skills), so 60s is ~85x the observed
latency and 1/45th of `maxRunMs`. It deliberately does not set `timedOut` — nothing was
truncated, and the verdict reads that flag to ship committed work as `partial`.

**FLAG-C — `law say` no longer claims more than it knows.** (a) It prints
``queued to <label> — `law watch <key>` to see it land``, not "sent": a returning `ok` means
the pipe accepted the bytes, not that the agent read them, and the only proof of
consumption is the CLI replaying the message back. (b) The window closes on the CHILD-EXIT
path: `runAgent` calls `endStdin()` the moment `Promise.race([completed, reaped])` resolves,
because a child can die without ever emitting a `result` — which left the ended-flag false,
`write()` succeeding against a dead pipe, EPIPE surfacing asynchronously, and `law say`
having already claimed success. Fixed where the fact lives rather than by racing the
adapter's `finally`. (c) `write()` returning false is backpressure and is ignored; only a
throw is a failure, and only the stream's async `'error'` event means a lost write.

**FLAG-D — one line moved.** The daemon directory is `chmod 0700` **before** `listen()`.
`listen()` creates the socket at the ambient umask, so a chmod on the `'listening'` event
left the path bindable and connectable inside a directory that was also not yet 0700.

**FLAG-F — `renderEvent` strips control characters, using the helper that already exists.**
`sanitizeUntrustedText` from `execution/prompt.ts`, applied on the OUTPUT side. `law watch`
renders raw agent text derived from attacker-controlled ticket content (T99); collapsing
whitespace does not remove ESC, and ANSI escapes would let that text rewrite the operator's
scrollback and forge this command's own `-- result success` line. No new code. This is
consistent with T-VOH-06 declining to sanitize `law say` text — different direction,
different trust.

## The three prose flags

**FLAG-B** — the T114 row named the wrong failure mode for "M4 is false". Corrected in both
`.planning/TRAPS.md` and `PLAN.md`: if OUR code makes `result` terminal it ships a PR after
turn one (the anti-trap test guards that); if **M4 itself** stops holding, the daemon is
immune there — last-wins, nothing resolves early — and what it would do instead is close
stdin on an internal-turn result, EOF the child mid-work, and truncate a healthy run into a
`partial`. No scripted-stream test can see that; the probe is the only instrument.

**FLAG-E** — the stale-socket probe now treats every failure to reach a listener as
leftovers: ECONNREFUSED, and also ENOTSOCK (macOS, a leftover regular file) and ENOENT (a
dangling path, in the window between the exists-check and the connect). Naming only
ECONNREFUSED made an unexpected errno mean "another daemon owns this root" — a boot-blocking
false positive. Only a successful connect refuses to boot.

**FLAG-G** — `PLAN.md`'s rollback line corrected: reverting Task 2's commit alone works only
until commit 3 lands, since commit 3 imports `userMessageLine` and `onInput` from commit 2.

**And the ambiguous prose at PLAN.md:501** now reads `prior.tokensUsed + outcome.tokensUsed`
with the reason: the inner sum is across results in one session, the outer across the
several sessions one run can have, and `usage.test.ts`'s `resumed run ACCUMULATES` case
asserts the outer one at 300.

## Relocated controls, re-falsified at the new seam

Both were asserting at the `-p` argv seam, which the prompt no longer crosses.

| Control | Was | Now | Observed RED at the new seam |
|---|---|---|---|
| T99 argv containment | `after(nasty,'-p') === hostile` | `!args.some(a => a.includes(hostile))` — the STRONGER claim, plus the stdin-seam assertion in `supervisor.test.ts` | deleting the stdin write: `T99/T57 relocated: the prompt reaches the child on STDIN` at `0 !== 1` |
| T57 "the resumed session is TOLD the answer" | `after(args,'-p') === answer` | asserted against a real `PassThrough` in `supervisor.test.ts` | same deletion; and `law say reaches a live session` at `1 !== 2` |

## Every new check, falsified

| Break | Observed RED |
|---|---|
| drop `chmodSync(dir, 0o700)` | `run-log.test.ts` x2, `493 !== 448` |
| drop `sanitizeUntrustedText` in `renderEvent` | `watch.test.ts`, "ESC survived into the rendered line" |
| search TERMINAL before ACTIVE | `resolve-run.test.ts`, "a LIVE run beats a finished one sharing the ticket" |
| delete the stdin prompt write | `supervisor.test.ts` x2, `0 !== 1` and `1 !== 2` |
| resolve on the first `result` | `supervisor.test.ts`, `+ 'turn one'` / `- 'turn two'` |
| remove the no-agent-ack reap | whole file, `failureType: 'testTimeoutFailure'`, "test timed out after 8000ms" — the run never resolves, which is M2's own shape |
| drop `--replay-user-messages` | `agent-args.test.ts`, "both paths carry --input-format stream-json and --replay-user-messages" |
| `queued to` -> `sent to` | `say.test.ts`, "The input did not match the regular expression /^queued to LAW-9 o\/r — .../" |
| remove the `awaiting_answer` redirect | `say.test.ts`, "a PARKED run is redirected to Linear" |

One falsification found a real bug rather than confirming a check: the size-cap test came
back `2 !== 1` because the `truncated` guard sat inside the byte arithmetic, so a small
event arriving after an oversized one fit under the frozen counter and appended past the
marker. The guard now runs before the arithmetic.

## T109 wiring procedure — three passes, one of them instructive

| Deleted call site | Unit suites | Integration |
|---|---|---|
| `onInput:` in `adapters.ts` | `inject.test.js` 11/11 GREEN | `adapters.inject.test.js` RED: "no live agent for run run-inje" |
| `onEvent:` in `adapters.ts`, **first attempt** | 627/627 GREEN | **nothing red** — the wiring was untested |
| `onEvent:` in `adapters.ts`, **re-run after adding the assertion** | 19/19 GREEN | `adapters.inject.test.js` RED: "the system/init reached the log" |
| `serveInjections(...)` in `daemon.ts` | 12/12 GREEN | `npm run smoke` `SMOKE FAILED` |

The middle row is the point. The plan predicted it and said what to do; commit 1 reported
the wiring as NOT PROVEN rather than claiming the procedure had passed, and commit 3
re-ran the deletion after adding the integration assertion. The T109 ledger row now records
that a first neither-red pass is the normal outcome, not a sign of doing it wrong.

## Real-binary probe — CLI 2.1.263, run once by hand

`npx tsx scripts/probe-stream-input.ts` — PASS. Three messages, one session:

```
  #  subtype   turns  total_cost_usd  input_tokens  cache_read
  1  success   3      0.391886        4             36972
  2  success   3      0.434957        4             74262
  3  success   3      0.478395        4             74807
```

Three inits (M9, one per message), the same `session_id` on all of them (M10), cost
monotonic (M6 — take the last), `input_tokens` flat (M6 — sum them), exit 0 immediately
after `stdin.end()` (M8). 2.6s to init, 4.2s to the first echo.

## Two things the plan did not have, found by measuring

**1. M11 is incomplete, and the comments now say so.** Three written messages produced
**nine** `user` events, not three: the CLI also replays an internal
`[structured-output-enforce]` turn and an empty tool-result turn per message. `userEchoes`
is therefore a SUPERSET of "messages we wrote". Neither use is weakened — liveness, and
zero-versus-nonzero delivery — but it must not be read as a message count.

**2. T115 turned out bigger than the plan's ask.** The plan wanted "the exact `system/init`
key list that does NOT contain a remote-control field". Writing it from the repo fixture
gave 13 keys; the fixture actually has 24. Measured live instead, with `--remote-control
probe` passed alongside `-p`: 24 keys, none matching `/remote/i` — M1 confirmed — **but**
`messaging_socket_path: "/tmp/cc-socks/57025.sock"`, with `/tmp/cc-socks` at `drwx------`
and the sockets at `srw-------`. The CLI already runs a per-session Unix socket at exactly
the trust level this task built one at. Its protocol was NOT probed and nothing here depends
on it; it is recorded as an OPEN LEAD because the next person wanting a control channel will
reach for `--remote-control`, find a no-op, and stop one line short of it.

## Pre-existing defects found and fixed in passing

- **`scripts/probe-gsd-allowlist.ts` had not type-checked since `maxTurns` became required
  on `ClaudeArgsInput`** — exactly the trap the plan's own constraint names (`scripts/` is
  outside tsconfig's `include`, so the compiler says nothing). Fixed with the shipped
  default of 40.
- **Two `Config` test fixtures carried no `worktreeRoot`**, which the schema requires;
  `daemonDirOf` threw the moment the run log was wired. T94's rule applied: the fixtures
  were widened, not the production code.
- **README's footgun count was already 3 stale** (T110-T112 were added without bumping it).
  Set to 115.

## Security

`src/ingress/receiver.ts` gains nothing. The gate over its non-comment lines was run and
returns 0:

```
grep -v '^\s*[/*]' src/ingress/receiver.ts | grep -c -i -E 'say|inject|sock'   ->   0
```

The say channel is a Unix socket at 0600 inside a 0700 directory, asserted by both a unit
test and the boot smoke — and the smoke proves the daemon is SERVING, via a real
`sendInjection` for an unknown run coming back `{ok:false}` with a reason, not merely that a
file exists. Run logs hold raw agent output, bypass the log redaction by design, are 0600,
are never transmitted, and are pruned at 7 days and capped at 64 MiB.

## Not verified, and stated as such

- **`law say` has not been exercised against a real spawned `claude` on a real Linear
  ticket.** The full chain is covered up to the process boundary — `adapters.inject.test.ts`
  drives a real `createAgentRunner` and asserts the envelope lands on a real `PassThrough`,
  the boot smoke proves the socket serves, and `probe-stream-input.ts` proves the real binary
  accepts a mid-session message (M7) — but nobody has typed `law say LAW-123 ...` at a live
  run and watched the reply appear in `law watch`. That is the one item in the plan's
  `<done>` that only live UAT can close.
- **The FLAG-A deadline has never fired in production**, only against a driven timer. Its
  60-second value is defended by measurement but not by experience.
- **`messaging_socket_path` was observed, not probed.** No claim is made about it.

## Deviations from the plan

- **`ackTimeoutMs` was added to `RunAgentInput`** so the FLAG-A deadline can be driven by a
  test rather than waited out — the same reason `maxRunMs` is a parameter. Not in the plan
  because FLAG-A is not in the plan.
- **`say.test.ts` was added during validation.** `say.ts` shipped in commit 3 with the socket
  and the registry tested and the module that decides what an operator READS untested.
- **The T115 row is broader than specified**, for the reason above.

## Self-Check: PASSED

All six created source files and the SUMMARY exist on disk; all five commit hashes
(24bf09c, 9712297, 7e97c67, 5ffc811, 22c857d) are in git log.

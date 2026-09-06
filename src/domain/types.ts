/**
 * Shared vocabulary. Every layer in this project imports from `src/domain/`, and
 * `src/domain/` imports nothing outside itself.
 */

export type RunId = string; // uuid v4
export type IssueId = string; // Linear uuid
export type SessionId = string; // uuid v4, pre-assigned to `claude --session-id`

/**
 * The nine run states (D-01). These exact strings appear in the SQL schema, in every log
 * line, in Linear comment bodies, and in all five parallel layers — renaming one is a
 * database migration plus a simultaneous edit to every layer.
 *
 * `partial` is a real state, not a rounding of `failed`: success is judged by evidence in
 * the worktree rather than by exit code, and a partial run still ships a draft PR. The
 * "barren" outcome — the agent produced no evidence at all — folds into `failed`.
 */
export type RunState =
  | 'queued'
  | 'preparing'
  | 'running'
  | 'awaiting_answer'
  | 'delivering'
  | 'delivered'
  | 'partial'
  | 'failed'
  | 'cancelled';

/**
 * Terminal states. Nothing leaves them, with exactly one documented exception:
 * `failed` accepts an explicit operator `requeue`.
 */
export const TERMINAL: ReadonlyArray<RunState> = ['delivered', 'partial', 'failed', 'cancelled'];

/**
 * States that occupy one of the daemon's concurrency slots (D-02).
 *
 * The parked state is deliberately absent, and that absence is load-bearing for the whole
 * scheduler: a run waiting on a human answer takes minutes to hours, so if it held a slot
 * three open questions would deadlock a three-slot laptop. Because it holds nothing, an
 * hours-long human wait costs the daemon nothing.
 */
export const HOLDS_SLOT: ReadonlyArray<RunState> = ['preparing', 'running', 'delivering'];

/**
 * States with a live `claude` child process (D-02).
 *
 * Only one qualifies. The Q&A design is exit-and-resume: the agent ends its turn to ask,
 * so the child process is already gone by the time the run parks. A parked run has no live
 * process any more than it has a slot.
 */
export const HAS_CHILD: ReadonlyArray<RunState> = ['running'];

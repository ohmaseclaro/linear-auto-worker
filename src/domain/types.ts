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

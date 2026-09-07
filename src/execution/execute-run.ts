/**
 * The command-runner port, and the verdict vocabulary.
 *
 * This module used to also hold `executeRun` — Phase 4's complete composition root for one
 * run: worktree, prompt, supervised spawn, verdict, deliver. It was **dead code**. Phase 6
 * and 7 built the real path (`orchestration/run-engine.ts` driving `cli/adapters.ts`), and
 * nothing outside `execute-run.test.ts` ever called `executeRun` again.
 *
 * It was deleted rather than kept, because a dead duplicate of a live path is not free.
 * Three documented defects on this project came from exactly that shape:
 *
 *   - **T72** — two Linear comment posters, one wired, one not; wiring the second would
 *     have double-posted every milestone.
 *   - **T73** — two verdict designs. The evidence-based one lived here and nothing on the
 *     live path called it, so for a whole milestone an agent that reported `complete`
 *     having written nothing WAS complete as far as the daemon could tell.
 *   - **T92** — two migration runners, and the tests were on the dead one, so adding a
 *     migration to the tested list applied nothing at all.
 *
 * The fourth was starting: wiring `--max-turns` and `--max-budget-usd` needed doing twice,
 * in two places, with nothing to catch it if they drifted.
 *
 * What survives is what other modules actually import: the `RunCommand` port with its real
 * implementation, and `ExecutionVerdict`. The filename is now wider than its contents; that
 * is cheaper than renaming an import in eleven files.
 */
import { execa } from 'execa';

export interface RunCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunCommandOptions {
  cwd?: string;
  /** Default true. A non-zero exit REJECTS unless this is explicitly false. */
  reject?: boolean;
}

/**
 * An injectable, execa-shaped one-shot command runner.
 *
 * Injecting it is what makes this whole path testable with no `git`, no `gh` and no
 * `claude` installed — which under RUSH mode is the only kind of test that can exist.
 * `execa` is imported in exactly two places in this phase: here, as this default, and in
 * `supervisor.ts` for the agent spawn. Both are injectable; nothing else in
 * `src/execution/` imports it.
 */
export type RunCommand = (
  file: string,
  args: readonly string[],
  options?: RunCommandOptions
) => Promise<RunCommandResult>;

export const defaultRunCommand: RunCommand = async (file, args, options) => {
  const result = await execa(file, [...args], {
    cwd: options?.cwd,
    reject: options?.reject ?? true,
  });
  return {
    exitCode: result.exitCode ?? 0,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
};

export type ExecutionVerdict = 'delivered' | 'partial' | 'failed' | 'needs_input';

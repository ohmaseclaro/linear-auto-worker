/**
 * The two host boundaries the wizard crosses — a child process, and the operator's
 * terminal — as injectable ports with the real implementation as the default.
 *
 * ## Why injection rather than `mock.method`
 *
 * Twenty-two of the fifty-six failures on this milestone's first gate run were one line:
 *
 * ```
 * error: 'Cannot redefine property: execa'   // and: 'Cannot redefine property: select'
 * ```
 *
 * `execa` and `@inquirer/prompts` are ESM, and an ESM namespace binding is
 * non-configurable **by specification** — `mock.method(ns, 'execa', …)` cannot work and
 * never could. Node's `mock.module` is the other way out and is `undefined` on Node 22
 * unless `--experimental-test-module-mocks` is passed, which would put an experimental flag
 * into the canonical gate permanently.
 *
 * 03-01 already hit this wall with the ngrok SDK and answered it with a default parameter
 * (`openTunnel(port, ngrok: NgrokApi = ngrokSdk)`). This is the same shape, so it is an
 * established convention here rather than a new one — and every production call site is
 * unchanged, because the real implementation is the default.
 *
 * The command runner is deliberately NOT a new type: `RunCommand` already exists in
 * `execution/execute-run.ts`, already means "run one child process, throw on non-zero", and
 * is already the injection seam the daemon's `BootOptions.runCommand` uses.
 */
import { checkbox, confirm, input, select } from '@inquirer/prompts';

export {
  defaultRunCommand,
  type RunCommand,
  type RunCommandResult,
} from '../../execution/execute-run.js';

/**
 * The slice of `@inquirer/prompts` the wizard uses.
 *
 * Written structurally and narrowly rather than as `typeof select` so a test can hand over
 * a two-line stub without reconstructing inquirer's full generic config types.
 */
export interface WizardPrompts {
  select<T>(config: { message: string; choices: ReadonlyArray<{ name: string; value: T }> }): Promise<T>;
  checkbox<T>(config: { message: string; choices: ReadonlyArray<{ name: string; value: T }> }): Promise<T[]>;
  input(config: { message: string }): Promise<string>;
  confirm(config: { message: string; default?: boolean }): Promise<boolean>;
}

/** The real terminal. Every exported wizard function defaults to this. */
export const realPrompts: WizardPrompts = { select, checkbox, input, confirm };

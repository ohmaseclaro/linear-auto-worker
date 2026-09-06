/**
 * The `stream-json` event router. AGNT-07, D-05.
 *
 * The tracer routes the two events the rest of the path depends on: `system/init`, where
 * the run is asserted to be the run we asked for, and `result`, which carries every
 * number the terminal comment reports. Plan 04 adds `system/task_summary`,
 * `system/post_turn_summary`, `system/permission_denied`, `assistant` and `user`.
 */
import { LawError } from '../domain/errors.js';
import type { Logger } from '../infra/logger.js';
import { PERMISSION_MODE } from './agent-args.js';

/**
 * The GSD entry points the spawned session must be able to see. Absence means the agent
 * would have produced generic, non-GSD work and exited 0 — which is indistinguishable
 * from success from the outside, and is precisely the difference between "GSD did not
 * run" and "GSD ran and found nothing to do".
 */
export const REQUIRED_GSD_SKILLS: readonly string[] = [
  'gsd-execute-phase',
  'gsd-plan-phase',
  'gsd-verify-work',
];

export interface PermissionDenial {
  tool_name: string;
  tool_use_id: string;
  tool_input: unknown;
}

/** Observed keys of `system/init` on CLI 2.1.259; only the asserted ones are typed. */
export interface SystemInitEvent {
  session_id?: string;
  cwd?: string;
  /** A flat string[] — 116 entries on this machine. Not a nested structure. */
  skills?: string[];
  /** The mode the CLI actually applied, echoed back. A free T1 detector at init time. */
  permissionMode?: string;
}

/** The terminal event. Field names are the CLI's, verbatim. */
export interface AgentResultEvent {
  type: 'result';
  subtype: string;
  is_error: boolean;
  session_id: string;
  /**
   * The assistant's final text — under --json-schema, the JSON *string*. Do not read it:
   * `structured_output` beside it is the same value already parsed (T31).
   */
  result?: string;
  structured_output?: unknown;
  stop_reason?: string;
  terminal_reason?: string;
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  permission_denials?: PermissionDenial[];
  usage?: Record<string, unknown>;
}

export interface RoutedRun {
  init?: SystemInitEvent;
  result?: AgentResultEvent;
}

export interface EventRouter {
  /** Called once per parsed NDJSON line, in emission order. */
  route(event: unknown): void;
  /** What the supervisor reads once the stream is exhausted. */
  readonly routed: RoutedRun;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * D-05 / AGNT-07. Throws, loudly and with a diagnosis, rather than letting the run
 * proceed to produce nothing.
 */
export function assertSessionUsable(init: SystemInitEvent): void {
  const skills = init.skills ?? [];
  const missing = REQUIRED_GSD_SKILLS.filter((skill) => !skills.includes(skill));
  if (missing.length > 0) {
    throw new LawError(
      'AGENT_ENV',
      `GSD skills absent from the spawned session: ${missing.join(', ')}. ` +
        `The session saw ${skills.length} skills in total. The two causes are: the ` +
        `forbidden --bare flag was passed (see agent-args.ts), or ~/.claude is not ` +
        `readable by the daemon user.`
    );
  }
  if (init.permissionMode !== PERMISSION_MODE) {
    throw new LawError(
      'AGENT_ENV',
      `permissionMode echoed back as ${String(init.permissionMode)}, expected ` +
        `${PERMISSION_MODE}. The CLI did not apply the mode this worker requested, so ` +
        `every edit is about to be denied while the process still exits 0 (T1).`
    );
  }
}

export function makeEventRouter(o: { log: Logger }): EventRouter {
  const routed: RoutedRun = {};

  return {
    routed,
    route(event: unknown): void {
      if (!isRecord(event)) return;

      if (event['type'] === 'system' && event['subtype'] === 'init') {
        const init = event as unknown as SystemInitEvent;
        routed.init = init;
        o.log.debug({ skills: init.skills?.length, mode: init.permissionMode }, 'agent init');
        assertSessionUsable(init);
        return;
      }

      if (event['type'] === 'result') {
        routed.result = event as unknown as AgentResultEvent;
        return;
      }
    },
  };
}

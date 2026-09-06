/**
 * The `stream-json` event router. AGNT-07, D-05.
 *
 * The tracer routes the two events the rest of the path depends on: `system/init`, where
 * the run is asserted to be the run we asked for, and `result`, which carries every
 * number the terminal comment reports. Plan 04 adds `system/task_summary`,
 * `system/post_turn_summary`, `system/permission_denied`, `assistant` and `user`.
 *
 * `assistant` and `user` events are intentionally not typed or routed anywhere beyond
 * being silently ignored (they carry no assertion and no progress signal this phase
 * owns) — a run log consumer can read them straight off the parser's `onEvent` if a
 * future phase wants the tool-use trace; duplicating them here is not this module's job.
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
  /**
   * T-04-23 / T27, T28. The three reason types seen in the research mean different
   * things: `mode` is the allowlist being wrong, `asyncAgent` is inherited `CLAUDE*`
   * variables reaching the child (T28), and `subcommandResults` is a piped Bash command
   * being decomposed per-part — which is why the allowlist grants the *tool*, `Bash`,
   * rather than trying to enumerate command patterns.
   */
  decision_reason_type?: string;
}

/** Plan 04, D-05/AGNT-07: what `assertSessionUsable` checks against. Both default from
 * this module's own constants, so a caller need not pass either unless it wants to. */
export interface AssertSessionUsableOptions {
  expectedPermissionMode?: string;
  requiredSkills?: readonly string[];
}

/**
 * Progress passed out through `makeEventRouter`'s callback. Consumed by Phase 5, not by
 * this phase — this module formats nothing and posts nothing anywhere.
 */
export type ProgressUpdate =
  | { kind: 'task_summary'; detail: string }
  | {
      kind: 'post_turn_summary';
      status_category?: string;
      status_detail?: string;
      needs_action: string | null;
    };

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
  /**
   * T-04-23. Every `system/permission_denied` seen so far, in order. A non-empty tally
   * at run's end is a first-class, reportable failure cause: it names the exact tool and
   * input that was refused, which is the difference between a diagnosable failure and a
   * run that produced nothing for no stated reason.
   */
  readonly denials: readonly PermissionDenial[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * D-05 / AGNT-07. Throws, loudly and with a diagnosis, rather than letting the run
 * proceed to produce nothing. `init.skills` absent entirely (not just empty) is not
 * given a nullish default here — it is its own branch with its own message, because
 * "the key was never sent" and "the key was sent empty" are different diagnoses.
 */
export function assertSessionUsable(
  init: SystemInitEvent,
  o: AssertSessionUsableOptions = {}
): void {
  const requiredSkills = o.requiredSkills ?? REQUIRED_GSD_SKILLS;
  const expectedMode = o.expectedPermissionMode ?? PERMISSION_MODE;

  if (init.skills === undefined) {
    throw new LawError(
      'AGENT_ENV',
      `system/init carried no "skills" key at all — the spawned session saw 0 skills, ` +
        `required: ${requiredSkills.join(', ')}. The two causes are: the forbidden ` +
        `--bare flag was passed to claude (see agent-args.ts), or ~/.claude is not ` +
        `readable by the daemon user.`
    );
  }

  const skills = init.skills;
  const missing = requiredSkills.filter((skill) => !skills.includes(skill));
  if (missing.length > 0) {
    throw new LawError(
      'AGENT_ENV',
      `GSD skills missing from the spawned session: ${missing.join(', ')}. ` +
        `The session saw ${skills.length} skills in total. The two causes are: the ` +
        `forbidden --bare flag was passed to claude (see agent-args.ts), or ~/.claude ` +
        `is not readable by the daemon user.`
    );
  }

  if (init.permissionMode !== expectedMode) {
    throw new LawError(
      'AGENT_ENV',
      `permissionMode echoed back as ${String(init.permissionMode)}, expected ` +
        `${expectedMode}. The claude CLI did not apply the mode this worker requested, ` +
        `so every edit is about to be denied while the process still exits 0 (T1). This ` +
        `is a second, independent detector — a correct mode alone does not guarantee ` +
        `zero denials (T27), which is what the denial tally below is for.`
    );
  }
}

export interface MakeEventRouterOptions {
  log: Logger;
  /** Defaults to `PERMISSION_MODE` from `agent-args.ts` — the mode this worker requested. */
  expectedPermissionMode?: string;
  /** Defaults to `REQUIRED_GSD_SKILLS`. */
  requiredSkills?: readonly string[];
  /** Phase 5 consumes this; this module formats nothing and posts nothing. */
  onProgress?: (update: ProgressUpdate) => void;
}

export function makeEventRouter(o: MakeEventRouterOptions): EventRouter {
  const routed: RoutedRun = {};
  const denials: PermissionDenial[] = [];
  const assertOptions: AssertSessionUsableOptions = {
    expectedPermissionMode: o.expectedPermissionMode,
    requiredSkills: o.requiredSkills,
  };

  return {
    routed,
    denials,
    route(event: unknown): void {
      if (!isRecord(event)) return;
      const type = event['type'];
      const subtype = event['subtype'];

      if (type === 'system' && subtype === 'init') {
        const init = event as unknown as SystemInitEvent;
        routed.init = init;
        o.log.debug({ skills: init.skills?.length, mode: init.permissionMode }, 'agent init');
        assertSessionUsable(init, assertOptions);
        return;
      }

      if (type === 'system' && subtype === 'task_summary') {
        const detail = event['detail'];
        // A null detail is a real, observed value (the CLI sends it between tool calls
        // with nothing new to report) and is not itself progress worth surfacing.
        if (typeof detail === 'string') {
          o.onProgress?.({ kind: 'task_summary', detail });
        }
        return;
      }

      if (type === 'system' && subtype === 'post_turn_summary') {
        const statusCategory = event['status_category'];
        const statusDetail = event['status_detail'];
        const needsAction = event['needs_action'];
        o.onProgress?.({
          kind: 'post_turn_summary',
          status_category: typeof statusCategory === 'string' ? statusCategory : undefined,
          status_detail: typeof statusDetail === 'string' ? statusDetail : undefined,
          // status_category: "blocked" is a directly usable machine signal that the run
          // is going nowhere — passed through untouched for whoever reads onProgress.
          needs_action: typeof needsAction === 'string' ? needsAction : null,
        });
        return;
      }

      if (type === 'system' && subtype === 'permission_denied') {
        denials.push({
          tool_name: typeof event['tool_name'] === 'string' ? (event['tool_name'] as string) : '',
          tool_use_id:
            typeof event['tool_use_id'] === 'string' ? (event['tool_use_id'] as string) : '',
          tool_input: event['tool_input'],
          decision_reason_type:
            typeof event['decision_reason_type'] === 'string'
              ? (event['decision_reason_type'] as string)
              : undefined,
        });
        return;
      }

      if (type === 'result') {
        // T31: `structured_output` is captured as the object the event already carries.
        // The string field beside it (`result`) is never read and never JSON.parse'd —
        // that would be duplicated work and a second, unnecessary failure mode.
        routed.result = event as unknown as AgentResultEvent;
        return;
      }

      // Unknown event type (including assistant/user/hook_started/hook_response/
      // rate_limit_event): ignored by design. The CLI ships frequently and a new event
      // kind must not kill a run.
    },
  };
}

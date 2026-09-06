/**
 * The domain barrel. Seven branches are importing from `src/domain/` without being able to
 * see it; this is what makes both the directory-level and the file-level guess compile.
 */

export * from './types.js';
export * from './state-machine.js';
export * from './errors.js';
export * from './agent-result.js';
export * from './fakes.js';

// ports.ts deliberately re-exports types.ts and agent-result.ts, so that either import
// path compiles for a sibling phase. `export * from './ports.js'` here would therefore
// make every shared name ambiguous (TS2308) and silently drop it from the barrel — so the
// barrel takes only the port interfaces themselves.
export type {
  ConfigLoader,
  Store,
  Logger,
  TunnelManager,
  WebhookRegistrar,
  WebhookDelivery,
  Receiver,
  DomainEvent,
  IngressEvent,
  EngineEvent,
  EventRouter,
  Scheduler,
  RunEngine,
  Worktree,
  WorktreeManager,
  AgentSpawnRequest,
  AgentRunner,
  PullRequest,
  Deliverer,
  LinearIssue,
  LinearComment,
  LinearClient,
  RunEvent,
  Notifier,
} from './ports.js';

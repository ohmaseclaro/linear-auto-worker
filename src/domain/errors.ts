/**
 * Typed errors for every layer. This set exists up front rather than growing per layer:
 * five layers are built in parallel, and each one otherwise invents its own error class
 * for the same condition and the merge collides.
 */

import type { RunState } from './types.js';

/** Base class for every error this project throws deliberately. */
export class LawError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LawError';
    this.code = code;
  }
}

/** A trigger was applied to a state that has no entry for it in the transition table. */
export class IllegalTransitionError extends LawError {
  readonly from: RunState;
  readonly trigger: string;

  constructor(from: RunState, trigger: string, options?: ErrorOptions) {
    super('ILLEGAL_TRANSITION', `illegal transition: ${from} --${trigger}-->`, options);
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.trigger = trigger;
  }
}

/** `config.json` is missing, unreadable, or fails its zod schema. Carries the zod path. */
export class ConfigError extends LawError {
  constructor(message: string, options?: ErrorOptions) {
    super('CONFIG', message, options);
    this.name = 'ConfigError';
  }
}

/** The agent's final result was not the JSON shape `AgentResultSchema` requires. */
export class AgentResultParseError extends LawError {
  constructor(message: string, options?: ErrorOptions) {
    super('AGENT_RESULT_PARSE', message, options);
    this.name = 'AgentResultParseError';
  }
}

/** A schema migration failed; the transaction was rolled back and user_version not bumped. */
export class MigrationError extends LawError {
  constructor(message: string, options?: ErrorOptions) {
    super('MIGRATION', message, options);
    this.name = 'MigrationError';
  }
}

/** `git worktree` add/remove/checkout failed. */
export class WorktreeError extends LawError {
  constructor(message: string, options?: ErrorOptions) {
    super('WORKTREE', message, options);
    this.name = 'WorktreeError';
  }
}

/** Push or PR creation failed. Note that a successful push is never rolled back. */
export class DeliveryError extends LawError {
  constructor(message: string, options?: ErrorOptions) {
    super('DELIVERY', message, options);
    this.name = 'DeliveryError';
  }
}

/** The ngrok tunnel could not be opened, or its URL was absent. */
export class TunnelError extends LawError {
  constructor(message: string, options?: ErrorOptions) {
    super('TUNNEL', message, options);
    this.name = 'TunnelError';
  }
}

/** A Linear GraphQL call failed, including the rate-limited case (HTTP 400 + RATELIMITED). */
export class LinearApiError extends LawError {
  constructor(message: string, options?: ErrorOptions) {
    super('LINEAR_API', message, options);
    this.name = 'LinearApiError';
  }
}

import { runPreflight } from './preflight.js';
import type { PreflightResult } from './preflight.js';

const STATUS_PREFIX: Record<PreflightResult['status'], string> = {
  pass: '✓', // ✓
  warn: '⚠', // ⚠
  fail: '✗', // ✗
};

function printResult(result: PreflightResult): void {
  const prefix = STATUS_PREFIX[result.status];
  console.log(`${prefix} ${result.name}: ${result.detail}`);
  if (result.fix) {
    console.log(`  fix: ${result.fix}`);
  }
}

/**
 * Orchestrates the setup wizard. In this plan it runs preflight only — later
 * plans (secrets, repo mapping, safety checks, registration) extend this
 * function. Never lets a raw error surface (D-08): every failure path here is
 * expressed as a PreflightResult with a human `fix` string.
 */
export async function runSetupWizard(): Promise<number> {
  const results = await runPreflight();

  for (const result of results) {
    printResult(result);
  }

  const hasFailure = results.some((r) => r.status === 'fail');
  return hasFailure ? 1 : 0;
}

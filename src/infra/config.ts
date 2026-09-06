import * as z from 'zod';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '../domain/types.js';

/**
 * Tracer-minimal shape: presence of `defaults`/`mappings` only. Task 2
 * replaces these two fields with the full CONF-02 toggle schema and the
 * project/team mapping rules.
 */
export const ConfigSchema = z.object({
  defaults: z.record(z.string(), z.unknown()),
  mappings: z.array(z.record(z.string(), z.unknown())),
});

/** D-01/D-06: config, secrets, database, and logs all resolve under here.
 * Uses os.homedir(), never process.env.HOME (unset in some spawned-process
 * contexts). */
export function defaultRoot(): string {
  return path.join(os.homedir(), '.linear-auto-worker');
}

export function loadConfig(root: string = defaultRoot()): Config {
  const configPath = path.join(root, 'config.json');
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid config at ${configPath}:\n${z.prettifyError(result.error)}`);
  }
  return result.data as Config;
}

import { existsSync } from 'node:fs';
import { z } from 'zod';
import { err, ok, type Result } from '../types/shared.ts';

/**
 * Environment configuration, read once at startup.
 *
 * Secrets are collected here and nowhere else. They are held in a Map keyed by
 * the name an action can reference, and the values leave this module only via
 * the executor (to type into a field) and the redactor (to scrub them back out
 * of anything we persist).
 */

/** Credentials for the target site are namespaced so nothing else leaks in. */
const SECRET_PREFIX = 'SIM_SECRET_';

const EnvSchema = z.object({
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
  /**
   * Points the SDK at an OpenAI-compatible endpoint instead of OpenAI itself.
   *
   * This is a base URL, deliberately not a provider abstraction: one string,
   * no branching, no second code path to keep correct. See `llm/client.ts` for
   * the constraint any such endpoint has to meet.
   */
  OPENAI_BASE_URL: z.string().url().optional(),
  OPENAI_PLANNER_MODEL: z.string().min(1).default('gpt-4.1'),
  OPENAI_EVALUATOR_MODEL: z.string().min(1).default('gpt-4.1'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  HEADLESS: z
    .string()
    .default('1')
    .transform((value) => value !== '0' && value.toLowerCase() !== 'false'),
});

export type Env = {
  readonly openaiApiKey: string;
  /** Undefined means OpenAI's own API. */
  readonly openaiBaseUrl: string | undefined;
  readonly plannerModel: string;
  readonly evaluatorModel: string;
  readonly logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  readonly headless: boolean;
  /** Name -> value, e.g. PASSWORD -> the actual password. */
  readonly secrets: ReadonlyMap<string, string>;
};

/** Reads `.env` into `process.env` if present. Real environment wins. */
export function loadDotEnv(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

export function collectSecrets(source: NodeJS.ProcessEnv): Map<string, string> {
  const secrets = new Map<string, string>();
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith(SECRET_PREFIX) || value === undefined || value === '') continue;
    secrets.set(key.slice(SECRET_PREFIX.length), value);
  }
  return secrets;
}

export function readEnv(source: NodeJS.ProcessEnv = process.env): Result<Env, string> {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    return err(`Invalid environment:\n  ${issues.join('\n  ')}`);
  }

  return ok({
    openaiApiKey: parsed.data.OPENAI_API_KEY,
    openaiBaseUrl: parsed.data.OPENAI_BASE_URL,
    plannerModel: parsed.data.OPENAI_PLANNER_MODEL,
    evaluatorModel: parsed.data.OPENAI_EVALUATOR_MODEL,
    logLevel: parsed.data.LOG_LEVEL,
    headless: parsed.data.HEADLESS,
    secrets: collectSecrets(source),
  });
}

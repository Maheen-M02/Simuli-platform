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
  /**
   * Ask the endpoint to route only to providers that support the parameters we
   * send. OpenRouter serves one model id from several upstream providers whose
   * structured-output support differs, so without this a run can be routed to
   * one that ignores the schema. Off by default: OpenAI rejects unknown
   * request fields.
   */
  LLM_REQUIRE_STRUCTURED_OUTPUT: z
    .string()
    .optional()
    .transform((value) => value !== undefined && value !== '0' && value.toLowerCase() !== 'false'),
  /** Optional attribution, shown on the OpenRouter activity page. */
  OPENROUTER_APP_TITLE: z.string().optional(),
  OPENROUTER_APP_URL: z.string().url().optional(),
  OPENAI_PLANNER_MODEL: z.string().min(1).default('gpt-4.1'),
  /**
   * NVIDIA's OpenAI-compatible endpoint, for benchmarking a second provider.
   *
   * Optional: absent simply means NVIDIA cannot be benchmarked, which the
   * benchmark reports as a fact about the run rather than failing halfway.
   */
  NVIDIA_API_KEY: z.string().optional(),
  NVIDIA_MODEL: z.string().min(1).default('nvidia/llama-3.1-nemotron-ultra-253b-v1'),
  /**
   * Cap on the planner's reply. One action plus reasoning is a few hundred
   * tokens; reserving more is billed by a metered endpoint and refused outright
   * by a prepaid one.
   */
  PLANNER_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(8192).default(1024),
  /** Per-million-token rates, for costing a benchmark. Never guessed. */
  OPENAI_COST_INPUT_PER_M: z.coerce.number().nonnegative().optional(),
  OPENAI_COST_OUTPUT_PER_M: z.coerce.number().nonnegative().optional(),
  NVIDIA_COST_INPUT_PER_M: z.coerce.number().nonnegative().optional(),
  NVIDIA_COST_OUTPUT_PER_M: z.coerce.number().nonnegative().optional(),
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
  /** Send provider.require_parameters, so a schema-blind provider is not used. */
  readonly requireStructuredOutput: boolean;
  readonly appTitle: string | undefined;
  readonly appUrl: string | undefined;
  readonly plannerModel: string;
  readonly evaluatorModel: string;
  /** Undefined means NVIDIA is not configured for this machine. */
  readonly nvidiaApiKey: string | undefined;
  readonly nvidiaModel: string;
  readonly plannerMaxOutputTokens: number;
  readonly openaiRates: { inputPerMillion: number; outputPerMillion: number } | undefined;
  readonly nvidiaRates: { inputPerMillion: number; outputPerMillion: number } | undefined;
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
    requireStructuredOutput: parsed.data.LLM_REQUIRE_STRUCTURED_OUTPUT,
    appTitle: parsed.data.OPENROUTER_APP_TITLE,
    appUrl: parsed.data.OPENROUTER_APP_URL,
    plannerModel: parsed.data.OPENAI_PLANNER_MODEL,
    evaluatorModel: parsed.data.OPENAI_EVALUATOR_MODEL,
    nvidiaApiKey: parsed.data.NVIDIA_API_KEY,
    nvidiaModel: parsed.data.NVIDIA_MODEL,
    plannerMaxOutputTokens: parsed.data.PLANNER_MAX_OUTPUT_TOKENS,
    // Both halves of a rate must be present, or the pair is meaningless.
    openaiRates:
      parsed.data.OPENAI_COST_INPUT_PER_M === undefined ||
      parsed.data.OPENAI_COST_OUTPUT_PER_M === undefined
        ? undefined
        : {
            inputPerMillion: parsed.data.OPENAI_COST_INPUT_PER_M,
            outputPerMillion: parsed.data.OPENAI_COST_OUTPUT_PER_M,
          },
    nvidiaRates:
      parsed.data.NVIDIA_COST_INPUT_PER_M === undefined ||
      parsed.data.NVIDIA_COST_OUTPUT_PER_M === undefined
        ? undefined
        : {
            inputPerMillion: parsed.data.NVIDIA_COST_INPUT_PER_M,
            outputPerMillion: parsed.data.NVIDIA_COST_OUTPUT_PER_M,
          },
    logLevel: parsed.data.LOG_LEVEL,
    headless: parsed.data.HEADLESS,
    secrets: collectSecrets(source),
  });
}

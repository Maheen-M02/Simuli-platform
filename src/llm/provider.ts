import { createModelPlanner, type Planner, type PlannerStats } from '../agent/planner.ts';
import { createLlmClient, type LlmClient } from './client.ts';
import { createUsageMeter, type Rates, type UsageMeter } from './usage.ts';
import { err, ok, type Result } from '../types/shared.ts';

/**
 * Choosing which model drives the agent.
 *
 * A note on what was already true, because it changes what needed building. The
 * agent runtime never depended on OpenAI: `runLoop` takes a `Planner`, which is
 * `(input) => Promise<Result<Action, string>>` — exactly the
 * `generateAction(input)` shape a provider interface would define. The loop has
 * no idea what is behind it, and a scripted function has stood in for a model in
 * the test suite from the beginning.
 *
 * So this file is not a new abstraction over the agent. It is the missing piece
 * one level out: a way to *name* a provider, keep its quirks in one place, and
 * account for what it cost. Adding a plugin system on top of a function type
 * would be ceremony.
 *
 * The rule that makes the benchmark meaningful: the system prompt, the user
 * prompt and the action schema are identical across providers. Only transport
 * and request-shaping differ, and both live below this line.
 */

export const PROVIDER_IDS = ['openai', 'nvidia'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export type ProviderConfig = {
  readonly id: ProviderId;
  readonly apiKey: string;
  /** Undefined means the provider's default endpoint. */
  readonly baseUrl?: string | undefined;
  readonly model: string;
  /**
   * Cap on the reply.
   *
   * An action plus its reasoning is a few hundred tokens. Reserving more is not
   * free: a prepaid endpoint refuses the request outright and a metered one
   * bills for a budget that was never going to be used.
   */
  readonly maxOutputTokens: number;
  /** Per-million-token rates, when known. Never guessed. */
  readonly rates?: Rates | undefined;
  /** Provider-specific request fields. Must not change the prompt's meaning. */
  readonly extraBody?: Record<string, unknown> | undefined;
  readonly requireStructuredOutput?: boolean;
  readonly appTitle?: string | undefined;
  readonly appUrl?: string | undefined;
};

export type ModelProvider = {
  readonly id: ProviderId;
  readonly model: string;
  /**
   * The agent's whole view of the model. Same type whichever provider this is,
   * which is what lets the loop stay ignorant of the difference.
   */
  readonly planner: Planner;
  /** Shared with the evaluator when one is used, so cost is not double-counted. */
  readonly client: LlmClient;
  readonly usage: UsageMeter;
  /** Validation failures and recoveries, for the reliability comparison. */
  stats(): PlannerStats;
};

/** NVIDIA's OpenAI-compatible endpoint. */
export const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';

/**
 * Nemotron Ultra, as NVIDIA's catalogue names it.
 *
 * A default, not a hardcoding: `NVIDIA_MODEL` overrides it, because NVIDIA
 * renames and retires ids and a model that 404s should be a config change rather
 * than a code change. Verify any id with `npm run check:endpoint` before
 * spending a benchmark on it — the catalogue lists models that are not served to
 * a given account, and those 404 on use.
 */
export const DEFAULT_NVIDIA_MODEL = 'nvidia/llama-3.1-nemotron-ultra-253b-v1';

export const DEFAULT_OPENAI_MODEL = 'gpt-4.1';

export function createProvider(config: ProviderConfig): ModelProvider {
  const usage = createUsageMeter(config.rates);

  const client = createLlmClient(config.apiKey, {
    baseUrl: config.baseUrl,
    onUsage: (call) => usage.record(call),
    ...(config.extraBody === undefined ? {} : { extraBody: config.extraBody }),
    ...(config.requireStructuredOutput === undefined
      ? {}
      : { requireStructuredOutput: config.requireStructuredOutput }),
    appTitle: config.appTitle,
    appUrl: config.appUrl,
  });

  // Same planner, same prompt, same schema, same retry policy for both
  // providers. If one needs different treatment to work at all, that is a
  // finding about the provider and belongs in the report, not in a branch here.
  const planner = createModelPlanner({
    client,
    model: config.model,
    maxOutputTokens: config.maxOutputTokens,
  });

  return {
    id: config.id,
    model: config.model,
    planner: planner.planner,
    client,
    usage,
    stats: planner.stats,
  };
}

export type ProviderEnv = {
  readonly openaiApiKey: string;
  readonly openaiBaseUrl: string | undefined;
  readonly openaiModel: string;
  readonly nvidiaApiKey: string | undefined;
  readonly nvidiaModel: string;
  readonly maxOutputTokens: number;
  readonly requireStructuredOutput: boolean;
  readonly appTitle: string | undefined;
  readonly appUrl: string | undefined;
  readonly openaiRates: Rates | undefined;
  readonly nvidiaRates: Rates | undefined;
};

/**
 * Builds a provider by id, or explains what is missing.
 *
 * A missing key is returned as an error rather than thrown, so a benchmark can
 * report "NVIDIA was not configured" as a fact about the run instead of dying
 * halfway through and leaving the OpenAI half unattributable.
 */
export function providerFromEnv(id: ProviderId, env: ProviderEnv): Result<ModelProvider, string> {
  if (id === 'openai') {
    return ok(
      createProvider({
        id: 'openai',
        apiKey: env.openaiApiKey,
        baseUrl: env.openaiBaseUrl,
        model: env.openaiModel,
        maxOutputTokens: env.maxOutputTokens,
        rates: env.openaiRates,
        requireStructuredOutput: env.requireStructuredOutput,
        appTitle: env.appTitle,
        appUrl: env.appUrl,
      }),
    );
  }

  if (env.nvidiaApiKey === undefined || env.nvidiaApiKey === '') {
    return err(
      'NVIDIA_API_KEY is not set. Add it to .env to benchmark NVIDIA, or run with --model openai.',
    );
  }

  return ok(
    createProvider({
      id: 'nvidia',
      apiKey: env.nvidiaApiKey,
      baseUrl: NVIDIA_BASE_URL,
      model: env.nvidiaModel,
      maxOutputTokens: env.maxOutputTokens,
      rates: env.nvidiaRates,
      // NVIDIA's own endpoint serves one model per id, so there is nothing to
      // route around. The flag is for an aggregator.
      requireStructuredOutput: false,
    }),
  );
}

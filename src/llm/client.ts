import OpenAI from 'openai';
import { err, ok, type Result } from '../types/shared.ts';
import type { CallUsage } from './usage.ts';

/**
 * The one place model calls are made.
 *
 * Shared by the planner and the evaluator, which is why it does not live under
 * `agent/`. It knows nothing about personas, goals or friction — it takes
 * messages and a schema and returns parsed JSON or an error value.
 *
 * Failures are returned, never thrown. A model that is down or rate-limited is
 * an ordinary condition for a long-running agent, and it must become a recorded
 * step rather than an exception that ends a run with no evidence.
 *
 * `baseUrl` allows any OpenAI-compatible endpoint. One requirement is
 * non-negotiable: the endpoint must honour `response_format` with a strict
 * `json_schema`. Several compatible gateways accept that parameter and quietly
 * ignore it, returning prose with a 200 — measured on NVIDIA NIM, where
 * `meta/llama-3.2-11b-vision-instruct` does exactly this while
 * `openai/gpt-oss-120b` honours the schema correctly. A silent downgrade is
 * worse than a refusal, so `looksLikeIgnoredSchema` names it explicitly rather
 * than letting it surface as a generic parse failure.
 */

export type JsonRequest = {
  readonly model: string;
  readonly system: string;
  readonly user: string;
  /** Name for the schema, surfaced in the API request. */
  readonly schemaName: string;
  readonly jsonSchema: Record<string, unknown>;
  /** Low by default: we want the persona's judgment, not novelty for its own sake. */
  readonly temperature?: number;
  readonly maxRetries?: number;
  /**
   * Cap on the reply. Always sent.
   *
   * Left unset, some endpoints reserve the model's entire context window for
   * the completion — OpenRouter refuses the request outright on that basis, and
   * a metered endpoint would instead simply let a runaway reply bill for it. A
   * structured action or evaluation has a known rough size, so there is no
   * reason to leave the ceiling open.
   */
  readonly maxOutputTokens?: number;
};

export type LlmClient = {
  completeJson(request: JsonRequest): Promise<Result<unknown, string>>;
};

const DEFAULT_MAX_RETRIES = 2;

/**
 * Generous for one action or one evaluation, and far below any model's context.
 * Callers that need more say so; nothing gets an open-ended budget.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/** Transient conditions are worth another go; a bad request never is. */
function isRetryable(error: unknown): boolean {
  if (error instanceof OpenAI.APIError) {
    if (error.status === undefined) return true; // network-level
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return true;
}

/**
 * A non-JSON reply to a strict-schema request means the endpoint disregarded
 * the schema. Retrying cannot fix that, and the operator needs to know it is a
 * configuration problem rather than a flaky model.
 */
function looksLikeIgnoredSchema(content: string): boolean {
  const trimmed = content.trim();
  return trimmed !== '' && !trimmed.startsWith('{') && !trimmed.startsWith('[');
}

export type ClientOptions = {
  readonly baseUrl?: string | undefined;
  /**
   * Send `provider.require_parameters`. Only meaningful on an aggregator, which
   * may serve one model id from several upstream providers whose
   * structured-output support differs. Off by default: OpenAI itself rejects
   * request fields it does not recognise.
   */
  readonly requireStructuredOutput?: boolean;
  readonly appTitle?: string | undefined;
  readonly appUrl?: string | undefined;
  /**
   * Called after every attempt, successful or not.
   *
   * Additive instrumentation: without it the client behaves exactly as before,
   * which is what keeps the existing baseline comparable. Never receives the
   * key, the prompt or the reply — only counts and timings.
   */
  readonly onUsage?: (usage: CallUsage) => void;
  /**
   * Extra request fields, for a provider whose structured output needs them.
   *
   * Deliberately opaque and not interpreted here: provider quirks belong in the
   * provider, and the semantic prompt must stay identical across providers or
   * the comparison measures two experiments at once.
   */
  readonly extraBody?: Record<string, unknown>;
};

export function createLlmClient(apiKey: string, options: ClientOptions = {}): LlmClient {
  // Attribution headers are OpenRouter's convention; other endpoints ignore them.
  const headers: Record<string, string> = {};
  if (options.appTitle !== undefined) headers['X-Title'] = options.appTitle;
  if (options.appUrl !== undefined) headers['HTTP-Referer'] = options.appUrl;

  const client = new OpenAI({
    apiKey,
    ...(options.baseUrl === undefined ? {} : { baseURL: options.baseUrl }),
    ...(Object.keys(headers).length === 0 ? {} : { defaultHeaders: headers }),
  });

  return {
    async completeJson(request) {
      const attempts = (request.maxRetries ?? DEFAULT_MAX_RETRIES) + 1;
      let lastError = 'The model call failed.';

      for (let attempt = 0; attempt < attempts; attempt++) {
        const startedAt = Date.now();
        try {
          const response = await client.chat.completions.create({
            model: request.model,
            temperature: request.temperature ?? 0.4,
            max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
            // Not part of the OpenAI API. An aggregator reads it and declines to
            // route us to a provider that cannot honour the schema we sent —
            // which is the difference between a loud failure and a silent
            // downgrade to prose.
            ...(options.requireStructuredOutput === true
              ? { provider: { require_parameters: true } }
              : {}),
            ...(options.extraBody ?? {}),
            messages: [
              { role: 'system', content: request.system },
              { role: 'user', content: request.user },
            ],
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: request.schemaName,
                strict: true,
                schema: request.jsonSchema,
              },
            },
          });

          const reported = (
            response as { usage?: { prompt_tokens?: number; completion_tokens?: number } }
          ).usage;
          options.onUsage?.({
            inputTokens: reported?.prompt_tokens ?? null,
            outputTokens: reported?.completion_tokens ?? null,
            latencyMs: Date.now() - startedAt,
            ok: true,
          });

          const choice = response.choices[0];
          if (choice?.finish_reason === 'length') {
            lastError = 'The model ran out of room before finishing its answer.';
            continue;
          }
          if (choice?.message.refusal != null) {
            // A refusal is a real answer, not a transport failure. Retrying it
            // would just spend money to be refused again.
            return err(`The model declined to answer: ${choice.message.refusal}`);
          }

          const content = choice?.message.content;
          if (content == null || content === '') {
            lastError = 'The model returned an empty response.';
            continue;
          }

          try {
            return ok(JSON.parse(content));
          } catch {
            if (looksLikeIgnoredSchema(content)) {
              return err(
                `The endpoint ignored the requested JSON schema and replied with prose. ` +
                  `Model "${request.model}" cannot be used for this: pick one that supports ` +
                  'strict structured output.',
              );
            }
            lastError = 'The model returned something that was not valid JSON.';
            continue;
          }
        } catch (caught) {
          // A failed call still consumed time, and on some endpoints tokens.
          // Dropping it would understate the cost of an unreliable provider.
          options.onUsage?.({
            inputTokens: null,
            outputTokens: null,
            latencyMs: Date.now() - startedAt,
            ok: false,
          });
          lastError = caught instanceof Error ? caught.message : String(caught);
          if (!isRetryable(caught)) return err(lastError);
        }
      }

      return err(lastError);
    },
  };
}

import OpenAI from 'openai';
import { err, ok, type Result } from '../types/shared.ts';

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
};

export type LlmClient = {
  completeJson(request: JsonRequest): Promise<Result<unknown, string>>;
};

const DEFAULT_MAX_RETRIES = 2;

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

export function createLlmClient(apiKey: string, baseUrl?: string): LlmClient {
  const client = new OpenAI({ apiKey, ...(baseUrl === undefined ? {} : { baseURL: baseUrl }) });

  return {
    async completeJson(request) {
      const attempts = (request.maxRetries ?? DEFAULT_MAX_RETRIES) + 1;
      let lastError = 'The model call failed.';

      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          const response = await client.chat.completions.create({
            model: request.model,
            temperature: request.temperature ?? 0.4,
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
          lastError = caught instanceof Error ? caught.message : String(caught);
          if (!isRetryable(caught)) return err(lastError);
        }
      }

      return err(lastError);
    },
  };
}

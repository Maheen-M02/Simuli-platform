/**
 * DEVELOPMENT TOOL — not part of the product.
 *
 * Checks that a model on the configured endpoint can actually do the one thing
 * this system cannot work without: honour a strict `json_schema`.
 *
 *   npm run check:endpoint -- --model openai/gpt-4.1
 *   npm run check:endpoint -- --model x/y --which evaluator
 *
 * Run this before pointing a real simulation at a new model. It sends the real
 * action schema, one request, and reports one of three things:
 *
 *   HONOURED  the reply parsed and validated. Usable.
 *   IGNORED   the endpoint accepted response_format and replied with prose.
 *             This is the dangerous case: HTTP 200, no error, unusable output.
 *             Measured on NVIDIA NIM with meta/llama-3.2-*. An aggregator can
 *             do it too, by routing to a provider that lacks the feature.
 *   ERROR     the request failed outright, which at least fails loudly.
 *
 * A model that is IGNORED cannot be fixed by prompting. Choose another.
 */

import { parseArgs } from 'node:util';
import { loadDotEnv, readEnv } from '../src/config/env.ts';
import { createLlmClient } from '../src/llm/client.ts';
import { ACTION_JSON_SCHEMA } from '../src/agent/prompt.ts';
import { ActionSchema } from '../src/actions/schema.ts';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    model: { type: 'string' },
    which: { type: 'string' },
  },
});

loadDotEnv();
const env = readEnv();
if (!env.ok) {
  process.stderr.write(`${env.error}\n`);
  process.exit(64);
}

const model =
  values.model ?? (values.which === 'evaluator' ? env.value.evaluatorModel : env.value.plannerModel);

const client = createLlmClient(env.value.openaiApiKey, {
  baseUrl: env.value.openaiBaseUrl,
  requireStructuredOutput: env.value.requireStructuredOutput,
  appTitle: env.value.appTitle,
  appUrl: env.value.appUrl,
});

process.stdout.write(
  `endpoint: ${env.value.openaiBaseUrl ?? 'https://api.openai.com/v1 (default)'}\n` +
    `model:    ${model}\n` +
    `require_parameters: ${env.value.requireStructuredOutput ? 'on' : 'off'}\n\n`,
);

const response = await client.completeJson({
  model,
  system:
    'You are Sam, a small business owner creating an account. You may only act on ' +
    'elements listed, using their refs such as e12.',
  user: [
    'URL: http://site.test/signup',
    'Title: Sign up',
    '',
    'textbox "Work email" [e2]',
    'password "Password" [e3]',
    'button "Create account" [e4]',
    '',
    'What do you do next?',
  ].join('\n'),
  schemaName: 'customer_action',
  jsonSchema: ACTION_JSON_SCHEMA as unknown as Record<string, unknown>,
  maxRetries: 0,
});

if (!response.ok) {
  // The client already distinguishes a silent downgrade from a transport error.
  const ignored = response.error.includes('ignored the requested JSON schema');
  process.stdout.write(`${ignored ? 'IGNORED' : 'ERROR'}: ${response.error}\n`);
  process.exit(1);
}

const envelope = response.value;
const decision =
  envelope !== null && typeof envelope === 'object' && 'decision' in envelope
    ? (envelope as { decision: unknown }).decision
    : envelope;

const parsed = ActionSchema.safeParse(decision);

if (parsed.success) {
  process.stdout.write(`HONOURED: ${JSON.stringify(parsed.data)}\n\nThis model is usable.\n`);
  process.exit(0);
}

// Valid JSON that does not match our schema is a weaker failure than prose, but
// still means the model cannot be relied on to produce actions.
process.stdout.write(
  `SCHEMA MISMATCH: the reply was JSON but did not validate.\n` +
    `${parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')}\n\n` +
    `Received: ${JSON.stringify(decision).slice(0, 400)}\n`,
);
process.exit(1);

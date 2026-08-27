/**
 * Re-judge an already-recorded session with the current evaluator.
 *
 *   npx tsx scripts/reevaluate.ts <session-id>
 *
 * No browser, no new simulation, no cost beyond one model call — the evaluator
 * reads only the persisted record. This is how evaluator changes get measured:
 * run it over sessions whose findings a human has already agreed or disagreed
 * with, and the agreement rate is the number the business actually turns on.
 *
 * An addition beyond the agreed V0 structure. It is a script, not a feature.
 */
import { openDb } from '../src/persistence/db.ts';
import { evaluateSession } from '../src/evaluation/evaluator.ts';
import { createLlmClient } from '../src/llm/client.ts';
import { loadDotEnv, readEnv } from '../src/config/env.ts';
import { renderEvaluation, renderRecord, setColorEnabled } from '../src/cli/render.ts';

loadDotEnv();
const env = readEnv();
if (!env.ok) throw new Error(env.error);

setColorEnabled(process.stdout.isTTY === true);

const db = openDb('data/sessions.db');
const record = db.loadSession(process.argv[2] ?? '');
if (record === null) throw new Error('no such session');

const result = await evaluateSession(record, {
  client: createLlmClient(env.value.openaiApiKey, {
    baseUrl: env.value.openaiBaseUrl,
    requireStructuredOutput: env.value.requireStructuredOutput,
    appTitle: env.value.appTitle,
    appUrl: env.value.appUrl,
  }),
  model: process.argv[3] ?? env.value.evaluatorModel,
  // Third argument caps the reply, for a thin prepaid balance.
  ...(process.argv[4] === undefined ? {} : { maxOutputTokens: Number(process.argv[4]) }),
  onRejectedFindings: (f) => console.log(`(discarded ${f.length} uncitable)`),
});

if (!result.ok) {
  process.stdout.write(`FAILED: ${result.error}\n`);
} else {
  // Reuses the product renderer, so what this prints is exactly what a run
  // prints — including the verdict caveat. A second formatter here would be a
  // second place for the caveat to go missing.
  process.stdout.write(`${renderRecord(record)}\n`);
  process.stdout.write(`${renderEvaluation(result.value)}\n`);
}
db.close();

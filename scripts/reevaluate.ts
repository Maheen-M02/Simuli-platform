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
import { openDb } from './src/persistence/db.ts';
import { evaluateSession } from './src/evaluation/evaluator.ts';
import { createLlmClient } from './src/llm/client.ts';
import { loadDotEnv, readEnv } from './src/config/env.ts';

loadDotEnv();
const env = readEnv();
if (!env.ok) throw new Error(env.error);

const db = openDb('data/sessions.db');
const record = db.loadSession(process.argv[2] ?? '');
if (record === null) throw new Error('no such session');

const result = await evaluateSession(record, {
  client: createLlmClient(env.value.openaiApiKey, env.value.openaiBaseUrl),
  model: 'openai/gpt-oss-20b',
  onRejectedFindings: (f) => console.log(`(discarded ${f.length} uncitable)`),
});

if (!result.ok) {
  console.log('FAILED:', result.error);
} else {
  console.log('goalAchieved:', result.value.goalAchieved);
  for (const f of result.value.findings) {
    console.log(`\n[${f.severity}] ${f.attribution}\n  ${f.title}\n  steps ${f.stepRefs.join(', ')}`);
  }
  const p = result.value.findings.filter((f) => f.attribution === 'PRODUCT_FRICTION').length;
  console.log(`\n${p} product / ${result.value.findings.length - p} ours`);
}
db.close();

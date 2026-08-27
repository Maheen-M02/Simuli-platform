/**
 * DEVELOPMENT / EVALUATION TOOL — not part of the product.
 *
 * Runs the evaluator against the golden dataset and reports how well it
 * classifies product issues.
 *
 *   npx tsx scripts/evaluate-golden.ts [--model <id>] [--json] [--scenario <id>]
 *
 * No browser is launched: every scenario is a hand-authored session record, so
 * the only variable between runs is the evaluator itself. It does call the
 * model, once per scenario, which is why this lives here and not in `npm test`.
 *
 * The numbers this prints are the only basis on which we may claim the
 * evaluator is trustworthy. Do not quote a target as met unless this says so.
 */

import { parseArgs } from 'node:util';
import { loadDotEnv, readEnv } from '../src/config/env.ts';
import { evaluateSession } from '../src/evaluation/evaluator.ts';
import { productIssues } from '../src/evaluation/schema.ts';
import { createLlmClient } from '../src/llm/client.ts';
import {
  formatMetrics,
  scoreProductIssueDetection,
  type ScenarioPrediction,
} from '../src/evaluation/metrics.ts';
import { GOLDEN_SCENARIOS } from '../tests/fixtures/golden/scenarios.ts';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    model: { type: 'string' },
    scenario: { type: 'string' },
    json: { type: 'boolean' },
    'max-tokens': { type: 'string' },
  },
});

loadDotEnv();
const env = readEnv();
if (!env.ok) {
  process.stderr.write(`${env.error}\n`);
  process.exit(64);
}

const model = values.model ?? env.value.evaluatorModel;
const client = createLlmClient(env.value.openaiApiKey, {
    baseUrl: env.value.openaiBaseUrl,
    requireStructuredOutput: env.value.requireStructuredOutput,
    appTitle: env.value.appTitle,
    appUrl: env.value.appUrl,
  });
const scenarios =
  values.scenario === undefined
    ? GOLDEN_SCENARIOS
    : GOLDEN_SCENARIOS.filter((s) => s.id === values.scenario);

if (scenarios.length === 0) {
  process.stderr.write(`No scenario matched "${values.scenario ?? ''}".\n`);
  process.exit(64);
}

type Row = ScenarioPrediction & {
  readonly category: string;
  readonly expected: string;
  readonly produced: readonly string[];
  readonly policyActions: number;
  /**
   * Why the policy overrode the model. Essential when diagnosing a false
   * negative: a genuine finding lost to our own enforcement is a very
   * different problem from one the model never made.
   */
  readonly policyReasons: readonly string[];
  /** How many fact ids the model cited, to spot a model that cites none. */
  readonly citedFacts: number;
};

const rows: Row[] = [];

for (const scenario of scenarios) {
  const result = await evaluateSession(scenario.record, {
    client,
    model,
    ...(values['max-tokens'] === undefined
      ? {}
      : { maxOutputTokens: Number(values['max-tokens']) }),
  });

  if (!result.ok) {
    rows.push({
      scenarioId: scenario.id,
      category: scenario.category,
      expected: scenario.expected,
      expectProductIssue: scenario.expectProductIssue,
      predictedProductIssue: false,
      produced: [],
      policyActions: 0,
      policyReasons: [],
      citedFacts: 0,
      error: result.error,
    });
    if (values.json !== true) process.stdout.write(`  ${scenario.id}: ERRORED — ${result.error}\n`);
    continue;
  }

  const products = productIssues(result.value);
  const row: Row = {
    scenarioId: scenario.id,
    category: scenario.category,
    expected: scenario.expected,
    expectProductIssue: scenario.expectProductIssue,
    predictedProductIssue: products.length > 0,
    produced: result.value.findings.map((f) => `${f.classification}: ${f.finding}`),
    policyActions: result.value.policyActions.length,
    policyReasons: result.value.policyActions.map((a) => `${a.from} -> ${a.to}: ${a.reason}`),
    citedFacts: result.value.findings.reduce((total, f) => total + f.evidenceRefs.length, 0),
  };
  rows.push(row);

  if (values.json !== true) {
    const correct = row.expectProductIssue === row.predictedProductIssue;
    const verdict = correct ? 'ok  ' : row.predictedProductIssue ? 'FALSE POS' : 'FALSE NEG';
    process.stdout.write(
      `  ${verdict.padEnd(10)} ${scenario.id.padEnd(32)} expected ${scenario.expected.padEnd(23)} ` +
        `produced ${row.produced.length} finding(s)${row.policyActions > 0 ? `, ${row.policyActions} reclassified` : ''}\n`,
    );
  }
}

const metrics = scoreProductIssueDetection(rows);

if (values.json === true) {
  process.stdout.write(`${JSON.stringify({ model, metrics, rows }, null, 2)}\n`);
} else {
  process.stdout.write(`\nModel: ${model}\n\n${formatMetrics(metrics)}\n`);

  const wrong = rows.filter(
    (row) => row.error === undefined && row.expectProductIssue !== row.predictedProductIssue,
  );
  if (wrong.length > 0) {
    process.stdout.write('\nMisclassified:\n');
    for (const row of wrong) {
      process.stdout.write(`\n  ${row.scenarioId} (${row.category}) — expected ${row.expected}\n`);
      for (const produced of row.produced) process.stdout.write(`    produced: ${produced}\n`);
      if (row.produced.length === 0) process.stdout.write('    produced: nothing\n');
      // Distinguishes a miss the model made from one our own policy imposed.
      process.stdout.write(`    fact ids cited: ${row.citedFacts}\n`);
      for (const reason of row.policyReasons) process.stdout.write(`    policy: ${reason}\n`);
    }
  }
}

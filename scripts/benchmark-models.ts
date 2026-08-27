/**
 * DEVELOPMENT / VALIDATION TOOL — not part of the product.
 *
 * Runs the same simulations on two model providers and compares them.
 *
 *   npm run benchmark:models -- --model both
 *   npm run benchmark:models -- --model nvidia --tasks find-pricing
 *   npm run benchmark:models -- --model openai --out docs/bench-openai.json
 *
 * What is held constant, and why it matters: the target, the personas, the
 * goals, the browser configuration, the observation layer, the action schema,
 * the termination rules, the prompt and the evaluator. The only intended
 * variable is which provider answers the planner. If two things vary, the
 * numbers describe neither.
 *
 * The evaluator is pinned to OpenAI for every arm. Letting it follow the planner
 * would mean the NVIDIA arm was judged by a different judge, and the findings
 * would not be comparable — which is the whole point of the exercise.
 *
 * Insufficient credit is reported, never absorbed. A provider outage is counted
 * separately from agent behaviour, because an unbilled account is not a bad
 * model.
 */

import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { loadDotEnv, readEnv } from '../src/config/env.ts';
import { RunConfigSchema } from '../src/config/runConfig.ts';
import { silentLogger } from '../src/logging/logger.ts';
import { runSimulation } from '../src/runSimulation.ts';
import { createLlmClient } from '../src/llm/client.ts';
import { providerFromEnv, PROVIDER_IDS, type ProviderId } from '../src/llm/provider.ts';
import {
  buildProviderReport,
  classifyRun,
  formatComparison,
  type BenchmarkRun,
  type ProviderReport,
} from '../src/validation/benchmark.ts';
import { scoreAgainstGroundTruth } from '../src/validation/groundTruth.ts';
import { startFreightFlow } from '../fixtures/freightflow/server.ts';
import { personaById } from '../fixtures/freightflow/personas.ts';
import { taskById } from '../fixtures/freightflow/tasks.ts';
import { groundTruthFor } from './targets.ts';
import type { CustomerContext } from '../src/personas/context.ts';

/** The controlled set. Three personas, three tasks, nine per provider. */
const DEFAULT_PERSONAS = ['first-time-owner', 'finance-manager', 'technical-power-user'] as const;
const DEFAULT_TASKS = ['create-first-invoice', 'find-pricing', 'add-customer'] as const;

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    model: { type: 'string', default: 'both' },
    target: { type: 'string', default: 'freightflow' },
    personas: { type: 'string' },
    tasks: { type: 'string' },
    'max-steps': { type: 'string' },
    timeout: { type: 'string' },
    out: { type: 'string' },
    json: { type: 'boolean' },
  },
});

const requested: ProviderId[] =
  values.model === 'both'
    ? [...PROVIDER_IDS]
    : PROVIDER_IDS.includes(values.model as ProviderId)
      ? [values.model as ProviderId]
      : [];

if (requested.length === 0) {
  process.stderr.write(`--model must be one of: ${[...PROVIDER_IDS, 'both'].join(', ')}\n`);
  process.exit(64);
}

if (values.target !== 'freightflow') {
  process.stderr.write(`Only the freightflow target is supported. Got "${values.target}".\n`);
  process.exit(64);
}

loadDotEnv();
const env = readEnv();
if (!env.ok) {
  process.stderr.write(`${env.error}\n`);
  process.exit(64);
}

const personaIds = values.personas === undefined ? [...DEFAULT_PERSONAS] : values.personas.split(',');
const taskIds = values.tasks === undefined ? [...DEFAULT_TASKS] : values.tasks.split(',');

const contexts = new Map<string, CustomerContext>();
for (const id of personaIds) {
  const persona = personaById(id);
  if (persona === undefined) {
    process.stderr.write(`Unknown persona "${id}".\n`);
    process.exit(64);
  }
  contexts.set(id, persona.context);
}
for (const id of taskIds) {
  if (taskById(id) === undefined) {
    process.stderr.write(`Unknown task "${id}".\n`);
    process.exit(64);
  }
}

// One evaluator for every arm, always OpenAI. This is the fairness control.
const evaluatorClient = createLlmClient(env.value.openaiApiKey, {
  baseUrl: env.value.openaiBaseUrl,
  requireStructuredOutput: env.value.requireStructuredOutput,
  appTitle: env.value.appTitle,
  appUrl: env.value.appUrl,
});

const groundTruth = groundTruthFor(values.target);
const reports: ProviderReport[] = [];
const skipped: { readonly providerId: string; readonly reason: string }[] = [];
const allRuns: BenchmarkRun[] = [];

process.stdout.write(
  `\nModel benchmark\n` +
    `  target     ${values.target}\n` +
    `  personas   ${personaIds.join(', ')}\n` +
    `  tasks      ${taskIds.join(', ')}\n` +
    `  providers  ${requested.join(', ')}\n` +
    `  per arm    ${personaIds.length * taskIds.length} simulations\n` +
    `  evaluator  ${env.value.evaluatorModel} (identical for every arm)\n` +
    `  max output ${env.value.plannerMaxOutputTokens} tokens per action\n\n`,
);

for (const providerId of requested) {
  const provider = providerFromEnv(providerId, {
    openaiApiKey: env.value.openaiApiKey,
    openaiBaseUrl: env.value.openaiBaseUrl,
    openaiModel: env.value.plannerModel,
    nvidiaApiKey: env.value.nvidiaApiKey,
    nvidiaModel: env.value.nvidiaModel,
    maxOutputTokens: env.value.plannerMaxOutputTokens,
    requireStructuredOutput: env.value.requireStructuredOutput,
    appTitle: env.value.appTitle,
    appUrl: env.value.appUrl,
    openaiRates: env.value.openaiRates,
    nvidiaRates: env.value.nvidiaRates,
  });

  if (!provider.ok) {
    // Recorded as a fact about the run rather than a silent omission.
    skipped.push({ providerId, reason: provider.error });
    process.stdout.write(`  ${providerId}: SKIPPED — ${provider.error}\n\n`);
    continue;
  }

  const runs: BenchmarkRun[] = [];
  process.stdout.write(`  ${providerId} (${provider.value.model})\n`);

  for (const personaId of personaIds) {
    for (const taskId of taskIds) {
      const persona = personaById(personaId);
      const task = taskById(taskId);
      if (persona === undefined || task === undefined) continue;

      // A fresh application per simulation. Sharing one would let an earlier
      // run's shipments change what a later one sees, and then a difference
      // between arms could be caused by ordering rather than by the model.
      const site = await startFreightFlow();

      const config = RunConfigSchema.safeParse({
        startUrl: `${site.url}${task.startPath}`,
        goal: task.goal,
        context: persona.context,
        limits: {
          maxSteps: values['max-steps'] === undefined ? 30 : Number(values['max-steps']),
          wallClockMs: (values.timeout === undefined ? 600 : Number(values.timeout)) * 1000,
        },
        dataDir: 'data',
        headless: true,
        screenshots: true,
        blockDestructive: true,
        evaluate: true,
      });

      if (!config.success) {
        await site.close();
        continue;
      }

      const startedAt = Date.now();
      const result = await runSimulation(config.data, {
        env: env.value,
        logger: silentLogger(),
        planner: provider.value.planner,
        llmClient: provider.value.client,
        evaluatorClient,
      });
      const wallClockMs = Date.now() - startedAt;
      await site.close();

      const scored =
        groundTruth !== null && result.evaluation !== null
          ? scoreAgainstGroundTruth({
              taskId,
              personaId,
              record: result.record,
              evaluation: result.evaluation,
              groundTruth,
            })
          : null;

      const run: BenchmarkRun = {
        providerId,
        model: provider.value.model,
        personaId,
        taskId,
        record: result.record,
        evaluation: result.evaluation,
        evaluationError: result.evaluationError,
        groundTruth: scored,
        wallClockMs,
      };
      runs.push(run);
      allRuns.push(run);

      const status = classifyRun(result.record);
      process.stdout.write(
        `    ${personaId.padEnd(22)} ${taskId.padEnd(22)} ${status.padEnd(18)} ` +
          `${String(result.record.steps.length).padStart(3)} steps  ${Math.round(wallClockMs / 1000)}s` +
          `${result.evaluation === null ? '  (no report)' : ''}\n`,
      );
    }
  }

  reports.push(
    buildProviderReport({
      providerId,
      model: provider.value.model,
      runs,
      stats: provider.value.stats(),
      usage: provider.value.usage.totals(),
      contexts,
    }),
  );
  process.stdout.write('\n');
}

if (values.json === true) {
  process.stdout.write(`${JSON.stringify({ reports, skipped }, null, 2)}\n`);
} else {
  process.stdout.write(`${formatComparison(reports)}\n`);
  if (skipped.length > 0) {
    process.stdout.write('\n  Providers not benchmarked:\n');
    for (const entry of skipped) {
      process.stdout.write(`    ${entry.providerId}: ${entry.reason}\n`);
    }
  }
  process.stdout.write(
    '\n  Simulated customers, not people. Nothing here is evidence about how a real\n' +
      '  person would behave.\n',
  );
}

if (values.out !== undefined) {
  writeFileSync(
    values.out,
    `${JSON.stringify(
      {
        target: values.target,
        personas: personaIds,
        tasks: taskIds,
        evaluatorModel: env.value.evaluatorModel,
        maxOutputTokens: env.value.plannerMaxOutputTokens,
        reports,
        skipped,
        runs: allRuns.map((run) => ({
          providerId: run.providerId,
          model: run.model,
          personaId: run.personaId,
          taskId: run.taskId,
          sessionId: run.record.id,
          status: classifyRun(run.record),
          steps: run.record.steps.length,
          wallClockMs: run.wallClockMs,
          evaluationError: run.evaluationError,
        })),
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`\n  Written to ${values.out}\n`);
}

// A benchmark where nothing ran is a failure of the benchmark, not a result.
const anyScorable = reports.some((report) => report.reliability.scorable > 0);
process.exit(anyScorable ? 0 : 1);

/**
 * DEVELOPMENT / VALIDATION TOOL — not part of the product.
 *
 * Runs several personas against one task and compares what they did.
 *
 *   npm run compare -- --target freightflow --goal create-first-invoice
 *   npm run compare -- --target freightflow --goal find-billing --personas skeptical-buyer,operations-manager
 *
 * This is the actual experiment. One run shows the agent can use a product;
 * several materially different customers on the same task show whether the
 * persona changes anything — which is the claim worth testing before anything
 * else gets built.
 *
 * Runs are sequential and each gets a fresh target instance, so no run inherits
 * another's data. Slower, but a difference between personas has to be caused by
 * the persona or it is not a finding.
 */

import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { loadDotEnv, readEnv } from '../src/config/env.ts';
import { RunConfigSchema } from '../src/config/runConfig.ts';
import { silentLogger } from '../src/logging/logger.ts';
import { runSimulation } from '../src/runSimulation.ts';
import { buildComparison, formatComparison, type PersonaRun } from '../src/validation/comparison.ts';
import {
  formatGroundTruth,
  scoreAgainstGroundTruth,
  totalGroundTruth,
  type GroundTruthReport,
} from '../src/validation/groundTruth.ts';
import { setColorEnabled } from '../src/cli/render.ts';
import { groundTruthFor, openTargetForComparison, TARGET_IDS } from './targets.ts';
import { startFreightFlow } from '../fixtures/freightflow/server.ts';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    target: { type: 'string' },
    goal: { type: 'string' },
    personas: { type: 'string' },
    'max-steps': { type: 'string' },
    timeout: { type: 'string' },
    out: { type: 'string' },
    json: { type: 'boolean' },
  },
});

if (values.target === undefined || values.goal === undefined) {
  process.stderr.write(
    'Usage: npm run compare -- --target <id> --goal <id> [--personas a,b,c] [--out report.json]\n' +
      `Targets: ${TARGET_IDS.join(', ')}\n`,
  );
  process.exit(64);
}

loadDotEnv();
const env = readEnv();
if (!env.ok) {
  process.stderr.write(`${env.error}\n`);
  process.exit(64);
}

const selection = await openTargetForComparison(
  values.target,
  undefined,
  values.goal,
  values.personas === undefined ? [] : values.personas.split(',').map((id) => id.trim()),
);
if (!selection.ok) {
  process.stderr.write(`${selection.error}\n`);
  process.exit(64);
}
// Only the task and persona list are wanted here; each run gets its own site.
await selection.value.close();

const { task, personas } = selection.value;
setColorEnabled(values.json !== true && process.stdout.isTTY === true);

if (values.json !== true) {
  process.stdout.write(
    `\nComparison run\n` +
      `  Target   ${values.target}\n` +
      `  Task     ${task.id} — ${task.label}\n` +
      `  Personas ${personas.map((p) => p.id).join(', ')}\n\n`,
  );
}

const runs: PersonaRun[] = [];
const groundTruthReports: GroundTruthReport[] = [];
const groundTruth = groundTruthFor(values.target);

for (const persona of personas) {
  // A fresh instance per persona. Sharing one would let an earlier persona's
  // shipments and invoices change what a later one sees.
  const site = await startFreightFlow();

  const config = RunConfigSchema.safeParse({
    startUrl: `${site.url}${task.startPath}`,
    goal: task.goal,
    context: persona.context,
    limits: {
      maxSteps: values['max-steps'] === undefined ? 40 : Number(values['max-steps']),
      wallClockMs: (values.timeout === undefined ? 900 : Number(values.timeout)) * 1000,
    },
    dataDir: 'data',
    headless: true,
    screenshots: true,
    blockDestructive: true,
    evaluate: true,
  });

  if (!config.success) {
    process.stderr.write(`Invalid configuration for ${persona.id}\n`);
    await site.close();
    continue;
  }

  if (values.json !== true) process.stdout.write(`  running ${persona.id} ... `);

  const result = await runSimulation(config.data, { env: env.value, logger: silentLogger() });
  await site.close();

  if (values.json !== true) {
    process.stdout.write(
      `${result.record.outcome} in ${result.record.steps.length} steps` +
        `${result.evaluation === null ? ' (no report)' : ''}\n`,
    );
  }

  runs.push({
    personaId: persona.id,
    personaLabel: persona.label,
    record: result.record,
    evaluation: result.evaluation,
    evaluationError: result.evaluationError,
  });

  if (groundTruth !== null && result.evaluation !== null) {
    groundTruthReports.push(
      scoreAgainstGroundTruth({
        taskId: task.id,
        personaId: persona.id,
        record: result.record,
        evaluation: result.evaluation,
        groundTruth,
      }),
    );
  }
}

const { rows, paths } = buildComparison(runs);
const totals = totalGroundTruth(groundTruthReports);

if (values.json === true) {
  process.stdout.write(
    `${JSON.stringify({ target: values.target, taskId: task.id, rows, groundTruth: { reports: groundTruthReports, totals } }, null, 2)}\n`,
  );
} else {
  process.stdout.write(`${formatComparison({ taskId: task.id, taskLabel: task.label, rows, paths })}\n`);
  if (groundTruthReports.length > 0) {
    process.stdout.write(`\n${formatGroundTruth(groundTruthReports, totals)}\n`);
  } else {
    process.stdout.write(
      '\nNo evaluations were produced, so nothing could be scored against ground truth.\n',
    );
  }
}

if (values.out !== undefined) {
  writeFileSync(
    values.out,
    `${JSON.stringify({ target: values.target, taskId: task.id, rows, groundTruth: { reports: groundTruthReports, totals } }, null, 2)}\n`,
  );
  if (values.json !== true) process.stdout.write(`\nWritten to ${values.out}\n`);
}

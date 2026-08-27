/**
 * DEVELOPMENT / VALIDATION TOOL — not part of the product.
 *
 * Runs one persona against one task on a local evaluation target.
 *
 *   npm run simulate -- --target freightflow --persona first-time-owner --goal create-first-invoice
 *   npm run simulate -- --target freightflow --persona skeptical-buyer --goal find-billing --headed
 *
 * The target is started in-process and stopped afterwards, so runs cannot
 * inherit state from each other — two runs of the same persona must see the
 * same application or a difference between personas means nothing. Point at an
 * already-running instance with `--url` if you want to watch it in a browser.
 *
 * Nothing here bypasses the agent: it builds a RunConfig and calls the same
 * `runSimulation()` the CLI does. The fixture is reached only over HTTP.
 */

import { parseArgs } from 'node:util';
import { loadDotEnv, readEnv } from '../src/config/env.ts';
import { RunConfigSchema } from '../src/config/runConfig.ts';
import { createLogger } from '../src/logging/logger.ts';
import { createRedactor } from '../src/observations/redact.ts';
import { runSimulation } from '../src/runSimulation.ts';
import { renderEvaluation, renderFooter, renderRecord, renderSteps, setColorEnabled } from '../src/cli/render.ts';
import { openTarget, TARGET_IDS } from './targets.ts';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    target: { type: 'string' },
    persona: { type: 'string' },
    goal: { type: 'string' },
    url: { type: 'string' },
    headed: { type: 'boolean' },
    steps: { type: 'boolean', default: true },
    json: { type: 'boolean' },
    'max-steps': { type: 'string' },
    timeout: { type: 'string' },
  },
});

if (values.target === undefined || values.persona === undefined || values.goal === undefined) {
  process.stderr.write(
    'Usage: npm run simulate -- --target <id> --persona <id> --goal <id> [--url <url>] [--headed]\n' +
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

const target = await openTarget({
  targetId: values.target,
  url: values.url,
  personaId: values.persona,
  taskId: values.goal,
});
if (!target.ok) {
  process.stderr.write(`${target.error}\n`);
  process.exit(64);
}

const { persona, task, baseUrl, close } = target.value;

setColorEnabled(values.json !== true && process.stdout.isTTY === true);

const config = RunConfigSchema.safeParse({
  startUrl: `${baseUrl}${task.startPath}`,
  goal: task.goal,
  context: persona.context,
  limits: {
    maxSteps: values['max-steps'] === undefined ? 40 : Number(values['max-steps']),
    wallClockMs: (values.timeout === undefined ? 900 : Number(values.timeout)) * 1000,
  },
  dataDir: 'data',
  headless: values.headed !== true,
  screenshots: true,
  blockDestructive: true,
  evaluate: true,
});

if (!config.success) {
  const issues = config.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  process.stderr.write(`Invalid run configuration:\n${issues}\n`);
  await close();
  process.exit(64);
}

if (values.json !== true) {
  process.stdout.write(
    `\nSimulation\n` +
      `  Target   ${values.target} at ${baseUrl}\n` +
      `  Persona  ${persona.id} — ${persona.label}\n` +
      `  Task     ${task.id} — ${task.label}\n` +
      `  Goal     ${task.goal.description}\n\n`,
  );
}

const logger = createLogger({
  level: env.value.logLevel,
  redact: createRedactor(env.value.secrets),
  pretty: values.json !== true,
});

const result = await runSimulation(config.data, { env: env.value, logger });
await close();

if (values.json === true) {
  process.stdout.write(
    `${JSON.stringify(
      {
        target: values.target,
        personaId: persona.id,
        taskId: task.id,
        sessionId: result.sessionId,
        outcome: result.record.outcome,
        terminationReason: result.record.terminationReason,
        steps: result.record.steps.length,
        evaluation: result.evaluation,
        evaluationError: result.evaluationError,
      },
      null,
      2,
    )}\n`,
  );
} else {
  process.stdout.write(`${renderRecord(result.record)}\n`);
  if (values.steps !== false) process.stdout.write(`${renderSteps(result.record)}\n`);
  if (result.evaluation !== null) {
    process.stdout.write(`${renderEvaluation(result.evaluation)}\n`);
  } else if (result.evaluationError !== null) {
    process.stdout.write(
      `\nThe report could not be written: ${result.evaluationError}\n` +
        `The run is recorded. Re-evaluate with:\n  npm run eval:session -- ${result.sessionId}\n`,
    );
  }
  process.stdout.write(renderFooter(result.sessionId, config.data.dataDir));
}

process.exit(result.record.outcome === 'ERROR' ? 2 : result.record.outcome === 'SUCCESS' ? 0 : 1);

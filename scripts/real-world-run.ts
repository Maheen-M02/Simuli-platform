/**
 * DEVELOPMENT / VALIDATION TOOL — not part of the product.
 *
 * Runs the existing agent against a real application, to answer one question:
 * does it behave like a plausible customer somewhere other than our own
 * fixture? See REAL_WORLD_VALIDATION.md.
 *
 *   npm run validate:real -- --config runs/acme-staging.json
 *
 * Takes a JSON file rather than flags, for one reason that matters: arguments
 * are visible to every process on the machine via the process list, so a
 * credential passed as `--password` is effectively public. Credentials are
 * never named here at all — the file lists which secret *names* the run may
 * use, and the values come from the environment.
 *
 * Nothing in this script bypasses the agent. It builds a RunConfig and calls
 * the same `runSimulation()` the CLI does, so the action schema, the executor's
 * refusals, the recorder and the evaluator all apply unchanged.
 */

import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { loadDotEnv, readEnv } from '../src/config/env.ts';
import { RunConfigSchema } from '../src/config/runConfig.ts';
import { CustomerContextSchema } from '../src/personas/context.ts';
import { GoalSchema } from '../src/goals/schema.ts';
import { createLogger } from '../src/logging/logger.ts';
import { createRedactor } from '../src/observations/redact.ts';
import { runSimulation } from '../src/runSimulation.ts';
import {
  renderEvaluation,
  renderFooter,
  renderRecord,
  renderSteps,
  setColorEnabled,
} from '../src/cli/render.ts';

/**
 * The run description. Deliberately explicit about permission: a real run
 * touches somebody's application, and "I had permission" should be a recorded
 * assertion rather than an assumption.
 */
const RealWorldRunSchema = z
  .object({
    /** Where the customer starts. Must be a staging or demo environment. */
    url: z.string().url(),
    /**
     * Confirms this target is one we are allowed to exercise. Required, and
     * checked, because the cost of being wrong lands on someone else.
     */
    permission: z.object({
      environment: z.enum(['staging', 'demo', 'sandbox', 'own-application']),
      /** Who authorised it, in whatever form you can point at later. */
      authorisedBy: z.string().min(1),
    }),
    goal: GoalSchema,
    customerContext: CustomerContextSchema,
    /**
     * Names of credentials the agent may reference, e.g. ["EMAIL","PASSWORD"].
     * The values are read from SIM_SECRET_<NAME> in the environment and never
     * appear in this file.
     */
    credentialNames: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).max(10).default([]),
    /** Extra origins beyond the start site, e.g. a separate SSO provider. */
    allowedOrigins: z.array(z.string().url()).max(20).default([]),
    /** Real products bounce login to auth subdomains. On by default here. */
    allowSubdomains: z.boolean().default(true),
    maxSteps: z.number().int().min(1).max(200).default(60),
    timeoutSeconds: z.number().int().min(30).max(1800).default(900),
    headed: z.boolean().default(false),
    screenshots: z.boolean().default(true),
  })
  .strict();

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    config: { type: 'string' },
    steps: { type: 'boolean' },
    json: { type: 'boolean' },
    headed: { type: 'boolean' },
  },
});

if (values.config === undefined) {
  process.stderr.write('Usage: npm run validate:real -- --config <file.json> [--steps] [--headed]\n');
  process.exit(64);
}

const parsedRun = RealWorldRunSchema.safeParse(
  JSON.parse(readFileSync(values.config, 'utf8')) as unknown,
);
if (!parsedRun.success) {
  const issues = parsedRun.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  process.stderr.write(`That run file is not valid:\n${issues}\n`);
  process.exit(64);
}
const run = parsedRun.data;

loadDotEnv();
const env = readEnv();
if (!env.ok) {
  process.stderr.write(`${env.error}\n`);
  process.exit(64);
}

// A credential the run says it needs but the environment does not have would
// otherwise surface mid-run as a SECRET_NOT_FOUND, several minutes and several
// model calls later. Fail now instead.
const missing = run.credentialNames.filter((name) => !env.value.secrets.has(name));
if (missing.length > 0) {
  process.stderr.write(
    `These credentials are named in the run file but not set in the environment: ${missing.join(', ')}\n` +
      `Set SIM_SECRET_${missing[0]} (and the rest) in .env, or remove them from credentialNames.\n`,
  );
  process.exit(64);
}

// Only the named credentials are exposed to the run. Anything else in the
// environment stays out of reach even though the process can see it.
const secrets = new Map<string, string>();
for (const name of run.credentialNames) {
  const value = env.value.secrets.get(name);
  if (value !== undefined) secrets.set(name, value);
}

const config = RunConfigSchema.safeParse({
  startUrl: run.url,
  goal: run.goal,
  context: run.customerContext,
  limits: { maxSteps: run.maxSteps, wallClockMs: run.timeoutSeconds * 1000 },
  allowedOrigins: run.allowedOrigins,
  allowSubdomains: run.allowSubdomains,
  dataDir: 'data',
  headless: !(run.headed || values.headed === true),
  screenshots: run.screenshots,
  // Never relaxed for a real target, whatever the run file says.
  blockDestructive: true,
  evaluate: true,
});

if (!config.success) {
  const issues = config.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  process.stderr.write(`That run configuration is not valid:\n${issues}\n`);
  process.exit(64);
}

setColorEnabled(values.json !== true && process.stdout.isTTY === true);

process.stdout.write(
  `\nReal-world validation run\n` +
    `  Target        ${run.url}\n` +
    `  Environment   ${run.permission.environment}, authorised by ${run.permission.authorisedBy}\n` +
    `  Customer      ${run.customerContext.persona.name}\n` +
    `  Goal          ${run.goal.description}\n` +
    `  Credentials   ${run.credentialNames.length === 0 ? '(none)' : run.credentialNames.join(', ')}\n` +
    `  Limits        ${run.maxSteps} steps, ${run.timeoutSeconds}s\n\n`,
);

const logger = createLogger({
  level: env.value.logLevel,
  redact: createRedactor(secrets),
  pretty: values.json !== true,
});

const result = await runSimulation(config.data, {
  env: { ...env.value, secrets },
  logger,
});

if (values.json === true) {
  process.stdout.write(
    `${JSON.stringify(
      {
        sessionId: result.sessionId,
        target: run.url,
        outcome: result.record.outcome,
        terminationReason: result.record.terminationReason,
        steps: result.record.steps.length,
        evaluation: result.evaluation,
        evaluationError: result.evaluationError,
        rejectedFindings: result.rejectedFindings.length,
      },
      null,
      2,
    )}\n`,
  );
} else {
  process.stdout.write(`${renderRecord(result.record)}\n`);
  // Steps are on by default for a real run: the transcript is the evidence a
  // human has to review before believing anything in the report.
  if (values.steps !== false) process.stdout.write(`${renderSteps(result.record)}\n`);

  if (result.evaluation !== null) {
    process.stdout.write(`${renderEvaluation(result.evaluation)}\n`);
  } else if (result.evaluationError !== null) {
    process.stdout.write(
      `\nThe report could not be written: ${result.evaluationError}\n` +
        `The run itself was recorded. Re-evaluate it with:\n` +
        `  npm run eval:session -- ${result.sessionId}\n`,
    );
  }
  process.stdout.write(renderFooter(result.sessionId, config.data.dataDir));
}

process.exit(result.record.outcome === 'ERROR' ? 2 : result.record.outcome === 'SUCCESS' ? 0 : 1);

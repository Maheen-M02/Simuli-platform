import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { loadDotEnv, readEnv } from '../config/env.ts';
import { RunConfigSchema } from '../config/runConfig.ts';
import { DEFAULT_PERSONA, PersonaSchema } from '../personas/schema.ts';
import { createLogger } from '../logging/logger.ts';
import { createRedactor } from '../observations/redact.ts';
import { runSimulation } from '../runSimulation.ts';
import {
  renderEvaluation,
  renderFooter,
  renderRecord,
  renderSteps,
  setColorEnabled,
} from './render.ts';

/**
 * The CLI: a thin wrapper.
 *
 * Everything of consequence happens in `runSimulation()`. This file parses
 * arguments, prints, and chooses an exit code — nothing else, so that a future
 * API or dashboard is not tempted to reimplement any of it.
 */

const USAGE = `
agent run --url <url> --goal <goal> [options]

Runs a simulated customer through a website and reports what they experienced.

Required
  --url <url>            Where the customer starts.
  --goal <text>          What they are trying to do, in their words.

Persona
  --persona <text>       A one-line description of who they are.
  --persona-file <path>  A JSON persona, for anything more detailed.

Run
  --max-steps <n>        Give up after this many steps (default 40).
  --timeout <seconds>    Give up after this long (default 300).
  --allow-origin <url>   Also permit this origin. Repeatable.
  --data-dir <path>      Where records and screenshots go (default data).

Flags
  --headed               Watch the browser drive itself.
  --no-screenshots       Do not capture screenshots.
  --no-evaluate          Record the run but skip the written report.
  --steps                Print every step, not just the findings.
  --json                 Print machine-readable JSON instead of a report.
  --no-color             Plain output.
  -h, --help             This message.
`;

/** Exit codes: 0 means the customer got there, not merely that we did not crash. */
const EXIT = { success: 0, notAchieved: 1, runFailed: 2, badUsage: 64 } as const;

export async function main(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        url: { type: 'string' },
        goal: { type: 'string' },
        persona: { type: 'string' },
        'persona-file': { type: 'string' },
        'max-steps': { type: 'string' },
        timeout: { type: 'string' },
        'allow-origin': { type: 'string', multiple: true },
        'data-dir': { type: 'string' },
        headed: { type: 'boolean' },
        screenshots: { type: 'boolean', default: true },
        evaluate: { type: 'boolean', default: true },
        steps: { type: 'boolean' },
        json: { type: 'boolean' },
        color: { type: 'boolean', default: true },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (caught) {
    process.stderr.write(`${caught instanceof Error ? caught.message : String(caught)}\n${USAGE}`);
    return EXIT.badUsage;
  }

  const { values, positionals } = parsed;

  if (values.help === true || positionals[0] === undefined) {
    process.stdout.write(USAGE);
    return values.help === true ? EXIT.success : EXIT.badUsage;
  }

  if (positionals[0] !== 'run') {
    process.stderr.write(`Unknown command "${positionals[0]}".\n${USAGE}`);
    return EXIT.badUsage;
  }

  setColorEnabled(values.color !== false && process.stdout.isTTY === true);

  if (values.url === undefined || values.goal === undefined) {
    process.stderr.write(`Both --url and --goal are required.\n${USAGE}`);
    return EXIT.badUsage;
  }

  loadDotEnv();
  const env = readEnv();
  if (!env.ok) {
    process.stderr.write(`${env.error}\n\nCopy .env.example to .env and fill it in.\n`);
    return EXIT.badUsage;
  }

  const persona = resolvePersona(values.persona, values['persona-file']);
  if (!persona.ok) {
    process.stderr.write(`${persona.error}\n`);
    return EXIT.badUsage;
  }

  const config = RunConfigSchema.safeParse({
    startUrl: values.url,
    goal: { description: values.goal },
    persona: persona.value,
    limits: {
      ...(values['max-steps'] === undefined ? {} : { maxSteps: Number(values['max-steps']) }),
      ...(values.timeout === undefined ? {} : { wallClockMs: Number(values.timeout) * 1000 }),
    },
    allowedOrigins: values['allow-origin'] ?? [],
    dataDir: values['data-dir'] ?? 'data',
    headless: values.headed !== true,
    screenshots: values.screenshots !== false,
    evaluate: values.evaluate !== false,
  });

  if (!config.success) {
    const issues = config.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    process.stderr.write(`That run configuration is not valid:\n${issues}\n`);
    return EXIT.badUsage;
  }

  const logger = createLogger({
    level: env.value.logLevel,
    redact: createRedactor(env.value.secrets),
    pretty: values.json !== true,
  });

  let result;
  try {
    result = await runSimulation(config.data, { env: env.value, logger });
  } catch (caught) {
    // runSimulation is built not to throw; if it does, say so plainly rather
    // than printing a stack trace at somebody evaluating our product.
    process.stderr.write(
      `The run could not be completed: ${caught instanceof Error ? caught.message : String(caught)}\n`,
    );
    return EXIT.runFailed;
  }

  if (values.json === true) {
    process.stdout.write(
      `${JSON.stringify(
        {
          sessionId: result.sessionId,
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
    if (values.steps === true) process.stdout.write(`${renderSteps(result.record)}\n`);
    if (result.evaluation !== null) {
      process.stdout.write(`${renderEvaluation(result.evaluation)}\n`);
    } else if (result.evaluationError !== null) {
      process.stdout.write(
        `\nThe report could not be written: ${result.evaluationError}\n` +
          'The run itself was recorded and can be evaluated again later.\n',
      );
    }
    process.stdout.write(renderFooter(result.sessionId, config.data.dataDir));
  }

  if (result.record.outcome === 'ERROR') return EXIT.runFailed;
  return result.record.outcome === 'SUCCESS' ? EXIT.success : EXIT.notAchieved;
}

function resolvePersona(
  inline: string | undefined,
  path: string | undefined,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (path !== undefined) {
    try {
      const parsed = PersonaSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
        return { ok: false, error: `That persona file is not valid:\n${issues}` };
      }
      return { ok: true, value: parsed.data };
    } catch (caught) {
      return {
        ok: false,
        error: `Could not read ${path}: ${caught instanceof Error ? caught.message : String(caught)}`,
      };
    }
  }

  if (inline !== undefined) {
    // A one-liner is enough to change how the agent behaves; the rest defaults.
    return { ok: true, value: { ...DEFAULT_PERSONA, name: inline, background: inline } };
  }

  return { ok: true, value: DEFAULT_PERSONA };
}

// Only run when invoked directly, so tests can import `main` freely.
if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (caught: unknown) => {
      process.stderr.write(`${caught instanceof Error ? caught.stack : String(caught)}\n`);
      process.exit(EXIT.runFailed);
    },
  );
}

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { runLoop } from './agent/loop.ts';
import { createModelPlanner, type Planner } from './agent/planner.ts';
import { startSession } from './browser/session.ts';
import type { RunConfig } from './config/runConfig.ts';
import type { Env } from './config/env.ts';
import { evaluateSession } from './evaluation/evaluator.ts';
import type { Evaluation, Finding } from './evaluation/schema.ts';
import { createLlmClient, type LlmClient } from './llm/client.ts';
import { silentLogger, type Logger } from './logging/logger.ts';
import { createRedactor } from './observations/redact.ts';
import { createArtifacts } from './persistence/artifacts.ts';
import { openDb, type Db } from './persistence/db.ts';
import { createRecorder } from './sessions/recorder.ts';
import type { SessionRecord } from './sessions/types.ts';

/**
 * One simulation run, end to end.
 *
 * This is the product's actual entry point. The CLI is a thin wrapper around
 * it, and a future API or dashboard would import this same function rather than
 * shelling out — which is why nothing here prints, parses arguments or reads
 * process state.
 *
 * Everything injectable is injected (planner, client, logger, clock), because
 * that is what lets the whole runtime be tested without a model.
 */

export type SimulationResult = {
  readonly record: SessionRecord;
  /** Absent when evaluation was skipped or failed; the run itself still stands. */
  readonly evaluation: Evaluation | null;
  /** Present when evaluation was attempted and did not produce a result. */
  readonly evaluationError: string | null;
  /** Findings discarded for citing steps that never happened. */
  readonly rejectedFindings: readonly Finding[];
  readonly sessionId: string;
};

export type SimulationDeps = {
  readonly env: Env;
  readonly logger?: Logger;
  /** Overridden in tests to avoid a model call. */
  readonly planner?: Planner;
  readonly llmClient?: LlmClient;
  readonly db?: Db;
  readonly sessionId?: string;
  readonly now?: () => number;
};

export async function runSimulation(
  config: RunConfig,
  deps: SimulationDeps,
): Promise<SimulationResult> {
  const logger = deps.logger ?? silentLogger();
  const sessionId = deps.sessionId ?? randomUUID();
  const redact = createRedactor(deps.env.secrets);

  const db = deps.db ?? openDb(join(config.dataDir, 'sessions.db'));
  const ownsDb = deps.db === undefined;

  const artifacts = config.screenshots
    ? createArtifacts(join(config.dataDir, 'artifacts'), sessionId)
    : null;

  const llmClient =
    deps.llmClient ??
    createLlmClient(deps.env.openaiApiKey, {
      baseUrl: deps.env.openaiBaseUrl,
      requireStructuredOutput: deps.env.requireStructuredOutput,
      appTitle: deps.env.appTitle,
      appUrl: deps.env.appUrl,
    });
  const planner =
    deps.planner ?? createModelPlanner({ client: llmClient, model: deps.env.plannerModel });

  const session = await startSession(config.startUrl, {
    headless: config.headless,
    allowedOrigins: config.allowedOrigins,
    allowSubdomains: config.allowSubdomains,
    onBlockedNavigation: (url) => logger.info({ url }, 'refused a navigation outside the allowlist'),
  });

  let record: SessionRecord;

  try {
    // The recorder is created before the first navigation, so a target that
    // cannot be reached at all still produces a session row with an explicit
    // outcome. Every run terminates with a verdict; an unreachable host is an
    // ordinary condition against a real application — a typo, a VPN, DNS — and
    // must not surface as an uncaught exception.
    const recorder = createRecorder({
      sessionId,
      startUrl: config.startUrl,
      context: config.context,
      goal: config.goal,
      plannerModel: deps.env.plannerModel,
      db,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });

    try {
      // The start URL is the one navigation we perform. From here the agent has
      // to get around the way a customer does: by clicking.
      await session.page.goto(config.startUrl, { waitUntil: 'domcontentloaded' });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      logger.error({ url: config.startUrl, err: message }, 'could not open the target');
      record = recorder.finish(
        'ERROR',
        'BROWSER_LOST',
        `The target at ${config.startUrl} could not be opened: ${message}`,
      );
      await session.close();
      if (ownsDb) db.close();
      return {
        record,
        evaluation: null,
        // Evaluating a run that never started would be judging a blank page.
        evaluationError: 'The run never reached the target, so there was nothing to evaluate.',
        rejectedFindings: [],
        sessionId,
      };
    }

    record = await runLoop({
      session,
      planner,
      recorder,
      context: config.context,
      goal: config.goal,
      secrets: deps.env.secrets,
      redact,
      logger,
      limits: config.limits,
      blockDestructive: config.blockDestructive,
      ...(artifacts === null
        ? {}
        : { capture: (stepIndex: number) => artifacts.capture(stepIndex, session.page) }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });
  } finally {
    await session.close();
  }

  // Evaluation reads only the record, so the browser is already gone by now.
  let evaluation: Evaluation | null = null;
  let evaluationError: string | null = null;
  const rejectedFindings: Finding[] = [];

  if (config.evaluate) {
    const result = await evaluateSession(record, {
      client: llmClient,
      model: deps.env.evaluatorModel,
      onRejectedFindings: (findings) => {
        rejectedFindings.push(...findings);
        logger.warn(
          { count: findings.length, titles: findings.map((f) => f.finding) },
          'discarded findings that cited steps which never happened',
        );
      },
    });

    if (result.ok) {
      evaluation = result.value;
      db.saveEvaluation(sessionId, JSON.stringify(result.value));
    } else {
      // A failed evaluation must not discard the run. The record is the
      // expensive part and can be re-evaluated later.
      evaluationError = result.error;
      logger.error({ reason: result.error }, 'evaluation failed; the session record is intact');
    }
  }

  if (ownsDb) db.close();

  return { record, evaluation, evaluationError, rejectedFindings, sessionId };
}

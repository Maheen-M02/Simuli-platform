import type { Action } from '../actions/schema.ts';
import { describeAction } from '../actions/schema.ts';
import { executeAction } from '../browser/executor.ts';
import type { BrowserSession } from '../browser/session.ts';
import type { Goal } from '../goals/schema.ts';
import type { Logger } from '../logging/logger.ts';
import { observe, settle } from '../observations/observe.ts';
import type { Redactor } from '../observations/redact.ts';
import { snapshotFingerprint, summarizeSnapshot } from '../observations/serialize.ts';
import type { Observation } from '../observations/types.ts';
import type { CustomerContext } from '../personas/context.ts';
import type { Recorder } from '../sessions/recorder.ts';
import type { SessionRecord, TerminationReason } from '../sessions/types.ts';
import type { ActionResult } from '../types/shared.ts';
import type { HistoryEntry, Planner } from './planner.ts';
import {
  actState,
  checkTermination,
  DEFAULT_LIMITS,
  INITIAL_STATE,
  observeState,
  outcomeFor,
  plannerFailedState,
  type Limits,
  type LoopState,
} from './termination.ts';

/**
 * The agent loop.
 *
 * settle -> observe -> record -> check termination -> decide -> validate ->
 * act -> record -> check termination -> repeat.
 *
 * The loop is the only thing that touches both observation and execution.
 * Observation is read-only, execution is write-only, and neither calls the
 * other; this function mediates. That separation is what stops a bug in acting
 * from quietly corrupting what the agent believes it saw.
 *
 * The loop never throws. Whatever happens, it returns a finished record with an
 * explicit outcome, because a run that ends without a verdict is a run we
 * cannot learn anything from.
 */

export type LoopOptions = {
  readonly session: BrowserSession;
  readonly planner: Planner;
  readonly recorder: Recorder;
  readonly context: CustomerContext;
  readonly goal: Goal;
  readonly secrets: ReadonlyMap<string, string>;
  readonly redact: Redactor;
  readonly logger: Logger;
  readonly limits?: Limits;
  /** Set false only for a run explicitly authorised to make real changes. */
  readonly blockDestructive?: boolean;
  /** Screenshot hook. Returns the saved path, or null. */
  readonly capture?: (stepIndex: number) => Promise<string | null>;
  readonly settleTimeoutMs?: number;
  readonly now?: () => number;
};

/**
 * What an action actually did, in the terms the model will read next step.
 *
 * A failure can be described immediately. A success cannot: "it worked" says
 * nothing about whether the page did what the agent expected, and that gap
 * between expectation and reality is the friction signal we exist to capture.
 * So a successful action's outcome is left open and filled in once the next
 * observation shows where the agent actually ended up.
 */
function describeFailure(result: ActionResult): string {
  return `It did not work: ${result.error?.message ?? 'the action failed.'}`;
}

function describeArrival(result: ActionResult, after: Observation): string {
  const where = result.navigated ? 'You are now on a different page. ' : 'You are on the same page. ';
  return `${where}It now reads: ${summarizeSnapshot(after.snapshot)}`;
}

export async function runLoop(options: LoopOptions): Promise<SessionRecord> {
  const now = options.now ?? Date.now;
  const limits = options.limits ?? DEFAULT_LIMITS;
  const startedAt = now();
  const { session, recorder, logger } = options;
  const secretNames = [...options.secrets.keys()];

  let state: LoopState = INITIAL_STATE;
  let generation = 0;
  const history: HistoryEntry[] = [];

  /** Set when the loop must stop for a reason other than a limit. */
  let hardStop: TerminationReason | null = null;
  let lastAction: Action | null = null;
  let agentSummary: string | null = null;
  /** A successful action whose consequence the next observation will describe. */
  let awaitingOutcome: { index: number; result: ActionResult } | null = null;

  try {
    for (;;) {
      const elapsed = now() - startedAt;

      // --- settle -> observe ---------------------------------------------
      await settle(session.page, { timeoutMs: options.settleTimeoutMs ?? 5000 });
      generation += 1;

      let observation: Observation;
      try {
        observation = await observe(session.page, { generation, redact: options.redact, now });
      } catch (caught) {
        // Losing the page is not something the agent can recover from, but the
        // steps taken so far are still worth every bit as much.
        logger.error({ err: caught }, 'lost the page while observing');
        hardStop = 'BROWSER_LOST';
        break;
      }

      // Now that we can see where the last action landed, say so.
      if (awaitingOutcome !== null) {
        const entry = history[awaitingOutcome.index];
        if (entry !== undefined) {
          history[awaitingOutcome.index] = {
            ...entry,
            outcome: describeArrival(awaitingOutcome.result, observation),
          };
        }
        awaitingOutcome = null;
      }

      state = observeState(state, snapshotFingerprint(observation.snapshot));

      // --- record ---------------------------------------------------------
      const stepIndex = recorder.beginStep(
        observation,
        (await options.capture?.(state.stepCount)) ?? null,
      );

      logger.debug(
        { step: stepIndex, url: observation.snapshot.url, nodes: observation.snapshot.nodes.length },
        'observed',
      );

      // --- check termination (before spending a model call) ----------------
      const beforeDeciding = checkTermination(state, limits, elapsed, null);
      if (beforeDeciding !== null) {
        hardStop = beforeDeciding;
        break;
      }

      // --- decide ----------------------------------------------------------
      const decision = await options.planner({
        context: options.context,
        goal: options.goal,
        observation,
        history,
        availableSecrets: secretNames,
        stepsRemaining: Math.max(0, limits.maxSteps - state.stepCount),
      });

      if (!decision.ok) {
        logger.warn({ step: stepIndex, reason: decision.error }, 'planner produced no usable action');
        recorder.failStep(decision.error);
        state = plannerFailedState(state);

        const afterFailure = checkTermination(state, limits, now() - startedAt, null);
        if (afterFailure !== null) {
          hardStop = afterFailure;
          break;
        }
        continue;
      }

      const action = decision.value;
      lastAction = action;

      // --- act ---------------------------------------------------------------
      const result = await executeAction(session.page, action, {
        snapshot: observation.snapshot,
        actionGeneration: observation.generation,
        currentGeneration: generation,
        secrets: options.secrets,
        takeBlockedNavigations: session.takeBlockedNavigations,
        blockDestructive: options.blockDestructive !== false,
        now,
      });

      // --- record -------------------------------------------------------------
      recorder.completeStep(action, result);
      state = actState(state, action, result);

      logger.info(
        { step: stepIndex, action: describeAction(action), ok: result.ok, kind: result.error?.kind },
        'acted',
      );

      if (action.action === 'finish') agentSummary = action.evidence;
      if (action.action === 'fail') agentSummary = action.reason;

      // History is a summary, not a transcript: replaying every past snapshot
      // would crowd the goal out of the context window by step ten.
      history.push({
        stepIndex,
        action: describeAction(action),
        expectation: action.expectation,
        outcome: result.ok ? 'Pending: the next observation shows where this led.' : describeFailure(result),
      });
      if (result.ok) awaitingOutcome = { index: history.length - 1, result };

      // --- check termination ---------------------------------------------------
      const afterActing = checkTermination(state, limits, now() - startedAt, action);
      if (afterActing !== null) {
        hardStop = afterActing;
        break;
      }
    }
  } catch (caught) {
    // The loop must not be able to end a run without a record.
    logger.error({ err: caught }, 'the run failed unexpectedly');
    hardStop = 'BROWSER_LOST';
  }

  const reason: TerminationReason = hardStop ?? 'MAX_STEPS';
  const outcome = outcomeFor(reason, lastAction);
  logger.info({ outcome, reason, steps: state.stepCount }, 'run finished');

  return recorder.finish(outcome, reason, agentSummary);
}

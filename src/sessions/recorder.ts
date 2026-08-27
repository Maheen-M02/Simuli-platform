import type { Action } from '../actions/schema.ts';
import type { Goal } from '../goals/schema.ts';
import type { Observation } from '../observations/types.ts';
import type { CustomerContext } from '../personas/context.ts';
import type { Db } from '../persistence/db.ts';
import type { ActionResult } from '../types/shared.ts';
import type {
  ObservationRecord,
  Outcome,
  SessionRecord,
  StepRecord,
  TerminationReason,
} from './types.ts';

/**
 * Records a run as it happens.
 *
 * The session row is written before the first step and the outcome is written
 * last, so an unfinished run is visibly unfinished rather than missing. Each
 * step is committed the moment it completes; nothing is buffered until the end.
 *
 * The recorder never reads the browser and never decides anything. It is told
 * what happened.
 */

export type Recorder = {
  readonly sessionId: string;
  /** Opens a step with what the agent saw. Returns the step index. */
  beginStep(observation: Observation, screenshotPath: string | null): number;
  /** Closes the open step with what the agent did and what came of it. */
  completeStep(action: Action, result: ActionResult): void;
  /** Closes the open step when the planner could not produce an action. */
  failStep(plannerError: string): void;
  finish(outcome: Outcome, reason: TerminationReason, agentSummary: string | null): SessionRecord;
  /** The record so far, including an in-progress run. */
  snapshot(): SessionRecord;
};

export type RecorderOptions = {
  readonly sessionId: string;
  readonly startUrl: string;
  readonly context: CustomerContext;
  readonly goal: Goal;
  readonly plannerModel: string;
  readonly db: Db;
  readonly now?: () => number;
};

function toObservationRecord(
  observation: Observation,
  screenshotPath: string | null,
): ObservationRecord {
  return {
    generation: observation.generation,
    capturedAt: observation.capturedAt,
    url: observation.snapshot.url,
    title: observation.snapshot.title,
    text: observation.text,
    nodeCount: observation.snapshot.nodes.length,
    screenshotPath,
  };
}

export function createRecorder(options: RecorderOptions): Recorder {
  const now = options.now ?? Date.now;
  const steps: StepRecord[] = [];

  let record: SessionRecord = {
    id: options.sessionId,
    startUrl: options.startUrl,
    context: options.context,
    goal: options.goal,
    plannerModel: options.plannerModel,
    startedAt: now(),
    endedAt: null,
    outcome: null,
    terminationReason: null,
    agentSummary: null,
    steps,
  };

  options.db.insertSession(record);

  /** The step opened by `beginStep` and not yet closed. */
  let open: { observation: ObservationRecord; startedAt: number; index: number } | null = null;

  function close(step: StepRecord): void {
    steps.push(step);
    options.db.appendStep(options.sessionId, step);
    open = null;
  }

  return {
    sessionId: options.sessionId,

    beginStep(observation, screenshotPath) {
      if (open !== null) {
        // Every observation must be accounted for, including one the agent
        // never got to act on. Losing it would hide where a run died.
        close({
          index: open.index,
          observation: open.observation,
          action: null,
          result: null,
          plannerError: 'Step was abandoned before an action was taken.',
          startedAt: open.startedAt,
          endedAt: now(),
        });
      }

      const index = steps.length;
      open = { observation: toObservationRecord(observation, screenshotPath), startedAt: now(), index };
      return index;
    },

    completeStep(action, result) {
      if (open === null) throw new Error('completeStep called with no open step');
      close({
        index: open.index,
        observation: open.observation,
        action,
        result,
        plannerError: null,
        startedAt: open.startedAt,
        endedAt: now(),
      });
    },

    failStep(plannerError) {
      if (open === null) throw new Error('failStep called with no open step');
      close({
        index: open.index,
        observation: open.observation,
        action: null,
        result: null,
        plannerError,
        startedAt: open.startedAt,
        endedAt: now(),
      });
    },

    finish(outcome, reason, agentSummary) {
      if (open !== null) {
        close({
          index: open.index,
          observation: open.observation,
          action: null,
          result: null,
          plannerError: 'Run ended before this step produced an action.',
          startedAt: open.startedAt,
          endedAt: now(),
        });
      }

      record = {
        ...record,
        endedAt: now(),
        outcome,
        terminationReason: reason,
        agentSummary,
        steps: [...steps],
      };
      options.db.finalizeSession(record);
      return record;
    },

    snapshot() {
      return { ...record, steps: [...steps] };
    },
  };
}

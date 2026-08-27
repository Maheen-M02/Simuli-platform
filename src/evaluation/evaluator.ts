import { describeAction } from '../actions/schema.ts';
import type { LlmClient } from '../llm/client.ts';
import type { SessionRecord } from '../sessions/types.ts';
import { err, ok, type Result } from '../types/shared.ts';
import { computeFacts, describeFacts } from './deterministic.ts';
import {
  ATTRIBUTIONS,
  EvaluationSchema,
  ModelEvaluationSchema,
  SEVERITIES,
  type Evaluation,
  type Finding,
} from './schema.ts';

/**
 * Judges a finished run.
 *
 * The evaluator reads only the persisted record. It never touches a browser and
 * never asks the agent anything, which is what lets us re-run a better
 * evaluator over sessions recorded months ago and compare results — evaluation
 * quality and agent quality improve independently.
 *
 * Findings that cite steps which did not happen are discarded, not corrected.
 * A confident paragraph about step 14 of a nine-step run is exactly the failure
 * mode that would destroy trust in the whole product, and the cheapest place to
 * stop it is here.
 */

const EVALUATION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    goalAchieved: {
      type: 'boolean',
      description: 'Did the customer actually accomplish the goal? Judge from the record.',
    },
    summary: {
      type: 'string',
      description: 'Two or three sentences a product manager could read on its own.',
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          attribution: { enum: [...ATTRIBUTIONS] },
          severity: { enum: [...SEVERITIES] },
          stepRefs: {
            type: 'array',
            items: { type: 'integer' },
            description: 'Step numbers (as shown) that this finding rests on.',
          },
        },
        required: ['title', 'description', 'attribution', 'severity', 'stepRefs'],
        additionalProperties: false,
      },
    },
  },
  required: ['goalAchieved', 'summary', 'findings'],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You review recordings of a simulated customer using a product.

Your job is to say what that customer actually experienced, and to be strict
about whose problem each thing was.

Every finding must be attributed:
- PRODUCT_FRICTION: the product made this hard. Unclear labels, hidden rules,
  dead ends, work the customer should not have had to do.
- AGENT_LIMITATION: the simulated customer was not good enough. It missed
  something a real person would have seen, or gave up too early.
- TECHNICAL_FAILURE: the simulation itself broke.

Be honest about the second and third. Findings that blame the product for our
own shortcomings are worse than no findings at all.

Rules:
- Every finding must cite the step numbers it rests on. Only cite steps that
  appear in the record below.
- Do not invent detail. If the record does not show something, it did not happen.
- The computed facts given to you are measurements, not opinions. Do not
  contradict them.
- A run where nothing went wrong should produce few findings or none. Do not
  manufacture problems to fill space.
- Judge goalAchieved from the evidence, not from what the customer claimed.
- What the customer believed and expected is a guess they made at the time, not
  a fact about the product. They routinely misdiagnose why something happened.
  Evidence is what the page actually showed. Never turn a customer's stated
  theory into a product finding unless the pages themselves bear it out.
- A message on the page persists until the page is re-rendered. A customer
  seeing the same error after fixing the input has usually not triggered a new
  error; they are looking at the old one. Do not report that as the product
  rejecting valid input.`;

/** The record, rendered for the model. Step numbers here are what may be cited. */
export function renderTranscript(record: SessionRecord): string {
  const lines: string[] = [
    `Goal: ${record.goal.description}`,
    `Customer: ${record.persona.name} — ${record.persona.background}`,
    `Outcome recorded by the system: ${record.outcome ?? 'unknown'} (${record.terminationReason ?? 'unknown'})`,
    '',
  ];

  for (const step of record.steps) {
    lines.push(`--- Step ${step.index} ---`);
    lines.push(`Page: ${step.observation.title} (${step.observation.url})`);
    lines.push(step.observation.text);

    if (step.plannerError !== null) {
      lines.push(`The customer could not decide what to do: ${step.plannerError}`);
    }

    if (step.action !== null) {
      lines.push(`Did: ${describeAction(step.action)}`);
      // Labelled as belief, not fact. On a real run the evaluator read two of
      // these as product behaviour and filed false findings: the customer had
      // guessed at why a stale error message was still on screen, and was wrong
      // both times.
      lines.push(`Believed at the time (may be mistaken): ${step.action.reasoning}`);
      lines.push(`Expected to happen: ${step.action.expectation}`);

      const result = step.result;
      if (result !== null) {
        lines.push(
          result.ok
            ? `Result: the action went through${result.navigated ? ' and the page changed' : ''}.`
            : `Result: FAILED — ${result.error?.kind}: ${result.error?.message}`,
        );
      }
    }

    lines.push('');
  }

  if (record.agentSummary !== null) {
    lines.push(`The customer's closing statement: ${record.agentSummary}`);
  }

  return lines.join('\n');
}

/**
 * Drops findings that cite steps which do not exist.
 *
 * A finding is kept when at least one cited step is real, with the phantom
 * references stripped; it is dropped when none of them are. Partial citation
 * errors are common and usually harmless, but a finding with no real evidence
 * behind it is a hallucination and must not reach a customer.
 */
export function validateStepRefs(
  findings: readonly Finding[],
  stepCount: number,
): { readonly kept: Finding[]; readonly rejected: Finding[] } {
  const kept: Finding[] = [];
  const rejected: Finding[] = [];

  for (const finding of findings) {
    const real = finding.stepRefs.filter((ref) => ref >= 0 && ref < stepCount);
    if (real.length === 0) {
      rejected.push(finding);
      continue;
    }
    kept.push(real.length === finding.stepRefs.length ? finding : { ...finding, stepRefs: real });
  }

  return { kept, rejected };
}

export type EvaluateOptions = {
  readonly client: LlmClient;
  readonly model: string;
  /** Called with findings dropped for citing steps that never happened. */
  readonly onRejectedFindings?: (rejected: readonly Finding[]) => void;
};

export async function evaluateSession(
  record: SessionRecord,
  options: EvaluateOptions,
): Promise<Result<Evaluation, string>> {
  const facts = computeFacts(record);

  const user = [
    'Computed facts about this run (measurements, not opinions):',
    describeFacts(facts),
    '',
    'The recording:',
    '',
    renderTranscript(record),
  ].join('\n');

  const response = await options.client.completeJson({
    model: options.model,
    system: SYSTEM_PROMPT,
    user,
    schemaName: 'session_evaluation',
    jsonSchema: EVALUATION_JSON_SCHEMA as unknown as Record<string, unknown>,
    // Judgment should be stable: the same record twice should read the same way.
    temperature: 0.1,
  });

  if (!response.ok) return err(response.error);

  const parsed = ModelEvaluationSchema.safeParse(response.value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return err(`The evaluation did not validate: ${issues}`);
  }

  const { kept, rejected } = validateStepRefs(parsed.data.findings, record.steps.length);
  if (rejected.length > 0) options.onRejectedFindings?.(rejected);

  const evaluation = EvaluationSchema.safeParse({
    sessionId: record.id,
    goalAchieved: parsed.data.goalAchieved,
    summary: parsed.data.summary,
    findings: kept,
    facts,
  });

  if (!evaluation.success) return err('The assembled evaluation did not validate.');
  return ok(evaluation.data);
}

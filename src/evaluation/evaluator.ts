import type { LlmClient } from '../llm/client.ts';
import type { SessionRecord } from '../sessions/types.ts';
import { err, ok, type Result } from '../types/shared.ts';
import { computeFacts, describeFacts } from './deterministic.ts';
import { deriveEvidence, renderEvidence, type EvidenceLedger } from './evidence.ts';
import { applyEvidencePolicy } from './policy.ts';
import { WOULD_PAY_VERDICTS } from './verdict.ts';
import {
  CLASSIFICATIONS,
  CONFIDENCES,
  EVIDENCE_TYPES,
  EvaluationSchema,
  ModelEvaluationSchema,
  SEVERITIES,
  type Evaluation,
  type Finding,
  type PolicyAction,
} from './schema.ts';

/**
 * Judges a finished run.
 *
 * The evaluator reads only the persisted record. It never touches a browser and
 * never asks the agent anything, which is what lets us re-run a better
 * evaluator over sessions recorded months ago and compare results — evaluation
 * quality and agent quality improve independently.
 *
 * Three layers, weakest last:
 *  1. `deriveEvidence` builds a fact ledger from the record, by code.
 *  2. The model may only cite from that ledger, and must answer a fixed set of
 *     questions about each finding, including what else could explain it.
 *  3. `applyEvidencePolicy` checks the result mechanically and demotes what the
 *     evidence does not support.
 *
 * Only the middle layer involves judgment, and it is the only one that can be
 * wrong in a way the other two cannot catch.
 */

const EVALUATION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    goalAchieved: {
      type: 'boolean',
      description: 'Did the customer actually accomplish the goal? Judge from the observed facts.',
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
          finding: { type: 'string', description: 'One sentence naming the problem.' },
          classification: { type: 'string', enum: [...CLASSIFICATIONS] },
          severity: { type: 'string', enum: [...SEVERITIES] },
          evidence: {
            type: 'string',
            description: 'Quote or closely paraphrase the observed facts you are citing.',
          },
          evidenceType: { type: 'string', enum: [...EVIDENCE_TYPES] },
          confidence: { type: 'string', enum: [...CONFIDENCES] },
          affectedPersona: { type: 'string' },
          supportingSteps: { type: 'array', items: { type: 'integer' } },
          evidenceRefs: {
            type: 'array',
            items: { type: 'string' },
            description: 'Fact ids such as "f12", from OBSERVED FACTS only. Never a belief id.',
          },
          alternativeExplanation: {
            type: 'string',
            description: 'The most plausible reading under which this is not a product problem.',
          },
          recommendation: { type: 'string' },
        },
        required: [
          'finding',
          'classification',
          'severity',
          'evidence',
          'evidenceType',
          'confidence',
          'affectedPersona',
          'supportingSteps',
          'evidenceRefs',
          'alternativeExplanation',
          'recommendation',
        ],
        additionalProperties: false,
      },
    },
    customerVerdict: {
      type: 'object',
      description:
        'How this particular customer would feel about the experience. An ' +
        'experimental signal, not a prediction of real behaviour.',
      properties: {
        satisfactionScore: {
          type: 'integer',
          description: '1 = would abandon and warn others, 5 = would recommend.',
        },
        satisfactionReason: { type: 'string' },
        wouldUseAgain: { type: 'boolean' },
        wouldUseAgainReason: { type: 'string' },
        wouldPay: {
          type: 'string',
          enum: [...WOULD_PAY_VERDICTS],
          description:
            'NOT_APPLICABLE unless the run actually reached something bearing on ' +
            'price or value. Most runs do not.',
        },
        wouldPayReason: { type: 'string' },
        confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
      },
      required: [
        'satisfactionScore',
        'satisfactionReason',
        'wouldUseAgain',
        'wouldUseAgainReason',
        'wouldPay',
        'wouldPayReason',
        'confidence',
      ],
      additionalProperties: false,
    },
  },
  required: ['goalAchieved', 'summary', 'findings', 'customerVerdict'],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You review recordings of a simulated customer using a product.

You are given two things, and the difference between them is the whole job:

OBSERVED FACTS — derived mechanically from the recording. Each has an id like
f7. These are the only things you may cite as evidence.

AGENT BELIEFS — what the simulated customer thought was happening. Ids like b3.
These are guesses, often wrong. They are NOT evidence. You may mention that the
customer believed something, but a belief can never support a claim about the
product. Never put a belief id in evidenceRefs.

Classify every finding as exactly one of:

- PRODUCT_ISSUE: the product made this hard, or it broke. Requires observed
  facts that show the product behaving that way.
- AGENT_MISUNDERSTANDING: the simulated customer got something wrong — used a
  control incorrectly, misread a message, gave up while a path was open, or drew
  a conclusion the facts do not support. Our shortcoming, not the product's.
- ENVIRONMENT_ERROR: our simulation or the browser failed. Facts labelled
  RUNTIME_FAILURE, PLANNER_FAILURE or DESTRUCTIVE_ACTION_BLOCKED are ours, never
  the product's.
- INCONCLUSIVE: something notable happened but the evidence will not settle
  whose problem it is.

Prefer INCONCLUSIVE over a PRODUCT_ISSUE you cannot evidence. An honest "we
cannot tell from this run" is worth more than a confident guess, because every
false product finding costs us the customer's trust in all the true ones.

Rules:
- Every finding needs evidenceRefs pointing at real fact ids, and
  supportingSteps that appear in the recording.
- A fact marked MESSAGE_PERSISTED_UNCHANGED means a message stayed on screen
  because the page had not re-rendered. It is NOT the product rejecting input
  again. Do not report a persisting message as repeated rejection.
- Do not contradict the computed facts. They are measurements.
- alternativeExplanation must be a real attempt at the other reading, not a
  dismissal. If the alternative is as plausible as your finding, the
  classification is INCONCLUSIVE.
- A run where nothing went wrong should produce no findings. Do not manufacture
  problems to fill space.
- Judge goalAchieved from the facts, not from what the customer claimed.

Finally, give the customer's own verdict: how this specific person, with the
expectations and constraints they arrived with, would feel about what happened.

- Answer as an assessment of this described person, not of the product in
  general. A tolerant customer and an impatient one rate the same run
  differently, and that difference is the point.
- wouldPay must be NOT_APPLICABLE unless the run actually reached something
  bearing on price or value. Most runs never do, and a forced yes/no there is
  noise dressed up as a signal.
- Set verdict confidence low when the run was short, ended in our own error, or
  never exercised what the customer cared about.`;

/** Renders the record for the model: computed facts, then the evidence ledger. */
export function renderEvaluatorPrompt(record: SessionRecord, ledger: EvidenceLedger): string {
  const facts = computeFacts(record);

  return [
    `Goal the customer was given: ${record.goal.description}`,
    `Who they were: ${record.context.persona.name} — ${record.context.persona.background}`,
    record.context.background === '' ? '' : `Their situation: ${record.context.background}`,
    record.context.motivation === '' ? '' : `Why they came: ${record.context.motivation}`,
    record.context.expectations.length === 0
      ? ''
      : `What they expected: ${record.context.expectations.join('; ')}`,
    record.context.constraints.length === 0
      ? ''
      : `What they could not change: ${record.context.constraints.join('; ')}`,
    `How the run ended: ${record.outcome ?? 'unknown'} (${record.terminationReason ?? 'unknown'})`,
    record.agentSummary === null ? '' : `What the customer said at the end: ${record.agentSummary}`,
    '',
    'COMPUTED MEASUREMENTS (not opinions):',
    describeFacts(facts),
    '',
    renderEvidence(ledger),
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export type EvaluateOptions = {
  readonly client: LlmClient;
  readonly model: string;
  /** Called with findings dropped for citing steps that never happened. */
  readonly onRejectedFindings?: (rejected: readonly Finding[]) => void;
  /** Called with reclassifications the policy imposed on the model. */
  readonly onPolicyActions?: (actions: readonly PolicyAction[]) => void;
  /** Cap on the reply, for a thin credit balance. Defaults to the client's. */
  readonly maxOutputTokens?: number;
};

export async function evaluateSession(
  record: SessionRecord,
  options: EvaluateOptions,
): Promise<Result<Evaluation, string>> {
  const facts = computeFacts(record);
  const ledger = deriveEvidence(record);

  const response = await options.client.completeJson({
    model: options.model,
    system: SYSTEM_PROMPT,
    user: renderEvaluatorPrompt(record, ledger),
    schemaName: 'session_evaluation',
    jsonSchema: EVALUATION_JSON_SCHEMA as unknown as Record<string, unknown>,
    // Judgment should be stable: the same record twice should read the same way.
    temperature: 0.1,
    ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
  });

  if (!response.ok) return err(response.error);

  const parsed = ModelEvaluationSchema.safeParse(response.value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return err(`The evaluation did not validate: ${issues}`);
  }

  const policy = applyEvidencePolicy(parsed.data.findings, ledger, record.steps.length);
  if (policy.rejected.length > 0) options.onRejectedFindings?.(policy.rejected);
  if (policy.actions.length > 0) options.onPolicyActions?.(policy.actions);

  const evaluation = EvaluationSchema.safeParse({
    sessionId: record.id,
    goalAchieved: parsed.data.goalAchieved,
    summary: parsed.data.summary,
    findings: policy.findings,
    facts,
    policyActions: policy.actions,
    customerVerdict: parsed.data.customerVerdict ?? null,
  });

  if (!evaluation.success) return err('The assembled evaluation did not validate.');
  return ok(evaluation.data);
}

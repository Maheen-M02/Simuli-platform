import type { Evaluation } from '../evaluation/schema.ts';
import type { SessionRecord } from '../sessions/types.ts';
import type { PlannerStats } from '../agent/planner.ts';
import type { UsageTotals } from '../llm/usage.ts';
import type { CustomerContext } from '../personas/context.ts';
import { measureDiversity, runPath, type DiversityReport } from './diversity.ts';
import type { GroundTruthReport } from './groundTruth.ts';

/**
 * Comparing one model provider against another on identical work.
 *
 * The one rule that makes any of this meaningful: everything except the planner's
 * provider is held constant — same target, personas, goals, prompt, action
 * schema, observation layer, termination rules, evaluator. If two things vary,
 * the numbers describe neither.
 *
 * The other rule is about what we refuse to conclude. A provider that succeeds
 * once has not won anything, and this module reports counts rather than verdicts
 * for that reason. Sample size is carried alongside every figure so a reader
 * cannot pick up a rate without seeing what it was computed from.
 */

/**
 * Why a simulation did not produce a usable result.
 *
 * The distinction that matters most: a provider outage is not an agent failure.
 * Counting a 402 as "the agent got stuck" would make an unbilled account look
 * like a bad model, which is exactly the mistake this separation prevents.
 */
export const RUN_STATUSES = [
  'SUCCESS',
  'FAILURE',
  'STUCK',
  'TIMEOUT',
  /** The agent's own machinery broke. Ours. */
  'AGENT_ERROR',
  /** The model API refused or failed. Not attributable to the agent at all. */
  'PROVIDER_FAILURE',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * Recognises a provider-side failure from the text an endpoint returned.
 *
 * Pattern matching on error strings is crude, and it is the honest option: the
 * alternative is inferring intent from a run that produced no actions, which
 * would silently absorb genuine agent failures into the excused column.
 */
export function looksLikeProviderFailure(message: string): boolean {
  return [
    // 401 unauthorised, 402 payment required, 403 forbidden, 404 unknown model.
    // 402 is deliberately in here: it is what a prepaid account actually
    // returns, and leaving it out filed every credit-exhausted run as an agent
    // error — the precise mistake this classification exists to prevent. A test
    // caught it, which is the only reason it is not still wrong.
    /\b40[1234]\b/,
    /\b429\b/,
    /\b5\d\d\b/,
    /credit/i,
    /quota/i,
    /rate limit/i,
    /insufficient/i,
    /billing/i,
    /not found for account/i,
    /ignored the requested JSON schema/i,
  ].some((pattern) => pattern.test(message));
}

export type BenchmarkRun = {
  readonly providerId: string;
  readonly model: string;
  readonly personaId: string;
  readonly taskId: string;
  readonly record: SessionRecord;
  readonly evaluation: Evaluation | null;
  readonly evaluationError: string | null;
  readonly groundTruth: GroundTruthReport | null;
  readonly wallClockMs: number;
};

/**
 * Classifies a run, separating provider outages from agent behaviour.
 *
 * A run counts as a provider failure when it produced no action at all and every
 * planner error looks like an API problem. If the agent managed even one action,
 * whatever happened afterwards is the agent's story and is reported as such.
 */
export function classifyRun(record: SessionRecord): RunStatus {
  const plannerErrors = record.steps
    .map((step) => step.plannerError)
    .filter((error): error is string => error !== null);

  const acted = record.steps.some((step) => step.action !== null);

  if (!acted && plannerErrors.length > 0 && plannerErrors.every(looksLikeProviderFailure)) {
    return 'PROVIDER_FAILURE';
  }

  switch (record.outcome) {
    case 'SUCCESS':
      return 'SUCCESS';
    case 'FAILURE':
      return 'FAILURE';
    case 'STUCK':
      return 'STUCK';
    case 'TIMEOUT':
      return 'TIMEOUT';
    default:
      return 'AGENT_ERROR';
  }
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
    : (sorted[middle] as number);
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

export type ReliabilityMetrics = {
  readonly attempted: number;
  /** Runs the agent actually got to attempt. Excludes provider outages. */
  readonly scorable: number;
  readonly providerFailures: number;
  readonly success: number;
  readonly failure: number;
  readonly stuck: number;
  readonly timeout: number;
  readonly agentError: number;
  /** success / scorable. Null when nothing was scorable. */
  readonly successRate: number | null;
  readonly averageSteps: number | null;
  readonly medianSteps: number | null;
  readonly invalidActions: number;
  readonly recoveredActions: number;
  readonly unusableActions: number;
  /** invalidActions / planner calls. The comparable reliability figure. */
  readonly invalidActionRate: number | null;
  readonly plannerCalls: number;
};

export function measureReliability(
  runs: readonly BenchmarkRun[],
  stats: PlannerStats,
): ReliabilityMetrics {
  const statuses = runs.map((run) => classifyRun(run.record));
  const count = (status: RunStatus): number => statuses.filter((s) => s === status).length;

  const providerFailures = count('PROVIDER_FAILURE');
  const scorable = runs.length - providerFailures;

  // Steps are counted only for runs the agent actually got to drive.
  const steps = runs
    .filter((_, index) => statuses[index] !== 'PROVIDER_FAILURE')
    .map((run) => run.record.steps.length);

  const success = count('SUCCESS');

  return {
    attempted: runs.length,
    scorable,
    providerFailures,
    success,
    failure: count('FAILURE'),
    stuck: count('STUCK'),
    timeout: count('TIMEOUT'),
    agentError: count('AGENT_ERROR'),
    successRate: scorable === 0 ? null : success / scorable,
    averageSteps: mean(steps),
    medianSteps: median(steps),
    invalidActions: stats.invalidActions,
    recoveredActions: stats.recoveredActions,
    unusableActions: stats.unusable,
    invalidActionRate: stats.calls === 0 ? null : stats.invalidActions / stats.calls,
    plannerCalls: stats.calls,
  };
}

export type PersonaAdherence = {
  readonly personaId: string;
  /** Steps whose reasoning referenced something specific to this persona. */
  readonly referencingSteps: number;
  readonly totalSteps: number;
  /** Quotes, so a reader can judge whether the match was meaningful. */
  readonly examples: readonly string[];
};

/**
 * Whether the persona appears to have influenced what the agent said.
 *
 * Keyword matching against the distinctive words of that persona's own context,
 * and no more than that. It cannot tell genuine influence from coincidence — an
 * agent might mention price because the page did — which is why the examples are
 * carried alongside the count. Read them.
 *
 * The honest framing: a zero here is strong evidence the persona did nothing. A
 * high number is weak evidence that it did.
 */
export function measurePersonaAdherence(
  personaId: string,
  context: CustomerContext,
  records: readonly SessionRecord[],
): PersonaAdherence {
  const stop = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has', 'not', 'are', 'was',
    'will', 'would', 'should', 'their', 'them', 'they', 'she', 'his', 'her', 'its', 'about',
    'into', 'than', 'then', 'been', 'before', 'after', 'without', 'anything', 'everything',
    'something', 'because', 'which', 'what', 'when', 'where', 'who', 'how', 'any', 'all',
    'more', 'most', 'much', 'very', 'just', 'only', 'also', 'able', 'cannot', 'want', 'wants',
    'needs', 'need', 'used', 'uses', 'using', 'does', 'doing', 'done', 'own', 'one', 'two',
    'run', 'runs', 'get', 'gets', 'good', 'well', 'like', 'make', 'made', 'take', 'takes',
  ]);

  const distinctive = new Set<string>();
  const source = [
    context.persona.background,
    context.background,
    context.motivation,
    ...context.persona.priorities,
    ...context.persona.wontDo,
    ...context.expectations,
    ...context.constraints,
  ].join(' ');

  for (const word of source.toLowerCase().match(/[a-z]{4,}/g) ?? []) {
    if (!stop.has(word)) distinctive.add(word);
  }

  let referencingSteps = 0;
  let totalSteps = 0;
  const examples: string[] = [];

  for (const record of records) {
    for (const step of record.steps) {
      if (step.action === null) continue;
      totalSteps += 1;

      const reasoning = step.action.reasoning.toLowerCase();
      const hits = [...distinctive].filter((word) => reasoning.includes(word));
      // Two distinctive words, not one: a single common word matches by accident.
      if (hits.length >= 2) {
        referencingSteps += 1;
        if (examples.length < 3) examples.push(step.action.reasoning);
      }
    }
  }

  return { personaId, referencingSteps, totalSteps, examples };
}

export type EvaluatorMetrics = {
  readonly runsEvaluated: number;
  readonly evaluationFailures: number;
  readonly detected: number;
  readonly missed: number;
  readonly falsePositives: number;
  readonly unmatched: number;
  readonly precision: number | null;
  readonly recall: number | null;
  readonly f1: number | null;
};

/**
 * Detection quality against the target's known issues.
 *
 * Precision uses only *likely* false positives — findings citing a page we know
 * works. Unmatched findings are reported separately and excluded, because a
 * fixture author does not know everything about their own product and counting
 * every unrecognised finding as wrong would punish a model for finding something
 * real that we failed to plant.
 */
export function measureEvaluator(runs: readonly BenchmarkRun[]): EvaluatorMetrics {
  const scored = runs.filter((run) => run.groundTruth !== null);

  let detected = 0;
  let missed = 0;
  let falsePositives = 0;
  let unmatched = 0;

  for (const run of scored) {
    const report = run.groundTruth as NonNullable<typeof run.groundTruth>;
    detected += report.detected.length;
    missed += report.missed.length;
    falsePositives += report.likelyFalsePositives.length;
    unmatched += report.unmatchedProductFindings.length - report.likelyFalsePositives.length;
  }

  const precision = detected + falsePositives === 0 ? null : detected / (detected + falsePositives);
  const recall = detected + missed === 0 ? null : detected / (detected + missed);

  return {
    runsEvaluated: scored.length,
    evaluationFailures: runs.filter((run) => run.evaluation === null).length,
    detected,
    missed,
    falsePositives,
    unmatched,
    precision,
    recall,
    f1:
      precision === null || recall === null || precision + recall === 0
        ? null
        : (2 * precision * recall) / (precision + recall),
  };
}

export type ProviderReport = {
  readonly providerId: string;
  readonly model: string;
  readonly reliability: ReliabilityMetrics;
  readonly adherence: readonly PersonaAdherence[];
  readonly diversity: DiversityReport;
  readonly evaluator: EvaluatorMetrics;
  readonly usage: UsageTotals;
  readonly averageWallClockMs: number | null;
  readonly costPerSimulation: number | null;
};

export function buildProviderReport(input: {
  readonly providerId: string;
  readonly model: string;
  readonly runs: readonly BenchmarkRun[];
  readonly stats: PlannerStats;
  readonly usage: UsageTotals;
  readonly contexts: ReadonlyMap<string, CustomerContext>;
}): ProviderReport {
  const { runs, stats, usage } = input;
  const reliability = measureReliability(runs, stats);

  const personaIds = [...new Set(runs.map((run) => run.personaId))];
  const adherence = personaIds.map((personaId) => {
    const context = input.contexts.get(personaId);
    const records = runs.filter((run) => run.personaId === personaId).map((run) => run.record);
    return context === undefined
      ? { personaId, referencingSteps: 0, totalSteps: 0, examples: [] }
      : measurePersonaAdherence(personaId, context, records);
  });

  // Diversity is measured only over runs that produced actions. Including an
  // outage would report identical paths and read as "the persona made no
  // difference" when in fact nobody got to act.
  const acted = runs.filter((run) => classifyRun(run.record) !== 'PROVIDER_FAILURE');

  return {
    providerId: input.providerId,
    model: input.model,
    reliability,
    adherence,
    diversity: measureDiversity(
      acted.map((run) => runPath(`${run.personaId}/${run.taskId}`, run.record)),
    ),
    evaluator: measureEvaluator(runs),
    usage,
    averageWallClockMs: mean(acted.map((run) => run.wallClockMs)),
    costPerSimulation:
      usage.costUsd === null || acted.length === 0 ? null : usage.costUsd / acted.length,
  };
}

function pct(value: number | null): string {
  return value === null ? 'n/a' : `${Math.round(value * 100)}%`;
}

function num(value: number | null, digits = 1): string {
  return value === null ? 'n/a' : value.toFixed(digits);
}

export function formatProviderReport(report: ProviderReport): string {
  const r = report.reliability;
  const e = report.evaluator;
  const lines = [
    `${report.providerId}  (${report.model})`,
    '',
    '  Agent execution',
    `    attempted              ${r.attempted}`,
    `    provider failures      ${r.providerFailures}  (not agent failures; excluded below)`,
    `    scorable               ${r.scorable}`,
    `      success              ${r.success}`,
    `      failure              ${r.failure}`,
    `      stuck                ${r.stuck}`,
    `      timeout              ${r.timeout}`,
    `      agent error          ${r.agentError}`,
    `    success rate           ${pct(r.successRate)}${r.scorable === 0 ? '' : ` of ${r.scorable}`}`,
    `    average steps          ${num(r.averageSteps)}`,
    `    median steps           ${num(r.medianSteps)}`,
    `    planner calls          ${r.plannerCalls}`,
    `    invalid actions        ${r.invalidActions}  (rate ${pct(r.invalidActionRate)})`,
    `    recovered on retry     ${r.recoveredActions}`,
    `    never usable           ${r.unusableActions}`,
    '',
    '  Evaluation against known ground truth',
    `    runs evaluated         ${e.runsEvaluated}${e.evaluationFailures > 0 ? `  (${e.evaluationFailures} evaluations failed)` : ''}`,
    `    known issues detected  ${e.detected}`,
    `    known issues missed    ${e.missed}`,
    `    false positives        ${e.falsePositives}  (findings about pages we know work)`,
    `    unmatched findings     ${e.unmatched}  (may include real problems we did not plant)`,
    `    precision              ${pct(e.precision)}`,
    `    recall                 ${pct(e.recall)}`,
    `    f1                     ${pct(e.f1)}`,
    '',
    '  Behaviour',
    `    distinct paths         ${report.diversity.uniquePaths.length}`,
    `    distinct path seqs     ${report.diversity.uniquePathSequences} of ${report.diversity.runs}`,
    `    distinct action seqs   ${report.diversity.uniqueActionSequences} of ${report.diversity.runs}`,
    `    first divergence       ${report.diversity.firstDivergenceStep ?? 'never'}`,
    `    reached by all         ${report.diversity.pathsFoundByAll.join(', ') || '(none)'}`,
    `    reached by one only    ${report.diversity.pathsFoundByOne.join(', ') || '(none)'}`,
    '',
    '  Persona adherence (keyword match on the agent’s own reasoning — approximate)',
  ];

  for (const entry of report.adherence) {
    const share = entry.totalSteps === 0 ? 'n/a' : pct(entry.referencingSteps / entry.totalSteps);
    lines.push(`    ${entry.personaId.padEnd(24)} ${entry.referencingSteps}/${entry.totalSteps} steps  ${share}`);
  }

  lines.push(
    '',
    '  Economics',
    `    model calls            ${report.usage.calls}${report.usage.failedCalls > 0 ? ` (${report.usage.failedCalls} failed)` : ''}`,
    `    input tokens           ${report.usage.inputTokens}${report.usage.tokensIncomplete ? ' (incomplete)' : ''}`,
    `    output tokens          ${report.usage.outputTokens}`,
    `    average latency        ${report.usage.averageLatencyMs === null ? 'n/a' : `${report.usage.averageLatencyMs}ms per call`}`,
    `    average wall clock     ${report.averageWallClockMs === null ? 'n/a' : `${Math.round(report.averageWallClockMs / 1000)}s per simulation`}`,
    `    estimated cost         ${report.usage.costUsd === null ? 'rates not configured' : `$${report.usage.costUsd.toFixed(4)}`}`,
    `    cost per simulation    ${report.costPerSimulation === null ? 'rates not configured' : `$${report.costPerSimulation.toFixed(4)}`}`,
  );

  return lines.join('\n');
}

/**
 * The comparison, with the caveats attached rather than left to a reader.
 *
 * Refuses to name a winner. That is a judgment for a person holding more than
 * one run's worth of evidence, and a function that printed one would be quoted
 * as though it had made a finding.
 */
export function formatComparison(reports: readonly ProviderReport[]): string {
  const lines = ['', 'Model comparison', ''];

  for (const report of reports) {
    lines.push(formatProviderReport(report), '');
  }

  const scorable = reports.reduce((total, report) => total + report.reliability.scorable, 0);

  lines.push('  Read this before comparing the numbers above.', '');

  if (scorable === 0) {
    lines.push(
      '    No simulation completed on any provider. Every figure above is empty and',
      '    nothing can be concluded about either model.',
    );
  } else if (scorable < 12) {
    lines.push(
      `    Only ${scorable} simulations completed across all providers. That is far too small a`,
      '    sample to compare success rates: a single run changes each figure by several',
      '    percentage points. Treat this as a smoke test of the harness, not a result.',
    );
  } else {
    lines.push(
      `    ${scorable} simulations completed. Still a small sample. A difference of one or two`,
      '    runs is noise, and no single metric settles which provider is better suited.',
    );
  }

  const uneven = reports.filter((report) => report.reliability.providerFailures > 0);
  if (uneven.length > 0) {
    lines.push(
      '',
      '    These providers had API failures, so their arms are not the same size:',
      ...uneven.map(
        (report) =>
          `      ${report.providerId}: ${report.reliability.providerFailures} of ${report.reliability.attempted} never ran`,
      ),
      '    Comparing rates across arms of different sizes overstates whichever one ran more.',
    );
  }

  if (reports.some((report) => report.usage.costUsd === null)) {
    lines.push(
      '',
      '    Cost is unpriced for at least one provider. Rates are configuration, not',
      '    something this harness will guess: an invented price looks like a measurement.',
    );
  }

  return lines.join('\n');
}

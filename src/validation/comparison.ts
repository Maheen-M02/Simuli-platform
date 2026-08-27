import type { Evaluation } from '../evaluation/schema.ts';
import type { SessionRecord } from '../sessions/types.ts';
import { describeAction } from '../actions/schema.ts';
import { formatDiversity, measureDiversity, runPath, type RunPath } from './diversity.ts';

/**
 * Side-by-side comparison of several personas on one task.
 *
 * The comparison is the experiment. A single run tells us whether the agent can
 * use a product; several runs of materially different customers on the same task
 * tell us whether the persona changes anything — which is the claim the business
 * rests on.
 */

export type PersonaRun = {
  readonly personaId: string;
  readonly personaLabel: string;
  readonly record: SessionRecord;
  /** Absent when evaluation failed. The run is still comparable. */
  readonly evaluation: Evaluation | null;
  readonly evaluationError: string | null;
};

export type ComparisonRow = {
  readonly personaId: string;
  readonly personaLabel: string;
  readonly outcome: string;
  readonly terminationReason: string;
  readonly steps: number;
  readonly durationSeconds: number;
  readonly navigationPath: readonly string[];
  readonly actions: readonly string[];
  /** Product findings, which is what a customer would call friction. */
  readonly productIssues: readonly string[];
  readonly agentMisunderstandings: readonly string[];
  readonly environmentErrors: readonly string[];
  readonly satisfaction: number | null;
  readonly wouldUseAgain: boolean | null;
};

function secondsFor(record: SessionRecord): number {
  return record.endedAt === null ? 0 : Math.round((record.endedAt - record.startedAt) / 1000);
}

function findingsOf(evaluation: Evaluation | null, of: string): string[] {
  return evaluation === null
    ? []
    : evaluation.findings.filter((f) => f.classification === of).map((f) => f.finding);
}

export function buildComparison(runs: readonly PersonaRun[]): {
  readonly rows: readonly ComparisonRow[];
  readonly paths: readonly RunPath[];
} {
  const rows = runs.map((run): ComparisonRow => {
    const path = runPath(run.personaId, run.record);
    return {
      personaId: run.personaId,
      personaLabel: run.personaLabel,
      outcome: run.record.outcome ?? 'UNKNOWN',
      terminationReason: run.record.terminationReason ?? 'unknown',
      steps: run.record.steps.length,
      durationSeconds: secondsFor(run.record),
      navigationPath: path.path,
      actions: run.record.steps
        .filter((step) => step.action !== null)
        .map((step) => describeAction(step.action as NonNullable<typeof step.action>)),
      productIssues: findingsOf(run.evaluation, 'PRODUCT_ISSUE'),
      agentMisunderstandings: findingsOf(run.evaluation, 'AGENT_MISUNDERSTANDING'),
      environmentErrors: findingsOf(run.evaluation, 'ENVIRONMENT_ERROR'),
      satisfaction: run.evaluation?.customerVerdict?.satisfactionScore ?? null,
      wouldUseAgain: run.evaluation?.customerVerdict?.wouldUseAgain ?? null,
    };
  });

  return { rows, paths: runs.map((run) => runPath(run.personaId, run.record)) };
}

export function formatComparison(input: {
  readonly taskId: string;
  readonly taskLabel: string;
  readonly rows: readonly ComparisonRow[];
  readonly paths: readonly RunPath[];
}): string {
  const lines = [
    '',
    `Comparison — ${input.taskLabel}  (${input.taskId})`,
    '',
    '  persona                   outcome   steps  time  satisfaction  product  agent',
    '  ' + '-'.repeat(74),
  ];

  for (const row of input.rows) {
    lines.push(
      '  ' +
        row.personaId.padEnd(25) +
        row.outcome.padEnd(10) +
        String(row.steps).padStart(4) +
        String(`${row.durationSeconds}s`).padStart(7) +
        (row.satisfaction === null ? '     n/a' : `     ${row.satisfaction}/5`).padStart(14) +
        String(row.productIssues.length).padStart(8) +
        String(row.agentMisunderstandings.length).padStart(7),
    );
  }

  lines.push('', '  Navigation paths', '');
  for (const row of input.rows) {
    lines.push(`    ${row.personaId}`);
    lines.push(`      ${row.navigationPath.join(' > ') || '(never moved)'}`);
    lines.push(`      stopped because: ${row.terminationReason}`);
    lines.push('');
  }

  const anyFindings = input.rows.some(
    (row) =>
      row.productIssues.length + row.agentMisunderstandings.length + row.environmentErrors.length > 0,
  );

  if (anyFindings) {
    lines.push('  What each persona hit', '');
    for (const row of input.rows) {
      lines.push(`    ${row.personaId}`);
      for (const finding of row.productIssues) lines.push(`      product  ${finding}`);
      for (const finding of row.agentMisunderstandings) lines.push(`      agent    ${finding}`);
      for (const finding of row.environmentErrors) lines.push(`      tooling  ${finding}`);
      if (row.productIssues.length + row.agentMisunderstandings.length + row.environmentErrors.length === 0) {
        lines.push('      (nothing reported)');
      }
      lines.push('');
    }
  } else {
    lines.push('  No findings were produced for any persona.', '');
  }

  lines.push(formatDiversity(measureDiversity(input.paths)));

  lines.push(
    '',
    '  These are simulated customers. Nothing here is evidence about how a real person',
    '  would behave — only about how these described customers behaved on this run.',
  );

  return lines.join('\n');
}

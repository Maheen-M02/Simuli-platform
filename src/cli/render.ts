import type { Evaluation, Finding } from '../evaluation/schema.ts';
import type { SessionRecord } from '../sessions/types.ts';
import { describeAction } from '../actions/schema.ts';

/**
 * Human-readable output.
 *
 * The report is written for a product person, not an engineer. Two things are
 * always visible whether or not they flatter us: which findings are our own
 * agent's shortcomings rather than the product's, and whether the run was
 * technically sound at all. A report that hides those is worth nothing the
 * first time somebody checks it.
 */

const RESET = '[0m';
const BOLD = '[1m';
const DIM = '[2m';
const RED = '[31m';
const GREEN = '[32m';
const YELLOW = '[33m';
const BLUE = '[34m';

let colorEnabled = true;

export function setColorEnabled(enabled: boolean): void {
  colorEnabled = enabled;
}

function paint(code: string, text: string): string {
  return colorEnabled ? `${code}${text}${RESET}` : text;
}

const OUTCOME_COLOR: Record<string, string> = {
  SUCCESS: GREEN,
  FAILURE: YELLOW,
  STUCK: YELLOW,
  TIMEOUT: YELLOW,
  ERROR: RED,
};

const CLASSIFICATION_LABEL: Record<Finding['classification'], string> = {
  PRODUCT_ISSUE: 'product',
  AGENT_MISUNDERSTANDING: 'our agent',
  ENVIRONMENT_ERROR: 'our tooling',
  INCONCLUSIVE: 'inconclusive',
};

export function renderProgress(stepIndex: number, record: string): string {
  return `${paint(DIM, `step ${String(stepIndex + 1).padStart(2)}`)}  ${record}`;
}

export function renderRecord(record: SessionRecord): string {
  const lines: string[] = [''];
  const outcome = record.outcome ?? 'UNKNOWN';

  lines.push(paint(BOLD, 'Run'));
  lines.push(`  Goal      ${record.goal.description}`);
  lines.push(`  Customer  ${record.persona.name}`);
  lines.push(`  Outcome   ${paint(OUTCOME_COLOR[outcome] ?? '', outcome)} ${paint(DIM, `(${record.terminationReason ?? '—'})`)}`);
  lines.push(`  Steps     ${record.steps.length}`);

  if (record.endedAt !== null) {
    lines.push(`  Duration  ${Math.round((record.endedAt - record.startedAt) / 1000)}s`);
  }
  if (record.agentSummary !== null) {
    lines.push(`  Said      ${record.agentSummary}`);
  }

  return lines.join('\n');
}

export function renderSteps(record: SessionRecord): string {
  const lines = ['', paint(BOLD, 'What the customer did')];

  for (const step of record.steps) {
    if (step.action === null) {
      lines.push(`  ${String(step.index).padStart(2)}. ${paint(DIM, step.plannerError ?? 'no action')}`);
      continue;
    }

    const failed = step.result !== null && !step.result.ok;
    const marker = failed ? paint(RED, '✗') : paint(GREEN, '✓');
    lines.push(`  ${String(step.index).padStart(2)}. ${marker} ${describeAction(step.action)}`);
    lines.push(`      ${paint(DIM, step.action.reasoning)}`);
    if (failed) {
      lines.push(`      ${paint(RED, step.result?.error?.message ?? 'failed')}`);
    }
  }

  return lines.join('\n');
}

export function renderEvaluation(evaluation: Evaluation): string {
  const lines = ['', paint(BOLD, 'What we found'), '', `  ${evaluation.summary}`, ''];

  if (!evaluation.facts.runIsTechnicallySound) {
    lines.push(
      paint(
        YELLOW,
        '  Note: this run hit failures in our own tooling. Treat the findings below with care.',
      ),
      '',
    );
  }

  if (evaluation.findings.length === 0) {
    lines.push(paint(DIM, '  Nothing got in the customer’s way.'));
    return lines.join('\n');
  }

  const order: Finding['severity'][] = ['high', 'medium', 'low'];
  const sorted = [...evaluation.findings].sort(
    (a, b) => order.indexOf(a.severity) - order.indexOf(b.severity),
  );

  for (const finding of sorted) {
    const severity =
      finding.severity === 'high'
        ? paint(RED, 'high')
        : finding.severity === 'medium'
          ? paint(YELLOW, 'medium')
          : paint(DIM, 'low');

    // Classification is never hidden: a finding that is our fault says so, and
    // one we could not settle says that rather than implying a product defect.
    const label = CLASSIFICATION_LABEL[finding.classification];
    const classification = paint(finding.classification === 'PRODUCT_ISSUE' ? BLUE : DIM, label);

    lines.push(`  ${paint(BOLD, finding.finding)}  ${severity} · ${classification} · ${paint(DIM, `${finding.confidence} confidence`)}`);
    lines.push(`    ${paint(DIM, 'Evidence:')} ${finding.evidence}`);
    lines.push(`    ${paint(DIM, 'Or perhaps:')} ${finding.alternativeExplanation}`);
    lines.push(`    ${paint(DIM, 'Suggested:')} ${finding.recommendation}`);
    lines.push(
      `    ${paint(DIM, `steps ${finding.supportingSteps.join(', ')} · ${finding.evidenceType} · affects ${finding.affectedPersona}`)}`,
    );
    lines.push('');
  }

  const counts = new Map<Finding['classification'], number>();
  for (const finding of evaluation.findings) {
    counts.set(finding.classification, (counts.get(finding.classification) ?? 0) + 1);
  }
  lines.push(
    paint(
      DIM,
      '  ' +
        [...counts.entries()]
          .map(([classification, n]) => `${n} ${CLASSIFICATION_LABEL[classification]}`)
          .join(', '),
    ),
  );

  // Overriding the model is a signal about our own reliability, so it is shown
  // rather than quietly applied.
  if (evaluation.policyActions.length > 0) {
    lines.push(
      '',
      paint(YELLOW, `  ${evaluation.policyActions.length} finding(s) were reclassified because the evidence did not support them:`),
    );
    for (const action of evaluation.policyActions) {
      lines.push(paint(DIM, `    ${action.from} -> ${action.to}: ${action.reason}`));
    }
  }

  return lines.join('\n');
}

export function renderFooter(sessionId: string, dataDir: string): string {
  return ['', `${paint(DIM, 'Session')} ${sessionId}`, `${paint(DIM, 'Recorded in')} ${dataDir}`, ''].join('\n');
}

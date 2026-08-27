import type { Evaluation, Finding } from '../evaluation/schema.ts';
import type { SessionRecord } from '../sessions/types.ts';
import { pathOf } from './diversity.ts';

/**
 * Scoring findings against known answers.
 *
 * The matching below is keyword-and-path based, which is approximate, and that
 * is stated rather than hidden. A recall number computed this way is a starting
 * point for a human reading the findings, not a substitute for it.
 *
 * Two design choices worth defending:
 *
 * A finding must both *mention the subject* and *rest on a step where the
 * problem is visible*. Either test alone matches far too much: keywords alone
 * credit us for a finding about billing that was actually about something else,
 * and paths alone credit us for any finding at all that happened to touch the
 * right page.
 *
 * A known issue is only scored on tasks that could plausibly surface it. Marking
 * `weight-validation-uncommunicated` as missed on a task that never books a
 * shipment would be counting our recall against pages the customer had no
 * reason to visit, which makes the number meaningless in the flattering
 * direction as soon as we add tasks.
 */

/** The shape the fixture's ground truth must satisfy. Structural, not imported. */
export type GroundTruthIssue = {
  readonly id: string;
  readonly description: string;
  readonly expected: string;
  readonly detection: {
    readonly anyKeyword: readonly string[];
    readonly onPaths: readonly string[];
  };
  readonly reachableFromTasks: readonly string[];
};

export type GroundTruthNonIssue = {
  readonly id: string;
  readonly description: string;
  readonly paths: readonly string[];
};

export type GroundTruth = {
  readonly issues: readonly GroundTruthIssue[];
  readonly nonIssues: readonly GroundTruthNonIssue[];
};

export type IssueVerdict = {
  readonly issueId: string;
  readonly detected: boolean;
  /** The finding credited with detecting it, when one was. */
  readonly matchedFinding: string | null;
  /** Why it matched, or why nothing did. Always populated. */
  readonly reason: string;
};

export type FalsePositive = {
  readonly finding: string;
  /** The non-issue it appears to be about, when identifiable. */
  readonly aboutNonIssue: string | null;
  readonly reason: string;
};

export type GroundTruthReport = {
  readonly taskId: string;
  readonly personaId: string;
  readonly sessionId: string;
  /** Issues in scope for this task. Others are not scored. */
  readonly issuesInScope: readonly string[];
  readonly detected: readonly IssueVerdict[];
  readonly missed: readonly IssueVerdict[];
  /**
   * Product findings that match no known issue.
   *
   * Called "unmatched" rather than "false" because a fixture author does not
   * know everything about their own product. Some of these will be real
   * problems we did not plant. Only the ones about a known non-issue are
   * confidently wrong.
   */
  readonly unmatchedProductFindings: readonly FalsePositive[];
  /** Unmatched findings that are about something we know works. */
  readonly likelyFalsePositives: readonly FalsePositive[];
  readonly agentMisunderstandings: number;
  readonly environmentErrors: number;
  readonly inconclusive: number;
  readonly runIsTechnicallySound: boolean;
};

function findingText(finding: Finding): string {
  return `${finding.finding} ${finding.evidence} ${finding.recommendation}`.toLowerCase();
}

/** Paths the finding's cited steps actually landed on. */
function citedPaths(finding: Finding, record: SessionRecord): string[] {
  return finding.supportingSteps
    .map((index) => record.steps[index])
    .filter((step): step is NonNullable<typeof step> => step !== undefined)
    .map((step) => pathOf(step.observation.url));
}

export function matchesIssue(
  finding: Finding,
  issue: GroundTruthIssue,
  record: SessionRecord,
): boolean {
  const text = findingText(finding);
  const mentions = issue.detection.anyKeyword.some((keyword) => text.includes(keyword.toLowerCase()));
  if (!mentions) return false;

  if (issue.detection.onPaths.length === 0) return true;
  const paths = citedPaths(finding, record);
  return paths.some((path) => issue.detection.onPaths.includes(path));
}

function matchesNonIssue(
  finding: Finding,
  nonIssue: GroundTruthNonIssue,
  record: SessionRecord,
): boolean {
  if (nonIssue.paths.length === 0) return false;
  const paths = citedPaths(finding, record);
  return paths.some((path) => nonIssue.paths.includes(path));
}

export function scoreAgainstGroundTruth(input: {
  readonly taskId: string;
  readonly personaId: string;
  readonly record: SessionRecord;
  readonly evaluation: Evaluation;
  readonly groundTruth: GroundTruth;
}): GroundTruthReport {
  const { taskId, personaId, record, evaluation, groundTruth } = input;

  const productFindings = evaluation.findings.filter((f) => f.classification === 'PRODUCT_ISSUE');
  const inScope = groundTruth.issues.filter((issue) => issue.reachableFromTasks.includes(taskId));

  const detected: IssueVerdict[] = [];
  const missed: IssueVerdict[] = [];
  /** Findings credited to an issue, so they are not also counted as unmatched. */
  const credited = new Set<Finding>();

  for (const issue of inScope) {
    const match = productFindings.find((finding) => matchesIssue(finding, issue, record));
    if (match !== undefined) {
      credited.add(match);
      detected.push({
        issueId: issue.id,
        detected: true,
        matchedFinding: match.finding,
        reason: 'A product finding mentioned the subject and cited a step where it is visible.',
      });
    } else {
      const anyMention = productFindings.some((finding) =>
        issue.detection.anyKeyword.some((keyword) => findingText(finding).includes(keyword.toLowerCase())),
      );
      missed.push({
        issueId: issue.id,
        detected: false,
        matchedFinding: null,
        reason: anyMention
          ? 'A finding mentioned the subject but cited no step on a page where the problem shows.'
          : 'No product finding mentioned the subject at all.',
      });
    }
  }

  const unmatched: FalsePositive[] = [];
  const likely: FalsePositive[] = [];

  for (const finding of productFindings) {
    if (credited.has(finding)) continue;

    const nonIssue = groundTruth.nonIssues.find((candidate) => matchesNonIssue(finding, candidate, record));
    const entry: FalsePositive = {
      finding: finding.finding,
      aboutNonIssue: nonIssue?.id ?? null,
      reason:
        nonIssue === undefined
          ? 'Matches no known issue. May be a real problem we did not plant — read it before dismissing it.'
          : `Cites a page we know works: ${nonIssue.id} — ${nonIssue.description}`,
    };

    unmatched.push(entry);
    if (nonIssue !== undefined) likely.push(entry);
  }

  return {
    taskId,
    personaId,
    sessionId: record.id,
    issuesInScope: inScope.map((issue) => issue.id),
    detected,
    missed,
    unmatchedProductFindings: unmatched,
    likelyFalsePositives: likely,
    agentMisunderstandings: evaluation.findings.filter((f) => f.classification === 'AGENT_MISUNDERSTANDING').length,
    environmentErrors: evaluation.findings.filter((f) => f.classification === 'ENVIRONMENT_ERROR').length,
    inconclusive: evaluation.findings.filter((f) => f.classification === 'INCONCLUSIVE').length,
    runIsTechnicallySound: evaluation.facts.runIsTechnicallySound,
  };
}

export type GroundTruthTotals = {
  readonly runsScored: number;
  readonly detected: number;
  readonly missed: number;
  readonly unmatched: number;
  readonly likelyFalsePositives: number;
  readonly agentMisunderstandings: number;
  readonly environmentErrors: number;
  readonly inconclusive: number;
  /** Detected / in-scope, across all scored runs. Null when nothing was in scope. */
  readonly recall: number | null;
  /** Issues found by at least one persona. */
  readonly issuesFoundByAnyone: readonly string[];
  /** In scope for someone, found by nobody. The list worth acting on. */
  readonly issuesFoundByNobody: readonly string[];
};

export function totalGroundTruth(reports: readonly GroundTruthReport[]): GroundTruthTotals {
  const found = new Set<string>();
  const inScope = new Set<string>();

  let detected = 0;
  let missed = 0;

  for (const report of reports) {
    for (const id of report.issuesInScope) inScope.add(id);
    for (const verdict of report.detected) {
      found.add(verdict.issueId);
      detected += 1;
    }
    missed += report.missed.length;
  }

  return {
    runsScored: reports.length,
    detected,
    missed,
    unmatched: reports.reduce((n, r) => n + r.unmatchedProductFindings.length, 0),
    likelyFalsePositives: reports.reduce((n, r) => n + r.likelyFalsePositives.length, 0),
    agentMisunderstandings: reports.reduce((n, r) => n + r.agentMisunderstandings, 0),
    environmentErrors: reports.reduce((n, r) => n + r.environmentErrors, 0),
    inconclusive: reports.reduce((n, r) => n + r.inconclusive, 0),
    recall: detected + missed === 0 ? null : detected / (detected + missed),
    issuesFoundByAnyone: [...found].sort(),
    issuesFoundByNobody: [...inScope].filter((id) => !found.has(id)).sort(),
  };
}

export function formatGroundTruth(
  reports: readonly GroundTruthReport[],
  totals: GroundTruthTotals,
): string {
  const lines = ['Against known ground truth', ''];

  for (const report of reports) {
    lines.push(`  ${report.personaId}  (session ${report.sessionId.slice(0, 8)})`);
    if (!report.runIsTechnicallySound) {
      lines.push('    run was NOT technically sound — treat these findings with care');
    }
    for (const verdict of report.detected) lines.push(`    found   ${verdict.issueId}`);
    for (const verdict of report.missed) lines.push(`    missed  ${verdict.issueId} — ${verdict.reason}`);
    for (const entry of report.likelyFalsePositives) {
      lines.push(`    FALSE   "${entry.finding}" — ${entry.reason}`);
    }
    for (const entry of report.unmatchedProductFindings) {
      if (entry.aboutNonIssue !== null) continue;
      lines.push(`    unmatched "${entry.finding}"`);
    }
    lines.push('');
  }

  lines.push(
    '  Totals',
    `    runs scored              ${totals.runsScored}`,
    `    known issues detected    ${totals.detected}`,
    `    known issues missed      ${totals.missed}`,
    `    recall over in-scope     ${totals.recall === null ? 'n/a' : `${Math.round(totals.recall * 100)}%`}`,
    `    likely false positives   ${totals.likelyFalsePositives}  (findings about pages we know work)`,
    `    unmatched findings       ${totals.unmatched}  (includes possible real problems we did not plant)`,
    `    agent misunderstandings  ${totals.agentMisunderstandings}`,
    `    environment errors       ${totals.environmentErrors}`,
    `    inconclusive             ${totals.inconclusive}`,
  );

  if (totals.issuesFoundByNobody.length > 0) {
    lines.push('', `  In scope but found by nobody: ${totals.issuesFoundByNobody.join(', ')}`);
  }

  lines.push(
    '',
    '  Matching is keyword-and-path based and therefore approximate. Read the findings',
    '  before quoting the recall figure.',
  );

  return lines.join('\n');
}

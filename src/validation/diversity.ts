import { actionSignature } from '../actions/schema.ts';
import type { SessionRecord } from '../sessions/types.ts';

/**
 * Behavioural diversity signals.
 *
 * Deliberately just counting. Every number here is a count of something you can
 * point at in a session record, and none of it claims to measure similarity
 * between people. We have no basis for such a claim: there is no human baseline
 * to calibrate against, and a plausible-looking distance metric would only
 * launder that absence into a figure somebody would quote.
 *
 * What these numbers *can* answer is narrower and still worth having: did
 * different personas actually behave differently, or is the persona input
 * decoration? If six materially different customers walk an identical path, we
 * are running a script with extra adjectives and should say so.
 */

export type RunPath = {
  readonly personaId: string;
  /** URL paths in visit order, consecutive duplicates collapsed. */
  readonly path: readonly string[];
  /** Action signatures in order. Reasoning excluded — that is the point. */
  readonly actions: readonly string[];
  readonly outcome: string;
  readonly stepCount: number;
};

/** Strips origin and query, so runs on different ports compare. */
export function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname.replace(/\/+$/, '') || '/';
  } catch {
    return url;
  }
}

export function runPath(personaId: string, record: SessionRecord): RunPath {
  const path: string[] = [];
  for (const step of record.steps) {
    const current = pathOf(step.observation.url);
    // Consecutive duplicates are noise: three actions on one form is one visit.
    if (path.at(-1) !== current) path.push(current);
  }

  return {
    personaId,
    path,
    actions: record.steps
      .filter((step) => step.action !== null)
      .map((step) => actionSignature(step.action as NonNullable<typeof step.action>)),
    outcome: record.outcome ?? 'UNKNOWN',
    stepCount: record.steps.length,
  };
}

export type PathReach = {
  readonly path: string;
  /** How many personas reached it. 1 means only one customer found it. */
  readonly personaCount: number;
  readonly personaIds: readonly string[];
};

export type DiversityReport = {
  readonly runs: number;
  /** Distinct URL paths any persona reached. */
  readonly uniquePaths: readonly string[];
  /** Distinct full path sequences. Equal to `runs` means no two agreed. */
  readonly uniquePathSequences: number;
  /** Distinct full action sequences. */
  readonly uniqueActionSequences: number;
  /**
   * Step index at which the runs stopped agreeing on where to go.
   *
   * Null when every run took the same path, which is the finding that would
   * most undermine the premise.
   */
  readonly firstDivergenceStep: number | null;
  /** Every path, with how many personas found it. Rarest first. */
  readonly reach: readonly PathReach[];
  /** Paths exactly one persona reached. The interesting ones. */
  readonly pathsFoundByOne: readonly string[];
  /** Paths every persona reached. The obvious ones. */
  readonly pathsFoundByAll: readonly string[];
  readonly outcomesByPersona: readonly { readonly personaId: string; readonly outcome: string }[];
  readonly stepCounts: readonly { readonly personaId: string; readonly steps: number }[];
};

export function measureDiversity(runs: readonly RunPath[]): DiversityReport {
  const reachMap = new Map<string, string[]>();
  for (const run of runs) {
    for (const path of new Set(run.path)) {
      const existing = reachMap.get(path);
      if (existing === undefined) reachMap.set(path, [run.personaId]);
      else if (!existing.includes(run.personaId)) existing.push(run.personaId);
    }
  }

  const reach: PathReach[] = [...reachMap.entries()]
    .map(([path, personaIds]) => ({ path, personaCount: personaIds.length, personaIds }))
    .sort((a, b) => a.personaCount - b.personaCount || a.path.localeCompare(b.path));

  return {
    runs: runs.length,
    uniquePaths: [...reachMap.keys()].sort(),
    uniquePathSequences: new Set(runs.map((run) => run.path.join(' > '))).size,
    uniqueActionSequences: new Set(runs.map((run) => run.actions.join(' > '))).size,
    firstDivergenceStep: firstDivergence(runs.map((run) => run.path)),
    reach,
    pathsFoundByOne: reach.filter((r) => r.personaCount === 1).map((r) => r.path),
    pathsFoundByAll: reach.filter((r) => r.personaCount === runs.length).map((r) => r.path),
    outcomesByPersona: runs.map((run) => ({ personaId: run.personaId, outcome: run.outcome })),
    stepCounts: runs.map((run) => ({ personaId: run.personaId, steps: run.stepCount })),
  };
}

/**
 * The first position where the sequences stop agreeing.
 *
 * Null when they never disagree — either because they are identical, or because
 * there are fewer than two of them to compare.
 */
export function firstDivergence(sequences: readonly (readonly string[])[]): number | null {
  if (sequences.length < 2) return null;
  const shortest = Math.min(...sequences.map((sequence) => sequence.length));

  for (let index = 0; index < shortest; index++) {
    const first = sequences[0]?.[index];
    if (sequences.some((sequence) => sequence[index] !== first)) return index;
  }

  // No disagreement within the common prefix. If one run simply went further,
  // that is still a divergence, at the point where the shorter one stopped.
  return sequences.some((sequence) => sequence.length !== shortest) ? shortest : null;
}

export function formatDiversity(report: DiversityReport): string {
  const lines = [
    'Behavioural diversity',
    '',
    `  runs                     ${report.runs}`,
    `  distinct paths visited   ${report.uniquePaths.length}`,
    `  distinct path sequences  ${report.uniquePathSequences} of ${report.runs}`,
    `  distinct action seqs     ${report.uniqueActionSequences} of ${report.runs}`,
    `  first divergence at step ${report.firstDivergenceStep ?? 'never — every run took the same path'}`,
    '',
  ];

  if (report.pathsFoundByAll.length > 0) {
    lines.push(`  reached by every persona: ${report.pathsFoundByAll.join(', ')}`);
  }
  if (report.pathsFoundByOne.length > 0) {
    lines.push(`  reached by only one:      ${report.pathsFoundByOne.join(', ')}`);
  }

  lines.push('', '  Where each persona went:');
  for (const run of report.outcomesByPersona) {
    const steps = report.stepCounts.find((s) => s.personaId === run.personaId)?.steps ?? 0;
    lines.push(`    ${run.personaId.padEnd(24)} ${run.outcome.padEnd(8)} ${steps} steps`);
  }

  if (report.uniquePathSequences === 1 && report.runs > 1) {
    // Stated loudly because it is the result that would undermine the premise.
    lines.push(
      '',
      '  NOTE: every persona took an identical path. On this task the persona made no',
      '  difference to behaviour, which is worth explaining before reading anything',
      '  else into these runs.',
    );
  }

  return lines.join('\n');
}

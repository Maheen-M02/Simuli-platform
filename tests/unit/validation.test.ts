import { describe, expect, it } from 'vitest';
import {
  firstDivergence,
  formatDiversity,
  measureDiversity,
  pathOf,
  runPath,
  type RunPath,
} from '../../src/validation/diversity.ts';
import {
  matchesIssue,
  scoreAgainstGroundTruth,
  totalGroundTruth,
  type GroundTruth,
} from '../../src/validation/groundTruth.ts';
import { buildComparison, formatComparison } from '../../src/validation/comparison.ts';
import { ActionSchema } from '../../src/actions/schema.ts';
import { CustomerContextSchema } from '../../src/personas/context.ts';
import { DEFAULT_PERSONA } from '../../src/personas/schema.ts';
import { GoalSchema } from '../../src/goals/schema.ts';
import { FindingSchema, type Evaluation, type Finding } from '../../src/evaluation/schema.ts';
import type { SessionRecord, StepRecord } from '../../src/sessions/types.ts';
import { PERSONAS } from '../../fixtures/freightflow/personas.ts';
import { TASKS } from '../../fixtures/freightflow/tasks.ts';
import {
  KNOWN_NON_ISSUES,
  KNOWN_PRODUCT_ISSUES,
} from '../../fixtures/freightflow/ground-truth.ts';

/**
 * The measurement layer.
 *
 * All of it is pure, which is the point: the numbers a comparison run prints
 * must be verifiable without a model, or we cannot tell a change in the agent
 * from a change in the arithmetic.
 */

const CONTEXT = CustomerContextSchema.parse({ persona: DEFAULT_PERSONA });
const common = { reasoning: 'r', expectation: 'e' };

function step(index: number, path: string, action?: unknown): StepRecord {
  return {
    index,
    observation: {
      generation: index + 1,
      capturedAt: 1_700_000_000_000 + index * 1000,
      url: `http://127.0.0.1:4321${path}`,
      title: path,
      text: `URL: http://127.0.0.1:4321${path}`,
      nodeCount: 5,
      screenshotPath: null,
    },
    action: action === undefined ? null : ActionSchema.parse(action),
    result: action === undefined ? null : { ok: true, durationMs: 10, navigated: true },
    plannerError: action === undefined ? 'no action' : null,
    startedAt: 1_700_000_000_000 + index * 1000,
    endedAt: 1_700_000_000_000 + index * 1000 + 500,
  };
}

function record(paths: readonly string[], id = 'r1'): SessionRecord {
  return {
    id,
    startUrl: 'http://127.0.0.1:4321/',
    context: CONTEXT,
    goal: GoalSchema.parse({ description: 'do a thing' }),
    plannerModel: 'fake',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_000_000 + paths.length * 1000,
    outcome: 'SUCCESS',
    terminationReason: 'AGENT_FINISHED',
    agentSummary: null,
    steps: paths.map((path, index) =>
      step(index, path, { action: 'click', ref: `e${index + 1}`, ...common }),
    ),
  };
}

function evaluation(findings: readonly Finding[], sound = true): Evaluation {
  return {
    sessionId: 'r1',
    goalAchieved: true,
    summary: 'x',
    findings: [...findings],
    policyActions: [],
    customerVerdict: null,
    facts: {
      stepCount: 3,
      durationMs: 3000,
      actionsAttempted: 3,
      actionsFailed: 0,
      plannerFailures: 0,
      errorsByKind: {},
      distinctUrls: 3,
      revisitedUrls: [],
      destructiveActionsBlocked: 0,
      runIsTechnicallySound: sound,
    },
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return FindingSchema.parse({
    finding: 'Billing is hard to find from the dashboard',
    classification: 'PRODUCT_ISSUE',
    severity: 'medium',
    evidence: 'The dashboard offered no link to billing.',
    evidenceType: 'PAGE_CONTENT',
    confidence: 'medium',
    affectedPersona: 'Ade',
    supportingSteps: [0],
    evidenceRefs: ['f1'],
    alternativeExplanation: 'The customer may not have looked under Account.',
    recommendation: 'Put billing in the navigation.',
    ...overrides,
  });
}

describe('path extraction', () => {
  it('strips origin and query, so runs on different ports compare', () => {
    expect(pathOf('http://127.0.0.1:53017/app/invoices?status=draft')).toBe('/app/invoices');
    expect(pathOf('http://127.0.0.1:61000/app/')).toBe('/app');
    expect(pathOf('not a url')).toBe('not a url');
  });

  it('collapses consecutive visits to one page', () => {
    // Three actions on one form is one visit, not three.
    const path = runPath('p', record(['/app/shipments/new', '/app/shipments/new', '/app/shipments/new', '/app']));
    expect(path.path).toEqual(['/app/shipments/new', '/app']);
  });

  it('keeps a genuine return visit', () => {
    const path = runPath('p', record(['/app', '/app/invoices', '/app']));
    expect(path.path).toEqual(['/app', '/app/invoices', '/app']);
  });
});

describe('divergence', () => {
  it('finds the step where sequences stop agreeing', () => {
    expect(firstDivergence([['/a', '/b', '/c'], ['/a', '/b', '/z']])).toBe(2);
    expect(firstDivergence([['/a', '/x'], ['/a', '/y'], ['/a', '/x']])).toBe(1);
  });

  it('returns null when every sequence is identical', () => {
    // The result that would undermine the premise, so it gets its own case.
    expect(firstDivergence([['/a', '/b'], ['/a', '/b']])).toBeNull();
  });

  it('treats one run going further as a divergence', () => {
    expect(firstDivergence([['/a'], ['/a', '/b']])).toBe(1);
  });

  it('returns null when there is nothing to compare', () => {
    expect(firstDivergence([])).toBeNull();
    expect(firstDivergence([['/a']])).toBeNull();
  });
});

describe('diversity measurement', () => {
  const runs: RunPath[] = [
    { personaId: 'a', path: ['/', '/signup', '/app'], actions: ['click:e1'], outcome: 'SUCCESS', stepCount: 3 },
    { personaId: 'b', path: ['/', '/pricing', '/signup', '/app'], actions: ['click:e2'], outcome: 'SUCCESS', stepCount: 4 },
    { personaId: 'c', path: ['/', '/signup', '/app', '/app/account'], actions: ['click:e1'], outcome: 'FAILURE', stepCount: 4 },
  ];

  it('counts distinct paths, sequences and action chains', () => {
    const report = measureDiversity(runs);
    expect(report.runs).toBe(3);
    expect(report.uniquePaths).toEqual(['/', '/app', '/app/account', '/pricing', '/signup']);
    expect(report.uniquePathSequences).toBe(3);
    // Two personas issued the same action chain, so this is 2 not 3.
    expect(report.uniqueActionSequences).toBe(2);
  });

  it('reports which paths only one persona found', () => {
    const report = measureDiversity(runs);
    expect(report.pathsFoundByOne).toContain('/pricing');
    expect(report.pathsFoundByOne).toContain('/app/account');
    expect(report.pathsFoundByAll).toEqual(['/', '/app', '/signup']);
  });

  it('names each persona that reached a path', () => {
    const report = measureDiversity(runs);
    const pricing = report.reach.find((r) => r.path === '/pricing');
    expect(pricing?.personaIds).toEqual(['b']);
  });

  it('says so loudly when every persona behaved identically', () => {
    const identical: RunPath[] = [
      { personaId: 'a', path: ['/', '/app'], actions: ['click:e1'], outcome: 'SUCCESS', stepCount: 2 },
      { personaId: 'b', path: ['/', '/app'], actions: ['click:e1'], outcome: 'SUCCESS', stepCount: 2 },
    ];
    const text = formatDiversity(measureDiversity(identical));
    expect(text).toContain('every persona took an identical path');
    expect(text).toContain('the persona made no');
  });

  it('does not claim identical behaviour when runs differ', () => {
    expect(formatDiversity(measureDiversity(runs))).not.toContain('identical path');
  });
});

describe('ground-truth scoring', () => {
  const groundTruth: GroundTruth = {
    issues: [
      {
        id: 'billing-hard-to-discover',
        description: 'Billing is hidden',
        expected: 'PRODUCT_ISSUE',
        detection: { anyKeyword: ['billing'], onPaths: ['/app'] },
        reachableFromTasks: ['find-billing'],
      },
      {
        id: 'weight-uncommunicated',
        description: 'Weight has no unit',
        expected: 'PRODUCT_ISSUE',
        detection: { anyKeyword: ['weight'], onPaths: ['/app/shipments/new'] },
        reachableFromTasks: ['create-first-shipment'],
      },
    ],
    nonIssues: [{ id: 'signup-works', description: 'Signup is fine', paths: ['/signup'] }],
  };

  const dashboardRun = record(['/app', '/app/account']);

  it('credits a finding that mentions the subject and cites the right page', () => {
    const report = scoreAgainstGroundTruth({
      taskId: 'find-billing',
      personaId: 'a',
      record: dashboardRun,
      evaluation: evaluation([finding()]),
      groundTruth,
    });
    expect(report.detected.map((d) => d.issueId)).toEqual(['billing-hard-to-discover']);
    expect(report.missed).toHaveLength(0);
  });

  it('does not credit a finding that mentions the subject on the wrong page', () => {
    // Keywords alone would credit this. The page test is what stops it.
    const elsewhere = record(['/signup', '/pricing']);
    const report = scoreAgainstGroundTruth({
      taskId: 'find-billing',
      personaId: 'a',
      record: elsewhere,
      evaluation: evaluation([finding()]),
      groundTruth,
    });
    expect(report.detected).toHaveLength(0);
    expect(report.missed[0]?.reason).toContain('cited no step on a page where the problem shows');
  });

  it('does not credit a finding on the right page that is about something else', () => {
    const report = scoreAgainstGroundTruth({
      taskId: 'find-billing',
      personaId: 'a',
      record: dashboardRun,
      // Every text field must be overridden: the matcher reads finding,
      // evidence and recommendation together, and a leftover default mentioning
      // billing would match — correctly, which is why the test has to be clean.
      evaluation: evaluation([
        finding({
          finding: 'The heading is misaligned',
          evidence: 'The title sat two pixels low.',
          recommendation: 'Align the heading.',
        }),
      ]),
      groundTruth,
    });
    expect(report.detected).toHaveLength(0);
    expect(report.missed[0]?.reason).toContain('mentioned the subject at all');
  });

  it('only scores issues the task could plausibly surface', () => {
    // Marking the weight issue missed on a billing task would count our recall
    // against a page the customer had no reason to visit.
    const report = scoreAgainstGroundTruth({
      taskId: 'find-billing',
      personaId: 'a',
      record: dashboardRun,
      evaluation: evaluation([]),
      groundTruth,
    });
    expect(report.issuesInScope).toEqual(['billing-hard-to-discover']);
    expect(report.missed.map((m) => m.issueId)).toEqual(['billing-hard-to-discover']);
  });

  it('flags a product finding about a page we know works', () => {
    const signupRun = record(['/signup']);
    const report = scoreAgainstGroundTruth({
      taskId: 'find-billing',
      personaId: 'a',
      record: signupRun,
      evaluation: evaluation([finding({ finding: 'Signup is broken', supportingSteps: [0] })]),
      groundTruth,
    });
    expect(report.likelyFalsePositives).toHaveLength(1);
    expect(report.likelyFalsePositives[0]?.aboutNonIssue).toBe('signup-works');
  });

  it('calls an unrecognised finding unmatched rather than false', () => {
    // A fixture author does not know everything about their own product.
    const report = scoreAgainstGroundTruth({
      taskId: 'find-billing',
      personaId: 'a',
      record: record(['/app/reports']),
      evaluation: evaluation([finding({ finding: 'Reports page returns an error', supportingSteps: [0] })]),
      groundTruth,
    });
    expect(report.unmatchedProductFindings).toHaveLength(1);
    expect(report.likelyFalsePositives).toHaveLength(0);
    expect(report.unmatchedProductFindings[0]?.reason).toContain(
      'May be a real problem we did not plant',
    );
  });

  it('counts the other classifications without treating them as product issues', () => {
    const report = scoreAgainstGroundTruth({
      taskId: 'find-billing',
      personaId: 'a',
      record: dashboardRun,
      evaluation: evaluation([
        finding({ classification: 'AGENT_MISUNDERSTANDING' }),
        finding({ classification: 'ENVIRONMENT_ERROR' }),
        finding({ classification: 'INCONCLUSIVE' }),
      ]),
      groundTruth,
    });
    expect(report.agentMisunderstandings).toBe(1);
    expect(report.environmentErrors).toBe(1);
    expect(report.inconclusive).toBe(1);
    expect(report.detected).toHaveLength(0);
    expect(report.unmatchedProductFindings).toHaveLength(0);
  });

  it('carries through whether the run was technically sound', () => {
    const report = scoreAgainstGroundTruth({
      taskId: 'find-billing',
      personaId: 'a',
      record: dashboardRun,
      evaluation: evaluation([], false),
      groundTruth,
    });
    expect(report.runIsTechnicallySound).toBe(false);
  });

  it('matches on any one of several keywords', () => {
    const issue = groundTruth.issues[0];
    expect(issue).toBeDefined();
    expect(matchesIssue(finding(), issue as NonNullable<typeof issue>, dashboardRun)).toBe(true);
  });
});

describe('ground-truth totals', () => {
  it('computes recall over in-scope issues and names what nobody found', () => {
    const totals = totalGroundTruth([
      {
        taskId: 't',
        personaId: 'a',
        sessionId: 's1',
        issuesInScope: ['x', 'y'],
        detected: [{ issueId: 'x', detected: true, matchedFinding: 'f', reason: 'r' }],
        missed: [{ issueId: 'y', detected: false, matchedFinding: null, reason: 'r' }],
        unmatchedProductFindings: [],
        likelyFalsePositives: [],
        agentMisunderstandings: 1,
        environmentErrors: 0,
        inconclusive: 2,
        runIsTechnicallySound: true,
      },
      {
        taskId: 't',
        personaId: 'b',
        sessionId: 's2',
        issuesInScope: ['x', 'y'],
        detected: [{ issueId: 'x', detected: true, matchedFinding: 'f', reason: 'r' }],
        missed: [{ issueId: 'y', detected: false, matchedFinding: null, reason: 'r' }],
        unmatchedProductFindings: [{ finding: 'q', aboutNonIssue: null, reason: 'r' }],
        likelyFalsePositives: [],
        agentMisunderstandings: 0,
        environmentErrors: 1,
        inconclusive: 0,
        runIsTechnicallySound: true,
      },
    ]);

    expect(totals.detected).toBe(2);
    expect(totals.missed).toBe(2);
    expect(totals.recall).toBeCloseTo(0.5);
    expect(totals.issuesFoundByAnyone).toEqual(['x']);
    expect(totals.issuesFoundByNobody).toEqual(['y']);
    expect(totals.unmatched).toBe(1);
    expect(totals.agentMisunderstandings).toBe(1);
  });

  it('reports null recall rather than a flattering zero when nothing was in scope', () => {
    expect(totalGroundTruth([]).recall).toBeNull();
  });
});

describe('comparison report', () => {
  it('lays out one row per persona with path and findings', () => {
    const { rows, paths } = buildComparison([
      {
        personaId: 'first-time-owner',
        personaLabel: 'Owner',
        record: record(['/', '/signup', '/app'], 's1'),
        evaluation: evaluation([finding()]),
        evaluationError: null,
      },
      {
        personaId: 'skeptical-buyer',
        personaLabel: 'Buyer',
        record: record(['/', '/pricing'], 's2'),
        evaluation: evaluation([]),
        evaluationError: null,
      },
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.navigationPath).toEqual(['/', '/signup', '/app']);
    expect(rows[0]?.productIssues).toHaveLength(1);
    expect(rows[1]?.productIssues).toHaveLength(0);

    const text = formatComparison({ taskId: 't', taskLabel: 'Task', rows, paths });
    expect(text).toContain('first-time-owner');
    expect(text).toContain('/pricing');
    expect(text).toContain('Behavioural diversity');
    // The disclaimer is not optional.
    expect(text).toContain('Nothing here is evidence about how a real person');
  });

  it('survives a run whose evaluation failed', () => {
    const { rows } = buildComparison([
      {
        personaId: 'a',
        personaLabel: 'A',
        record: record(['/'], 's1'),
        evaluation: null,
        evaluationError: 'out of credit',
      },
    ]);
    expect(rows[0]?.productIssues).toEqual([]);
    expect(rows[0]?.satisfaction).toBeNull();
  });
});

describe('the FreightFlow evaluation set', () => {
  it('has at least five materially distinct personas', () => {
    expect(PERSONAS.length).toBeGreaterThanOrEqual(5);
    expect(new Set(PERSONAS.map((p) => p.id)).size).toBe(PERSONAS.length);
  });

  it('varies the traits that should change behaviour', () => {
    // Personas that share every trait would not be materially different, whatever
    // their backstories say.
    expect(new Set(PERSONAS.map((p) => p.context.persona.techLevel)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(PERSONAS.map((p) => p.context.persona.patience)).size).toBeGreaterThanOrEqual(2);
    for (const persona of PERSONAS) {
      expect(persona.context.motivation.length, persona.id).toBeGreaterThan(10);
      expect(persona.context.expectations.length, persona.id).toBeGreaterThan(0);
    }
  });

  it('has tasks stated as outcomes, never as routes', () => {
    expect(TASKS.length).toBeGreaterThanOrEqual(5);
    for (const task of TASKS) {
      const text = `${task.goal.description} ${task.goal.successCriteria ?? ''}`.toLowerCase();
      // A goal naming a control is an instruction, and tests obedience not judgment.
      for (const word of ['click', 'press the', 'navigate to', 'go to the', 'sidebar', 'button']) {
        expect(text.includes(word), `${task.id} mentions "${word}"`).toBe(false);
      }
    }
  });

  it('has every known issue reachable from at least one real task', () => {
    const taskIds = new Set(TASKS.map((task) => task.id));
    for (const issue of KNOWN_PRODUCT_ISSUES) {
      expect(issue.reachableFromTasks.length, issue.id).toBeGreaterThan(0);
      for (const id of issue.reachableFromTasks) {
        expect(taskIds.has(id), `${issue.id} references unknown task ${id}`).toBe(true);
      }
    }
  });

  it('lists more non-issues than issues, so recall cannot be gamed by reporting everything', () => {
    expect(KNOWN_NON_ISSUES.length).toBeGreaterThan(KNOWN_PRODUCT_ISSUES.length);
  });

  it('gives every known issue detection hints and a rationale', () => {
    for (const issue of KNOWN_PRODUCT_ISSUES) {
      expect(issue.detection.anyKeyword.length, issue.id).toBeGreaterThan(0);
      expect(issue.rationale.length, issue.id).toBeGreaterThan(40);
      expect(issue.expected).toBe('PRODUCT_ISSUE');
    }
  });
});

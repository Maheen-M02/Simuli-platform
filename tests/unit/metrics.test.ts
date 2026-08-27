import { describe, expect, it } from 'vitest';
import {
  formatMetrics,
  scoreProductIssueDetection,
  type ScenarioPrediction,
} from '../../src/evaluation/metrics.ts';
import { duplicateIds, GOLDEN_SCENARIOS } from '../fixtures/golden/scenarios.ts';

/**
 * The arithmetic is tested against hand-worked cases, because a metric computed
 * wrongly is worse than no metric: it launders a bad evaluator into a number
 * somebody will quote in a sales conversation.
 */

function prediction(
  expectProductIssue: boolean,
  predictedProductIssue: boolean,
  id = `s${Math.abs(expectProductIssue ? 1 : 0)}`,
): ScenarioPrediction {
  return { scenarioId: id, expectProductIssue, predictedProductIssue };
}

describe('confusion matrix', () => {
  it('counts each cell correctly', () => {
    const metrics = scoreProductIssueDetection([
      prediction(true, true, 'tp1'),
      prediction(true, true, 'tp2'),
      prediction(false, true, 'fp1'),
      prediction(false, false, 'tn1'),
      prediction(false, false, 'tn2'),
      prediction(true, false, 'fn1'),
    ]);

    expect(metrics.truePositives).toBe(2);
    expect(metrics.falsePositives).toBe(1);
    expect(metrics.trueNegatives).toBe(2);
    expect(metrics.falseNegatives).toBe(1);
    expect(metrics.scored).toBe(6);
  });

  it('computes precision, recall and the error rates from those cells', () => {
    // TP=2 FP=1 TN=2 FN=1 by hand:
    //   precision = 2/3, recall = 2/3, FPR = 1/3, FNR = 1/3
    const metrics = scoreProductIssueDetection([
      prediction(true, true, 'a'),
      prediction(true, true, 'b'),
      prediction(false, true, 'c'),
      prediction(false, false, 'd'),
      prediction(false, false, 'e'),
      prediction(true, false, 'f'),
    ]);

    expect(metrics.precision).toBeCloseTo(2 / 3);
    expect(metrics.recall).toBeCloseTo(2 / 3);
    expect(metrics.falsePositiveRate).toBeCloseTo(1 / 3);
    expect(metrics.falseNegativeRate).toBeCloseTo(1 / 3);
    expect(metrics.f1).toBeCloseTo(2 / 3);
  });

  it('scores a perfect evaluator as perfect', () => {
    const metrics = scoreProductIssueDetection([
      prediction(true, true, 'a'),
      prediction(false, false, 'b'),
    ]);
    expect(metrics.precision).toBe(1);
    expect(metrics.recall).toBe(1);
    expect(metrics.falsePositiveRate).toBe(0);
    expect(metrics.falseNegativeRate).toBe(0);
  });

  it('gives an evaluator that reports everything precision below 1 and recall 1', () => {
    const metrics = scoreProductIssueDetection([
      prediction(true, true, 'a'),
      prediction(false, true, 'b'),
      prediction(false, true, 'c'),
    ]);
    expect(metrics.precision).toBeCloseTo(1 / 3);
    expect(metrics.recall).toBe(1);
    expect(metrics.falsePositiveRate).toBe(1);
  });

  it('gives an evaluator that reports nothing recall 0 and undefined precision', () => {
    // The degenerate case that a naive implementation reports as 100% precision.
    const metrics = scoreProductIssueDetection([
      prediction(true, false, 'a'),
      prediction(false, false, 'b'),
    ]);
    expect(metrics.precision).toBeNull();
    expect(metrics.recall).toBe(0);
    expect(metrics.falsePositiveRate).toBe(0);
    expect(metrics.falseNegativeRate).toBe(1);
    expect(metrics.f1).toBeNull();
  });

  it('reports nulls rather than dividing by zero on an empty set', () => {
    const metrics = scoreProductIssueDetection([]);
    expect(metrics.scored).toBe(0);
    expect(metrics.precision).toBeNull();
    expect(metrics.recall).toBeNull();
    expect(metrics.falsePositiveRate).toBeNull();
  });

  it('excludes errored scenarios instead of scoring them either way', () => {
    const metrics = scoreProductIssueDetection([
      prediction(true, true, 'a'),
      { scenarioId: 'b', expectProductIssue: true, predictedProductIssue: false, error: 'rate limited' },
    ]);
    expect(metrics.scored).toBe(1);
    expect(metrics.errored).toBe(1);
    // The errored scenario must not be counted as a miss.
    expect(metrics.falseNegatives).toBe(0);
    expect(metrics.recall).toBe(1);
  });
});

describe('metric formatting', () => {
  it('renders n/a rather than NaN for an undefined ratio', () => {
    const text = formatMetrics(scoreProductIssueDetection([]));
    expect(text).toContain('n/a');
    expect(text).not.toContain('NaN');
  });

  it('names each cell so a reader cannot mistake which is which', () => {
    const text = formatMetrics(scoreProductIssueDetection([prediction(false, true, 'a')]));
    expect(text).toContain('false positives:   1');
    expect(text).toContain('but reported one');
  });
});

describe('the golden dataset itself', () => {
  it('has enough scenarios to be worth measuring', () => {
    expect(GOLDEN_SCENARIOS.length).toBeGreaterThanOrEqual(10);
    expect(GOLDEN_SCENARIOS.length).toBeLessThanOrEqual(20);
  });

  it('has unique ids, or metrics would double-count', () => {
    expect(duplicateIds()).toEqual([]);
  });

  it('covers every classification, so no class is untested', () => {
    const covered = new Set(GOLDEN_SCENARIOS.map((s) => s.expected));
    expect(covered).toContain('PRODUCT_ISSUE');
    expect(covered).toContain('AGENT_MISUNDERSTANDING');
    expect(covered).toContain('ENVIRONMENT_ERROR');
    expect(covered).toContain('INCONCLUSIVE');
  });

  it('is balanced enough that guessing one answer cannot score well', () => {
    const positives = GOLDEN_SCENARIOS.filter((s) => s.expectProductIssue).length;
    const share = positives / GOLDEN_SCENARIOS.length;
    // Always-yes or always-no must both be visibly bad strategies.
    expect(share).toBeGreaterThan(0.25);
    expect(share).toBeLessThan(0.6);
  });

  it('states a human rationale for every expectation', () => {
    for (const scenario of GOLDEN_SCENARIOS) {
      expect(scenario.rationale.length, scenario.id).toBeGreaterThan(60);
      expect(scenario.category.length, scenario.id).toBeGreaterThan(3);
    }
  });

  it('gives every scenario a recorded outcome and at least one step', () => {
    for (const scenario of GOLDEN_SCENARIOS) {
      expect(scenario.record.outcome, scenario.id).not.toBeNull();
      expect(scenario.record.steps.length, scenario.id).toBeGreaterThan(0);
    }
  });

  it('scores an always-yes evaluator badly on this dataset', () => {
    // A guard on the dataset, not the evaluator: if this passes with good
    // numbers, the dataset is too easy to be measuring anything.
    const alwaysYes = GOLDEN_SCENARIOS.map((s) => ({
      scenarioId: s.id,
      expectProductIssue: s.expectProductIssue,
      predictedProductIssue: true,
    }));
    const metrics = scoreProductIssueDetection(alwaysYes);
    expect(metrics.recall).toBe(1);
    expect(metrics.precision).toBeLessThan(0.6);
    expect(metrics.falsePositiveRate).toBe(1);
  });
});

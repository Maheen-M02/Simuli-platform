/**
 * Scoring the evaluator against a labelled dataset.
 *
 * Deliberately narrow: this measures the classification of PRODUCT_ISSUE, and
 * nothing else. That is the claim the business rests on — "this is a real
 * problem with your product" — and it is the claim that costs us everything
 * when it is wrong. Getting AGENT_MISUNDERSTANDING confused with
 * ENVIRONMENT_ERROR is untidy; calling our own crash a product defect is fatal.
 *
 * Treated as binary classification per scenario: did the evaluator report at
 * least one product issue, and should it have? A run is one sample, because a
 * customer reads a run's report as one artefact.
 *
 * Pure functions over plain data, so the arithmetic is testable without a model
 * and a metric can never be quietly produced by the thing it is measuring.
 */

export type ScenarioPrediction = {
  readonly scenarioId: string;
  /** What a human said the run's primary classification should be. */
  readonly expectProductIssue: boolean;
  /** Whether the evaluator actually emitted a PRODUCT_ISSUE finding. */
  readonly predictedProductIssue: boolean;
  /** Set when the evaluator could not be run at all. Excluded from metrics. */
  readonly error?: string;
};

export type ConfusionMatrix = {
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly trueNegatives: number;
  readonly falseNegatives: number;
};

export type Metrics = ConfusionMatrix & {
  readonly scored: number;
  readonly errored: number;
  /** Of the product issues we reported, how many were real. Null when none reported. */
  readonly precision: number | null;
  /** Of the real product issues, how many we found. Null when none existed. */
  readonly recall: number | null;
  /** How often we invented a product issue where there was none. */
  readonly falsePositiveRate: number | null;
  /** How often we missed a real one. */
  readonly falseNegativeRate: number | null;
  readonly f1: number | null;
};

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export function scoreProductIssueDetection(
  predictions: readonly ScenarioPrediction[],
): Metrics {
  // A scenario the evaluator could not process is not evidence either way.
  // Counting it as a success would flatter us; as a failure, it would hide a
  // transport problem behind a quality number.
  const scorable = predictions.filter((prediction) => prediction.error === undefined);

  let truePositives = 0;
  let falsePositives = 0;
  let trueNegatives = 0;
  let falseNegatives = 0;

  for (const prediction of scorable) {
    if (prediction.expectProductIssue) {
      if (prediction.predictedProductIssue) truePositives++;
      else falseNegatives++;
    } else if (prediction.predictedProductIssue) {
      falsePositives++;
    } else {
      trueNegatives++;
    }
  }

  const precision = ratio(truePositives, truePositives + falsePositives);
  const recall = ratio(truePositives, truePositives + falseNegatives);

  return {
    truePositives,
    falsePositives,
    trueNegatives,
    falseNegatives,
    scored: scorable.length,
    errored: predictions.length - scorable.length,
    precision,
    recall,
    falsePositiveRate: ratio(falsePositives, falsePositives + trueNegatives),
    falseNegativeRate: ratio(falseNegatives, falseNegatives + truePositives),
    f1:
      precision === null || recall === null || precision + recall === 0
        ? null
        : (2 * precision * recall) / (precision + recall),
  };
}

function asPercent(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(0)}%`;
}

export function formatMetrics(metrics: Metrics): string {
  return [
    `scored:            ${metrics.scored} scenarios${metrics.errored > 0 ? ` (${metrics.errored} errored, excluded)` : ''}`,
    `true positives:    ${metrics.truePositives}   (real product issue, reported)`,
    `false positives:   ${metrics.falsePositives}   (no product issue, but reported one)`,
    `true negatives:    ${metrics.trueNegatives}   (no product issue, none reported)`,
    `false negatives:   ${metrics.falseNegatives}   (real product issue, missed)`,
    '',
    `precision:            ${asPercent(metrics.precision)}`,
    `recall:               ${asPercent(metrics.recall)}`,
    `false-positive rate:  ${asPercent(metrics.falsePositiveRate)}`,
    `false-negative rate:  ${asPercent(metrics.falseNegativeRate)}`,
    `f1:                   ${asPercent(metrics.f1)}`,
  ].join('\n');
}

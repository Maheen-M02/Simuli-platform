import { OUR_FAULT_FACT_KINDS, type EvidenceLedger, type ObservedFact } from './evidence.ts';
import type { Finding, PolicyAction } from './schema.ts';

/**
 * The deterministic guard on what a finding is allowed to claim.
 *
 * Prompt instructions are advisory. This is enforcement, and it lives here for
 * the same reason the destructive-action denylist lives in the executor: the
 * whole product rests on findings being trustworthy, so the checks that make
 * them trustworthy must not be a request to a model.
 *
 * Every rule below was written against an observed false finding, not
 * hypothesised. And every intervention is recorded as a `PolicyAction`, because
 * how often we have to override the model is itself a number worth watching —
 * if it climbs, the prompt is wrong; if it falls to zero, the rules may be dead
 * weight.
 */

export type PolicyResult = {
  readonly findings: readonly Finding[];
  readonly actions: readonly PolicyAction[];
  /** Findings dropped entirely: they cited no step that ever happened. */
  readonly rejected: readonly Finding[];
};

function factsFor(finding: Finding, ledger: EvidenceLedger): ObservedFact[] {
  const byId = new Map(ledger.facts.map((fact) => [fact.id, fact]));
  return finding.evidenceRefs
    .map((ref) => byId.get(ref))
    .filter((fact): fact is ObservedFact => fact !== undefined);
}

/**
 * Applies the policy to one model-produced finding.
 *
 * Order matters. A finding is first checked for having any real evidence at
 * all, then for resting only on our own failures, and only then is its
 * classification accepted. Demotion is always to INCONCLUSIVE or to the class
 * the evidence actually supports — never to a *stronger* claim, because the
 * point is to stop overreach, not to invent findings the model did not make.
 */
export function applyEvidencePolicy(
  findings: readonly Finding[],
  ledger: EvidenceLedger,
  stepCount: number,
): PolicyResult {
  const kept: Finding[] = [];
  const actions: PolicyAction[] = [];
  const rejected: Finding[] = [];

  const demote = (finding: Finding, to: Finding['classification'], reason: string): Finding => {
    if (finding.classification === to) return finding;
    actions.push({ finding: finding.finding, from: finding.classification, to, reason });
    // Confidence cannot survive a demotion intact: the model was confident
    // about a claim we have just declined to accept.
    return { ...finding, classification: to, confidence: 'low' };
  };

  for (const original of findings) {
    // A finding citing no step that happened has no evidence at all. This is
    // the hallucinated-evidence case, and it is dropped rather than demoted.
    const realSteps = original.supportingSteps.filter((step) => step >= 0 && step < stepCount);
    if (realSteps.length === 0) {
      rejected.push(original);
      continue;
    }

    let finding: Finding =
      realSteps.length === original.supportingSteps.length
        ? original
        : { ...original, supportingSteps: realSteps };

    const facts = factsFor(finding, ledger);

    // Rule 1: a claim about the product must rest on something the record
    // witnessed. An honest AGENT_BELIEF label is caught here too.
    if (finding.classification === 'PRODUCT_ISSUE' && facts.length === 0) {
      finding = demote(
        finding,
        'INCONCLUSIVE',
        'Cited no observed fact from the evidence ledger, so nothing supports a claim about the product.',
      );
    } else if (finding.classification === 'PRODUCT_ISSUE' && finding.evidenceType === 'AGENT_BELIEF') {
      finding = demote(
        finding,
        'INCONCLUSIVE',
        "Rested on the simulated customer's interpretation, which is not evidence about the product.",
      );
    } else if (
      finding.classification === 'PRODUCT_ISSUE' &&
      facts.every((fact) => OUR_FAULT_FACT_KINDS.has(fact.kind))
    ) {
      // Rule 2: our own crash is not a product defect. This is the exact path
      // by which a working dropdown was reported as broken.
      finding = demote(
        finding,
        'ENVIRONMENT_ERROR',
        'Every cited fact describes a failure of our own simulation rather than product behaviour.',
      );
    }

    // Rule 3: any finding whose evidence refs are entirely unknown is not
    // reporting on this run, whatever it is classified as.
    if (finding.evidenceRefs.length > 0 && facts.length === 0 && finding.classification !== 'INCONCLUSIVE') {
      finding = demote(
        finding,
        'INCONCLUSIVE',
        'Every cited evidence id was unknown; the finding does not refer to this recording.',
      );
    }

    kept.push(finding);
  }

  return { findings: kept, actions, rejected };
}

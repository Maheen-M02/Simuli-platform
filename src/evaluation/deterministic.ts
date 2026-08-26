import type { SessionRecord } from '../sessions/types.ts';
import type { ErrorKind } from '../types/shared.ts';
import type { DeterministicFacts } from './schema.ts';

/**
 * The pre-pass: everything we can know without asking a model.
 *
 * This runs first and its output is not negotiable. Technical failures are
 * classified from machine facts rather than inferred by a model, so "the run
 * broke" and "the product is confusing" can never be swapped by a persuasive
 * paragraph. The model gets these facts as input and is not permitted to
 * contradict them.
 */

/** Error kinds that mean our machinery failed, not that the product did. */
const OUR_FAULT: ReadonlySet<ErrorKind> = new Set<ErrorKind>([
  'BROWSER_CRASHED',
  'UNKNOWN',
  'STALE_SNAPSHOT',
  'SECRET_NOT_FOUND',
]);

export function computeFacts(record: SessionRecord): DeterministicFacts {
  const errorsByKind: Record<string, number> = {};
  const urlCounts = new Map<string, number>();

  let actionsAttempted = 0;
  let actionsFailed = 0;
  let plannerFailures = 0;
  let destructiveActionsBlocked = 0;
  let ourFailures = 0;

  for (const step of record.steps) {
    urlCounts.set(step.observation.url, (urlCounts.get(step.observation.url) ?? 0) + 1);

    if (step.plannerError !== null) plannerFailures += 1;
    if (step.action === null) continue;

    actionsAttempted += 1;
    const result = step.result;
    if (result === null || result.ok) continue;

    actionsFailed += 1;
    const kind = result.error?.kind;
    if (kind === undefined) continue;

    errorsByKind[kind] = (errorsByKind[kind] ?? 0) + 1;
    if (kind === 'ACTION_BLOCKED') destructiveActionsBlocked += 1;
    if (OUR_FAULT.has(kind)) ourFailures += 1;
  }

  const revisitedUrls = [...urlCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([url]) => url)
    .slice(0, 50);

  const endedAt = record.endedAt ?? record.startedAt;

  return {
    stepCount: record.steps.length,
    durationMs: Math.max(0, endedAt - record.startedAt),
    actionsAttempted,
    actionsFailed,
    plannerFailures,
    errorsByKind,
    distinctUrls: urlCounts.size,
    revisitedUrls,
    destructiveActionsBlocked,
    // A run that ended in ERROR, or that spent much of its time failing on our
    // own account, cannot be read as evidence about the product.
    runIsTechnicallySound:
      record.outcome !== 'ERROR' && ourFailures === 0 && plannerFailures <= 1,
  };
}

/** The facts, written out for the model to reason against. */
export function describeFacts(facts: DeterministicFacts): string {
  const lines = [
    `Steps recorded: ${facts.stepCount}`,
    `Actions attempted: ${facts.actionsAttempted}, of which failed: ${facts.actionsFailed}`,
    `Distinct pages seen: ${facts.distinctUrls}`,
    `Run duration: ${Math.round(facts.durationMs / 1000)}s`,
  ];

  if (facts.plannerFailures > 0) {
    lines.push(`Times the simulated customer could not decide what to do: ${facts.plannerFailures}`);
  }
  if (facts.revisitedUrls.length > 0) {
    lines.push(`Pages visited more than once: ${facts.revisitedUrls.join(', ')}`);
  }
  if (facts.destructiveActionsBlocked > 0) {
    lines.push(
      `Actions the simulation refused because they would have had real-world effects: ` +
        `${facts.destructiveActionsBlocked}`,
    );
  }

  const kinds = Object.entries(facts.errorsByKind);
  if (kinds.length > 0) {
    lines.push(`Failure kinds: ${kinds.map(([kind, n]) => `${kind} x${n}`).join(', ')}`);
  }

  lines.push(
    facts.runIsTechnicallySound
      ? 'This run was technically sound: nothing in our own tooling failed.'
      : 'This run hit failures in our own tooling. Findings must reflect that ' +
        'rather than blaming the product for them.',
  );

  return lines.join('\n');
}

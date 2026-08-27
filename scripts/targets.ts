/**
 * The registry of local evaluation targets.
 *
 * One target today. It is a registry rather than a hardcoded import because the
 * next target will not be FreightFlow, and because keeping the lookup in one
 * place is what stops target-specific knowledge leaking into the scripts.
 *
 * Everything here runs on the harness side of the boundary. The agent never
 * imports any of it: `openTarget` returns a URL, and that URL is the only thing
 * that reaches the browser.
 */

import { startFreightFlow } from '../fixtures/freightflow/server.ts';
import { PERSONAS, personaById, type PersonaEntry } from '../fixtures/freightflow/personas.ts';
import { taskById, TASKS, type TaskEntry } from '../fixtures/freightflow/tasks.ts';
import {
  KNOWN_NON_ISSUES,
  KNOWN_PRODUCT_ISSUES,
} from '../fixtures/freightflow/ground-truth.ts';
import type { GroundTruth } from '../src/validation/groundTruth.ts';
import { err, ok, type Result } from '../src/types/shared.ts';

export const TARGET_IDS = ['freightflow'] as const;

export type OpenTarget = {
  readonly baseUrl: string;
  readonly persona: PersonaEntry;
  readonly task: TaskEntry;
  close(): Promise<void>;
};

export type OpenTargetMulti = {
  readonly baseUrl: string;
  readonly task: TaskEntry;
  readonly personas: readonly PersonaEntry[];
  close(): Promise<void>;
};

/** Ground truth, in the structural shape the scorer expects. */
export function groundTruthFor(targetId: string): GroundTruth | null {
  if (targetId !== 'freightflow') return null;
  return { issues: KNOWN_PRODUCT_ISSUES, nonIssues: KNOWN_NON_ISSUES };
}

async function baseFor(url: string | undefined): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  // An externally-served instance is used as-is, so a human can watch a run in
  // a browser they already have open.
  if (url !== undefined) return { baseUrl: url.replace(/\/+$/, ''), close: async () => undefined };
  const site = await startFreightFlow();
  return { baseUrl: site.url, close: () => site.close() };
}

export async function openTarget(input: {
  readonly targetId: string;
  readonly url: string | undefined;
  readonly personaId: string;
  readonly taskId: string;
}): Promise<Result<OpenTarget, string>> {
  const { targetId, url, personaId, taskId } = input;

  if (targetId !== 'freightflow') {
    return err(`Unknown target "${targetId}". Known targets: ${TARGET_IDS.join(', ')}`);
  }

  const resolvedPersona = personaById(personaId);
  const resolvedTask = taskById(taskId);

  if (resolvedPersona === undefined) {
    return err(`Unknown persona. Available: ${PERSONAS.map((p) => p.id).join(', ')}`);
  }
  if (resolvedTask === undefined) {
    return err(`Unknown goal "${taskId}". Available: ${TASKS.map((t) => t.id).join(', ')}`);
  }

  const base = await baseFor(url);
  return ok({ baseUrl: base.baseUrl, persona: resolvedPersona, task: resolvedTask, close: base.close });
}

export async function openTargetForComparison(
  targetId: string,
  url: string | undefined,
  taskId: string,
  personaIds: readonly string[],
): Promise<Result<OpenTargetMulti, string>> {
  if (targetId !== 'freightflow') {
    return err(`Unknown target "${targetId}". Known targets: ${TARGET_IDS.join(', ')}`);
  }

  const task = taskById(taskId);
  if (task === undefined) {
    return err(`Unknown goal "${taskId}". Available: ${TASKS.map((t) => t.id).join(', ')}`);
  }

  const personas: PersonaEntry[] = [];
  for (const id of personaIds) {
    const entry = personaById(id);
    if (entry === undefined) {
      return err(`Unknown persona "${id}". Available: ${PERSONAS.map((p) => p.id).join(', ')}`);
    }
    personas.push(entry);
  }

  const base = await baseFor(url);
  return ok({
    baseUrl: base.baseUrl,
    task,
    personas: personas.length > 0 ? personas : PERSONAS,
    close: base.close,
  });
}

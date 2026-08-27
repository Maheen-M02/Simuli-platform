import type { Locator, Page } from 'playwright';
import type { Action } from '../actions/schema.ts';
import { isSecretRef } from '../actions/schema.ts';
import type { PageSnapshot, SnapshotNode } from '../observations/types.ts';
import { resolveRef, type Resolution } from './resolver.ts';
import type { ActionError, ActionResult, ErrorKind } from '../types/shared.ts';

/**
 * Executes one validated action against the page.
 *
 * Execution is write-only: it never reads the page back into an observation.
 * The loop mediates, so a bug here cannot quietly corrupt what the agent thinks
 * it saw.
 *
 * Two enforcement points live here rather than in the prompt, because prompt
 * instructions are advisory and executor checks are not:
 *  - Stale-generation rejection. An action decided against an older view of the
 *    page is refused outright.
 *  - The destructive-action denylist. V0 runs against staging and demo
 *    environments, and must never spend money, send a real message or delete
 *    someone's data even if the model decides that is the way forward.
 */

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Matched against an element's accessible name. Deliberately blunt: a false
 * refusal costs one recorded blocker, a false pass costs a real-world side
 * effect. Note the absence of a bare "submit" — it appears on nearly every
 * harmless form and would block signup itself.
 */
const DESTRUCTIVE_NAME_PATTERNS: readonly RegExp[] = [
  /\b(pay|paying|payment)\b/i,
  /\b(purchase|buy|checkout|place order|order now)\b/i,
  /\b(subscribe|upgrade plan|start (my )?(trial|subscription))\b/i,
  /\b(delete|remove|erase|destroy|wipe)\b/i,
  /\b(send|email|invite|publish|post)\b/i,
  /\b(transfer|withdraw|wire|refund)\b/i,
  /\b(deactivate|close (my )?account|cancel (my )?(account|subscription))\b/i,
  /\b(confirm and|yes,? (delete|send|pay))\b/i,
];

export function isDestructiveName(name: string): boolean {
  return DESTRUCTIVE_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

export type ExecuteOptions = {
  /** The snapshot the action was decided against. */
  readonly snapshot: PageSnapshot;
  /** Generation the action was decided against. */
  readonly actionGeneration: number;
  /** Generation the page is actually on now. */
  readonly currentGeneration: number;
  readonly secrets: ReadonlyMap<string, string>;
  readonly timeoutMs?: number;
  /** Set false only for a run explicitly authorised to make changes. */
  readonly blockDestructive?: boolean;
  /**
   * Drains navigations the session refused. Supplied by the loop; without it a
   * blocked click looks like a click that simply did nothing.
   */
  readonly takeBlockedNavigations?: () => readonly string[];
  readonly now?: () => number;
};

function failure(kind: ErrorKind, message: string, durationMs: number): ActionResult {
  return { ok: false, error: { kind, message }, durationMs, navigated: false };
}

/** Maps a Playwright exception onto our closed error vocabulary. */
function classify(error: unknown): ActionError {
  if (error instanceof SecretNotFoundError) {
    return {
      kind: 'SECRET_NOT_FOUND',
      // The name is safe to surface; the value is what must never appear.
      message: `No credential named ${error.secretName} is available in this run.`,
    };
  }

  const message = error instanceof Error ? error.message : String(error);

  if (/Timeout .* exceeded|waiting for locator/i.test(message)) {
    return {
      kind: 'TIMEOUT',
      message: 'The element did not become ready in time. It may be hidden, disabled or still loading.',
    };
  }
  if (/net::ERR_BLOCKED_BY_CLIENT|blockedbyclient/i.test(message)) {
    return {
      kind: 'NAVIGATION_BLOCKED',
      message: 'That link leads outside the site this run is allowed to visit.',
    };
  }
  if (/Target (page|closed)|Browser has been closed|crashed/i.test(message)) {
    return { kind: 'BROWSER_CRASHED', message: 'The browser stopped responding.' };
  }
  if (/not (visible|enabled|editable|stable)|intercepts pointer events/i.test(message)) {
    return {
      kind: 'ELEMENT_NOT_ACTIONABLE',
      message: 'The element is on the page but cannot be interacted with right now.',
    };
  }
  if (/did not find some options|Option .* not found/i.test(message)) {
    return { kind: 'WRONG_ELEMENT_TYPE', message: 'That option is not available in this dropdown.' };
  }
  // Playwright messages can echo page content, which can echo a submitted
  // credential. Never pass one through verbatim.
  return { kind: 'UNKNOWN', message: 'The action could not be completed.' };
}

/** A destination is worth naming, but a full URL can carry a token. */
function originLabel(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'another site';
  }
}

/** True when the action moved the page to a different document. */
async function detectNavigation(page: Page, before: string): Promise<boolean> {
  try {
    return page.url() !== before;
  } catch {
    return false;
  }
}

export async function executeAction(
  page: Page,
  action: Action,
  options: ExecuteOptions,
): Promise<ActionResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const elapsed = (): number => now() - startedAt;

  if (options.actionGeneration !== options.currentGeneration) {
    return failure(
      'STALE_SNAPSHOT',
      'The page changed after you looked at it, so those refs no longer mean anything. Re-read the page.',
      elapsed(),
    );
  }

  if (action.action === 'finish' || action.action === 'fail') {
    // Terminal actions are decisions, not interactions. The loop handles them.
    return { ok: true, durationMs: elapsed(), navigated: false };
  }

  const urlBefore = page.url();

  // Anything buffered from before this action belongs to a previous step.
  options.takeBlockedNavigations?.();

  /**
   * A refused navigation raises nothing and moves nothing, so a click that hit
   * the allowlist would otherwise be reported as a success that changed the
   * page in no way — and the agent would sit there clicking it again.
   */
  const blockedNavigation = (): ActionResult | null => {
    const blocked = options.takeBlockedNavigations?.() ?? [];
    const first = blocked[0];
    if (first === undefined) return null;
    return failure(
      'NAVIGATION_BLOCKED',
      `That leads to ${originLabel(first)}, which is outside the site this simulation is allowed to visit.`,
      elapsed(),
    );
  };

  try {
    switch (action.action) {
      case 'wait': {
        await page.waitForTimeout(action.ms);
        return { ok: true, durationMs: elapsed(), navigated: await detectNavigation(page, urlBefore) };
      }

      case 'scroll': {
        const delta = action.amount === 'half' ? 0.5 : 0.9;
        const direction = action.direction === 'down' ? 1 : -1;
        await page.evaluate(
          ([d, factor]) => window.scrollBy({ top: window.innerHeight * factor * d, behavior: 'instant' }),
          [direction, delta] as const,
        );
        return { ok: true, durationMs: elapsed(), navigated: false };
      }

      case 'go_back': {
        const response = await page.goBack({ timeout });
        if (response === null && page.url() === urlBefore) {
          return failure('NO_HISTORY', 'There is no previous page to go back to.', elapsed());
        }
        return (
          blockedNavigation() ?? {
            ok: true,
            durationMs: elapsed(),
            navigated: await detectNavigation(page, urlBefore),
          }
        );
      }

      case 'press_key': {
        await page.keyboard.press(action.key);
        return (
          blockedNavigation() ?? {
            ok: true,
            durationMs: elapsed(),
            navigated: await detectNavigation(page, urlBefore),
          }
        );
      }

      case 'click':
      case 'type':
      case 'select': {
        const resolved = await resolveRef(page, options.snapshot, action.ref);
        if (!resolved.ok) {
          return { ok: false, error: resolved.error, durationMs: elapsed(), navigated: false };
        }

        const mismatch = checkElementType(action, resolved.value.node);
        if (mismatch !== null) return { ...mismatch, durationMs: elapsed() };

        const blocked = checkDestructive(action, resolved.value.node, options.blockDestructive !== false);
        if (blocked !== null) return { ...blocked, durationMs: elapsed() };

        await performTargeted(action, resolved.value, options, timeout);

        return (
          blockedNavigation() ?? {
            ok: true,
            durationMs: elapsed(),
            navigated: await detectNavigation(page, urlBefore),
            resolvedVia: resolved.value.via,
          }
        );
      }
    }
  } catch (caught) {
    return { ok: false, error: classify(caught), durationMs: elapsed(), navigated: false };
  }
}

/**
 * Refuses an action that does not suit the element, and says what would.
 *
 * Playwright would otherwise spend the full timeout waiting for a `<select>` to
 * become fillable and then report ELEMENT_NOT_ACTIONABLE — "it may be hidden,
 * disabled or still loading". That message is not merely unhelpful, it is
 * wrong, and it is read by two audiences that both act on it: the agent, which
 * retries pointlessly, and the evaluator, which concluded from exactly this
 * wording on a real run that the product's dropdown was broken. It was not.
 *
 * An executor that misdescribes a failure manufactures false findings about
 * somebody's product, so the diagnosis belongs here, where the element is known.
 */
function checkElementType(action: Action, node: SnapshotNode): ActionResult | null {
  const refuse = (message: string): ActionResult => ({
    ok: false,
    error: { kind: 'WRONG_ELEMENT_TYPE', message },
    durationMs: 0,
    navigated: false,
  });

  if (action.action === 'type' && node.role === 'combobox') {
    const options = node.options === undefined ? '' : ` Its options are: ${node.options.join(', ')}.`;
    return refuse(
      `"${node.name}" is a dropdown, not a text field, so there is nothing to type into.` +
        `${options} Use the select action to choose one of them.`,
    );
  }

  if (action.action === 'select' && node.role !== 'combobox') {
    return refuse(`"${node.name}" is not a dropdown, so there is nothing to select in it.`);
  }

  if (action.action === 'type' && node.role !== 'textbox' && node.role !== 'password') {
    return refuse(`"${node.name}" is a ${node.role}, not a text field. You cannot type into it.`);
  }

  return null;
}

function checkDestructive(
  action: Action,
  node: SnapshotNode,
  enabled: boolean,
): ActionResult | null {
  if (!enabled) return null;
  // Only activation can have a side effect; filling a field cannot.
  if (action.action !== 'click') return null;
  if (node.role !== 'button' && node.role !== 'link') return null;
  if (!isDestructiveName(node.name)) return null;

  return {
    ok: false,
    error: {
      kind: 'ACTION_BLOCKED',
      message:
        `"${node.name}" looks like it would take a real action that cannot be undone, ` +
        'so this simulation will not press it. Treat this as the end of the path: ' +
        'if reaching this point was the goal, say so with `finish`.',
    },
    durationMs: 0,
    navigated: false,
  };
}

async function performTargeted(
  action: Extract<Action, { ref: string }>,
  resolution: Resolution,
  options: ExecuteOptions,
  timeout: number,
): Promise<void> {
  const locator: Locator = resolution.locator;

  if (action.action === 'click') {
    await locator.click({ timeout });
    return;
  }

  if (action.action === 'select') {
    // Try the option's value, then its visible label. A person reads labels.
    try {
      await locator.selectOption({ value: action.value }, { timeout });
    } catch {
      await locator.selectOption({ label: action.value }, { timeout });
    }
    return;
  }

  // type
  const value = resolveSecret(action.value, options.secrets);
  await locator.fill(value, { timeout });
  // Pressed on the field itself, not on whatever happens to hold focus: after a
  // fill the two are usually the same, but "usually" is not a guarantee and a
  // stray Enter elsewhere on the page is an untraceable phantom action.
  if (action.submit) await locator.press('Enter', { timeout });
}

/**
 * Substitutes a credential at the last possible moment. The value exists in
 * this call frame and nowhere else — not in the action, the prompt, the log or
 * the session record.
 */
function resolveSecret(
  value: string | { secret: string },
  secrets: ReadonlyMap<string, string>,
): string {
  if (!isSecretRef(value)) return value;
  const resolved = secrets.get(value.secret);
  if (resolved === undefined) {
    throw new SecretNotFoundError(value.secret);
  }
  return resolved;
}

export class SecretNotFoundError extends Error {
  constructor(readonly secretName: string) {
    super(`No credential named ${secretName} is configured for this run.`);
    this.name = 'SecretNotFoundError';
  }
}

import type { Locator, Page } from 'playwright';
import type { SnapshotNode, PageSnapshot } from '../observations/types.ts';
import { err, ok, type ActionError, type Result } from '../types/shared.ts';

/**
 * Turns an opaque ref back into a single element.
 *
 * The rule that matters: **fail rather than guess**. A wrong click is worse than
 * a failed click — a failed click is recorded as friction the customer would
 * also have hit, while a wrong click silently corrupts the whole run and every
 * conclusion drawn from it. So an ambiguous ref is an error, never a coin toss.
 *
 * `data-sim-ref` is tried first. The role+name fallback exists because a page
 * can re-render between observation and action without meaningfully changing —
 * a React re-mount drops our attribute but the button is still the same button.
 */

const REF_ATTR = 'data-sim-ref';

/** Snapshot roles map onto ARIA roles Playwright understands. */
const ARIA_ROLE: Partial<Record<SnapshotNode['role'], string>> = {
  link: 'link',
  button: 'button',
  textbox: 'textbox',
  password: 'textbox',
  checkbox: 'checkbox',
  radio: 'radio',
  combobox: 'combobox',
};

export type Resolution = {
  readonly locator: Locator;
  /** How it was found. Recorded, because falling back is a weak signal of churn. */
  readonly via: 'ref' | 'role-name';
  readonly node: SnapshotNode;
};

export async function resolveRef(
  page: Page,
  snapshot: PageSnapshot,
  ref: string,
): Promise<Result<Resolution, ActionError>> {
  const node = snapshot.nodes.find((candidate) => candidate.ref === ref);
  if (node === undefined) {
    return err({
      kind: 'REF_NOT_FOUND',
      message: `No element ${ref} in the current view.`,
    });
  }

  const stamped = page.locator(`[${REF_ATTR}="${ref}"]`);
  const stampedCount = await stamped.count();
  if (stampedCount === 1) return ok({ locator: stamped, via: 'ref', node });
  if (stampedCount > 1) {
    // Our own stamping is unique per snapshot, so this means the page cloned a
    // subtree after we observed it. We cannot tell the copies apart.
    return err({
      kind: 'REF_AMBIGUOUS',
      message: `${ref} now matches ${stampedCount} elements; the page changed underneath. Re-read the page.`,
    });
  }

  const role = ARIA_ROLE[node.role];
  if (role === undefined || node.name === '') {
    return err({
      kind: 'REF_NOT_FOUND',
      message: `${ref} (${node.role} "${node.name}") is no longer on the page.`,
    });
  }

  const byRole = page.getByRole(role as Parameters<Page['getByRole']>[0], {
    name: node.name,
    exact: true,
  });
  const roleCount = await byRole.count();

  if (roleCount === 1) return ok({ locator: byRole, via: 'role-name', node });
  if (roleCount === 0) {
    return err({
      kind: 'REF_NOT_FOUND',
      message: `${ref} (${node.role} "${node.name}") is no longer on the page.`,
    });
  }

  return err({
    kind: 'REF_AMBIGUOUS',
    message:
      `${ref} matches ${roleCount} elements named "${node.name}". ` +
      'Refusing to guess which one you meant — re-read the page and pick a distinct target.',
  });
}

import type { Page } from 'playwright';
import { extractSnapshot } from './extract.browser.ts';
import { serializeSnapshot } from './serialize.ts';
import type { Observation, PageSnapshot } from './types.ts';
import { redactDeep, type Redactor } from './redact.ts';

/**
 * Observation is read-only. It never clicks, types or navigates; the loop
 * mediates between seeing and acting. The one write it does make is stamping
 * `data-sim-ref` attributes, which is bookkeeping for the resolver rather than
 * an interaction with the product.
 */

/** Beyond this, a page is a wall of text and the model reasons worse, not better. */
const DEFAULT_NODE_BUDGET = 200;

export type SettleOptions = {
  /** Hard cap on waiting for the page to stop moving. */
  readonly timeoutMs: number;
};

/**
 * Waits for the page to stop moving, without ever letting a busy page stall the
 * run. `networkidle` is best-effort on purpose: sites with polling or open
 * sockets never reach it, and a customer would not wait forever either.
 */
export async function settle(page: Page, options: SettleOptions): Promise<void> {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: options.timeoutMs });
  } catch {
    // A page that never finishes loading is itself an observation; carry on and
    // let the agent see whatever is rendered.
  }
  try {
    await page.waitForLoadState('networkidle', { timeout: Math.min(options.timeoutMs, 2000) });
  } catch {
    // Expected on any page with long-lived connections. Not an error.
  }
}

export type ObserveOptions = {
  readonly generation: number;
  readonly redact: Redactor;
  readonly nodeBudget?: number;
  readonly now?: () => number;
};

/**
 * Captures one observation. Redaction happens here, before the snapshot is
 * handed to anything that records or displays it, so no caller can forget.
 */
export async function observe(page: Page, options: ObserveOptions): Promise<Observation> {
  const budget = options.nodeBudget ?? DEFAULT_NODE_BUDGET;
  const raw = (await page.evaluate(extractSnapshot, budget)) as PageSnapshot;
  const snapshot = redactDeep(raw, options.redact);

  return {
    generation: options.generation,
    capturedAt: (options.now ?? Date.now)(),
    snapshot,
    text: serializeSnapshot(snapshot),
  };
}

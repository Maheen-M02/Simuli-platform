import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';

/**
 * Screenshots for a run.
 *
 * These may contain anything the product renders, including a customer's data,
 * so they live under gitignored `data/` and are never attached to logs or
 * prompts. They exist for a human reviewing a run, not for the model — the
 * agent is text-only by design.
 */

export type Artifacts = {
  readonly dir: string;
  /** Returns the saved path, or null when the shot could not be taken. */
  capture(stepIndex: number, page: Page): Promise<string | null>;
};

export function createArtifacts(rootDir: string, sessionId: string): Artifacts {
  const dir = join(rootDir, sessionId);
  mkdirSync(dir, { recursive: true });

  return {
    dir,
    async capture(stepIndex, page) {
      const path = join(dir, `step-${String(stepIndex).padStart(3, '0')}.png`);
      try {
        await page.screenshot({ path, timeout: 5000 });
        return path;
      } catch {
        // A screenshot is diagnostic, not load-bearing. Losing one must never
        // cost us the step it belonged to.
        return null;
      }
    },
  };
}

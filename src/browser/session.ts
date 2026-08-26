import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

/**
 * One browser session per run.
 *
 * Every run gets a fresh, isolated context: no shared profile, cookies or
 * storage. Two runs of the same persona against the same product must be
 * independent, or the second one is measuring the first one's leftovers.
 *
 * Navigation is confined to an origin allowlist by request routing rather than
 * by asking the model nicely. The agent has no `navigate` action, but a product
 * can still redirect to a payment processor or an OAuth provider, and V0 has no
 * business being there.
 */

export type SessionOptions = {
  readonly headless: boolean;
  /** Origins the run may load. The start URL's origin is added automatically. */
  readonly allowedOrigins: readonly string[];
  readonly viewport?: { readonly width: number; readonly height: number };
  /** Called whenever a request is refused, so the run record can show it. */
  readonly onBlockedNavigation?: (url: string) => void;
};

export type BrowserSession = {
  readonly page: Page;
  readonly context: BrowserContext;
  /** Origins this session is confined to. */
  readonly allowedOrigins: ReadonlySet<string>;
  /**
   * Returns the navigations refused since the last call, and clears the buffer.
   *
   * A refused navigation is invisible from the page's point of view: the click
   * succeeds, nothing moves, and no exception is raised. The executor drains
   * this after each action so a block becomes a reported error instead of a
   * silent no-op the agent would retry forever.
   */
  takeBlockedNavigations(): readonly string[];
  close(): Promise<void>;
};

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

/** Shown in place of an off-limits destination. Deliberately plain and honest. */
const BLOCKED_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Outside this simulation</title></head>
<body>
<h1>This page is outside the simulation</h1>
<div role="alert">This destination is not part of the product being tested, so the
simulation did not load it. Go back to return to where you were.</div>
</body></html>`;

export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export async function startSession(
  startUrl: string,
  options: SessionOptions,
): Promise<BrowserSession> {
  const startOrigin = originOf(startUrl);
  if (startOrigin === null) throw new Error(`Not a valid URL: ${startUrl}`);

  const allowedOrigins = new Set<string>([startOrigin]);
  for (const origin of options.allowedOrigins) {
    const normalized = originOf(origin);
    if (normalized !== null) allowedOrigins.add(normalized);
  }

  let blocked: string[] = [];

  const browser: Browser = await chromium.launch({ headless: options.headless });
  const context = await browser.newContext({
    viewport: options.viewport ?? DEFAULT_VIEWPORT,
    // A simulated customer is a customer, not a crawler pretending to be one.
    locale: 'en-US',
    timezoneId: 'UTC',
  });

  // Only top-level document loads are gated. Blocking sub-resources would break
  // pages in ways a real customer would never see, and we would then be
  // measuring our own sandbox instead of the product.
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (request.resourceType() !== 'document' || !request.isNavigationRequest()) {
      return route.continue();
    }
    const origin = originOf(request.url());
    if (origin !== null && allowedOrigins.has(origin)) return route.continue();

    blocked.push(request.url());
    options.onBlockedNavigation?.(request.url());

    // Aborting would leave Chrome on its own error page, which destroys the
    // agent's sense of place and makes the block look like a product crash.
    // Serving a stand-in keeps the browser in a coherent state and gives the
    // agent something it can read and back out of.
    return route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: BLOCKED_PAGE,
    });
  });

  // esbuild (which both tsx and vitest use, configured differently) can compile
  // a named function into a call to an injected `__name` helper. Our DOM walk
  // is stringified and shipped into the page, where that helper does not
  // exist — so the function throws `__name is not defined` on arrival, and the
  // run dies with BROWSER_LOST before its first step.
  //
  // This is invisible to the test suite: vitest's transform does not inject the
  // helper, so the same code that passes under `npm test` fails under the CLI.
  // Rather than depend on any toolchain's settings, give the page a harmless
  // identity shim. Runs before any page script, on every document.
  await context.addInitScript(() => {
    const scope = globalThis as unknown as Record<string, unknown>;
    scope['__name'] ??= (fn: unknown) => fn;
  });

  const page = await context.newPage();

  return {
    page,
    context,
    allowedOrigins,
    takeBlockedNavigations: () => {
      const drained = blocked;
      blocked = [];
      return drained;
    },
    close: async () => {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    },
  };
}

/**
 * Token and latency accounting for model calls.
 *
 * Separate from the client because it is bookkeeping, not transport, and because
 * the benchmark needs it while an ordinary run does not care.
 *
 * Two things it deliberately does not do. It never records a key, or any part of
 * one. And it never invents a price: if per-token rates have not been supplied,
 * cost comes back null rather than as a plausible-looking number somebody would
 * quote. A made-up cost comparison is worse than none, because it looks like a
 * measurement.
 */

export type CallUsage = {
  /** Prompt tokens, when the endpoint reports them. */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** Wall-clock for the request, measured by us and therefore always present. */
  readonly latencyMs: number;
  /** False when the call failed. Failed calls still cost latency. */
  readonly ok: boolean;
};

/** Per-million-token rates. Supplied by configuration, never guessed. */
export type Rates = {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
};

export type UsageTotals = {
  readonly calls: number;
  readonly failedCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** True when at least one call reported no token counts. */
  readonly tokensIncomplete: boolean;
  readonly totalLatencyMs: number;
  readonly averageLatencyMs: number | null;
  /** Null unless rates were configured. */
  readonly costUsd: number | null;
};

export type UsageMeter = {
  record(usage: CallUsage): void;
  totals(): UsageTotals;
  reset(): void;
};

export function createUsageMeter(rates?: Rates): UsageMeter {
  let calls = 0;
  let failedCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let tokensIncomplete = false;
  let totalLatencyMs = 0;

  return {
    record(usage) {
      calls += 1;
      if (!usage.ok) failedCalls += 1;
      totalLatencyMs += usage.latencyMs;

      if (usage.inputTokens === null || usage.outputTokens === null) {
        // Flagged rather than treated as zero: a missing count would otherwise
        // read as a cheap call and quietly flatter whichever provider is silent
        // about usage.
        tokensIncomplete = true;
      }
      inputTokens += usage.inputTokens ?? 0;
      outputTokens += usage.outputTokens ?? 0;
    },

    totals() {
      return {
        calls,
        failedCalls,
        inputTokens,
        outputTokens,
        tokensIncomplete,
        totalLatencyMs,
        averageLatencyMs: calls === 0 ? null : Math.round(totalLatencyMs / calls),
        costUsd:
          rates === undefined
            ? null
            : (inputTokens / 1_000_000) * rates.inputPerMillion +
              (outputTokens / 1_000_000) * rates.outputPerMillion,
      };
    },

    reset() {
      calls = 0;
      failedCalls = 0;
      inputTokens = 0;
      outputTokens = 0;
      tokensIncomplete = false;
      totalLatencyMs = 0;
    },
  };
}

export function formatUsage(totals: UsageTotals, label: string): string {
  const cost =
    totals.costUsd === null
      ? 'not configured (set per-token rates to price this)'
      : `$${totals.costUsd.toFixed(4)}`;

  return [
    `${label}`,
    `  model calls          ${totals.calls}${totals.failedCalls > 0 ? ` (${totals.failedCalls} failed)` : ''}`,
    `  input tokens         ${totals.inputTokens}${totals.tokensIncomplete ? ' (incomplete — some calls reported none)' : ''}`,
    `  output tokens        ${totals.outputTokens}`,
    `  average latency      ${totals.averageLatencyMs === null ? 'n/a' : `${totals.averageLatencyMs}ms`}`,
    `  estimated cost       ${cost}`,
  ].join('\n');
}

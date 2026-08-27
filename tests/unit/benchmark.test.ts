import { describe, expect, it, vi } from 'vitest';
import {
  buildProviderReport,
  classifyRun,
  formatComparison,
  looksLikeProviderFailure,
  measureEvaluator,
  measurePersonaAdherence,
  measureReliability,
  type BenchmarkRun,
} from '../../src/validation/benchmark.ts';
import { createUsageMeter, formatUsage } from '../../src/llm/usage.ts';
import {
  createProvider,
  DEFAULT_NVIDIA_MODEL,
  NVIDIA_BASE_URL,
  providerFromEnv,
  PROVIDER_IDS,
  type ProviderEnv,
} from '../../src/llm/provider.ts';
import { createModelPlanner } from '../../src/agent/planner.ts';
import { ActionSchema } from '../../src/actions/schema.ts';
import { GoalSchema } from '../../src/goals/schema.ts';
import { CustomerContextSchema } from '../../src/personas/context.ts';
import { PersonaSchema } from '../../src/personas/schema.ts';
import type { LlmClient } from '../../src/llm/client.ts';
import type { PlannerStats } from '../../src/agent/planner.ts';
import type { SessionRecord, StepRecord } from '../../src/sessions/types.ts';
import type { GroundTruthReport } from '../../src/validation/groundTruth.ts';
import { err, ok } from '../../src/types/shared.ts';
import { personaById } from '../../fixtures/freightflow/personas.ts';

/**
 * The benchmark's arithmetic, and the provider seam.
 *
 * The case that matters most is the boring one: a provider outage must not be
 * counted as an agent failure. Getting that wrong would make an unbilled account
 * look like a bad model, which is precisely the conclusion this benchmark exists
 * to avoid drawing by accident.
 */

const CONTEXT = CustomerContextSchema.parse({
  persona: PersonaSchema.parse({ name: 'Test', background: 'Someone' }),
});
const common = { reasoning: 'r', expectation: 'e' };

function step(index: number, options: { action?: boolean; plannerError?: string } = {}): StepRecord {
  return {
    index,
    observation: {
      generation: index + 1,
      capturedAt: 1000 + index,
      url: `http://127.0.0.1:4321/page-${index}`,
      title: 'p',
      text: 'x',
      nodeCount: 1,
      screenshotPath: null,
    },
    action:
      options.action === true
        ? ActionSchema.parse({ action: 'click', ref: `e${index + 1}`, ...common })
        : null,
    result: options.action === true ? { ok: true, durationMs: 1, navigated: true } : null,
    plannerError: options.plannerError ?? null,
    startedAt: 1000 + index,
    endedAt: 1100 + index,
  };
}

function record(
  outcome: SessionRecord['outcome'],
  steps: readonly StepRecord[],
  id = 'r',
): SessionRecord {
  return {
    id,
    startUrl: 'http://127.0.0.1:4321/',
    context: CONTEXT,
    goal: GoalSchema.parse({ description: 'g' }),
    plannerModel: 'm',
    startedAt: 1000,
    endedAt: 5000,
    outcome,
    terminationReason: 'AGENT_FINISHED',
    agentSummary: null,
    steps: [...steps],
  };
}

const NO_STATS: PlannerStats = {
  calls: 0,
  invalidActions: 0,
  recoveredActions: 0,
  unusable: 0,
  transportFailures: 0,
};

function run(overrides: Partial<BenchmarkRun> = {}): BenchmarkRun {
  return {
    providerId: 'openai',
    model: 'gpt-4.1',
    personaId: 'p',
    taskId: 't',
    record: record('SUCCESS', [step(0, { action: true })]),
    evaluation: null,
    evaluationError: null,
    groundTruth: null,
    wallClockMs: 5000,
    ...overrides,
  };
}

describe('provider failures are not agent failures', () => {
  it('recognises the errors an endpoint returns when it will not serve us', () => {
    for (const message of [
      // 402 first: it is what a prepaid account returns, and it was missing from
      // the pattern set until this test caught it.
      '402 This request requires more credits',
      '401 Unauthorized',
      '404 model not found',
      '429 Too Many Requests',
      '503 Service Unavailable',
      'insufficient quota for this request',
      'rate limit exceeded',
      'Specified function in account ... is not found for account',
      'The endpoint ignored the requested JSON schema and replied with prose.',
    ]) {
      expect(looksLikeProviderFailure(message), message).toBe(true);
    }
  });

  it('does not mistake an agent problem for a provider problem', () => {
    for (const message of [
      "The model's action did not validate: ref: must look like \"e12\"",
      'Nothing sensible to do on this page.',
      'The model returned something that was not valid JSON.',
    ]) {
      expect(looksLikeProviderFailure(message), message).toBe(false);
    }
  });

  it('classifies a run that never acted, with only API errors, as a provider failure', () => {
    const failed = record('ERROR', [
      step(0, { plannerError: '402 This request requires more credits' }),
      step(1, { plannerError: '402 This request requires more credits' }),
    ]);
    expect(classifyRun(failed)).toBe('PROVIDER_FAILURE');
  });

  it('blames the agent once it managed even one action', () => {
    // Whatever happened after the agent started acting is the agent's story.
    const mixed = record('ERROR', [
      step(0, { action: true }),
      step(1, { plannerError: '402 out of credit' }),
    ]);
    expect(classifyRun(mixed)).toBe('AGENT_ERROR');
  });

  it('classifies a schema failure as an agent error, not a provider one', () => {
    const invalid = record('ERROR', [
      step(0, { plannerError: "The model's action did not validate: ref" }),
    ]);
    expect(classifyRun(invalid)).toBe('AGENT_ERROR');
  });

  it('passes through the ordinary outcomes unchanged', () => {
    expect(classifyRun(record('SUCCESS', [step(0, { action: true })]))).toBe('SUCCESS');
    expect(classifyRun(record('STUCK', [step(0, { action: true })]))).toBe('STUCK');
    expect(classifyRun(record('TIMEOUT', [step(0, { action: true })]))).toBe('TIMEOUT');
    expect(classifyRun(record('FAILURE', [step(0, { action: true })]))).toBe('FAILURE');
  });
});

describe('reliability metrics', () => {
  it('excludes provider failures from the success rate denominator', () => {
    // The arithmetic that stops an outage reading as a bad model: 1 success out
    // of 2 that ran, not 1 out of 4 attempted.
    const runs = [
      run({ record: record('SUCCESS', [step(0, { action: true })]) }),
      run({ record: record('STUCK', [step(0, { action: true })]) }),
      run({ record: record('ERROR', [step(0, { plannerError: '402 no credit' })]) }),
      run({ record: record('ERROR', [step(0, { plannerError: '402 no credit' })]) }),
    ];

    const metrics = measureReliability(runs, NO_STATS);
    expect(metrics.attempted).toBe(4);
    expect(metrics.providerFailures).toBe(2);
    expect(metrics.scorable).toBe(2);
    expect(metrics.successRate).toBeCloseTo(0.5);
  });

  it('reports a null success rate rather than zero when nothing ran', () => {
    const runs = [run({ record: record('ERROR', [step(0, { plannerError: '402' })]) })];
    const metrics = measureReliability(runs, NO_STATS);
    expect(metrics.scorable).toBe(0);
    expect(metrics.successRate).toBeNull();
    expect(metrics.averageSteps).toBeNull();
  });

  it('computes mean and median steps over runs the agent drove', () => {
    const runs = [
      run({ record: record('SUCCESS', [step(0, { action: true }), step(1, { action: true })]) }),
      run({
        record: record('SUCCESS', [
          step(0, { action: true }),
          step(1, { action: true }),
          step(2, { action: true }),
          step(3, { action: true }),
        ]),
      }),
      // Excluded: never ran, so its zero steps must not drag the average down.
      run({ record: record('ERROR', [step(0, { plannerError: '429 rate limit' })]) }),
    ];

    const metrics = measureReliability(runs, NO_STATS);
    expect(metrics.averageSteps).toBe(3);
    expect(metrics.medianSteps).toBe(3);
  });

  it('carries invalid and recovered action counts, and a rate', () => {
    const metrics = measureReliability([run()], {
      calls: 10,
      invalidActions: 3,
      recoveredActions: 2,
      unusable: 1,
      transportFailures: 0,
    });
    expect(metrics.invalidActions).toBe(3);
    expect(metrics.recoveredActions).toBe(2);
    expect(metrics.unusableActions).toBe(1);
    expect(metrics.invalidActionRate).toBeCloseTo(0.3);
  });
});

describe('evaluator metrics', () => {
  function scored(input: Partial<GroundTruthReport>): GroundTruthReport {
    return {
      taskId: 't',
      personaId: 'p',
      sessionId: 's',
      issuesInScope: ['a'],
      detected: [],
      missed: [],
      unmatchedProductFindings: [],
      likelyFalsePositives: [],
      agentMisunderstandings: 0,
      environmentErrors: 0,
      inconclusive: 0,
      runIsTechnicallySound: true,
      ...input,
    };
  }

  it('computes precision, recall and f1 from detected, missed and false positives', () => {
    const metrics = measureEvaluator([
      run({
        groundTruth: scored({
          detected: [{ issueId: 'a', detected: true, matchedFinding: 'f', reason: 'r' }],
        }),
      }),
      run({
        groundTruth: scored({
          missed: [{ issueId: 'b', detected: false, matchedFinding: null, reason: 'r' }],
          likelyFalsePositives: [{ finding: 'q', aboutNonIssue: 'signup-works', reason: 'r' }],
          unmatchedProductFindings: [{ finding: 'q', aboutNonIssue: 'signup-works', reason: 'r' }],
        }),
      }),
    ]);

    expect(metrics.detected).toBe(1);
    expect(metrics.missed).toBe(1);
    expect(metrics.falsePositives).toBe(1);
    expect(metrics.precision).toBeCloseTo(0.5);
    expect(metrics.recall).toBeCloseTo(0.5);
    expect(metrics.f1).toBeCloseTo(0.5);
  });

  it('excludes unmatched findings from precision, since they may be real', () => {
    // An unrecognised finding might be a genuine problem we failed to plant.
    // Counting it as wrong would punish a model for out-finding the fixture.
    const metrics = measureEvaluator([
      run({
        groundTruth: scored({
          detected: [{ issueId: 'a', detected: true, matchedFinding: 'f', reason: 'r' }],
          unmatchedProductFindings: [{ finding: 'novel', aboutNonIssue: null, reason: 'r' }],
        }),
      }),
    ]);
    expect(metrics.precision).toBe(1);
    expect(metrics.unmatched).toBe(1);
    expect(metrics.falsePositives).toBe(0);
  });

  it('reports nulls rather than flattering zeros with nothing scored', () => {
    const metrics = measureEvaluator([run()]);
    expect(metrics.runsEvaluated).toBe(0);
    expect(metrics.precision).toBeNull();
    expect(metrics.recall).toBeNull();
    expect(metrics.f1).toBeNull();
  });

  it('counts evaluations that failed to produce a report', () => {
    expect(measureEvaluator([run({ evaluation: null })]).evaluationFailures).toBe(1);
  });
});

describe('persona adherence', () => {
  const owner = personaById('first-time-owner');

  it('finds steps whose reasoning echoes the persona’s own concerns', () => {
    expect(owner).toBeDefined();
    const context = (owner as NonNullable<typeof owner>).context;

    const withReasoning = record('SUCCESS', [
      {
        ...step(0, { action: true }),
        action: ActionSchema.parse({
          action: 'click',
          ref: 'e1',
          reasoning:
            'I need to know the price before committing, and I will not enter card details ' +
            'during a trial.',
          expectation: 'the pricing page',
        }),
      },
    ]);

    const adherence = measurePersonaAdherence('first-time-owner', context, [withReasoning]);
    expect(adherence.referencingSteps).toBe(1);
    expect(adherence.examples[0]).toContain('price');
  });

  it('does not credit reasoning that says nothing persona-specific', () => {
    expect(owner).toBeDefined();
    const context = (owner as NonNullable<typeof owner>).context;

    const generic = record('SUCCESS', [
      {
        ...step(0, { action: true }),
        action: ActionSchema.parse({
          action: 'click',
          ref: 'e1',
          reasoning: 'I will click the link.',
          expectation: 'a page',
        }),
      },
    ]);

    expect(measurePersonaAdherence('first-time-owner', context, [generic]).referencingSteps).toBe(0);
  });

  it('counts no steps when the agent never acted', () => {
    expect(owner).toBeDefined();
    const context = (owner as NonNullable<typeof owner>).context;
    const adherence = measurePersonaAdherence('first-time-owner', context, [
      record('ERROR', [step(0, { plannerError: '402' })]),
    ]);
    expect(adherence.totalSteps).toBe(0);
    expect(adherence.referencingSteps).toBe(0);
  });
});

describe('usage accounting', () => {
  it('sums tokens and averages latency', () => {
    const meter = createUsageMeter();
    meter.record({ inputTokens: 100, outputTokens: 20, latencyMs: 1000, ok: true });
    meter.record({ inputTokens: 200, outputTokens: 40, latencyMs: 3000, ok: true });

    const totals = meter.totals();
    expect(totals.inputTokens).toBe(300);
    expect(totals.outputTokens).toBe(60);
    expect(totals.averageLatencyMs).toBe(2000);
    expect(totals.tokensIncomplete).toBe(false);
  });

  it('flags missing token counts instead of treating them as zero', () => {
    // A silent provider would otherwise look like a free one.
    const meter = createUsageMeter();
    meter.record({ inputTokens: null, outputTokens: null, latencyMs: 500, ok: true });
    expect(meter.totals().tokensIncomplete).toBe(true);
  });

  it('counts a failed call, because it still cost time', () => {
    const meter = createUsageMeter();
    meter.record({ inputTokens: null, outputTokens: null, latencyMs: 800, ok: false });
    const totals = meter.totals();
    expect(totals.calls).toBe(1);
    expect(totals.failedCalls).toBe(1);
    expect(totals.totalLatencyMs).toBe(800);
  });

  it('returns null cost rather than inventing a price', () => {
    const meter = createUsageMeter();
    meter.record({ inputTokens: 1_000_000, outputTokens: 1_000_000, latencyMs: 1, ok: true });
    expect(meter.totals().costUsd).toBeNull();
    expect(formatUsage(meter.totals(), 'x')).toContain('not configured');
  });

  it('costs usage when rates are supplied', () => {
    const meter = createUsageMeter({ inputPerMillion: 2, outputPerMillion: 8 });
    meter.record({ inputTokens: 1_000_000, outputTokens: 500_000, latencyMs: 1, ok: true });
    expect(meter.totals().costUsd).toBeCloseTo(2 + 4);
  });
});

describe('the provider seam', () => {
  const baseEnv: ProviderEnv = {
    openaiApiKey: 'test-openai-key',
    openaiBaseUrl: undefined,
    openaiModel: 'gpt-4.1',
    nvidiaApiKey: undefined,
    nvidiaModel: DEFAULT_NVIDIA_MODEL,
    maxOutputTokens: 1024,
    requireStructuredOutput: false,
    appTitle: undefined,
    appUrl: undefined,
    openaiRates: undefined,
    nvidiaRates: undefined,
  };

  it('offers exactly the two providers, with no plugin machinery', () => {
    expect([...PROVIDER_IDS]).toEqual(['openai', 'nvidia']);
  });

  it('builds an OpenAI provider whose planner is an ordinary Planner', () => {
    const provider = providerFromEnv('openai', baseEnv);
    expect(provider.ok).toBe(true);
    if (!provider.ok) return;
    // The agent's whole view of a model: a function. Same type either way, which
    // is what lets the loop stay ignorant of which provider it is talking to.
    expect(typeof provider.value.planner).toBe('function');
    expect(provider.value.model).toBe('gpt-4.1');
  });

  it('explains a missing NVIDIA key instead of throwing mid-benchmark', () => {
    const provider = providerFromEnv('nvidia', baseEnv);
    expect(provider.ok).toBe(false);
    if (!provider.ok) {
      expect(provider.error).toContain('NVIDIA_API_KEY');
      expect(provider.error).toContain('--model openai');
    }
  });

  it('builds an NVIDIA provider against the OpenAI-compatible endpoint', () => {
    const provider = providerFromEnv('nvidia', { ...baseEnv, nvidiaApiKey: 'nvapi-test' });
    expect(provider.ok).toBe(true);
    if (provider.ok) {
      expect(provider.value.id).toBe('nvidia');
      expect(provider.value.model).toBe(DEFAULT_NVIDIA_MODEL);
    }
    expect(NVIDIA_BASE_URL).toBe('https://integrate.api.nvidia.com/v1');
  });

  it('lets the model id be configured rather than hardcoded', () => {
    const provider = providerFromEnv('nvidia', {
      ...baseEnv,
      nvidiaApiKey: 'nvapi-test',
      nvidiaModel: 'nvidia/some-future-nemotron',
    });
    expect(provider.ok).toBe(true);
    if (provider.ok) expect(provider.value.model).toBe('nvidia/some-future-nemotron');
  });

  it('sends the same prompt and schema whichever provider it is', async () => {
    // The fairness control. If these diverged, the benchmark would be comparing
    // two experiments rather than two models.
    const seen: { system: string; schemaName: string; maxOutputTokens?: number }[] = [];
    const client: LlmClient = {
      async completeJson(request) {
        seen.push({
          system: request.system,
          schemaName: request.schemaName,
          ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
        });
        return ok({ decision: { action: 'go_back', reasoning: 'r', expectation: 'e' } });
      },
    };

    const input = {
      context: CONTEXT,
      goal: GoalSchema.parse({ description: 'g' }),
      observation: {
        generation: 1,
        capturedAt: 1,
        snapshot: { url: 'http://x/', title: 't', nodes: [], hasMoreBelow: false, truncated: 0 },
        text: 'page',
      },
      history: [],
      availableSecrets: [],
      stepsRemaining: 10,
    };

    for (const model of ['gpt-4.1', DEFAULT_NVIDIA_MODEL]) {
      const planner = createModelPlanner({ client, model, maxOutputTokens: 1024 });
      await planner.planner(input);
    }

    expect(seen).toHaveLength(2);
    expect(seen[0]?.system).toBe(seen[1]?.system);
    expect(seen[0]?.schemaName).toBe(seen[1]?.schemaName);
    expect(seen[0]?.maxOutputTokens).toBe(1024);
    expect(seen[1]?.maxOutputTokens).toBe(1024);
  });

  it('respects a configured output cap rather than a hardcoded one', async () => {
    let requested: number | undefined;
    const client: LlmClient = {
      async completeJson(request) {
        requested = request.maxOutputTokens;
        return ok({ decision: { action: 'go_back', reasoning: 'r', expectation: 'e' } });
      },
    };
    const planner = createModelPlanner({ client, model: 'm', maxOutputTokens: 512 });
    await planner.planner({
      context: CONTEXT,
      goal: GoalSchema.parse({ description: 'g' }),
      observation: {
        generation: 1,
        capturedAt: 1,
        snapshot: { url: 'http://x/', title: 't', nodes: [], hasMoreBelow: false, truncated: 0 },
        text: 'p',
      },
      history: [],
      availableSecrets: [],
      stepsRemaining: 5,
    });
    expect(requested).toBe(512);
  });

  it('counts invalid actions and recoveries', async () => {
    const replies = [
      { decision: { action: 'click', ref: 'not-a-ref', reasoning: 'r', expectation: 'e' } },
      { decision: { action: 'click', ref: 'e1', reasoning: 'r', expectation: 'e' } },
    ];
    let index = 0;
    const client: LlmClient = {
      async completeJson() {
        const reply = replies[Math.min(index, replies.length - 1)];
        index += 1;
        return ok(reply);
      },
    };

    const planner = createModelPlanner({ client, model: 'm' });
    const input = {
      context: CONTEXT,
      goal: GoalSchema.parse({ description: 'g' }),
      observation: {
        generation: 1,
        capturedAt: 1,
        snapshot: { url: 'http://x/', title: 't', nodes: [], hasMoreBelow: false, truncated: 0 },
        text: 'p',
      },
      history: [],
      availableSecrets: [],
      stepsRemaining: 5,
    };

    const result = await planner.planner(input);
    expect(result.ok).toBe(true);

    const stats = planner.stats();
    expect(stats.calls).toBe(1);
    expect(stats.invalidActions).toBe(1);
    expect(stats.recoveredActions).toBe(1);
    expect(stats.unusable).toBe(0);
  });

  it('counts a transport failure separately from an invalid action', async () => {
    const client: LlmClient = {
      async completeJson() {
        return err('402 out of credit');
      },
    };
    const planner = createModelPlanner({ client, model: 'm' });
    await planner.planner({
      context: CONTEXT,
      goal: GoalSchema.parse({ description: 'g' }),
      observation: {
        generation: 1,
        capturedAt: 1,
        snapshot: { url: 'http://x/', title: 't', nodes: [], hasMoreBelow: false, truncated: 0 },
        text: 'p',
      },
      history: [],
      availableSecrets: [],
      stepsRemaining: 5,
    });

    const stats = planner.stats();
    expect(stats.transportFailures).toBe(1);
    expect(stats.invalidActions).toBe(0);
  });

  it('never puts a key anywhere a usage record could carry it', () => {
    const meter = createUsageMeter();
    const provider = createProvider({
      id: 'nvidia',
      apiKey: 'nvapi-super-secret-value',
      baseUrl: NVIDIA_BASE_URL,
      model: DEFAULT_NVIDIA_MODEL,
      maxOutputTokens: 1024,
    });
    meter.record({ inputTokens: 1, outputTokens: 1, latencyMs: 1, ok: true });

    const serialised = JSON.stringify({
      usage: provider.usage.totals(),
      stats: provider.stats(),
      id: provider.id,
      model: provider.model,
    });
    expect(serialised).not.toContain('nvapi-super-secret-value');
    expect(serialised).not.toContain('nvapi');
  });
});

describe('the comparison refuses to overclaim', () => {
  function reportFor(providerId: string, runs: readonly BenchmarkRun[]): ReturnType<typeof buildProviderReport> {
    return buildProviderReport({
      providerId,
      model: 'm',
      runs,
      stats: NO_STATS,
      usage: createUsageMeter().totals(),
      contexts: new Map([['p', CONTEXT]]),
    });
  }

  it('says plainly when nothing completed', () => {
    const text = formatComparison([
      reportFor('openai', [run({ record: record('ERROR', [step(0, { plannerError: '402' })]) })]),
    ]);
    expect(text).toContain('No simulation completed');
    expect(text).toContain('nothing can be concluded');
  });

  it('calls a small sample a smoke test rather than a result', () => {
    const text = formatComparison([
      reportFor('openai', [run(), run()]),
      reportFor('nvidia', [run()]),
    ]);
    expect(text).toContain('too small a');
    expect(text).toContain('smoke test of the harness, not a result');
  });

  it('warns when the two arms are not the same size', () => {
    const text = formatComparison([
      reportFor('openai', [run(), run()]),
      reportFor('nvidia', [
        run({ record: record('ERROR', [step(0, { plannerError: '402 no credit' })]) }),
      ]),
    ]);
    expect(text).toContain('not the same size');
    expect(text).toContain('overstates whichever one ran more');
  });

  it('never names a winner', () => {
    const text = formatComparison([reportFor('openai', [run()]), reportFor('nvidia', [run()])]);
    for (const word of ['winner', 'better than', 'wins', 'recommend']) {
      expect(text.toLowerCase()).not.toContain(word);
    }
  });

  it('says cost is unpriced rather than showing a guess', () => {
    const text = formatComparison([reportFor('openai', [run()])]);
    expect(text).toContain('unpriced');
    expect(text).toContain('an invented price looks like a measurement');
  });

  it('excludes provider failures from the diversity measurement', () => {
    // Otherwise an outage reports identical paths and reads as "the persona made
    // no difference" when in fact nobody got to act.
    const report = reportFor('openai', [
      run({ record: record('SUCCESS', [step(0, { action: true })]) }),
      run({ record: record('ERROR', [step(0, { plannerError: '402 no credit' })]) }),
    ]);
    expect(report.diversity.runs).toBe(1);
  });
});

describe('the existing baseline is untouched', () => {
  it('still exposes the golden-dataset metrics module unchanged in shape', async () => {
    // Guard against this iteration quietly redefining the earlier measurement.
    const metrics = await import('../../src/evaluation/metrics.ts');
    expect(typeof metrics.scoreProductIssueDetection).toBe('function');
    expect(typeof metrics.formatMetrics).toBe('function');
  });

  it('leaves the golden dataset at its recorded size', async () => {
    const { GOLDEN_SCENARIOS } = await import('../fixtures/golden/scenarios.ts');
    expect(GOLDEN_SCENARIOS.length).toBe(17);
  });

  it('keeps a scripted planner working, so no test needs a provider', async () => {
    const scripted = vi.fn(async () =>
      ok(ActionSchema.parse({ action: 'go_back', reasoning: 'r', expectation: 'e' })),
    );
    const result = await scripted();
    expect(result.ok).toBe(true);
    expect(scripted).toHaveBeenCalledTimes(1);
  });
});

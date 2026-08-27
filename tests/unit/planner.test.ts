import { describe, expect, it, vi } from 'vitest';
import { createModelPlanner, type PlannerInput } from '../../src/agent/planner.ts';
import { buildSystemPrompt, buildUserPrompt } from '../../src/agent/prompt.ts';
import type { LlmClient } from '../../src/llm/client.ts';
import { DEFAULT_PERSONA, PersonaSchema } from '../../src/personas/schema.ts';
import { CustomerContextSchema } from '../../src/personas/context.ts';
import { GoalSchema } from '../../src/goals/schema.ts';
import { err, ok } from '../../src/types/shared.ts';
import type { Observation } from '../../src/observations/types.ts';

/** Same persona as before, now inside the context envelope. */
const CONTEXT = CustomerContextSchema.parse({ persona: DEFAULT_PERSONA });


/**
 * The planner boundary, with a fake client. No API call happens here.
 *
 * What matters is what the planner does with what a model hands back — and the
 * cases worth testing are the bad ones, because a model that returns a selector
 * or invents a ref must be stopped by us rather than by good luck.
 */

const observation: Observation = {
  generation: 3,
  capturedAt: 1000,
  snapshot: {
    url: 'http://site.test/signup',
    title: 'Sign up',
    nodes: [
      { ref: 'e1', role: 'textbox', name: 'Work email', inViewport: true },
      { ref: 'e2', role: 'password', name: 'Password', inViewport: true },
      { ref: 'e3', role: 'button', name: 'Create account', inViewport: true },
    ],
    hasMoreBelow: false,
    truncated: 0,
  },
  text: 'URL: http://site.test/signup\ntextbox "Work email" [e1]',
};

const input: PlannerInput = {
  context: CONTEXT,
  goal: GoalSchema.parse({ description: 'Create an account' }),
  observation,
  history: [],
  availableSecrets: ['PASSWORD'],
  stepsRemaining: 20,
};

/** A client that returns the given payloads in order. */
function fakeClient(...payloads: unknown[]): { client: LlmClient; calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  return {
    calls,
    client: {
      async completeJson(request) {
        calls.push(request.user);
        const payload = payloads[Math.min(index, payloads.length - 1)];
        index += 1;
        return payload instanceof Error ? err(payload.message) : ok(payload);
      },
    },
  };
}

const planner = (client: LlmClient) => createModelPlanner({ client, model: 'test-model' });

describe('model planner', () => {
  it('accepts a well-formed decision', async () => {
    const { client } = fakeClient({
      decision: {
        action: 'click',
        ref: 'e3',
        reasoning: 'I have filled everything in',
        expectation: 'my account is created',
      },
    });

    const result = await planner(client)(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.action).toBe('click');
  });

  it('accepts a decision returned without the wrapper', async () => {
    const { client } = fakeClient({
      action: 'go_back',
      reasoning: 'wrong page',
      expectation: 'the previous page',
    });
    expect((await planner(client)(input)).ok).toBe(true);
  });

  it('retries once with the validation errors, and accepts the correction', async () => {
    const { client, calls } = fakeClient(
      { decision: { action: 'click', ref: 'button.submit', reasoning: 'r', expectation: 'e' } },
      { decision: { action: 'click', ref: 'e3', reasoning: 'r', expectation: 'e' } },
    );

    const result = await planner(client)(input);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    // The second prompt tells the model what was wrong with the first.
    expect(calls[1]).toContain('could not be used');
    expect(calls[1]).toContain('ref');
  });

  it('gives up rather than coercing a persistently invalid action', async () => {
    const { client, calls } = fakeClient({
      decision: { action: 'navigate', url: 'https://evil.test', reasoning: 'r', expectation: 'e' },
    });

    const result = await planner(client)(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('did not validate');
    expect(calls).toHaveLength(2);
  });

  it('never turns a selector into an action', async () => {
    const { client } = fakeClient({
      decision: { action: 'click', ref: '#pay-now', reasoning: 'r', expectation: 'e' },
    });
    expect((await planner(client)(input)).ok).toBe(false);
  });

  it('passes a transport failure through as a planner failure', async () => {
    const { client } = fakeClient(new Error('rate limited'));
    const result = await planner(client)(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('rate limited');
  });

  it('does not retry a transport failure at this level', async () => {
    // Retrying the network is the client's job; doing it here too would
    // multiply the attempts and the bill.
    const completeJson = vi.fn(async () => err('service unavailable'));
    await planner({ completeJson })(input);
    expect(completeJson).toHaveBeenCalledTimes(1);
  });
});

describe('prompt construction', () => {
  it('tells the model who it is and what it wants', () => {
    const system = buildSystemPrompt(input);
    expect(system).toContain(DEFAULT_PERSONA.name);
    expect(system).toContain('Create an account');
  });

  it('names available credentials but never their values', () => {
    const system = buildSystemPrompt(input);
    expect(system).toContain('PASSWORD');
    expect(system).toContain('{"secret": "PASSWORD"}');
    expect(system).not.toContain('correct-horse');
  });

  it('says so plainly when there are no credentials', () => {
    expect(buildSystemPrompt({ ...input, availableSecrets: [] })).toContain('No stored credentials');
  });

  it('tells the agent to act like the person, not like an expert', () => {
    const system = buildSystemPrompt(input);
    expect(system).toContain('not as an expert would');
  });

  it('forbids destructive actions and names the way out', () => {
    const system = buildSystemPrompt(input);
    expect(system).toContain('WOULD_BE_DESTRUCTIVE');
  });

  it('shows the page as the agent saw it', () => {
    expect(buildUserPrompt(input)).toContain(observation.text);
  });

  it('includes expectation-versus-reality for past steps', () => {
    const user = buildUserPrompt({
      ...input,
      history: [
        {
          stepIndex: 0,
          action: 'click e3',
          expectation: 'my account is created',
          outcome: 'You are on the same page. It now reads: Sign up — alert "Password must be..."',
        },
      ],
    });

    expect(user).toContain('You expected: my account is created');
    expect(user).toContain('What happened:');
    expect(user).toContain('Password must be');
  });

  it('warns honestly when the run is nearly out of steps', () => {
    expect(buildUserPrompt({ ...input, stepsRemaining: 2 })).toContain('steps left');
    expect(buildUserPrompt({ ...input, stepsRemaining: 30 })).not.toContain('steps left');
  });

  it('carries a persona\'s refusals into the prompt', () => {
    const persona = PersonaSchema.parse({
      name: 'Priya',
      background: 'Cautious buyer',
      wontDo: ['enter real card details'],
    });
    expect(
      buildSystemPrompt({ ...input, context: CustomerContextSchema.parse({ persona }) }),
    ).toContain('enter real card details');
  });
});

describe('OpenAI-compatible endpoints', () => {
  it('names a silent schema downgrade instead of reporting a parse failure', async () => {
    // Measured behaviour on NVIDIA NIM: some models accept response_format and
    // return prose with a 200. Retrying cannot fix a misconfigured endpoint, so
    // the error has to say what is actually wrong.
    const proseClient: LlmClient = {
      async completeJson() {
        return err(
          'The endpoint ignored the requested JSON schema and replied with prose. ' +
            'Model "meta/llama-3.2-11b-vision-instruct" cannot be used for this: ' +
            'pick one that supports strict structured output.',
        );
      },
    };

    const result = await planner(proseClient)(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('ignored the requested JSON schema');
      expect(result.error).toContain('strict structured output');
    }
  });
});

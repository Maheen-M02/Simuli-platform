# Model provider benchmark

Comparing OpenAI GPT-4.1 against NVIDIA Nemotron Ultra as the planner behind our
customer simulation agent.

> **Status: no data collected.** The harness is built, tested and verified, but
> zero of the 18 planned simulations completed. OpenAI credits are exhausted and
> no NVIDIA key is configured. Every results table below is empty, deliberately,
> rather than filled with a partial run presented as a comparison. See
> [§11 Failures](#11-failures).

---

## 1. Experimental setup

One intended variable: which provider answers the planner.

Held constant across every arm:

| | |
|---|---|
| Target application | FreightFlow, local, fresh instance per simulation |
| Personas | 3, identical definitions |
| Goals | 3, identical wording |
| Browser | Playwright Chromium, headless, isolated context per run |
| Observation layer | Same DOM walk, same 400-node budget |
| Action schema | Same Zod discriminated union |
| Prompt | Same system and user prompt, byte for byte |
| Termination rules | 30 steps, 600s wall clock, same loop detectors |
| Evaluator | **Always OpenAI**, never the arm's own provider |

That last row is the fairness control worth stating twice. Letting the evaluator
follow the planner would mean the NVIDIA arm was judged by a different judge, and
its findings would not be comparable with OpenAI's. The planner varies; the judge
does not.

A fresh FreightFlow instance per simulation, because a shared one would let an
earlier run's shipments and invoices change what a later one sees — and then a
difference between arms could be caused by ordering rather than by the model.

### Running it

```bash
npm run benchmark:models -- --model both
npm run benchmark:models -- --model openai --out docs/bench-openai.json
npm run benchmark:models -- --model nvidia --tasks find-pricing --personas first-time-owner
```

Exits non-zero when no simulation completed, because a benchmark that collected
nothing is a failure of the benchmark and not a result.

## 2. Exact model identifiers

| Arm | Identifier | Endpoint |
|---|---|---|
| A | `gpt-4.1` | `OPENAI_BASE_URL`, currently OpenRouter |
| B | `nvidia/llama-3.1-nemotron-ultra-253b-v1` | `https://integrate.api.nvidia.com/v1` |

Both are configurable — `OPENAI_PLANNER_MODEL` and `NVIDIA_MODEL`. Neither is
hardcoded, because NVIDIA renames and retires ids and a model that stops
resolving should be a config change.

**Verify an id before spending a benchmark on it:**

```bash
npm run check:endpoint -- --model nvidia/llama-3.1-nemotron-ultra-253b-v1
```

NVIDIA's catalogue lists models that are not served to a given account; those
return `404 ... not found for account` on use. Measured earlier in this project:
`nvidia/llama-3.1-nemotron-70b-instruct` and `deepseek-ai/deepseek-v4-flash-0731`
were both listed and both 404'd, while `openai/gpt-oss-120b` worked. Listing is
not entitlement.

**The unverified assumption in arm B.** We have not confirmed Nemotron Ultra
honours `response_format` with a strict `json_schema` on NIM. It is a hard
requirement — the planner cannot work without it. Measured on NIM earlier,
`meta/llama-3.2-11b-vision-instruct` accepts the parameter and silently returns
prose with HTTP 200, which no prompt can fix. `check:endpoint` distinguishes
`HONOURED` from `IGNORED` in one request; run it first.

## 3. Prompt and configuration

The prompt is identical across arms. `createModelPlanner` is constructed the same
way for both, with the same system prompt, the same user prompt, the same
`ACTION_JSON_SCHEMA`, and the same one-retry-on-validation-failure policy.

**No per-model prompt tuning was done.** That was the instruction and it is also
the only way a first benchmark means anything: tuning one arm first would measure
the tuning.

Provider-specific concerns are isolated below the prompt, in `ClientOptions`:

- `baseUrl` — transport only.
- `extraBody` — extra request fields for a provider whose structured output needs
  them. Empty for both arms in this configuration. If Nemotron turns out to need
  a `chat_template_kwargs` thinking toggle, it goes here, is recorded in this
  document as a deviation, and does not change the semantic prompt.

Token control:

| Setting | Value | Why |
|---|---|---|
| `PLANNER_MAX_OUTPUT_TOKENS` | 1024 | An action plus its reasoning is a few hundred tokens. |
| Evaluator cap | 4096 | A full report is larger. |

An unbounded budget is not free: earlier in this project an unset `max_tokens`
caused OpenRouter to reserve the model's whole 65k context and refuse the request
outright, and a metered endpoint would have billed for a runaway reply instead.
Both caps are configurable.

Token usage is logged per call when the endpoint reports it. **Keys are never
logged.** A test asserts no key can appear in a serialised usage or stats record.

## 4. Personas

Three, from the six defined in `fixtures/freightflow/personas.ts`, chosen to be
materially different rather than three shades of the same careful user.

| id | Who | Tech | Patience |
|---|---|---|---|
| `first-time-owner` | Owner of a 40-person haulier, on spreadsheets, very price sensitive | novice | medium |
| `finance-manager` | 15 years in logistics finance, expects accounting conventions | confident | medium |
| `technical-power-user` | Systems lead, uses search before menus, maps the data model | expert | high |

## 5. Tasks

Three, all stated as outcomes. A test fails any goal mentioning a button, a route
or the sidebar — a goal naming a control tests obedience rather than judgment.

| id | What the customer wants | Known issue in scope |
|---|---|---|
| `create-first-invoice` | Create an invoice for a customer | `invoice-requires-shipment`, `weight-validation-uncommunicated` |
| `find-pricing` | Find out how much this product costs | none (pricing is discoverable on the marketing site) |
| `add-customer` | Add a named customer | none (a known non-issue) |

3 personas × 3 tasks × 2 providers = **18 simulations**.

Note that only `create-first-invoice` has a planted issue in scope. `find-pricing`
and `add-customer` are there to test the other half: whether a model invents
problems on paths we know work.

## 6. Results

**None collected.** 0 of 18 simulations completed.

| | OpenAI GPT-4.1 | NVIDIA Nemotron Ultra |
|---|---|---|
| Attempted | 1 (of 9) | 0 |
| Provider failures | 1 | — |
| Completed | **0** | **0** |
| Status | Credits exhausted | Not configured |

## 7. Agent reliability comparison

No data. The metrics the harness will report, once it can:

attempted · provider failures (excluded from rates) · scorable · success ·
failure · stuck · timeout · agent error · success rate · average steps · median
steps · planner calls · invalid actions and rate · recovered on retry · never
usable.

**Provider failures are counted separately from agent outcomes and excluded from
the success-rate denominator.** An unbilled account is not a bad model. A run
counts as a provider failure only when it produced no action at all *and* every
planner error looks like an API problem; once the agent managed even one action,
whatever followed is the agent's story.

A bug worth recording: the pattern set originally matched HTTP `401` and `403`
but not `402`, which is the code a prepaid account actually returns. Every
credit-exhausted run would have been filed as an agent error — the precise
mistake this classification exists to prevent. A test caught it.

## 8. Behavioural comparison

No data. The harness measures, per arm: distinct URL paths, distinct path
sequences, distinct action sequences, first divergence step, paths reached by all
personas, and paths reached by only one.

Plain counting, no invented similarity metric — there is no human baseline to
calibrate one against.

Runs that never acted are excluded from this measurement. Including them would
report identical paths and read as "the persona made no difference" when in fact
nobody got to act.

Persona adherence is reported as the share of steps whose reasoning echoes at
least two distinctive words from that persona's own context, with example quotes
attached. It is keyword matching and approximate: **a zero is strong evidence the
persona did nothing; a high number is weak evidence that it did.** Read the
quotes.

## 9. Evaluator comparison

No data. Precision, recall, F1, detected, missed and false positives against
FreightFlow's four planted issues and ten known non-issues.

Two things to keep straight. Precision counts only *likely* false positives —
findings citing a page we know works. Unrecognised findings are reported
separately and excluded, because a fixture author does not know everything about
their own product and counting every unmatched finding as wrong would punish a
model for out-finding the fixture.

And this is **not** the golden-dataset baseline in
[`evaluator-baseline.md`](./evaluator-baseline.md). That measurement — precision
75%, recall 60% on 14 of 17 hand-authored scenarios — is unchanged and was not
touched by this work. Two independent measurements; do not merge them.

## 10. Cost comparison

No data, and **no prices are assumed.** Rates come from configuration
(`OPENAI_COST_INPUT_PER_M` and friends) and are otherwise reported as "not
configured". An invented cost comparison is worse than none because it looks like
a measurement.

What is recorded whether or not rates are set: input tokens, output tokens,
whether any call failed to report usage, per-call latency, per-simulation wall
clock. A provider that is silent about token counts is flagged as `incomplete`
rather than treated as free.

## 11. Failures

Recorded rather than worked around.

**OpenAI: credits exhausted.** Every planner call returned
`402 This request requires more credits`. The account is on a free tier with
$0.16 of usage against no remaining balance. Classified `PROVIDER_FAILURE`,
excluded from agent metrics.

**NVIDIA: no key configured.** `NVIDIA_API_KEY` is unset, so arm B was reported
as skipped with a reason rather than silently omitted or failed halfway.

Neither is an agent failure and neither is attributable to either model.

**What is still unverified.** That Nemotron Ultra honours strict `json_schema` on
NIM; that the model id resolves for a given account; and Nemotron's real latency,
which matters — it is a 253B model, and earlier NIM measurements in this project
ran between 13s and 150s per step depending on the model. A 30-step simulation at
150s per step is 75 minutes.

## 12. Limitations

- **Zero sample.** Nothing below the setup is a result.
- **18 simulations would still be a small sample.** Nine per arm; a single run
  moves a success rate by 11 percentage points. The harness says so itself and
  calls anything under 12 completed runs a smoke test rather than a result.
- **One target, and a friendly one.** FreightFlow is server-rendered, with no
  iframes, no shadow DOM, no bot protection and no email verification. A real
  SaaS is harder, and a model's relative standing could differ there.
- **Three tasks, only one with a planted issue in scope.** Precision and recall
  will rest on very few opportunities.
- **Ground-truth matching is keyword-and-path based**, therefore approximate.
- **Persona adherence is keyword matching**, and cannot distinguish genuine
  influence from an agent mentioning price because the page did.
- **Latency is measured on shared infrastructure** and will vary with load,
  region and time of day. It is indicative, not a benchmark of the providers'
  serving capacity.
- **Simulated behaviour is not human behaviour.** Nothing here is evidence about
  how a real person would use a real product.

## 13. Recommendation

**None, on this evidence.** There is no evidence.

What can be said without data:

- **Keep OpenAI as the default.** Not because it is better — that is untested —
  but because the existing baseline was measured on it, and changing the default
  would invalidate the one calibration figure we have.
- **The switch is now a config change, not a code change.** The agent runtime
  never depended on OpenAI: `runLoop` takes a `Planner`, which is exactly the
  `generateAction(input)` shape, and a scripted function has stood in for a model
  in the test suite from the start. What this iteration added is provider
  *naming*, usage accounting, and a fair harness.
- **Run `check:endpoint` before benchmarking Nemotron.** If it reports `IGNORED`,
  arm B cannot run at all and no amount of prompting will change that. Better to
  learn it in one request than 40 minutes into a benchmark.

When both arms have credit, `npm run benchmark:models -- --model both` fills in
sections 6 to 10. Until then this document records what was built and what was
not measured.

Do not read a winner into an empty table.

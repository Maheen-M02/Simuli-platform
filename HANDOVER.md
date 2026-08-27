# HANDOVER — read this first

For a Claude Code session picking this project up on another machine.

---

## 1. Status in one line

**V0 is built and green against the local fixture site (126 tests). The one
thing left is the first run driven by a real model against a real website,
which needs an `OPENAI_API_KEY` and a chosen demo target.**

Implementation was authorised on 2026-08-26, along with the two decisions that
were blocking it: use `node:sqlite`, and keep the `expectation` field.

---

## 2. What this project is

An AI customer simulation platform for SaaS companies. A company gives us a URL,
test credentials, a target customer profile and a goal; we run a realistic AI
persona through their product in a real browser and report what that customer
would actually experience.

Vision: *"Your AI customer base before your real customer base."*

This is **not** automated QA. QA asks "does this predefined workflow work?"
We ask "can a realistic customer succeed here, and what do they hit on the way?"

Full product/engineering context is in **`CLAUDE.md`** at the repo root. Read it
before doing anything — it is the source of truth for scope, conventions and
constraints, and it overrides default behaviour.

---

## 3. What is in the repo

```
CLAUDE.md                                  Project instructions. Read first.
HANDOVER.md                                This file.
docs/startup-overview.html                 Source for the founder briefing PDF.
docs/AI-Customer-Simulation-Overview.pdf   21-page founder briefing (generated).
src/  tests/                               The runtime and its 126 tests.
package.json  tsconfig.json  vitest.config.ts  .env.example  .gitignore
```

The source map, and what each part is for:

```
src/
  runSimulation.ts   The library entry point. Everything else serves this.
  cli/               main.ts (arg parsing, exit codes), render.ts (the report).
  config/            env.ts (secrets, validated), runConfig.ts (one run).
  actions/schema.ts  The model-output security boundary. Read this first.
  observations/      extract.browser.ts (in-page DOM walk), serialize.ts,
                     redact.ts (redaction on write), observe.ts, types.ts.
  browser/           session.ts (isolated context, origin allowlist),
                     resolver.ts (fail-never-guess), executor.ts (enforcement).
  agent/             loop.ts, planner.ts, prompt.ts, termination.ts.
  evaluation/        deterministic.ts (facts, no LLM), evaluator.ts, schema.ts.
  sessions/          recorder.ts (incremental writes), types.ts.
  persistence/       db.ts (node:sqlite), artifacts.ts (screenshots).
  llm/client.ts      The only place model calls are made.
  logging/logger.ts  The only place redaction is configured.
tests/
  unit/  integration/  fixtures/site/
```

### Running it

```bash
npm install
npx playwright install chromium
npm test                    # 126 tests, no API key needed, ~70s
npm run agent -- run --url https://example.com --goal "sign up" --steps
```

`npm test` requires no API key and makes no network calls: unit tests inject a
fake planner, integration tests run against `tests/fixtures/site/`.

---

## 4. How we got here

Four requests have been handled so far:

1. **Architecture proposal.** The user asked for a full V0 design — architecture,
   directory structure, agent loop, action schema, Playwright execution,
   observation representation, session recording, evaluation, risks, tradeoffs —
   and explicitly said *do not implement yet*. Delivered, and `CLAUDE.md` was
   created from it.
2. **Founder briefing PDF.** A plain-English explanation of the startup for the
   user's co-founder. Created as HTML, rendered to PDF via headless Chrome.
3. **Market research added to the PDF.** Market sizing, business model canvas,
   competitor analysis, differentiation and revenue estimates were researched
   from the live web and added. PDF grew to 21 pages.
4. **V0 implemented** (2026-08-26), in the ten steps of the original build
   order, across three commits. 126 tests.

---

## 5. Decisions already made (treat as settled unless the user reopens them)

These are all reflected in `CLAUDE.md`. The non-obvious ones, with reasoning:

| Decision | Why |
|---|---|
| LLM is a pure function `(persona, goal, observation, history) → Action`. No browser handle, no code execution. | Safety and auditability at the type level, not by filtering. |
| Targets are opaque snapshot refs (`e14`), never model-authored CSS/XPath. | The model cannot hallucinate a selector. It can only point at what we showed it. |
| **No `navigate` action.** `go_back` is allowed. | Real customers reach pages by clicking. Direct URL entry would let the agent teleport past the exact friction we sell the ability to detect. |
| Every action carries `reasoning` **and `expectation`**. | Expectation-vs-reality is the primary friction signal. An addition beyond the user's original spec, confirmed 2026-08-26. |
| Ref resolution: `data-sim-ref` first, then role+name fallback; **fail if ambiguous, never guess**. | A wrong click is worse than a failed click. |
| Evaluation is two-stage: deterministic pre-pass (facts, no LLM) then LLM judgment. | Technical failures are classified from machine facts, reproducibly — not inferred by a model. |
| Every friction point must carry an attribution: `PRODUCT_FRICTION \| AGENT_LIMITATION \| TECHNICAL_FAILURE`, and cite `stepRefs` that are validated against the record. | Kills hallucinated evidence, and makes our own failure rate measurable. This is the product's trust wedge. |
| Evaluator reads only persisted session records, never live browser state. | Evaluation can be re-run and improved against old sessions independently of agent quality. |
| Runtime is a library (`runSimulation()`); CLI is a thin wrapper. | A future API/dashboard imports the same function. |
| Destructive-action denylist enforced in the **executor**, not the prompt. | Prompt instructions are advisory; executor checks are enforcement. |

### Directory structure (as built)

```
src/
  cli/            main.ts, render.ts
  config/         env.ts, runConfig.ts
  agent/          loop.ts, planner.ts, prompt.ts, termination.ts
  browser/        session.ts, executor.ts, resolver.ts
  observations/   observe.ts, extract.browser.ts, serialize.ts, redact.ts
  actions/        schema.ts
  personas/       schema.ts
  goals/          schema.ts
  evaluation/     deterministic.ts, evaluator.ts, schema.ts
  sessions/       recorder.ts, types.ts
  persistence/    db.ts, artifacts.ts
  llm/            client.ts
  logging/        logger.ts
  types/          shared.ts
tests/
  unit/  integration/  fixtures/site/
data/             gitignored: sessions.db + artifacts/
```

`llm/` and `logging/` were additions beyond the user's original list: the LLM
client is shared by planner *and* evaluator (so it cannot live in `agent/`), and
pino redaction must be configured in exactly one place. Built as designed, plus
`src/runSimulation.ts` at the root (the library entry point the CLI wraps) and
`observations/types.ts` (the in-page walk is stringified into the browser, so
its types have to live somewhere the Node side can import).

### Action schema (as built — see `src/actions/schema.ts`)

Zod discriminated union on `action`. Shared fields on every variant:
`reasoning: string`, `expectation: string`.

```
click     { ref }
type      { ref, value: string | {secret: name}, submit? }
select    { ref, value }
scroll    { direction: up|down, amount?: page|half }
press_key { key: Enter|Tab|Escape|ArrowUp|ArrowDown|Backspace }   // enum, not free string
go_back   { }
wait      { ms ≤ 5000 }
finish    { goalAchieved, evidence }
fail      { reason, blocker }
```

---

## 6. OPEN

Two of the three technical questions are settled:

1. ~~SQLite driver~~ — **`node:sqlite`**, decided 2026-08-26. Verified working
   unflagged on Node v24.16.0. No native module, no Windows build toolchain.
2. **Demo target site — still open.** Most real SaaS requires email confirmation
   at sign-up, which V0 cannot do. This defines what "working" looks like for
   the first real run, and is now the main thing standing between us and it.
3. ~~Confirm `expectation`~~ — **kept**, decided 2026-08-26. It is on every
   action variant, and the evaluator depends on it.

Also needed for the first real run: an `OPENAI_API_KEY` in `.env`.

### Endpoint

`OPENAI_BASE_URL` points the OpenAI SDK at any OpenAI-compatible endpoint.
Currently configured for **OpenRouter**. One requirement is non-negotiable: the
endpoint must honour `response_format` with a strict `json_schema`, because both
the planner and the evaluator depend on it.

Some endpoints accept that parameter and silently ignore it, returning prose
with an HTTP 200 — measured on NVIDIA NIM, where `meta/llama-3.2-*` did exactly
this while `openai/gpt-oss-*` honoured it. An aggregator makes this *more*
likely, not less, because one model id can be routed to providers with
different capabilities; `LLM_REQUIRE_STRUCTURED_OUTPUT=1` sends
`provider.require_parameters` so OpenRouter declines to route us to one that
cannot comply.

Check any new model before spending a run on it:

```bash
npm run check:endpoint -- --model openai/gpt-4.1
```

HONOURED means usable. IGNORED cannot be fixed by prompting — choose another
model.

Plus business questions raised in the PDF (§19 of the briefing), not blocking code:

4. Do we accept that we are not first? (Spur and Uxia already exist — see §8.)
5. First customer type: seed–Series B SaaS founders, or established product teams?
6. Agreement on the single success metric: % of findings a human reviewer agrees
   are genuine product problems. Proposed: continue above ~70%, stop below ~40%.
7. How long V0 gets before a go/no-go. Proposed: a hard checkpoint at 6 weeks.

---

## 7. Build order — done

All ten planned steps are complete (scaffolding, fixture site, action schema,
observations, browser layer, persistence + recorder, termination + loop, model
planner, evaluation, CLI). See the three implementation commits.

Testing rules from `CLAUDE.md` that are easy to violate, and still hold: never
test against an external production website; unit tests never call the OpenAI
API; integration tests assert loop/executor behaviour, never model judgment.

### Things found while building that the design did not anticipate

- **Chrome's own form validation is invisible in text mode.** An
  `<input type="email">` holding a malformed value silently refuses to submit:
  no error node appears in the DOM, so the agent sees a button that does
  nothing. A concrete instance of the accepted "visual defects are invisible"
  limitation, and it will look like a product bug in reports.
- **A blocked navigation must not be aborted.** `route.abort()` leaves Chrome
  on `chrome-error://chromewebdata/`, which destroys the agent's sense of place
  and reads as a product crash. `session.ts` serves a plain stand-in page
  instead, and the executor reports NAVIGATION_BLOCKED via a drain callback —
  a refused navigation raises nothing and moves nothing, so without that the
  agent would click the same dead link forever.
- **`<button>` inside `<a>` is reported as one link, not two targets.** The DOM
  walk does not descend into an anchor. Correct, but it means a visually
  obvious button can reach the agent as a link.
- **Enter is pressed on the field, not on ambient focus.** `locator.press`
  rather than `keyboard.press`, so a stray Enter cannot land somewhere
  untraceable.

## 8. Research findings (do not redo this — it cost a full research pass)

Gathered from live web search in August 2026. Full citations are in §20 of the
PDF briefing.

**Market sizing**
- Usability testing software: **$1.84B (2026) → $9.44B by 2034**, ~19.9% CAGR.
- User research & testing software: $2.03B (2026) → $4.28B by 2035.
- UX research software (narrow): $520M (2026) → $1.25B by 2034.
- AI-powered software testing & QA: **$11.99B (2026) → $39.4B by 2031**, ~26.9% CAGR.
- ~33,200 SaaS companies worldwide; ~17,000 in the US.

**Competitors — the critical finding: we are NOT first**
- **Spur** — closest competitor. AI agents in real browsers, $4.5M seed (First
  Round, Pear VC, Neo, Conviction), 30+ customers, e-commerce logos. Already
  ships a "UI/UX testing" agent. Positioned and sold as **QA**, mostly to retail.
  Quote-only pricing.
- **Uxia** — synthetic testers, friction reports, SUS/SUPR-Q benchmarks. Claims
  17x faster, 5x cheaper. Prototype-first heritage; opaque "book a demo" pricing.
- **Maze** — already ships an AI "Synthetic Users" feature. $99/mo Starter tier.
  Their synthetic users answer questions; they do not operate the live product.
- **UserTesting** — incumbent. ~$36k/yr average for SMBs, ~$148k/yr enterprise.
- Synthetic-user research category (Synthetic Users, Minds, Evidenza, Simile,
  Lakmoos, Aaru): **they never touch the product** — an LLM's opinion of a
  description. That is the clearest gap we exploit.
- AI QA category (Momentic ~$18.7M raised, Bug0 $2,500/mo flat and ~$90k median
  ACV, Ranger, QA.tech, QA Wolf, TestSprite): measure correctness, not
  comprehension. Sold to engineering, not product.
- Over **$1.5B of VC** has gone into AI testing platforms; 40+ startups competing.

**Positioning conclusion:** the gap is positioning, not technology. QA players own
"does it work"; research players own "what do people think"; nobody has
convincingly claimed *"can this specific kind of person get through your
product."* Winnable on trust and evidence quality, not novelty.

**Unit economics (our estimate)**
- Cost per simulation today ~**$0.40** (LLM $0.20–0.60, browser $0.02–0.10),
  optimised target ~$0.15.
- Proposed pricing: Free (3/mo) · Starter $99/mo (50) · Growth $499/mo (300) ·
  Scale $1,999/mo (1,500) · Enterprise $25k–60k/yr.
- Base-case revenue: $140k ARR Y1 → $865k Y2 → $3.2M Y3. Weakest assumptions are
  churn (4%/mo falling to 2.5%) and the $260 starting ARPA.

---

## 9. Environment notes

Developed on **Windows 11**, Node **v24.17.0**, npm **11.13.0**, git 2.54.
PowerShell 5.1 is the primary shell; a Bash tool is also available. Note the
PowerShell 5.1 limitations: no `&&`/`||` chaining, no ternary, and
`[System.Text.Encoding]::Latin1` does not exist (use `GetEncoding(28591)`).

Nothing is Windows-specific in the design. If you pick up on macOS or Linux,
only the PDF-render command below changes.

### Regenerating the PDF

Edit `docs/startup-overview.html`, then:

```powershell
# Windows
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --disable-gpu `
  --no-pdf-header-footer `
  --print-to-pdf="docs\AI-Customer-Simulation-Overview.pdf" `
  "file:///C:/Users/mahee/simulation_agents/docs/startup-overview.html"
```

```bash
# macOS / Linux — substitute the local Chrome path
chrome --headless=new --disable-gpu --no-pdf-header-footer \
  --print-to-pdf=docs/AI-Customer-Simulation-Overview.pdf \
  "file://$PWD/docs/startup-overview.html"
```

Two gotchas found the hard way: Chrome returns before the file is fully flushed
(sleep ~2s before inspecting it), and it may serve a cached `file://` render —
delete the old PDF first to guarantee a fresh one. Verify by checking the page
count changed, not just that the command exited 0.

---

## 10. Rules for the next session

1. **Read `CLAUDE.md` first.** It overrides default behaviour.
2. **Run `npm test` before changing anything.** It is the contract. If it is
   green the runtime works; if a change turns it red, the change is wrong until
   proven otherwise.
3. The next milestone is the first real model-driven run. That needs an API key
   and a demo target site (§6.2) — not more code.
4. Keep V0 small. The temptation will be to add a dashboard, parallel runs, or a
   persona generator. All are explicitly out of scope in `CLAUDE.md` §10.
5. The PDF is a founder-facing document written in plain English for a
   non-technical reader. If you edit it, keep that register — and keep the honest
   framing about competitors and risks. That honesty was deliberate, not an
   oversight.

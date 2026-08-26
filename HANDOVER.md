# HANDOVER — read this first

For a Claude Code session picking this project up on another machine.

---

## 1. Status in one line

**Architecture is designed and approved-in-principle. No application code has been
written yet, and implementation has NOT been authorised.** Do not start building
until the user explicitly says to proceed (see §6).

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
.gitignore
```

There is no `package.json`, no `src/`, no dependencies installed. That is expected.

---

## 4. How we got here

Three requests have been handled so far:

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

---

## 5. Decisions already made (treat as settled unless the user reopens them)

These are all reflected in `CLAUDE.md`. The non-obvious ones, with reasoning:

| Decision | Why |
|---|---|
| LLM is a pure function `(persona, goal, observation, history) → Action`. No browser handle, no code execution. | Safety and auditability at the type level, not by filtering. |
| Targets are opaque snapshot refs (`e14`), never model-authored CSS/XPath. | The model cannot hallucinate a selector. It can only point at what we showed it. |
| **No `navigate` action.** `go_back` is allowed. | Real customers reach pages by clicking. Direct URL entry would let the agent teleport past the exact friction we sell the ability to detect. |
| Every action carries `reasoning` **and `expectation`**. | Expectation-vs-reality is the primary friction signal. `expectation` was an addition beyond the user's original spec — the user has not yet confirmed it (see §6). |
| Ref resolution: `data-sim-ref` first, then role+name fallback; **fail if ambiguous, never guess**. | A wrong click is worse than a failed click. |
| Evaluation is two-stage: deterministic pre-pass (facts, no LLM) then LLM judgment. | Technical failures are classified from machine facts, reproducibly — not inferred by a model. |
| Every friction point must carry an attribution: `PRODUCT_FRICTION \| AGENT_LIMITATION \| TECHNICAL_FAILURE`, and cite `stepRefs` that are validated against the record. | Kills hallucinated evidence, and makes our own failure rate measurable. This is the product's trust wedge. |
| Evaluator reads only persisted session records, never live browser state. | Evaluation can be re-run and improved against old sessions independently of agent quality. |
| Runtime is a library (`runSimulation()`); CLI is a thin wrapper. | A future API/dashboard imports the same function. |
| Destructive-action denylist enforced in the **executor**, not the prompt. | Prompt instructions are advisory; executor checks are enforcement. |

### Proposed directory structure (agreed, not yet created)

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
pino redaction must be configured in exactly one place.

### Proposed action schema (agreed, not yet written)

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

## 6. OPEN — blocking implementation

**The user has not yet said "proceed".** Do not write application code until they do.

Three technical questions were put to the user and are still unanswered:

1. **SQLite driver.** `better-sqlite3` (recommended — mature, prebuilt binaries,
   but a native module) vs. Node 24's built-in `node:sqlite` (zero-dependency, no
   Windows build toolchain, still marked experimental). The user is on Windows,
   which is why this matters.
2. **Demo target site.** Most real SaaS requires email confirmation at sign-up,
   which V0 cannot do. The demo site must be chosen with that constraint in mind,
   because it defines what "working" looks like for V0.
3. **Confirm the `expectation` field** on every action — the one addition beyond
   the user's original action schema.

Plus business questions raised in the PDF (§19 of the briefing), not blocking code:

4. Do we accept that we are not first? (Spur and Uxia already exist — see §8.)
5. First customer type: seed–Series B SaaS founders, or established product teams?
6. Agreement on the single success metric: % of findings a human reviewer agrees
   are genuine product problems. Proposed: continue above ~70%, stop below ~40%.
7. How long V0 gets before a go/no-go. Proposed: a hard checkpoint at 6 weeks.

---

## 7. Build order, once approved

Suggested sequence — each step is independently testable:

1. `package.json`, `tsconfig.json` (strict), `vitest.config.ts`, `.env.example`,
   `.gitignore`. Install Playwright, Zod, OpenAI, Pino, Vitest, SQLite driver.
2. `tests/fixtures/site/` — the deterministic local test app (signup →
   onboarding → invoice) over `node:http`. Build this **before** the agent, so
   everything after it can be tested without touching a real website.
3. `actions/schema.ts` + its unit tests (valid, invalid, adversarial model output).
4. `observations/` — the in-page DOM walk and the serialiser. Hardest part; expect
   iteration.
5. `browser/` — session, resolver, executor. Integration tests against the fixture site.
6. `sessions/` + `persistence/` — recorder and SQLite schema. Test incremental
   writes and crash-mid-run integrity.
7. `agent/` — termination predicates first (pure, easy to test), then the loop
   with an **injected fake planner** returning scripted actions. No OpenAI calls
   in unit tests.
8. `llm/` + `agent/planner.ts` — real model calls, structured output, retry.
9. `evaluation/` — deterministic pre-pass, then the LLM evaluator.
10. `cli/` — thin wrapper. Then the first real end-to-end run.

Testing rules from `CLAUDE.md` that are easy to violate: never test against an
external production website; unit tests never call the OpenAI API; integration
tests assert loop/executor behaviour, never model judgment.

---

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
2. **Do not write application code until the user explicitly authorises it.**
   The last thing said to them was a request for approval; they have not given it.
3. If the user does say proceed, ask the §6 questions 1–3 first if still
   unanswered — question 1 changes `package.json`, question 2 changes what the
   first end-to-end run targets.
4. Keep V0 small. The temptation will be to add a dashboard, parallel runs, or a
   persona generator. All are explicitly out of scope in `CLAUDE.md` §10.
5. The PDF is a founder-facing document written in plain English for a
   non-technical reader. If you edit it, keep that register — and keep the honest
   framing about competitors and risks. That honesty was deliberate, not an
   oversight.

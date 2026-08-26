# CLAUDE.md — AI Customer Simulation Platform

## 1. Product Context
AI customer simulation for SaaS companies. A company gives us a URL, test
credentials, a target customer profile and a goal; we run a realistic AI
persona through their product in a real browser and report what that
customer would actually experience.

Vision: "Your AI customer base before your real customer base."

This is NOT automated QA. QA asks "does this predefined workflow work?"
We ask "can a realistic customer succeed here, and what do they hit on the
way?" If a change makes the agent behave more like a script and less like a
person, it is the wrong change.

## 2. Current V0 Objective
One deliverable only:
"An AI agent can autonomously use a real website through a browser to
accomplish a user-defined goal while recording its actions, observations,
and outcome."

Driven from a CLI:
  agent run --url <url> --goal <goal> --persona <persona>

Anything beyond this is out of scope until the milestone is met.

## 3. Architecture
CLI -> agent loop -> { observations | planner (LLM) | executor } -> recorder
-> evaluator (offline, over the recorded session).

Dependencies point one way. Observation is read-only; execution is
write-only; they never call each other — the loop mediates.
The runtime is a library (`runSimulation()`); the CLI is a thin wrapper.
The evaluator reads only persisted session records, never live browser state.

Loop: settle -> observe -> record -> check termination -> decide (LLM) ->
validate -> act -> record -> check termination -> repeat.

## 4. Tech Stack
Node.js + TypeScript (strict), Playwright, OpenAI API, Zod, Vitest, Pino,
SQLite. npm. Single repository.

Explicitly forbidden without discussion: Python, .NET, Redis, PostgreSQL,
Kafka, Kubernetes, microservices, cloud infra, auth, billing, any frontend,
Next.js, and general-purpose frameworks.

## 5. Agent Design Principles
- The LLM is a pure function: (persona, goal, observation, history) -> Action.
  It has no browser handle and no code execution.
- The LLM never generates executable code, selectors, or URLs.
- Every model output is validated with Zod before it can affect anything.
- Actions come from a fixed discriminated union. Widening it is a deliberate
  decision, not a convenience.
- Every action carries `reasoning` and `expectation`. Expectation-vs-reality
  is our primary friction signal — do not drop it for token savings.
- Every session has enforced termination: finish, fail, max steps, wall-clock,
  no-change loop, repeated-action loop, consecutive errors. No run may hang.
- The agent decides like the persona would, not like an optimal user.

## 6. Browser Interaction Principles
- Each run gets a fresh, isolated Playwright browser context. No shared
  profile, cookies, or storage between runs.
- Targets are opaque snapshot refs, never model-authored selectors.
- Ref resolution: `data-sim-ref` first, then role+name fallback. If ambiguous
  or missing, FAIL the action — never guess. A wrong click is worse than a
  failed click.
- Actions carrying a stale snapshot generation are rejected.
- No `navigate` action: customers reach pages by clicking. `go_back` is fine.
- Navigation is restricted to an origin allowlist via request routing.
- Executor-level destructive-action denylist (pay/purchase/delete/send/...);
  prompt instructions are advisory, executor checks are enforcement.
- Every Playwright op returns a structured ActionResult with a closed
  ErrorKind enum. No raw exceptions escape the executor.

## 7. Testing Requirements
Vitest. Required coverage:
- Action schema validation (valid, invalid, adversarial model output)
- Action execution against the local fixture site
- Agent termination conditions (all of them, individually)
- Session recording (incremental writes, crash-mid-run integrity)
- Goal state handling
- Evaluator output validation (incl. rejection of bad step references)

Never test against an external production website. `tests/fixtures/site/` is a
tiny deterministic app (signup -> onboarding -> invoice) served over node:http.
Unit tests never call the OpenAI API — inject a fake planner returning
scripted actions. Integration tests assert loop/executor behavior, never
model judgment.

## 8. Security Principles
- Secrets come from environment variables. Never commit a real `.env`.
- Credentials are referenced by name in actions (`{secret: "password"}`) and
  resolved at execution time. Secret values never enter prompts, model output,
  logs, or session records.
- Redaction happens on write, not as a post-hoc cleanup step.
- Pino redaction is configured in exactly one place: `src/logging/logger.ts`.
- V0 targets staging/demo environments. The agent must not make purchases,
  transfer money, send real emails, delete data, or take irreversible actions.
- Screenshots may contain sensitive data: they stay in gitignored `data/`.

## 9. Coding Conventions
- TypeScript strict. No `any`. No non-null `!` assertions on model-derived data.
- Zod schemas are the source of truth; derive TS types with `z.infer`.
- Prefer plain functions and plain data over classes and interfaces.
- Do not add an abstraction until there is a second real caller.
- Small modules with one responsibility; no barrel re-export files.
- Errors are values at module boundaries (Result-shaped), exceptions inside.
- Structured logging only — pino with fields, never string-interpolated state.
- Comments explain why, not what.

## 10. Explicitly Out of Scope
No web dashboard/frontend, no HTTP API, no auth, no multi-tenancy, no
billing, no job queue, no parallel/distributed session execution, no
persona-generation system, no session replay UI, no cloud deployment, no
CAPTCHA solving, no email-inbox integration, no multi-tab or file-upload
actions, no self-healing selector ML, no non-OpenAI providers.

Known V0 limitations, accepted deliberately: flows requiring email
verification are not supported; bot-protected pages will be blocked; purely
visual defects are invisible in text-only mode.

## 11. Current Development Milestone
V0 — single CLI simulation run, end to end, against a real website, with a
full session record and a structured evaluation.

Done when:
1. `agent run --url --goal --persona` drives a real browser autonomously.
2. Every action is validated, executed, and recorded.
3. Every run terminates with an explicit outcome:
   SUCCESS | FAILURE | STUCK | TIMEOUT | ERROR.
4. Each run produces a session record (SQLite + artifacts) and a structured,
   schema-validated evaluation.
5. The required test suite passes against the local fixture site.

Not started: implementation. The architecture above is approved; code is not
yet written.

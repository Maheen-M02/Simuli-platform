# Real-world validation

Development-only. This runs the existing agent against a real application to
answer one question:

> Does the agent behave like a plausible customer somewhere other than our own
> fixture?

It is not a product feature, it is not a test suite, and it does not gate
anything. Nothing here bypasses the agent: it builds a `RunConfig` and calls the
same `runSimulation()` the CLI does, so the validated action schema, the
executor's refusals, the recorder and the evaluator all apply unchanged.

---

## Only run this against something you are allowed to run against

The run file requires you to state the environment and who authorised it, and
the runner refuses to start without both. Use a staging, demo, sandbox or
own-application target. Do not point this at a public site you do not control:
you would be generating load on somebody else's system, possibly against their
terms of service, and any finding you got would be unusable anyway.

---

## How to run one

```bash
npm install
npx playwright install chromium
npm run check:endpoint -- --model openai/gpt-4.1   # confirm the model first

cp runs/example.json runs/my-target.json           # then edit it
npm run validate:real -- --config runs/my-target.json
```

Useful flags:

| Flag | Effect |
|---|---|
| `--headed` | Watch the browser. Do this for your first run against any new target. |
| `--json` | Machine-readable output instead of the report. |

Exit codes: `0` the customer succeeded, `1` they did not, `2` the run itself
broke.

### The run file

```jsonc
{
  "url": "https://app.acme-staging.test/",
  "permission": {
    "environment": "staging",          // staging | demo | sandbox | own-application
    "authorisedBy": "Dana, VP Eng at Acme (email 2026-08-27)"
  },
  "goal": {
    "description": "Sign up and send my first invoice",
    "successCriteria": "An invoice exists with my client's name on it"
  },
  "customerContext": {
    "persona": {
      "name": "Priya, ops lead at a logistics firm",
      "background": "Runs operations for a 40-person freight company.",
      "techLevel": "average",          // novice | average | confident | expert
      "patience": "low",
      "priorities": ["getting paid faster"],
      "wontDo": ["enter real payment details"]
    },
    "background": "Her team is outgrowing spreadsheets; she has budget this quarter.",
    "motivation": "Needs to choose a tool before the quarter closes.",
    "expectations": ["a trial without a card", "CSV import"],
    "constraints": ["no admin rights on her laptop"]
  },
  "credentialNames": ["EMAIL", "PASSWORD"],
  "allowedOrigins": [],
  "allowSubdomains": true,
  "maxSteps": 60,
  "timeoutSeconds": 900,
  "screenshots": true
}
```

Note `credentialNames` lists **names, never values**.

---

## Required environment variables

In `.env` (gitignored — never commit it):

| Variable | Required | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | yes | Model key. On OpenRouter, `sk-or-v1-…`. |
| `OPENAI_BASE_URL` | no | OpenAI-compatible endpoint. Currently OpenRouter. |
| `LLM_REQUIRE_STRUCTURED_OUTPUT` | on OpenRouter | Routes only to providers that honour a strict `json_schema`. |
| `OPENAI_PLANNER_MODEL` | no | Drives the browser. |
| `OPENAI_EVALUATOR_MODEL` | no | Judges the run. Do not economise here. |
| `SIM_SECRET_<NAME>` | per credential | One per entry in `credentialNames`. |
| `LOG_LEVEL` | no | `trace`…`error`. |

The endpoint **must** honour strict `json_schema`. Some accept the parameter and
silently return prose with an HTTP 200, which cannot be fixed by prompting.
`npm run check:endpoint` tells you in one request.

---

## Authentication: what is supported

**Supported: the agent logs in the way a customer does.** It is given credential
*names* and clicks its way through the login form, typing
`{"secret": "PASSWORD"}` — which the executor substitutes at the last moment.

How credentials are kept safe, and why each part matters:

- **Values live only in the environment.** The run file names them.
- **Never in argv.** This is why the runner takes a config file rather than
  flags: process arguments are visible to every process on the machine, so a
  `--password` flag is effectively public.
- **Only the named credentials are exposed.** The runner builds a map containing
  just the entries in `credentialNames`; everything else in the environment is
  out of the run's reach.
- **Never in model input or output.** The action carries `{secret: NAME}`.
  Substitution happens inside the executor's call frame.
- **Redaction on write, not cleanup after.** Anything the product echoes back
  into its own HTML is scrubbed before it reaches a log, a record or a prompt.
- **Password fields are never read back.** The DOM walk refuses to read the
  value of `input[type=password]` at all.
- **Missing credentials fail immediately.** A name in the file with no matching
  env var stops the run before the browser opens, rather than surfacing as a
  `SECRET_NOT_FOUND` several minutes and several model calls later.

**Not supported.** Anything needing a code from an email or an SMS. Any OAuth or
SSO flow that leaves the site's own domain (add the provider to
`allowedOrigins` if you must, but expect its bot protection to stop you). Any
CAPTCHA. Credentials in an iframe — see limitations.

Use a pre-provisioned test account wherever you can. It removes the
email-verification problem entirely and is the single biggest thing that makes a
target usable.

---

## Known limitations

Ordered by how likely each is to spoil a run.

**Bot protection stops us.** Cloudflare, hCaptcha, reCAPTCHA and friends will
block or challenge a Playwright browser. There is no workaround here and we are
not going to add one. Symptom: the agent sees a challenge page and reports being
blocked. Prefer a staging environment with protection disabled.

**Iframes are invisible.** The DOM walk runs `walk(document.body)` on the main
frame only. Anything inside an `<iframe>` — Stripe payment fields, some embedded
auth, some chat widgets — does not exist as far as the agent is concerned. It
will report a form it cannot fill. This is our limitation and will read as a
product defect unless you check.

**Shadow DOM is invisible.** Same walk, same problem: components using closed or
open shadow roots are not traversed.

**Large pages are truncated.** The snapshot budget is 400 nodes. Beyond that the
agent is shown part of the page. This is emitted as an `OBSERVATION_TRUNCATED`
fact and counted as *our* fault, so a product claim resting only on it is
reclassified — but a feature the agent could not find on a truncated page is
still a finding you should distrust.

**Purely visual problems are invisible.** Text-only observation. An overlapping
layout, an invisible-on-white button, a broken image: none of it registers.
Native browser validation is in this category too — an `<input type="email">`
with a malformed value refuses to submit with no DOM change at all, so the agent
sees a button that does nothing.

**Cookie and consent banners consume steps.** The agent can see and dismiss
them, as a real customer must, but it costs steps and sometimes confuses the
first observation.

**Client-rendered apps may be observed mid-render.** `settle()` waits for
something interactive or ~40 characters of text before snapshotting, capped at
4s. A slower app can still be caught early.

**Multi-tab flows are unsupported.** There is no tab action. A flow that opens a
new window dead-ends.

**No file upload.** Not in the action union.

**Destructive actions are refused, and this will sometimes block a real path.**
The denylist matches on accessible name (pay, purchase, delete, send, transfer,
subscribe…). On a real product this can refuse a step the goal genuinely needs.
That is the intended trade: it is recorded as `DESTRUCTIVE_ACTION_BLOCKED` and
classified as ours, not the product's. Check the transcript for it before
concluding the customer could not finish.

**Real runs are slow and cost money.** Roughly 10–30s per step depending on the
model. A 60-step run is 10–30 minutes and dozens of model calls.

---

## What to review manually

The report is not evidence. The transcript is. For every run, before believing
anything:

1. **`runIsTechnicallySound`.** If false, our tooling failed and the findings
   are suspect. The report prints a warning; do not skip past it.
2. **The reclassification list.** Every finding the policy pass overrode, and
   why. A long list means the evaluator is reaching.
3. **Screenshots for each cited step**, in `data/artifacts/<session-id>/`. This
   is the only way to catch a purely visual problem, and the only way to see a
   cookie banner or overlay that was in the way.
4. **Every `PRODUCT_ISSUE` finding, against its cited steps.** Read the
   observation text for those steps. Ask: did the page really do this, or did
   the agent misread it? This is the check that produces our quality metric.
5. **Any `OBSERVATION_TRUNCATED` fact.** Then ask whether the thing the customer
   failed to find was in the part we hid.
6. **Any `DESTRUCTIVE_ACTION_BLOCKED` fact.** Did our refusal end the run?
7. **The steps where the agent's `expectation` did not match what happened.**
   That gap is the friction signal; it is also where the agent's own
   misunderstandings show up most clearly.

Re-judge a recorded run without touching the browser:

```bash
npm run eval:session -- <session-id> [model] [max-output-tokens]
```

The third argument caps the reply, which matters on a prepaid balance: a run is
recorded whether or not the evaluation succeeds, so a 402 on the report costs
you the report and not the run.

---

## Interpreting the customer verdict

**The satisfaction score, would-use-again and would-pay outputs are an
experimental signal. They are not a prediction of real human behaviour.**

What they actually are: a language model's guess at how a *described* person
would feel, inferred from a text transcript of a browser session. Nothing here
has been validated against a real human. There is currently no evidence that
these numbers correlate with what an actual customer would do.

Two legitimate uses, neither of which needs the number to be accurate in
absolute terms:

- **As a direction.** If the score moves when the product changes, that is
  informative. The delta is worth more than the value.
- **As a contradiction detector.** A 5/5 verdict alongside three high-severity
  product issues means one of the two is wrong. Go and find out which.

**Do not** tell a customer their real users would rate them N out of 5, or that
some proportion would pay. That is inventing evidence, which is the one thing
this system exists not to do. `wouldPay` is `NOT_APPLICABLE` for most runs and
that is the honest answer — a customer who never saw pricing has no basis for
the question.

The caveat is printed next to the number in every report, deliberately, so a
score cannot travel without it.

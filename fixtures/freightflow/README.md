# FreightFlow

A small freight operations SaaS, built as an **evaluation target** for our agent.

It exists for one purpose: to give the agent a believable B2B product to get lost
in, so that "the agent completed the task" means something. It is not a demo of
anything, it is not our product, and nobody should ship it.

---

## Running it

```bash
npm run fixture:freightflow              # http://127.0.0.1:4321
PORT=5000 npm run fixture:freightflow
```

Sign up with any email and a password of ten or more characters including a
number. A new account is seeded with three customers, two shipments and one
invoice, so the product is never an empty shell.

**Look at it yourself before trusting a run against it.** If it does not feel
like a product to you, the run is not measuring what we think it is.

## Running the agent against it

```bash
# one persona, one task
npm run simulate -- --target freightflow --persona skeptical-buyer --goal find-pricing

# watch it
npm run simulate -- --target freightflow --persona operations-manager --goal create-first-shipment --headed

# every persona on one task, with comparison and ground-truth scoring
npm run compare -- --target freightflow --goal create-first-invoice
npm run compare -- --target freightflow --goal find-billing --personas skeptical-buyer,first-time-owner
```

Each run gets its own fresh instance of the app. Sharing one would let an
earlier persona's shipments change what a later one sees, and then a difference
between personas would not be attributable to the persona.

---

## Personas

Six, chosen to be materially different rather than six shades of the same
careful user. A test asserts they vary in technical level and patience, because
personas that share every trait are not different whatever their backstories say.

| id | who |
|---|---|
| `first-time-owner` | 40-staff haulier on spreadsheets, novice, very price sensitive |
| `finance-manager` | 15 years in logistics finance, expects accounting conventions |
| `operations-manager` | On shift, low patience, wants to book a load and leave |
| `technical-power-user` | Expert, uses search before menus, maps the data model |
| `skeptical-buyer` | Burned by an auto-renewal, reads billing before touching the product |
| `office-administrator` | Told to "get it set up", follows the interface literally |

## Tasks

Nine, every one stated as an outcome. A test fails any goal that mentions a
button, a route or the sidebar — a goal naming a control tests obedience, not
judgment, and that is QA.

| id | what the customer wants |
|---|---|
| `find-pricing` | Find out how much this product costs |
| `supports-40-people` | Whether it suits ~40 people, and what that costs |
| `complete-onboarding` | Sign up and get as far as being able to use it |
| `add-customer` | Add a named customer |
| `create-first-shipment` | Book a 1,200 kg load, Dover to Glasgow |
| `create-first-invoice` | Create an invoice for a customer |
| `invoice-a-customer` | Invoice the load that has not been invoiced |
| `find-billing` | What am I charged, and what happens after the trial |
| `understand-cost-before-committing` | Cost and exit terms, from inside the product |

---

## Ground truth

`ground-truth.ts` records what we know: four deliberate product problems, ten
things that work, and one controlled failure.

**It cannot reach the agent, and that is enforced rather than assumed.** The
agent's whole view is the HTTP responses `server.ts` writes, so:

- `server.ts` never imports `ground-truth.ts`, and a test parses the import
  statements of every file that renders a page to prove it.
- Another test crawls all sixteen routes looking for issue ids and markers.
- A third looks for words like "intentional" or "known issue" in the markup —
  the sort of comment a debugging session leaves behind, which would be as good
  as telling the agent.

If any of those fail the experiment is compromised and its numbers are
worthless: an agent that can read the answer key is not being measured.

The harness imports it freely. The harness is not the agent.

### The four deliberate problems

Each is something real products actually do, not a contrived trap. An agent that
only finds implausible problems has not shown it can find real ones.

1. **`billing-hard-to-discover`** — billing sits two levels down behind a nav
   item called "Account"; the word "Billing" appears nowhere in the navigation
   and the dashboard offers only shipment and customer actions.
2. **`invoice-requires-shipment`** — the Invoices page has no create action and
   no explanation. Every other list in the product has a create button. The only
   route is to open a shipment and use "Generate invoice".
3. **`weight-validation-uncommunicated`** — the weight field states no unit and
   no range, and rejects bad input with "Invalid value." Contrast the signup
   form, which states its password rule up front.
4. **`pricing-not-linked-in-app`** — once signed in there is no pricing link
   except inside the billing page, which is itself two levels down.

### Why the non-issue list matters more

Recall is trivially gamed by reporting everything. The ten known non-issues —
signup, sign-in, onboarding, team size, customer creation, shipment booking,
navigation, search, sign-out, and pricing on the marketing site — are what stop
that. A product finding citing any of those pages is a likely false positive and
the report says so.

### On the controlled failure

`/app/reports` always returns HTTP 500. Note the taxonomy: this is a
**`PRODUCT_ISSUE`**, because the *product* broke. Our `ENVIRONMENT_ERROR` class
means *our* simulation broke, and a fixture cannot cause that by serving a page.
Filing it under "environment failure" would quietly corrupt the metric, so it is
recorded with its true expected classification instead.

---

## Behavioural diversity

Plain counting, and nothing more:

- distinct URL paths any persona reached
- distinct path sequences, and distinct action sequences
- the step at which the runs stopped agreeing
- for each path, how many personas found it

**We do not attempt to define behavioural similarity mathematically.** There is
no human baseline to calibrate such a metric against, and a plausible-looking
distance number would only launder that absence into something quotable.

What these numbers *can* answer is narrower and still worth having: did the
persona change anything? If six materially different customers walk an identical
path, the persona input is decoration and the report says so in as many words.

---

## Limitations

- **The fixture is server-rendered.** Deliberate: a client-rendered app would
  test our observation layer's SPA handling rather than the agent's judgment,
  and those are different experiments. It also means a real SPA may behave worse
  than this suggests.
- **No iframes, no shadow DOM, no bot protection, no email verification.** All
  are things a real target has and this one does not, so a run here is easier
  than a run against a real product.
- **Ground-truth matching is keyword-and-path based**, therefore approximate.
  Read the findings before quoting a recall figure.
- **The known-issue list is written by the same people building the agent.**
  That is a real bias. It is mitigated only by the list being fixed before any
  agent sees it and not adjusted afterwards — adding an issue because the agent
  found it, or dropping one it kept missing, would make recall a measure of our
  willingness to move the target.
- **Simulated behaviour is not human behaviour.** Nothing produced here is
  evidence about how a real person would use a real product. It is evidence
  about how these described customers behaved on this run.

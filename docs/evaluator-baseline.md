# Evaluator calibration baseline

Measured with `npm run eval:golden`. Update this file when the numbers move, and
keep the old rows — the trend matters more than any single figure.

Reproduce:

```bash
npm run check:endpoint -- --model <id>   # confirm strict json_schema first
npm run eval:golden -- --model <id>
```

---

## 2026-08-27 · openai/gpt-4.1 via OpenRouter · first measured baseline

17 golden scenarios, 14 scored, 3 unscored (OpenRouter 402 — out of credit, not
an evaluator failure; excluded rather than counted as misses).

| | |
|---|---|
| true positives | 3 |
| false positives | 1 |
| true negatives | 8 |
| false negatives | 2 |
| **precision** | **75%** |
| **recall** | **60%** |
| false-positive rate | 11% |
| false-negative rate | 40% |
| f1 | 67% |

**No policy reclassifications fired on any scenario.** This disproves the
hypothesis carried from the earlier NVIDIA run, that `applyEvidencePolicy` was
over-suppressing genuine findings. With a model that cites fact ids properly,
the policy is inert on correct output and the remaining errors are model
judgment. The earlier collapse was a weak model failing to populate
`evidenceRefs`, not the policy being wrong.

### The three errors, and what each one means

**1. `persistent-validation-message` — FALSE POSITIVE. The one that matters.**

Reported: *"Validation message for email did not clear after entering a valid
email address, persisting until the password was also entered."*

This is the exact mechanism the whole iteration was built to stop, and it is
**not fixed**. The evidence ledger emits `MESSAGE_PERSISTED_UNCHANGED`, the
prompt names the rule explicitly, and the model still called it a product issue.

Note the model's description is mechanically accurate — it just draws the wrong
conclusion. The page is server-rendered and only re-renders on submit, so the
message staying put is correct HTML behaviour and the agent never re-submitted.

Worth holding open: a stale error that survives fixing the input *is* mildly bad
UX in a real product. The scenario may be genuinely borderline rather than
clear-cut, which would make this partly a dataset question. Resolve that before
tuning against it.

**2. `hidden-nav-label` — FALSE NEGATIVE, and arguably a labelling dispute.**

Reported `AGENT_MISUNDERSTANDING`: *"The customer did not immediately find the
'Billing' section and explored 'Settings' and 'Reports' first."*

Our label says poor discoverability is the product's fault. The model says the
customer was inefficient. Both readings are defensible from the same facts. This
is the case where a human reviewer would most plausibly disagree with us, so it
is a poor scenario to tune against until the intended answer is firmer.

**3. `hidden-password-rule` — FALSE NEGATIVE, and a real miss.**

Produced nothing at all. A password rule withheld until an attempt fails is
genuine friction, and the validation message is right there in the facts. No
ambiguity, no dispute: the evaluator should have caught this and did not.

### Honest read

Precision 75% is below the ~70% threshold only if you count generously, and
recall 60% is poor. Of the three errors, **one is a clear miss, one is a
labelling dispute, and one is the false-positive mechanism we set out to
eliminate still firing.** The machinery is in place and measurable; the
calibration is not done.

Do not quote these as a met target.

### Known limitations of this measurement

- **n=14.** Far too small for the differences between runs to be meaningful.
  Treat a change of one scenario as noise.
- **Scenario-level binary metric.** "Did it report any product issue" ignores
  whether the *right* product issue was found, and ignores severity entirely.
- **Golden labels are ours.** They encode our judgment, not a customer's. The
  metric that ultimately matters is the share of findings a human reviewer
  agrees with, and this dataset is a proxy for it.
- **Hand-authored records.** Scenarios are cleaner and shorter than real runs;
  a 25-step real recording is a harder input than anything here.
- **One model, one temperature, one attempt per scenario.** No variance
  measured. The same scenario may not classify the same way twice.

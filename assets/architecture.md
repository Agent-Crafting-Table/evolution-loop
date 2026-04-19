# Evolution Loop — Architecture

```
 ┌──────────────────────────────────────────────────────────────────────────┐
 │                     CRON-LEVEL EVOLUTION LOOP                              │
 │                                                                          │
 │   crons/logs/*.log (from cron-framework)                                │
 │             │                                                           │
 │             ▼                                                           │
 │   ┌────────────────────┐                                               │
 │   │  trace-extract.js  │ ── data/execution-traces.json                 │
 │   │  classify failures │    (per-job rolling window of 30 traces)      │
 │   └────────┬───────────┘                                               │
 │            │                                                           │
 │            ▼  (runs for jobs with 2+ unresolved same-mode failures)    │
 │   ┌────────────────────┐                                               │
 │   │   variant-gen.js   │ ── spawns `claude -p` to propose 2 variants   │
 │   └────────┬───────────┘                                               │
 │            │                                                           │
 │            ▼                                                           │
 │   ┌─────────────────────────────────────────────────────────┐           │
 │   │  per-variant scoring                                     │           │
 │   │    (1) cron-eval.js  — static gates 1-5                 │           │
 │   │    (2) variant-test  — dry-run against past traces +    │           │
 │   │                        cross-contamination check        │           │
 │   └────────┬────────────────────────────────────────────────┘           │
 │            │                                                           │
 │            ▼  data/candidate-variants.json (status=pending_review)      │
 │   ┌─────────────────────────────┐                                      │
 │   │  evolution-review.js        │ ── posts to Discord (or stdout)      │
 │   │  formats diff + eval + dry  │                                      │
 │   └────────┬────────────────────┘                                      │
 │            │                                                           │
 │            ▼  human approves one variant                                │
 │   ┌─────────────────────────────┐                                      │
 │   │  evolution-review.js        │ ── writes variant.message →          │
 │   │     --apply-variant <c> <v> │    crons/jobs.json                   │
 │   └─────────────────────────────┘                                      │
 │                                                                        │
 └──────────────────────────────────────────────────────────────────────────┘

 ┌──────────────────────────────────────────────────────────────────────────┐
 │                     SKILL-LEVEL EVOLUTION LOOP                           │
 │                                                                          │
 │   agent uses memory/skills/<slug>.md for a procedure                     │
 │             │                                                           │
 │             ▼                                                           │
 │   ┌────────────────────┐                                               │
 │   │   skill-log.js     │ ── data/skill-outcomes.json                    │
 │   │   record outcome   │    (per-skill rolling window of 100 uses)     │
 │   └────────┬───────────┘                                               │
 │            │                                                           │
 │            ▼  (cron-scheduled nightly)                                 │
 │   ┌────────────────────┐                                               │
 │   │   skill-log.js     │ ── emits slugs w/ 3+ consecutive failures     │
 │   │  --flag-recurring  │    (plug into variant-gen-style refinement)   │
 │   └────────┬───────────┘                                               │
 │            │                                                           │
 │            ▼                                                           │
 │   ┌────────────────────┐                                               │
 │   │  skill-create.js   │ ── create refined skill + rebuild INDEX.md    │
 │   │ --refresh-index    │    (idempotent, regenerates from disk)        │
 │   └────────────────────┘                                               │
 │                                                                        │
 └──────────────────────────────────────────────────────────────────────────┘
```

## Why two loops, why symmetric

A skill is just a prompt in a different costume — a durable procedure the
agent loads on-demand. Both crons and skills are "prompts that drift." The
only real differences are the trigger (schedule vs on-demand) and the
outcome signal (log pattern vs explicit `skill-log` call).

Once you accept that symmetry, both loops collapse to the same shape:

1. **Observe.** Record what happened (log pattern / outcome call).
2. **Aggregate.** Roll runs into a failure-mode histogram.
3. **Propose.** Ask Claude for improved variants when a mode recurs.
4. **Verify.** Static gates + historical replay before shipping.
5. **Approve.** Human in the loop — never auto-apply.
6. **Apply.** Overwrite the original with the approved variant.

## Why five gates + dry-run

The static gates in `cron-eval.js` are fast (one regex per rule) but shallow:
they only check string presence/absence. The dry-run in `variant-test.js` is
slower (touches the trace store) but deeper: it actually asks "would this
variant have fixed the specific failures we already saw?"

Used together, a variant can only ship if:
- It doesn't contain known-bad strings (Gate 1, 2).
- It contains the fix content for its target failure mode (Gate 3).
- It preserves existing success markers (Gate 4, 5).
- It would have fixed the failures that actually happened (dry-run addressed).
- It doesn't re-introduce a pattern that broke a different job (cross-contamination).

## What the kit does NOT do

- It does not execute variants in production. Humans approve every change.
- It does not run Claude for scoring — only for generating variants. Scoring
  is pure static analysis + set-membership checks. No hidden LLM calls.
- It does not refine itself. The constraints, classifiers, and gates are all
  author-controlled data files you version alongside your code.

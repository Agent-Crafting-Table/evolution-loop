# Evolution Loop — Closed-Loop Prompt Refinement for Claude Agents

Detect recurring failures in scheduled cron jobs and reusable skills, draft improved prompts automatically via Claude, validate them statically and against historical runs, and ship them only with human approval.

> Part of [The Agent Crafting Table](https://github.com/Agent-Crafting-Table) — standalone agent system components for Claude Code.

## What This Solves

- **No feedback from scoring to proposals** — scoring-only systems label jobs as broken forever. `variant-gen.js` closes the loop by drafting concrete fixes the moment a failure mode recurs.
- **Blind LLM rewrites** — handing Claude an old prompt and "please fix" produces variants that look plausible but re-introduce bugs from other jobs or drop the success marker. 5 static gates + dry-run catch these before humans see them.
- **Cross-contamination between jobs** — fixing job A by borrowing an approach from job B used to re-introduce a pattern that broke job C. `variant-test.js` checks every candidate against every other job's `required_absent` set.
- **Silent prompt drift** — without a score on whether a change *would have fixed the actual failures*, reviewers LGTM any plausible diff. The dry-run forces the question.
- **Dead-code skills** — procedures in `memory/skills/` with no usage signal silently decay. `skill-log.js` makes their health observable and feeds them into the same refinement pipeline.

## Files

```
src/
  trace-extract.js      # Converts raw cron logs → structured trace records
  instruction-refine.js # Auto-patches low-risk failures (3+ consecutive); escalates to variant-gen
  variant-gen.js        # Reflexion pattern: one diagnosis + one targeted change per proposal
  variant-test.js       # Dry-runs candidates against historical traces, cross-contamination check
  cron-eval.js          # Static 5-gate pre-flight validator for prompt patches
  evolution-review.js   # Posts compact diff to Discord/stdout; applies approved variants
  skill-log.js          # Records skill invocation outcomes, flags recurring failures
  skill-create.js       # Creates/updates skill files, rebuilds INDEX.md
examples/
  cron-eval.json           # Example eval ruleset to copy to data/cron-eval.json
  failure-classifiers.json # Example project-specific failure classifiers
  variant-constraints.json # Example per-project constraints for variant generation
  skill-example.md         # Example skill file format
assets/
  architecture.md          # System design notes
```

## Prerequisites

This kit layers on top of [cron-framework](https://github.com/Agent-Crafting-Table/cron-framework) or an equivalent system that produces:

- `crons/jobs.json` — job registry with `{ id, name, message, ... }`
- `crons/logs/YYYY-MM-DD-<prefix>.log` — per-run logs
- `data/cron-performance.json` — scored run history keyed by job id

The skill-level loop (`skill-log`, `skill-create`) works independently of cron-framework.

## Requirements

- Node.js 18+
- `claude` CLI on `$PATH` — only required by `variant-gen.js`
- No database, no network services

## Setup

### 1. Drop `src/` into your project

All seven scripts are standalone — no npm install needed.

### 2. Author your eval dataset

```bash
cp examples/cron-eval.json data/cron-eval.json
```

Edit `data/cron-eval.json` to define your project's failure patterns, success markers, and per-mode fix requirements. This is the file the loop reads most often.

### 3. (Optional) Extend classifiers and constraints

```bash
cp examples/failure-classifiers.json data/failure-classifiers.json
cp examples/variant-constraints.json data/variant-constraints.json
```

- `failure-classifiers.json` — project-specific failure fingerprints (paths, error strings, HTTP codes)
- `variant-constraints.json` — constraints appended to the Claude meta-prompt during variant generation (e.g. "do not reference paths under /old/config")

### 4. Wire the loop as a recurring job

Add this to your cron schedule (daily is typical):

```bash
node src/trace-extract.js --all --days=1
node src/instruction-refine.js --apply      # auto-patch low-risk failures
node src/variant-gen.js --pending           # draft single-change diffs for 3+ consecutive failures
node src/evolution-review.js                # post to Discord or stdout for human approval
node src/skill-log.js --flag-recurring
node src/skill-create.js --refresh-index
```

When a variant is approved:

```bash
node src/evolution-review.js --apply-variant <candidate-id> <variant-id>
```

### 5. Mark job autofix levels

In `crons/jobs.json`, add an `autofixLevel` field to each job:

- `"autofixLevel": "safe"` — `instruction-refine.js` can auto-apply mechanical patches (utility crons: backups, health checks, status posts)
- `"autofixLevel": "review"` (default if unset) — variants always go to human approval (dev agents, customer-facing jobs, anything that touches money)

Jobs with `"critical": true` are never auto-patched regardless of `autofixLevel`.

## Workflow

```
cron logs → trace-extract.js → execution-traces.json
                                       ↓
                              cron-performance.json
                                       ↓
                         instruction-refine.js
                         (auto-patch low-risk, 3+ consecutive)
                                       ↓ (medium/high-risk or review-level)
                              variant-gen.js → candidate-variants.json
                              (Reflexion: one diagnosis + one change)
                                       ↓
                         cron-eval.js (5 static gates)
                         variant-test.js (dry-run + cross-contamination)
                                       ↓
                         evolution-review.js → human reviews diff
                         (reply "apply <id>" / "skip <id>")
                                       ↓ (approved)
                              jobs.json updated
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `WORKSPACE_DIR` | cwd | Project root |
| `CRON_MODEL` | `sonnet` | Claude model for `variant-gen.js` |
| `SUCCESS_MARKER` | `HEARTBEAT_OK` | String that marks a successful run |
| `MAX_PER_RUN` | 3 | Max job+mode pairs per `--pending` invocation |
| `DISCORD_POST` | — | Path to `node <script> <channel> <message>` helper |
| `REVIEW_CHANNEL` | — | Discord channel ID for variant reviews |
| `IMPROVEMENTS_FILE` | `memory/references/cron-improvements.md` | Human-review log for `instruction-refine.js` |
| `PATCH_LOG_FILE` | `data/patch-log.md` | Applied-patch log for `instruction-refine.js` |
| `MAX_PATCH_CHARS` | 500 | Max chars a single auto-patch may add |
| `MAX_PATCHES_PER_RUN` | 3 | Max auto-patches per `--apply` invocation |
| `SKILLS_DIR` | `memory/skills` | Where skill markdown files live |
| `SKILL_LOG_MAX` | 100 | Rolling invocation window per skill |
| `SKILL_LOG_FAIL_THRESHOLD` | 3 | Consecutive failures before a skill is flagged |

## On-Demand Operations

```bash
# Refine a specific job+failure-mode
node src/variant-gen.js --job-id daily-status-report --mode timeout

# Dry-run a hand-written candidate against history
node src/variant-test.js --job-id daily-status-report \
  --variant-message "$(cat proposed.txt)"

# Static eval only
node src/cron-eval.js --job-id daily-status-report --mode timeout \
  --original-message "$(cat old.txt)" --patched-message "$(cat new.txt)"

# List pending reviews
node src/evolution-review.js --list

# Apply an approved variant
node src/evolution-review.js --apply-variant <candidate-id> <variant-id>
```

## Runtime Files (Created by the Framework)

- `data/execution-traces.json` — structured, rolling-window traces per job (~KB per job)
- `data/candidate-variants.json` — every proposed variant with scores; status: `pending_review → review_posted → applied | skipped`; stale records pruned after 14 days
- `data/skill-outcomes.json` — per-skill invocation history and consecutive failure counts
- `memory/skills/INDEX.md` — auto-generated table of contents for all skill files

## The 5 Static Gates (cron-eval.js)

1. **Failure patterns** — patched message must not contain known-bad patterns
2. **Required absent** — patterns that must never appear in this job's prompt
3. **Mode-specific fix content** — for the target failure mode, patched message must contain the required fix
4. **Per-job success indicators** — job-specific success markers must be preserved
5. **Default success indicators** — fleet-wide success signal (e.g. `HEARTBEAT_OK`) enforced automatically

## Variant Test Scoring

`variant-test.js` dry-runs a candidate against the past 30 traces for that job:

- **Coverage score (0.0–1.0)** — what fraction of past failure modes would this variant have addressed?
- **Cross-contamination check** — does this variant contain any pattern in another job's `required_absent`?
- **Verdict** — `pass` (score ≥ 0.7, no contamination) / `warn` / `fail`

## Constraints

- **Humans approve every prompt change.** `evolution-review.js` never auto-applies.
- **Static analysis only.** No variant is ever executed against production.
- **English-language substring checks.** Patterns are literal substrings. For regex, extend `classifyFailure()` in `trace-extract.js`.
- **Variant generation costs LLM tokens.** Each `--pending` run makes up to `MAX_PER_RUN` Claude calls.

## Safety Notes

- `variant-gen.js` spawns `claude --dangerously-skip-permissions`. The model sees the full job message — don't point this at jobs whose prompts contain secrets.
- `evolution-review.js --apply-variant` overwrites `crons/jobs.json` in-place. Commit before running so you can `git diff` and revert.
- Variant messages are not sandboxed — once applied, the next scheduled tick runs whatever the approved variant says. The human reviewer is the final gate.
- `skill-log.js` stores `--note` / `--context` values in plain JSON. Avoid piping raw user input into these fields.

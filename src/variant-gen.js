#!/usr/bin/env node
/**
 * variant-gen.js — Generate candidate prompt variants for failing cron jobs
 *
 * When a cron job has 3+ *consecutive* failures of the same mode that can't be
 * auto-patched, this script uses Claude (Reflexion pattern) to produce exactly
 * ONE diagnosis + ONE targeted change per proposal. Variants are scored by
 * cron-eval.js (static) and variant-test.js (dry-run against history) before
 * being presented for human approval via evolution-review.js.
 *
 * Usage:
 *   node variant-gen.js --job-id <id> --mode <failure_mode>
 *   node variant-gen.js --pending              # process all 3+ consecutive failures
 *
 * Reads:
 *   crons/jobs.json                      job registry
 *   data/cron-performance.json           run history (from cron-framework/cron-score)
 *   data/execution-traces.json           structured traces (from trace-extract)
 *   data/variant-constraints.json        OPTIONAL — extra constraints to append to the meta-prompt
 *
 * Writes:
 *   data/candidate-variants.json
 *
 * Env:
 *   WORKSPACE_DIR   project root (default: cwd)
 *   CRON_MODEL      claude model for variant generation (default: sonnet)
 *   MAX_PER_RUN     max job+mode pairs to process in one --pending run (default: 3)
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const WORKSPACE      = process.env.WORKSPACE_DIR || process.cwd();
const JOBS_FILE      = path.join(WORKSPACE, 'crons', 'jobs.json');
const TRACES_FILE    = path.join(WORKSPACE, 'data', 'execution-traces.json');
const PERF_FILE      = path.join(WORKSPACE, 'data', 'cron-performance.json');
const VARIANTS_FILE  = path.join(WORKSPACE, 'data', 'candidate-variants.json');
const CONSTRAINTS_FILE = path.join(WORKSPACE, 'data', 'variant-constraints.json');

const MODEL       = process.env.CRON_MODEL || 'sonnet';
const MAX_PER_RUN = parseInt(process.env.MAX_PER_RUN || '3', 10);

const { evalPatch } = require('./cron-eval');
const { dryRun }    = require('./variant-test');

// Default constraints — extend via data/variant-constraints.json
const DEFAULT_CONSTRAINTS = [
  "Keep the job's original intent and outcome unchanged",
  "Must be a complete message (not just a patch snippet)",
  "If the original ends with a success marker (e.g. HEARTBEAT_OK), keep it",
];

function loadConstraints() {
  if (!fs.existsSync(CONSTRAINTS_FILE)) return DEFAULT_CONSTRAINTS;
  try {
    const data = JSON.parse(fs.readFileSync(CONSTRAINTS_FILE, 'utf8'));
    const user = Array.isArray(data) ? data : (data.constraints || []);
    return [...DEFAULT_CONSTRAINTS, ...user];
  } catch {
    return DEFAULT_CONSTRAINTS;
  }
}

// ── Reflexion meta-prompt — single diagnosis + single change ─────────────────
function buildVariantPrompt(job, mode, traces) {
  const constraints = loadConstraints();
  const recentTraces = traces?.slice(-3) || [];
  const traceExcerpts = recentTraces.map(t =>
    `Date: ${t.date} | Outcome: ${t.outcome} | Failure: ${t.failure_mode || 'none'}\n` +
    `Errors: ${(t.errors || []).join('; ') || 'none'}\n` +
    `Log excerpt:\n${t.excerpt || ''}`
  ).join('\n\n---\n\n');

  const constraintsBlock = constraints.map((c, i) => `${i + 1}. ${c}`).join('\n');

  return `You are diagnosing a cron job instruction that is systematically failing (3+ consecutive failures).

JOB NAME: ${job.name}
FAILURE MODE: ${mode}
CURRENT MESSAGE (the cron job prompt sent to a Claude subagent):
---
${job.message.slice(0, 2000)}${job.message.length > 2000 ? '\n[...truncated]' : ''}
---

RECENT EXECUTION TRACES (last 3 failures):
---
${traceExcerpts || 'No traces available — diagnose from the failure mode and message.'}
---

TASK: Using the Reflexion pattern — diagnose the root cause in one sentence, then generate exactly ONE targeted change that fixes it.

RULES:
1. ONE change only — one block added, one line modified, or one timeout adjusted. Not a full rewrite.
2. The change must be the minimum edit to fix the diagnosed root cause.

CONSTRAINTS:
${constraintsBlock}

Output ONLY valid JSON, no markdown, no explanation:
{
  "variants": [
    {
      "id": "v1",
      "diagnosis": "One sentence: fails because [specific root cause]",
      "single_change": {
        "description": "One sentence describing what this change does",
        "remove": "exact text to remove (or empty string if addition only)",
        "add": "exact replacement text (or new text to append)"
      },
      "message": "The complete updated cron job message with exactly the one change applied",
      "expected_fix": "One sentence: why this specific change will stop the failure"
    }
  ]
}`;
}

// ── Spawn Claude ─────────────────────────────────────────────────────────────
function generateVariants(prompt) {
  const result = spawnSync(
    'claude',
    ['--dangerously-skip-permissions', '--model', MODEL, '-p', prompt],
    {
      cwd: WORKSPACE,
      encoding: 'utf8',
      timeout: 120000,
      env: { ...process.env, HOME: process.env.HOME || require('os').homedir() },
    }
  );

  if (result.error) throw new Error(`claude CLI spawn failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`claude exited ${result.status}: ${result.stderr?.slice(0, 200)}`);

  const output = (result.stdout || '').trim();
  const jsonMatch = output.match(/\{[\s\S]*"variants"[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`No JSON found in claude output: ${output.slice(0, 300)}`);

  return JSON.parse(jsonMatch[0]);
}

// ── Load traces in either format ─────────────────────────────────────────────
function loadJobTraces(jobId) {
  const allTraces = fs.existsSync(TRACES_FILE)
    ? JSON.parse(fs.readFileSync(TRACES_FILE, 'utf8'))
    : {};

  if (Array.isArray(allTraces)) {
    return allTraces
      .filter(t => t.jobId === jobId && t.status !== 'ok')
      .slice(-10)
      .map(t => ({
        date: (t.date || '').slice(0, 10),
        outcome: 'fail',
        failure_mode: t.errorReason ? t.errorReason.slice(0, 80) : 'unknown',
        errors: [t.error || t.errorReason || ''].filter(Boolean),
        excerpt: t.summary || '',
      }));
  }
  return allTraces[jobId]?.traces || [];
}

// ── Count consecutive trailing failures per mode ──────────────────────────────
function getConsecutiveStreaks(runs) {
  const sorted = [...runs].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const streak = {};
  for (let i = sorted.length - 1; i >= 0; i--) {
    const run = sorted[i];
    if (run.fix_applied || run.outcome === 'success') break;
    if (run.failure_mode) streak[run.failure_mode] = (streak[run.failure_mode] || 0) + 1;
  }
  return streak;
}

// ── Process one job+mode ──────────────────────────────────────────────────────
function processFailure(jobId, mode, jobsById) {
  const job = jobsById[jobId];
  if (!job) { console.log(`Job ${jobId} not found`); return null; }

  console.log(`\nGenerating variant for: ${job.name} (${mode})`);

  const jobTraces = loadJobTraces(jobId);
  const prompt    = buildVariantPrompt(job, mode, jobTraces);

  let parsed;
  try {
    parsed = generateVariants(prompt);
  } catch (e) {
    console.error(`  ❌ Variant generation failed: ${e.message}`);
    return null;
  }

  if (!parsed?.variants?.length) {
    console.error('  ❌ No variants returned');
    return null;
  }

  const scored = parsed.variants.map(v => {
    const result = evalPatch({ job, mode, originalMessage: job.message, patchedMessage: v.message });
    const dry    = dryRun({ jobId, variantMessage: v.message });
    return { ...v, eval: result, dry_run: dry };
  });

  const record = {
    id: `${jobId.slice(0, 8)}-${mode}-${Date.now()}`,
    job_id: jobId,
    job_name: job.name,
    failure_mode: mode,
    generated_at: new Date().toISOString(),
    status: 'pending_review',
    variants: scored,
  };

  const passing = scored.filter(v => v.eval.pass);
  const failing = scored.filter(v => !v.eval.pass && !v.eval.skip);
  console.log(`  Generated ${scored.length} variant(s): ${passing.length} pass eval, ${failing.length} fail eval`);
  for (const v of scored) {
    console.log(`    ${v.id} — dry-run: ${v.dry_run.verdict} (score ${v.dry_run.score}, ${v.dry_run.past_failures_addressed.length}/${v.dry_run.past_modes_seen} modes addressed)`);
  }
  return record;
}

// ── Main ─────────────────────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const jobIdArg = args.find(a => a.startsWith('--job-id='))?.split('=')[1]
              || (args.includes('--job-id') ? args[args.indexOf('--job-id') + 1] : null);
const modeArg  = args.find(a => a.startsWith('--mode='))?.split('=')[1]
              || (args.includes('--mode') ? args[args.indexOf('--mode') + 1] : null);
const pending  = args.includes('--pending');

if (!jobIdArg && !pending) {
  console.error('Usage: variant-gen.js --job-id <id> --mode <mode> | --pending');
  process.exit(1);
}

const { jobs } = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
const jobsById = Object.fromEntries(jobs.map(j => [j.id, j]));

let candidates = fs.existsSync(VARIANTS_FILE)
  ? JSON.parse(fs.readFileSync(VARIANTS_FILE, 'utf8'))
  : [];

// Remove stale candidates (older than 14 days)
const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
candidates = candidates.filter(c => new Date(c.generated_at).getTime() > cutoff);

if (pending) {
  if (!fs.existsSync(PERF_FILE)) {
    console.log('No performance data — run cron-score.js first');
    process.exit(0);
  }
  const perf = JSON.parse(fs.readFileSync(PERF_FILE, 'utf8'));

  let processed = 0;
  for (const [jobId, data] of Object.entries(perf)) {
    const streak = getConsecutiveStreaks(data.runs || []);
    for (const [mode, count] of Object.entries(streak)) {
      if (count >= 3) {
        const existing = candidates.find(c => c.job_id === jobId && c.failure_mode === mode && c.status === 'pending_review');
        if (existing) {
          console.log(`Skipping ${data.name} / ${mode} — candidates already pending review`);
          continue;
        }
        const record = processFailure(jobId, mode, jobsById);
        if (record) { candidates.push(record); processed++; }
        if (processed >= MAX_PER_RUN) break;
      }
    }
    if (processed >= MAX_PER_RUN) break;
  }
  console.log(`\nProcessed ${processed} failure(s)`);
} else {
  if (!modeArg) {
    console.error('--mode is required with --job-id');
    process.exit(1);
  }
  const record = processFailure(jobIdArg, modeArg, jobsById);
  if (record) candidates.push(record);
}

fs.mkdirSync(path.dirname(VARIANTS_FILE), { recursive: true });
fs.writeFileSync(VARIANTS_FILE, JSON.stringify(candidates, null, 2));
console.log(`\nSaved to data/candidate-variants.json (${candidates.length} total record(s))`);
console.log('HEARTBEAT_OK');

#!/usr/bin/env node
/**
 * variant-test.js — Dry-run a candidate variant against historical execution traces
 *
 * Scores how well a proposed prompt variant would have handled past failures
 * recorded for the same job. Static only — does NOT execute the cron.
 *
 * Also checks the variant against all known failure patterns across every job
 * in data/cron-eval.json to catch cross-contamination: a variant for job A
 * that accidentally re-introduces a pattern that broke job B.
 *
 * Usage (CLI):
 *   node variant-test.js --job-id <id> --variant-message "..."
 *   node variant-test.js --candidate-id <cid> --variant-id <vid>
 *
 * Programmatic:
 *   const { dryRun } = require('./variant-test');
 *   const r = dryRun({ jobId, variantMessage });
 *   // r: {
 *   //   past_failures, past_modes_seen,
 *   //   past_failures_addressed: [{ mode, count, fix_found }],
 *   //   past_failures_missed:    [{ mode, count, reason }],
 *   //   cross_contamination:     [{ pattern, source }],
 *   //   score: 0.0..1.0,
 *   //   verdict: 'pass' | 'warn' | 'fail'
 *   // }
 *
 * Exit codes (CLI):
 *   0 = pass (score >= 0.8, no contamination)
 *   1 = warn (partial fix)
 *   2 = fail (addresses nothing or contaminated)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const WORKSPACE     = process.env.WORKSPACE_DIR || process.cwd();
const TRACES_FILE   = path.join(WORKSPACE, 'data', 'execution-traces.json');
const VARIANTS_FILE = path.join(WORKSPACE, 'data', 'candidate-variants.json');
const EVAL_FILE     = path.join(WORKSPACE, 'data', 'cron-eval.json');

// ── Helpers ─────────────────────────────────────────────────────────────────
function loadJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function collectAllFailurePatterns(evalData) {
  // Every known-bad pattern across defaults + every job.required_absent.
  const out = new Map();
  for (const p of (evalData?.defaults?.required_absent  || [])) out.set(p, 'defaults.required_absent');
  for (const p of (evalData?.defaults?.failure_patterns || [])) out.set(p, 'defaults.failure_patterns');
  for (const [jid, jobCfg] of Object.entries(evalData?.jobs || {})) {
    for (const p of (jobCfg.required_absent || [])) out.set(p, `jobs.${jid}.required_absent`);
  }
  return out;
}

// Accept both trace shapes:
//   trace-extract.js writes: { [jobId]: { name, traces: [{ outcome, failure_mode }] } }
//   an alternate logger may write: [ { jobId, status, errorReason, summary } ]
function tracesForJob(allTraces, jobId) {
  if (Array.isArray(allTraces)) {
    return allTraces
      .filter(t => t.jobId === jobId && t.status !== 'ok')
      .map(t => ({ outcome: 'fail', failure_mode: inferModeFromFlat(t) }));
  }
  return allTraces[jobId]?.traces || [];
}

function inferModeFromFlat(t) {
  const text = [t.error || '', t.errorReason || '', t.summary || ''].join(' ');
  if (/Cannot find module/i.test(text)) return 'module_not_found';
  if (/ENOTFOUND|ECONNREFUSED/i.test(text)) return 'network_error';
  if (/timed out|timeout/i.test(text) || t.status === 'timeout') return 'timeout';
  if (/error/i.test(text)) return 'script_error';
  return 'unknown';
}

// ── Core dry-run ────────────────────────────────────────────────────────────
function dryRun({ jobId, variantMessage }) {
  const allTraces = loadJson(TRACES_FILE, {});
  const evalData  = loadJson(EVAL_FILE, { defaults: {}, failure_mode_checks: {}, jobs: {} });

  const jobTraces    = tracesForJob(allTraces, jobId);
  const pastFailures = jobTraces.filter(t => t.outcome === 'fail' && t.failure_mode);

  const addressed = [];
  const missed    = [];

  const modesSeen = new Map();
  for (const t of pastFailures) {
    modesSeen.set(t.failure_mode, (modesSeen.get(t.failure_mode) || 0) + 1);
  }

  for (const [mode, count] of modesSeen) {
    const check = evalData.failure_mode_checks?.[mode];
    if (!check) {
      missed.push({ mode, count, reason: 'no failure_mode_checks entry — cannot verify fix' });
      continue;
    }

    const missingRequired = (check.patch_must_contain || []).filter(s => !variantMessage.includes(s));
    const forbiddenPresent = (check.patch_must_not_contain || []).filter(s => variantMessage.includes(s));

    if (missingRequired.length === 0 && forbiddenPresent.length === 0) {
      addressed.push({ mode, count, fix_found: true });
    } else {
      const reasons = [];
      if (missingRequired.length) reasons.push(`missing required: ${missingRequired.join(', ')}`);
      if (forbiddenPresent.length) reasons.push(`contains forbidden: ${forbiddenPresent.join(', ')}`);
      missed.push({ mode, count, reason: reasons.join(' / ') });
    }
  }

  const allPatterns = collectAllFailurePatterns(evalData);
  const crossContamination = [];
  for (const [pattern, source] of allPatterns) {
    if (variantMessage.includes(pattern)) crossContamination.push({ pattern, source });
  }

  const totalModes    = modesSeen.size;
  const rawScore      = totalModes === 0 ? 1.0 : addressed.length / totalModes;
  const contamPenalty = crossContamination.length * 0.3;
  const score         = Math.max(0, rawScore - contamPenalty);

  let verdict;
  if (crossContamination.length > 0 || score === 0) verdict = 'fail';
  else if (score >= 0.8) verdict = 'pass';
  else verdict = 'warn';

  return {
    past_failures: pastFailures.length,
    past_modes_seen: totalModes,
    past_failures_addressed: addressed,
    past_failures_missed: missed,
    cross_contamination: crossContamination,
    score: Number(score.toFixed(2)),
    verdict,
    tested_at: new Date().toISOString(),
  };
}

module.exports = { dryRun };

// ── CLI ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (n) => { const i = args.indexOf(n); return i !== -1 ? args[i + 1] : null; };

  let jobId          = getArg('--job-id');
  let variantMessage = getArg('--variant-message');

  const candidateId = getArg('--candidate-id');
  const variantId   = getArg('--variant-id');
  if (candidateId && variantId) {
    const candidates = loadJson(VARIANTS_FILE, []);
    const c = candidates.find(x => x.id === candidateId);
    if (!c) { console.error(`Candidate ${candidateId} not found`); process.exit(2); }
    const v = c.variants.find(x => x.id === variantId);
    if (!v) { console.error(`Variant ${variantId} not found in ${candidateId}`); process.exit(2); }
    jobId = jobId || c.job_id;
    variantMessage = variantMessage || v.message;
  }

  if (!jobId || !variantMessage) {
    console.error('Usage: variant-test.js --job-id <id> --variant-message "..."');
    console.error('   or: variant-test.js --candidate-id <cid> --variant-id <vid>');
    process.exit(2);
  }

  const r = dryRun({ jobId, variantMessage });

  console.log(`\nDry-run verdict: ${r.verdict.toUpperCase()} (score: ${r.score})`);
  console.log(`Past failures: ${r.past_failures} (${r.past_modes_seen} distinct modes)`);
  if (r.past_failures_addressed.length) {
    console.log('Addressed:');
    for (const a of r.past_failures_addressed) console.log(`  ✅ ${a.mode} (seen ${a.count}x)`);
  }
  if (r.past_failures_missed.length) {
    console.log('Missed:');
    for (const m of r.past_failures_missed) console.log(`  ❌ ${m.mode} (seen ${m.count}x) — ${m.reason}`);
  }
  if (r.cross_contamination.length) {
    console.log('Cross-contamination detected:');
    for (const c of r.cross_contamination) console.log(`  ⚠️  "${c.pattern}" (from ${c.source})`);
  }

  if (r.verdict === 'pass') process.exit(0);
  if (r.verdict === 'warn') process.exit(1);
  process.exit(2);
}

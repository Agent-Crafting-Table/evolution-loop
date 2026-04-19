#!/usr/bin/env node
/**
 * cron-eval.js — Static validation of candidate prompt patches
 *
 * Version 2 of cron-framework's cron-eval.js with one additional gate:
 *   Gate 5 — default success patterns are enforced for every job, not only
 *   jobs that have an entry in data/cron-eval.json's `jobs` block. Means any
 *   project-wide success marker (e.g. HEARTBEAT_OK) is guarded for every
 *   patch automatically — no per-job config required.
 *
 * If you already have cron-framework v0.2's cron-eval.js in your project,
 * this file supersedes it. The data/cron-eval.json schema is unchanged and
 * backwards compatible.
 *
 * Usage (CLI):
 *   node cron-eval.js --job-id <id> --mode <failure_mode> \
 *     [--original-message "..."] [--patched-message "..."]
 *
 * Exit codes:
 *   0 = PASS, 1 = FAIL, 2 = SKIP (no eval data)
 *
 * Programmatic:
 *   const { evalPatch } = require('./cron-eval');
 *   evalPatch({ job, mode, originalMessage, patchedMessage });
 *   // → { pass: true } | { pass: false, reason } | { skip: true, reason }
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const WORKSPACE = process.env.WORKSPACE_DIR || process.cwd();
const EVAL_FILE = path.join(WORKSPACE, 'data', 'cron-eval.json');

function loadEval() {
  if (!fs.existsSync(EVAL_FILE)) return null;
  return JSON.parse(fs.readFileSync(EVAL_FILE, 'utf8'));
}

function evalPatch({ job, mode, originalMessage, patchedMessage }) {
  const evalData = loadEval();
  if (!evalData) return { skip: true, reason: 'No eval dataset found' };

  const defaults     = evalData.defaults || {};
  const modeChecks   = evalData.failure_mode_checks || {};
  const jobOverrides = evalData.jobs?.[job.id] || {};

  const failurePatterns = [...(defaults.failure_patterns || []), ...(jobOverrides.failure_patterns || [])];
  const requiredAbsent  = [...(defaults.required_absent  || []), ...(jobOverrides.required_absent  || [])];

  // Gate 1 — no failure strings in patched message
  for (const p of failurePatterns) {
    if (patchedMessage.includes(p)) {
      return { pass: false, reason: `Patched message still contains failure pattern: "${p}"` };
    }
  }

  // Gate 2 — required_absent strings must not appear
  for (const s of requiredAbsent) {
    if (patchedMessage.includes(s)) {
      return { pass: false, reason: `Patched message contains a string required to be absent: "${s}"` };
    }
  }

  // Gate 3 — mode-specific fix requirements
  const modeCheck = modeChecks[mode];
  if (modeCheck) {
    for (const req of (modeCheck.patch_must_contain || [])) {
      if (!patchedMessage.includes(req)) {
        return { pass: false, reason: `Patch for "${mode}" must contain "${req}" but doesn't — fix may be incomplete` };
      }
    }
    for (const forb of (modeCheck.patch_must_not_contain || [])) {
      if (patchedMessage.includes(forb)) {
        return { pass: false, reason: `Patch for "${mode}" must not contain "${forb}" — regression detected` };
      }
    }
  }

  // Gate 4 — patch must not remove per-job success indicators
  for (const p of (jobOverrides.success_patterns || [])) {
    if (originalMessage.includes(p) && !patchedMessage.includes(p)) {
      return { pass: false, reason: `Patch removes success indicator: "${p}" — may break success detection` };
    }
  }

  // Gate 5 — patch must not remove default success indicators (new in v2)
  for (const p of (defaults.success_patterns || [])) {
    if (originalMessage.includes(p) && !patchedMessage.includes(p)) {
      return { pass: false, reason: `Patch removes default success indicator: "${p}" — all jobs must preserve this` };
    }
  }

  return { pass: true };
}

module.exports = { evalPatch, loadEval };

if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (n) => { const i = args.indexOf(n); return i !== -1 ? args[i + 1] : null; };
  const jobId = getArg('--job-id');
  const mode  = getArg('--mode');
  const originalMessage = getArg('--original-message') || '';
  const patchedMessage  = getArg('--patched-message')  || '';

  if (!jobId || !mode) {
    console.error('Usage: cron-eval.js --job-id <id> --mode <mode> [--original-message "..."] [--patched-message "..."]');
    process.exit(2);
  }
  if (!loadEval()) { console.log('SKIP: No eval dataset found'); process.exit(2); }

  const r = evalPatch({ job: { id: jobId }, mode, originalMessage, patchedMessage });
  if (r.skip) { console.log(`SKIP: ${r.reason}`); process.exit(2); }
  if (r.pass) { console.log('PASS: Patch passes all evaluation gates'); process.exit(0); }
  console.log(`FAIL: ${r.reason}`);
  process.exit(1);
}

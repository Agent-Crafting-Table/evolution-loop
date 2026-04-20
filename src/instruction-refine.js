#!/usr/bin/env node
/**
 * instruction-refine.js — Detect recurring cron failures and auto-patch instructions
 *
 * Scans cron-performance.json for 3+ *consecutive* failures of the same mode,
 * applies a library of low-risk mechanical patches, gates each patch through 5
 * constraint checks, and writes a patch log. Medium/high-risk failures are
 * written to cron-improvements.md for human review (and fed into variant-gen.js).
 *
 * Usage:
 *   node instruction-refine.js --dry-run   # show what would change
 *   node instruction-refine.js --apply     # apply low-risk patches
 *   node instruction-refine.js --report    # list recurring failures only
 *
 * Constraint gates (applied before any auto-patch ships):
 *   1. MAX_PATCH_CHARS — patch must not add more than 500 chars to a message
 *   2. JSON validity — patched jobs.json must serialize cleanly
 *   3. Critical job flag — jobs with `"critical": true` are never auto-patched
 *   4. autofixLevel — jobs with `"autofixLevel": "review"` skip non-low-risk patches
 *   5. MAX_PATCHES_PER_RUN — max 3 auto-patches per --apply run
 *
 * Env:
 *   WORKSPACE_DIR         project root (default: cwd)
 *   IMPROVEMENTS_FILE     path to human-review log (default: memory/references/cron-improvements.md)
 *   PATCH_LOG_FILE        path to patch log (default: data/patch-log.md)
 *   MAX_PATCH_CHARS       max chars added per patch (default: 500)
 *   MAX_PATCHES_PER_RUN   max patches per --apply run (default: 3)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const WORKSPACE          = process.env.WORKSPACE_DIR || process.cwd();
const JOBS_FILE          = path.join(WORKSPACE, 'crons', 'jobs.json');
const PERF_FILE          = path.join(WORKSPACE, 'data', 'cron-performance.json');
const IMPROVEMENTS_FILE  = process.env.IMPROVEMENTS_FILE || path.join(WORKSPACE, 'memory', 'references', 'cron-improvements.md');
const PATCH_LOG_FILE     = process.env.PATCH_LOG_FILE    || path.join(WORKSPACE, 'data', 'patch-log.md');

const MAX_PATCH_CHARS    = parseInt(process.env.MAX_PATCH_CHARS    || '500', 10);
const MAX_PATCHES_PER_RUN = parseInt(process.env.MAX_PATCHES_PER_RUN || '3', 10);

const { evalPatch } = require('./cron-eval');

// ── Constraint gate validators ────────────────────────────────────────────────
function checkDiffSize(original, patched) {
  const delta = patched.length - original.length;
  if (delta > MAX_PATCH_CHARS) return `patch adds ${delta} chars (limit: ${MAX_PATCH_CHARS}) — flag for review`;
  return null;
}

function checkJsonValidity(jobsData) {
  try { JSON.parse(JSON.stringify(jobsData)); return null; }
  catch (e) { return `JSON validation failed after patch: ${e.message}`; }
}

function checkCriticalFlag(job) {
  if (job.critical === true) return `job is marked critical=true — never auto-patch`;
  return null;
}

// ── Patch library ─────────────────────────────────────────────────────────────
// Each patch: { risk, description, apply(message, job) → newMessage | null,
//               applyToJob?(job) → patch object | null }
// null = already fixed or can't auto-patch
const PATCHES = {
  no_heartbeat: {
    risk: 'low',
    description: 'Job ended without success marker — appending HEARTBEAT_OK reminder (safe jobs only)',
    apply(message, job) {
      // Only auto-patch jobs explicitly marked safe; review-level jobs go to variant-gen
      if ((job.autofixLevel || 'review') !== 'safe') return null;
      if (message.includes('Reply HEARTBEAT_OK') || message.includes('HEARTBEAT_OK as your final')) return null;
      return message + '\n\nReply HEARTBEAT_OK as your final output when done.';
    },
  },

  timeout: {
    risk: 'low',
    description: 'Job consistently times out — bumping timeoutSeconds by 50%, capped at 600s',
    apply() { return null; },
    applyToJob(job) {
      if (!job.timeoutSeconds) return null;
      const MAX_TIMEOUT = 600;
      const newTimeout = Math.min(Math.round(job.timeoutSeconds * 1.5), MAX_TIMEOUT);
      if (newTimeout === job.timeoutSeconds) return null;
      return { timeoutSeconds: newTimeout };
    },
  },

  // Example: add project-specific patches here.
  // stale_path: {
  //   risk: 'low',
  //   description: 'Old path reference in message',
  //   apply(message) {
  //     if (!message.includes('/old/path/')) return null;
  //     return message.replace(/\/old\/path\//g, '/new/path/');
  //   },
  // },
};

// ── Count consecutive trailing failures per mode ──────────────────────────────
function getRecurringFailures(perf, minConsecutive = 3) {
  const results = [];
  for (const [jobId, data] of Object.entries(perf)) {
    const sorted = [...(data.runs || [])].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const streak = {};
    for (let i = sorted.length - 1; i >= 0; i--) {
      const run = sorted[i];
      if (run.fix_applied || run.outcome === 'success') break;
      if (run.failure_mode) streak[run.failure_mode] = (streak[run.failure_mode] || 0) + 1;
    }
    for (const [mode, count] of Object.entries(streak)) {
      if (count >= minConsecutive) results.push({ jobId, name: data.name, mode, count });
    }
  }
  return results.sort((a, b) => b.count - a.count);
}

function writePatchLog(entries) {
  const today = new Date().toISOString();
  const existing = fs.existsSync(PATCH_LOG_FILE) ? fs.readFileSync(PATCH_LOG_FILE, 'utf8') : '';
  const header = `\n## ${today}\n`;
  const items = entries.map(e => {
    if (e.type === 'applied') return `- ✅ **${e.name}**: \`${e.mode}\` [risk: ${e.risk}] — ${e.description}\n  Delta: ${e.delta > 0 ? '+' : ''}${e.delta} chars`;
    if (e.type === 'blocked') return `- 🚫 **${e.name}**: \`${e.mode}\` — BLOCKED: ${e.reason}`;
    return `- ⚠️  **${e.name}**: \`${e.mode}\` — ${e.reason}`;
  }).join('\n');
  fs.mkdirSync(path.dirname(PATCH_LOG_FILE), { recursive: true });
  fs.writeFileSync(PATCH_LOG_FILE, (existing || '# Instruction Refine Patch Log\n') + header + items + '\n');
}

// ── Main ─────────────────────────────────────────────────────────────────────
const args   = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const apply  = args.includes('--apply');
const report = args.includes('--report');

if (!fs.existsSync(PERF_FILE)) {
  console.log('No cron-performance.json found — run cron-score.js first');
  process.exit(0);
}

const perf     = JSON.parse(fs.readFileSync(PERF_FILE, 'utf8'));
const jobsData = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
const jobMap   = Object.fromEntries(jobsData.jobs.map(j => [j.id, j]));

const recurring  = getRecurringFailures(perf);
const appliedLog = [];
const pendingLog = [];
const patchLogEntries = [];
let patchesApplied = 0;

if (recurring.length === 0) {
  console.log('No recurring failures (3+ consecutive) detected. HEARTBEAT_OK');
  process.exit(0);
}

if (report) {
  console.log('\n🔁 Recurring Failures (3+ consecutive):\n');
  for (const r of recurring) {
    const patch = PATCHES[r.mode];
    const risk  = patch ? patch.risk : 'unknown';
    const critFlag = jobMap[r.jobId]?.critical ? ' [CRITICAL — no auto-patch]' : '';
    console.log(`  ${r.name}: ${r.mode} × ${r.count} [risk: ${risk}]${critFlag}`);
  }
  console.log();
  process.exit(0);
}

for (const { jobId, name, mode, count } of recurring) {
  const job   = jobMap[jobId];
  const patch = PATCHES[mode];

  if (!job) continue;

  if (!patch) {
    pendingLog.push({ name, mode, count, reason: 'No patch defined' });
    continue;
  }

  if (patch.risk === 'high') {
    pendingLog.push({ name, mode, count, reason: `Risk=high: ${patch.description}` });
    continue;
  }

  // Gate: critical job flag
  const critErr = checkCriticalFlag(job);
  if (critErr) {
    pendingLog.push({ name, mode, count, reason: critErr });
    patchLogEntries.push({ type: 'blocked', name, mode, reason: critErr });
    continue;
  }

  // Gate: autofixLevel — 'review' jobs with non-low-risk patches go to variant-gen
  const autofixLevel = job.autofixLevel || 'review';
  if (autofixLevel === 'review' && patch.risk !== 'low') {
    pendingLog.push({ name, mode, count, reason: `autofixLevel=review — escalate to variant-gen` });
    continue;
  }

  // Gate: max patches per run
  if (apply && patchesApplied >= MAX_PATCHES_PER_RUN) {
    pendingLog.push({ name, mode, count, reason: `MAX_PATCHES_PER_RUN (${MAX_PATCHES_PER_RUN}) reached — deferred` });
    continue;
  }

  const newMessage    = patch.apply(job.message, job);
  const jobLevelPatch = patch.applyToJob ? patch.applyToJob(job) : null;

  if (!newMessage && !jobLevelPatch) {
    continue; // already fixed or can't auto-patch
  }

  // Gate: diff size (message patches only)
  if (newMessage && newMessage !== job.message) {
    const sizeErr = checkDiffSize(job.message, newMessage);
    if (sizeErr) {
      pendingLog.push({ name, mode, count, reason: sizeErr });
      patchLogEntries.push({ type: 'blocked', name, mode, reason: sizeErr });
      continue;
    }
  }

  // Gate: static eval
  if (newMessage && newMessage !== job.message) {
    const evalResult = evalPatch({ job, mode, originalMessage: job.message, patchedMessage: newMessage });
    if (!evalResult.skip && !evalResult.pass) {
      pendingLog.push({ name, mode, count, reason: `Eval gate: ${evalResult.reason}` });
      patchLogEntries.push({ type: 'blocked', name, mode, reason: `Eval: ${evalResult.reason}` });
      continue;
    }
  }

  if (dryRun) {
    console.log(`[DRY RUN] ${name} — would fix: ${mode} × ${count} [risk: ${patch.risk}]`);
    if (newMessage && newMessage !== job.message) console.log(`  Delta: ${newMessage.length - job.message.length > 0 ? '+' : ''}${newMessage.length - job.message.length} chars`);
    if (jobLevelPatch) console.log(`  Job-level:`, JSON.stringify(jobLevelPatch));
    continue;
  }

  if (apply) {
    const originalMessage = job.message;
    if (newMessage && newMessage !== job.message) job.message = newMessage;
    if (jobLevelPatch) Object.assign(job, jobLevelPatch);

    // Gate: JSON validity (rollback on fail)
    const jsonErr = checkJsonValidity(jobsData);
    if (jsonErr) {
      job.message = originalMessage;
      if (jobLevelPatch) Object.assign(job, Object.fromEntries(Object.keys(jobLevelPatch).map(k => [k, job[k]])));
      pendingLog.push({ name, mode, count, reason: jsonErr });
      patchLogEntries.push({ type: 'blocked', name, mode, reason: jsonErr });
      continue;
    }

    const today = new Date().toISOString().slice(0, 10);
    for (const run of perf[jobId].runs) {
      if (run.failure_mode === mode && !run.fix_applied) run.fix_applied = today;
    }

    const delta = newMessage ? newMessage.length - originalMessage.length : 0;
    appliedLog.push({ name, mode, count, risk: patch.risk, description: patch.description, delta });
    patchLogEntries.push({ type: 'applied', name, mode, risk: patch.risk, description: patch.description, delta });
    patchesApplied++;
    console.log(`✅ Patched: ${name} — ${mode} × ${count} (delta: ${delta > 0 ? '+' : ''}${delta} chars)`);
  }
}

if (apply && appliedLog.length > 0) {
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobsData, null, 2));
  fs.writeFileSync(PERF_FILE, JSON.stringify(perf, null, 2));
}

if (apply && patchLogEntries.length > 0) {
  writePatchLog(patchLogEntries);
  console.log(`\nPatch log written to ${PATCH_LOG_FILE}`);
}

if (pendingLog.length > 0) {
  const today = new Date().toISOString().slice(0, 10);
  let existing = fs.existsSync(IMPROVEMENTS_FILE) ? fs.readFileSync(IMPROVEMENTS_FILE, 'utf8') : '';
  const header = `\n## ${today} — Needs Manual Review\n`;
  const items  = pendingLog.map(p => `- **${p.name}**: \`${p.mode}\` × ${p.count} — ${p.reason}`).join('\n');
  if (!existing.includes(`## ${today}`)) {
    fs.mkdirSync(path.dirname(IMPROVEMENTS_FILE), { recursive: true });
    fs.writeFileSync(IMPROVEMENTS_FILE, existing + header + items + '\n');
    console.log(`\nWrote ${pendingLog.length} pending item(s) to ${IMPROVEMENTS_FILE}`);
  }
}

console.log(`\nApplied: ${appliedLog.length} | Pending review: ${pendingLog.length}`);
if (patchesApplied >= MAX_PATCHES_PER_RUN && recurring.length > patchesApplied) {
  console.log(`  (MAX_PATCHES_PER_RUN=${MAX_PATCHES_PER_RUN} hit — remaining deferred to next run)`);
}

if (appliedLog.length > 0) {
  console.log('\nPatches applied:');
  for (const a of appliedLog) console.log(`  ✅ ${a.name}: ${a.mode} [${a.risk}] delta: ${a.delta > 0 ? '+' : ''}${a.delta}`);
}

if (pendingLog.length > 0) {
  console.log('\nPending review (→ variant-gen.js):');
  for (const p of pendingLog) console.log(`  ⚠️  ${p.name}: ${p.mode} — ${p.reason}`);
}

console.log('\nHEARTBEAT_OK');

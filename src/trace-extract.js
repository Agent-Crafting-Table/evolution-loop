#!/usr/bin/env node
/**
 * trace-extract.js — Extract structured execution traces from raw cron log files
 *
 * Converts raw stdout/stderr dumps into structured records that feed the
 * variant-generation loop (variant-gen.js / variant-test.js).
 *
 * Usage:
 *   node trace-extract.js --job-id <id> [--days=7]
 *   node trace-extract.js --all [--days=7]
 *
 * Writes:
 *   data/execution-traces.json  (schema: { [jobId]: { name, traces: [{ date, outcome, failure_mode, errors, warnings, excerpt, ... }] } })
 *
 * Reads:
 *   crons/logs/YYYY-MM-DD-<prefix>.log     — per-run logs written by cron-framework
 *   crons/jobs.json                        — job registry
 *   data/failure-classifiers.json          — OPTIONAL, extend default classifiers
 *
 * Failure mode classification: built-in defaults cover generic modes
 * (module_not_found, network_error, timeout, script_error, no_heartbeat).
 * To add project-specific modes (e.g. "stale_config_path"), author
 * data/failure-classifiers.json as an ordered list:
 *
 *   [
 *     { "mode": "stale_config_path", "match_any": ["/old/path"] },
 *     { "mode": "quota_exceeded",    "match_any": ["429", "rate limit"] }
 *   ]
 *
 * Classifiers are evaluated in file order, first match wins. Built-ins run
 * afterwards as a fallback.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const WORKSPACE   = process.env.WORKSPACE_DIR || process.cwd();
const LOGS_DIR    = path.join(WORKSPACE, 'crons', 'logs');
const JOBS_FILE   = path.join(WORKSPACE, 'crons', 'jobs.json');
const TRACES_FILE = path.join(WORKSPACE, 'data', 'execution-traces.json');
const CLASSIFIER_FILE = path.join(WORKSPACE, 'data', 'failure-classifiers.json');

const MAX_TRACE_CONTEXT = 600;   // chars of log head + tail to keep per trace
const MAX_TRACES_PER_JOB = 30;    // rolling window
const SKIP_LOGS = new Set(['cron-runner.log', 'slash-handler.log']);

// ── Built-in classifiers (applied after user-defined ones) ──────────────────
const BUILTIN_CLASSIFIERS = [
  { mode: 'module_not_found', match_any: ['Cannot find module'] },
  { mode: 'network_error',    match_any: ['ECONNREFUSED', 'ENOTFOUND'] },
  { mode: 'timeout',          match_any: ['timed out', 'timeout exceeded'] },
  { mode: 'script_error',     match_any: ['Error:', 'error:', 'Traceback'] },
];

function loadClassifiers() {
  const user = fs.existsSync(CLASSIFIER_FILE)
    ? JSON.parse(fs.readFileSync(CLASSIFIER_FILE, 'utf8'))
    : [];
  return [...user, ...BUILTIN_CLASSIFIERS];
}

function classifyFailure(content, classifiers) {
  for (const c of classifiers) {
    for (const needle of (c.match_any || [])) {
      if (content.includes(needle)) return c.mode;
    }
  }
  return null;
}

// ── Extract one trace from raw log content ──────────────────────────────────
function extractTrace({ content, jobId, dateStr, logFile, classifiers, successMarker }) {
  const lines = content.split('\n');

  const headerMatch = content.match(/=== ([\d\-T:.Z]+) — .+ ===/);
  const startTime = headerMatch ? headerMatch[1] : null;

  const errors = lines
    .filter(l => /[Ee]rror:|ENOTFOUND|ECONNREFUSED|Cannot find module|Traceback/i.test(l))
    .slice(0, 5)
    .map(l => l.trim().slice(0, 200));

  const warnings = lines
    .filter(l => /warning|warn:/i.test(l) && !/node_modules/.test(l))
    .slice(0, 3)
    .map(l => l.trim().slice(0, 150));

  const succeeded = content.includes(successMarker);

  let failureMode = null;
  if (!succeeded) {
    failureMode = classifyFailure(content, classifiers) || 'no_heartbeat';
  }

  const head = content.slice(0, MAX_TRACE_CONTEXT / 2).trim();
  const tail = content.slice(-(MAX_TRACE_CONTEXT / 2)).trim();
  const excerpt = head + (content.length > MAX_TRACE_CONTEXT ? '\n[...]\n' + tail : '');

  return {
    job_id: jobId,
    date: dateStr,
    log_file: logFile,
    start_time: startTime,
    outcome: succeeded ? 'success' : 'fail',
    failure_mode: failureMode,
    errors,
    warnings,
    excerpt: excerpt.slice(0, MAX_TRACE_CONTEXT + 20),
    log_length: content.length,
    extracted_at: new Date().toISOString(),
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args    = process.argv.slice(2);
  const jobIdArg = args.find(a => a.startsWith('--job-id='))?.split('=')[1]
                 || (args.includes('--job-id') ? args[args.indexOf('--job-id') + 1] : null);
  const daysArg = args.find(a => a.startsWith('--days='));
  const days    = daysArg ? parseInt(daysArg.split('=')[1], 10) : 7;
  const allJobs = args.includes('--all');

  if (!jobIdArg && !allJobs) {
    console.error('Usage: trace-extract.js --job-id <id> [--days=N] | --all [--days=N]');
    process.exit(1);
  }

  if (!fs.existsSync(JOBS_FILE)) {
    console.error(`jobs.json not found at ${JOBS_FILE}`);
    process.exit(1);
  }
  if (!fs.existsSync(LOGS_DIR)) {
    console.error(`Logs directory not found at ${LOGS_DIR} — has the cron runner written any logs yet?`);
    process.exit(1);
  }

  const { jobs } = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
  const jobsByPrefix = {};
  for (const job of jobs) jobsByPrefix[job.id.slice(0, 8)] = job;

  const classifiers = loadClassifiers();
  const successMarker = process.env.SUCCESS_MARKER || 'HEARTBEAT_OK';

  let traces = fs.existsSync(TRACES_FILE)
    ? JSON.parse(fs.readFileSync(TRACES_FILE, 'utf8'))
    : {};

  const now      = Date.now();
  const windowMs = days * 24 * 60 * 60 * 1000;

  const logFiles = fs.readdirSync(LOGS_DIR)
    .filter(f => f.endsWith('.log') && !SKIP_LOGS.has(f))
    .filter(f => {
      const dateStr = f.slice(0, 10);
      return (now - new Date(dateStr).getTime()) <= windowMs;
    })
    .filter(f => {
      if (allJobs) return true;
      const prefix = f.slice(11, 19);
      const job    = jobsByPrefix[prefix];
      return job && job.id === jobIdArg;
    })
    .sort();

  let extracted = 0, skipped = 0;
  for (const logFile of logFiles) {
    const dateStr = logFile.slice(0, 10);
    const prefix  = logFile.slice(11, 19);
    const job     = jobsByPrefix[prefix];
    if (!job) continue;

    const jobId = job.id;
    if (!traces[jobId]) traces[jobId] = { name: job.name, traces: [] };
    if (traces[jobId].traces.some(t => t.date === dateStr)) { skipped++; continue; }

    const content = fs.readFileSync(path.join(LOGS_DIR, logFile), 'utf8');
    const trace   = extractTrace({ content, jobId, dateStr, logFile: `crons/logs/${logFile}`, classifiers, successMarker });
    traces[jobId].traces.push(trace);

    if (traces[jobId].traces.length > MAX_TRACES_PER_JOB) {
      traces[jobId].traces = traces[jobId].traces.slice(-MAX_TRACES_PER_JOB);
    }
    extracted++;
  }

  fs.mkdirSync(path.dirname(TRACES_FILE), { recursive: true });
  fs.writeFileSync(TRACES_FILE, JSON.stringify(traces, null, 2));

  console.log(`Extracted ${extracted} trace(s), skipped ${skipped} already-processed.`);
  if (jobIdArg && traces[jobIdArg]) {
    const recent = traces[jobIdArg].traces.slice(-3);
    console.log(`\nRecent traces for ${traces[jobIdArg].name}:`);
    for (const t of recent) {
      console.log(`  ${t.date}: ${t.outcome}${t.failure_mode ? ' (' + t.failure_mode + ')' : ''} — ${t.errors.length} errors`);
    }
  }
}

module.exports = { extractTrace, loadClassifiers, classifyFailure };

#!/usr/bin/env node
/**
 * evolution-review.js — Post candidate variant reviews for human approval, apply approved variants
 *
 * Reads pending variants from data/candidate-variants.json, formats a compact
 * diff block (one proposal per message), and surfaces them for human review. If
 * DISCORD_POST is set (path to a script that takes `<channel_id> <message>`),
 * reviews are posted there. Otherwise printed to stdout.
 *
 * NEVER auto-applies — always requires explicit human approval.
 *
 * Usage:
 *   node evolution-review.js                               # post all pending reviews
 *   node evolution-review.js --id <candidate-id>           # post a specific one
 *   node evolution-review.js --list                        # list pending candidates
 *   node evolution-review.js --apply-variant <cid> <vid>   # apply an approved variant
 *
 * Reads/writes:
 *   data/candidate-variants.json
 *   crons/jobs.json                  (updated on --apply-variant)
 *
 * Env:
 *   WORKSPACE_DIR        project root (default: cwd)
 *   DISCORD_POST         optional path to `script.js <channel> <message>` for posting
 *   REVIEW_CHANNEL       Discord channel ID to post reviews to (required if DISCORD_POST set)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const WORKSPACE     = process.env.WORKSPACE_DIR || process.cwd();
const VARIANTS_FILE = path.join(WORKSPACE, 'data', 'candidate-variants.json');
const JOBS_FILE     = path.join(WORKSPACE, 'crons', 'jobs.json');

const DISCORD_POST   = process.env.DISCORD_POST || '';
const REVIEW_CHANNEL = process.env.REVIEW_CHANNEL || '';

// ── Format — compact single-diff message ─────────────────────────────────────
function formatReview(record) {
  const { id, job_name, failure_mode, variants, consecutive_count } = record;
  const v = variants[0]; // single-change diff — one variant per proposal
  if (!v) return null;

  const dryRunIcon = !v.dry_run ? '' :
    v.dry_run.verdict === 'pass' ? '🟢' :
    v.dry_run.verdict === 'warn' ? '🟡' : '🔴';
  const dryRunStr = v.dry_run
    ? `${dryRunIcon} dry-run: ${v.dry_run.verdict} (${v.dry_run.past_failures_addressed.length}/${v.dry_run.past_modes_seen} past modes addressed)`
    : '';

  const sc = v.single_change || {};
  const removeSnip = (sc.remove || '').slice(0, 120);
  const addSnip    = (sc.add    || '').slice(0, 120);
  const diffBlock  = removeSnip || addSnip
    ? `\`\`\`diff\n${removeSnip ? `- ${removeSnip}\n` : ''}${addSnip ? `+ ${addSnip}\n` : ''}\`\`\``
    : '(no diff — see full message in candidate-variants.json)';

  let body = `🔧 **Proposal — ${job_name}** (${consecutive_count || '3+'}× consecutive \`${failure_mode}\`)\n`;
  body += `**Diagnosis:** ${v.diagnosis || v.reasoning || '(none)'}\n`;
  body += `**Change:** ${sc.description || '(see diff)'}\n`;
  body += `${diffBlock}\n`;
  if (dryRunStr) body += `${dryRunStr}\n`;
  body += `**Expected:** ${v.expected_fix || '(see reasoning)'}\n`;
  body += `\nReply: \`apply ${id}\` to apply · \`skip ${id}\` to dismiss`;

  return body.slice(0, 1900);
}

function deliverReview(message) {
  if (DISCORD_POST && REVIEW_CHANNEL && fs.existsSync(DISCORD_POST)) {
    const result = spawnSync('node', [DISCORD_POST, REVIEW_CHANNEL, message], {
      cwd: WORKSPACE,
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env },
    });
    if (result.status !== 0) {
      console.error('Discord post failed:', result.stderr?.slice(0, 200));
      console.log('\n--- FALLBACK: review printed below ---\n');
      console.log(message);
    } else {
      console.log(`Posted to Discord (channel ${REVIEW_CHANNEL})`);
    }
  } else {
    console.log(message);
    console.log('---');
  }
}

// ── Apply an approved variant ─────────────────────────────────────────────────
function applyVariant(candidateId, variantId) {
  if (!fs.existsSync(VARIANTS_FILE)) { console.error('No variants file found'); process.exit(1); }
  const candidates = JSON.parse(fs.readFileSync(VARIANTS_FILE, 'utf8'));
  const record = candidates.find(c => c.id === candidateId);
  if (!record) { console.error(`Candidate ${candidateId} not found`); process.exit(1); }
  const variant = record.variants.find(v => v.id === variantId);
  if (!variant) { console.error(`Variant ${variantId} not found in ${candidateId}`); process.exit(1); }

  if (!variant.eval?.pass && !variant.eval?.skip) {
    console.error(`Variant ${variantId} failed eval: ${variant.eval?.reason}`);
    console.error('Refusing to apply — regenerate variants or edit the eval dataset.');
    process.exit(1);
  }

  const jobsData = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
  const job = jobsData.jobs.find(j => j.id === record.job_id);
  if (!job) { console.error(`Job ${record.job_id} not found in jobs.json`); process.exit(1); }

  const originalMessage = job.message;
  job.message = variant.message;
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobsData, null, 2));

  record.status = 'applied';
  record.applied_variant = variantId;
  record.applied_at = new Date().toISOString();
  fs.writeFileSync(VARIANTS_FILE, JSON.stringify(candidates, null, 2));

  console.log(`✅ Applied variant ${variantId} for ${record.job_name}`);
  console.log(`   Original length: ${originalMessage.length} → New length: ${variant.message.length}`);
  console.log('HEARTBEAT_OK');
}

// ── Main ─────────────────────────────────────────────────────────────────────
const args      = process.argv.slice(2);
const idArg     = args.includes('--id') ? args[args.indexOf('--id') + 1] : null;
const listMode  = args.includes('--list');
const applyMode = args.includes('--apply-variant');

if (applyMode) {
  const idx = args.indexOf('--apply-variant');
  const candidateId = args[idx + 1];
  const variantId   = args[idx + 2];
  if (!candidateId || !variantId) {
    console.error('Usage: evolution-review.js --apply-variant <candidate-id> <variant-id>');
    process.exit(1);
  }
  applyVariant(candidateId, variantId);
  process.exit(0);
}

if (!fs.existsSync(VARIANTS_FILE)) {
  console.log('No candidate variants file found. Run variant-gen.js first.');
  process.exit(0);
}

const candidates = JSON.parse(fs.readFileSync(VARIANTS_FILE, 'utf8'));
const { jobs: allJobs } = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
const jobsById = Object.fromEntries(allJobs.map(j => [j.id, j]));

const pending = candidates.filter(c => c.status === 'pending_review');

if (listMode) {
  console.log(`\nPending variant reviews: ${pending.length}\n`);
  for (const c of pending) {
    const passing = c.variants.filter(v => v.eval?.pass).length;
    console.log(`  ${c.id}`);
    console.log(`    Job: ${c.job_name}`);
    console.log(`    Mode: ${c.failure_mode}`);
    console.log(`    Generated: ${c.generated_at.slice(0, 10)}`);
    console.log(`    Passing variants: ${passing}/${c.variants.length}`);
  }
  process.exit(0);
}

const toPost = idArg ? pending.filter(c => c.id === idArg) : pending;
if (toPost.length === 0) { console.log('No pending variant reviews to post.'); process.exit(0); }

for (const record of toPost) {
  const message = formatReview(record);
  if (!message) { console.log(`Skipping ${record.id} — no formattable variant`); continue; }
  console.log(`\nReview for: ${record.job_name}`);
  deliverReview(message);
  record.status = 'review_posted';
  record.posted_at = new Date().toISOString();
}

fs.writeFileSync(VARIANTS_FILE, JSON.stringify(candidates, null, 2));
console.log('\nHEARTBEAT_OK');

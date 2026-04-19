#!/usr/bin/env node
/**
 * evolution-review.js — Post candidate variant reviews for human approval, apply approved variants
 *
 * Reads pending variants from data/candidate-variants.json, formats a diff
 * summary + eval + dry-run verdict, and surfaces them for human review. If
 * DISCORD_POST is set (a path to a script that takes `<channel_id> <message>`),
 * reviews are posted to that channel. Otherwise they are printed to stdout.
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

// ── Helpers ─────────────────────────────────────────────────────────────────
function diffSummary(original, patched) {
  const oLines = original.split('\n');
  const pLines = patched.split('\n');
  const changes = [];
  for (let i = 0; i < Math.max(oLines.length, pLines.length); i++) {
    if ((oLines[i] || '') !== (pLines[i] || '')) {
      const oSnip = (oLines[i] || '').slice(0, 100);
      const pSnip = (pLines[i] || '').slice(0, 100);
      if (oSnip || pSnip) changes.push({ line: i + 1, from: oSnip, to: pSnip });
    }
    if (changes.length >= 3) { changes.push({ truncated: true }); break; }
  }
  return changes;
}

function formatReview(record, job) {
  const { id, job_name, failure_mode, generated_at, variants } = record;
  const date = generated_at.slice(0, 10);
  const passing = variants.filter(v => v.eval?.pass);

  let body = `🧬 **Evolution Review** — ${date}\n`;
  body += `**Job:** ${job_name}\n`;
  body += `**Failure mode:** \`${failure_mode}\`\n`;
  body += `**Candidate ID:** \`${id}\`\n`;
  body += `**Variants:** ${variants.length} generated, ${passing.length} pass eval gates\n\n`;

  for (const v of variants) {
    const evalStatus = v.eval?.pass ? '✅ PASS' : v.eval?.skip ? '⏭️ SKIP' : `❌ FAIL: ${v.eval?.reason}`;
    body += `**${v.id}** [${evalStatus}]\n`;
    body += `> ${v.reasoning}\n`;

    if (v.dry_run) {
      const d = v.dry_run;
      const icon = d.verdict === 'pass' ? '🟢' : d.verdict === 'warn' ? '🟡' : '🔴';
      body += `${icon} Dry-run: ${d.verdict} (${d.past_failures_addressed.length}/${d.past_modes_seen} past modes fixed, score ${d.score})`;
      if (d.cross_contamination.length) {
        body += ` — contamination: ${d.cross_contamination.map(c => '`' + c.pattern + '`').join(', ')}`;
      }
      body += '\n';
    }

    if (job?.message) {
      const changes = diffSummary(job.message, v.message);
      if (changes.length > 0 && !changes[0].truncated) {
        body += 'Changes: ';
        body += changes.slice(0, 2)
          .map(c => c.truncated ? '...' : `line ${c.line}: \`${c.from.slice(0, 60)}\` → \`${c.to.slice(0, 60)}\``)
          .join(', ');
        body += '\n';
      }
    }
    body += '\n';
  }

  body += `**To apply:** \`node evolution-review.js --apply-variant ${id} <v1|v2>\`\n`;
  body += `**To skip:** edit data/candidate-variants.json and set status=skipped`;

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

// ── Apply an approved variant ───────────────────────────────────────────────
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

// ── Main ────────────────────────────────────────────────────────────────────
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
  const job = jobsById[record.job_id];
  const message = formatReview(record, job);
  console.log(`\nReview for: ${record.job_name}`);
  deliverReview(message);
  record.status = 'review_posted';
  record.posted_at = new Date().toISOString();
}

fs.writeFileSync(VARIANTS_FILE, JSON.stringify(candidates, null, 2));
console.log('\nHEARTBEAT_OK');

#!/usr/bin/env node
/**
 * skill-create.js — Create a new skill file and refresh the skills index
 *
 * Skills are durable, reusable procedures stored as markdown with YAML
 * frontmatter. This script creates them and keeps INDEX.md in sync with
 * the on-disk set (INDEX.md is always regenerated from disk, preventing
 * drift).
 *
 * Usage:
 *   node skill-create.js --name "Fix Thing" --summary "One-line summary" --body "Procedure steps..."
 *   node skill-create.js --name "Fix Thing" --summary "One-line" < procedure.md
 *
 * Flags:
 *   --source <tag>    where this skill came from (manual, session-summary,
 *                     self-healing, variant-review, etc.). Stored in frontmatter.
 *   --if-missing      skip silently if the skill already exists (else exit 1)
 *   --refresh-index   rebuild INDEX.md from disk without creating a new skill
 *
 * Writes:
 *   memory/skills/<slug>.md          new skill
 *   memory/skills/INDEX.md           auto-regenerated from every file's frontmatter
 *
 * Env overrides:
 *   WORKSPACE_DIR — project root (default: cwd)
 *   SKILLS_DIR    — skills dir (default: memory/skills)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const WORKSPACE  = process.env.WORKSPACE_DIR || process.cwd();
const SKILLS_DIR = process.env.SKILLS_DIR || path.join(WORKSPACE, 'memory', 'skills');
const INDEX_FILE = path.join(SKILLS_DIR, 'INDEX.md');

const VALID_SOURCES = new Set([
  'manual',
  'session-summary',
  'self-healing',
  'discord-triage',
  'variant-review',
  'unknown',
]);

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--name')           args.name         = argv[++i];
    if (argv[i] === '--summary')        args.summary      = argv[++i];
    if (argv[i] === '--body')           args.body         = argv[++i];
    if (argv[i] === '--source')         args.source       = argv[++i];
    if (argv[i] === '--if-missing')     args.ifMissing    = true;
    if (argv[i] === '--refresh-index')  args.refreshIndex = true;
  }
  return args;
}

function readStdin() {
  return new Promise(resolve => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data.trim()));
  });
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const out = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function refreshIndex() {
  if (!fs.existsSync(SKILLS_DIR)) {
    console.log(`${SKILLS_DIR} does not exist — nothing to index`);
    return 0;
  }
  const files = fs.readdirSync(SKILLS_DIR)
    .filter(f => f.endsWith('.md') && f !== 'INDEX.md')
    .sort();

  const entries = [];
  for (const f of files) {
    const content = fs.readFileSync(path.join(SKILLS_DIR, f), 'utf8');
    const fm = parseFrontmatter(content);
    const summary = fm.summary || '(no summary)';
    entries.push(`- \`${f}\` — ${summary}`);
  }

  const header = `# Skills Index

Reusable procedures. Load this file at session start (summaries only);
load the full skill file on-demand when relevant.

Auto-generated from ${path.relative(WORKSPACE, SKILLS_DIR)}/*.md — do not edit by hand.
Run \`node skill-create.js --refresh-index\` to regenerate.

## Skills

`;

  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  fs.writeFileSync(INDEX_FILE, header + entries.join('\n') + '\n');
  console.log(`INDEX.md refreshed — ${entries.length} skill(s) indexed`);
  return entries.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.refreshIndex) {
    refreshIndex();
    console.log('HEARTBEAT_OK');
    return;
  }

  if (!args.name || !args.summary) {
    console.error('Usage: skill-create.js --name "Skill Name" --summary "One-line" [--body "..."] [--source <tag>] [--if-missing]');
    console.error('   or: skill-create.js --refresh-index');
    process.exit(1);
  }

  const source = args.source || 'manual';
  if (!VALID_SOURCES.has(source)) {
    console.error(`--source must be one of: ${[...VALID_SOURCES].join(', ')}`);
    process.exit(1);
  }

  const body = args.body || (await readStdin()) || '## Steps\n\nTODO: document procedure steps here.';
  const slug = slugify(args.name);
  const today = new Date().toISOString().slice(0, 10);
  const skillFile = path.join(SKILLS_DIR, `${slug}.md`);

  if (fs.existsSync(skillFile)) {
    if (args.ifMissing) {
      console.log(`Skill already exists: ${skillFile} — skipping (--if-missing)`);
      refreshIndex();
      console.log('HEARTBEAT_OK');
      return;
    }
    console.error(`Skill already exists: ${skillFile}`);
    console.error('Use --if-missing to skip silently, or delete and re-create.');
    process.exit(1);
  }

  fs.mkdirSync(SKILLS_DIR, { recursive: true });

  const content = `---
name: ${args.name}
summary: ${args.summary}
source: ${source}
created: ${today}
last_used: ${today}
use_count: 1
---

${body}
`;
  fs.writeFileSync(skillFile, content);
  console.log(`Created: ${skillFile} (source: ${source})`);

  refreshIndex();
  console.log('HEARTBEAT_OK');
}

main().catch(e => {
  console.error('skill-create.js error:', e.message);
  process.exit(1);
});

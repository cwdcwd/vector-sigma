#!/usr/bin/env node
// Render each workspace's vitest coverage-summary.json (written by `npm run test:coverage`) as a
// markdown table: to $GITHUB_STEP_SUMMARY in CI, else stdout. The floors live in each vitest.config.ts
// (vitest fails the run below them); a missing summary is an error, because then coverage silently stopped running.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const workspaces = ['shared', 'registrar', 'registrant'];
const rows = [];
for (const ws of workspaces) {
  const p = `${ws}/coverage/coverage-summary.json`;
  if (!existsSync(p)) {
    console.error(`coverage-summary: ${p} missing (did test:coverage run for ${ws}?)`);
    process.exit(1);
  }
  const { total } = JSON.parse(readFileSync(p, 'utf8'));
  const pct = (k) => `${total[k].pct.toFixed(1)}%`;
  rows.push(`| ${ws} | ${pct('lines')} | ${pct('branches')} | ${pct('functions')} | ${pct('statements')} |`);
}
const md = [
  '### Unit test coverage',
  '',
  '| Workspace | Lines | Branches | Functions | Statements |',
  '|---|---|---|---|---|',
  ...rows,
  '',
].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
console.log(md);

#!/usr/bin/env node
import { appendFileSync } from 'node:fs';

export function validatePromotionRun(run, { repository, runId, attempt }) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) throw new Error('workflow run response is not an object');
  if (String(run.id) !== String(runId) || String(run.run_attempt) !== String(attempt)) {
    throw new Error('workflow run ID or attempt does not match the requested promotion');
  }
  if (run.repository?.full_name !== repository) throw new Error('workflow run repository does not match this repository');
  if (run.path !== '.github/workflows/build-images.yml') throw new Error('artifact source is not the build-images workflow');
  if (run.head_branch !== 'main' || !['push', 'workflow_dispatch'].includes(run.event)) {
    throw new Error('promotion run must be a main-branch push or manual dispatch');
  }
  if (run.status !== 'completed' || run.conclusion !== 'success') throw new Error('promotion run did not complete successfully');
  return true;
}

async function main() {
  const { GITHUB_REPOSITORY, GITHUB_TOKEN, PROMOTION_RUN_ID, PROMOTION_RUN_ATTEMPT, GITHUB_OUTPUT } = process.env;
  if (!/^\d+$/.test(PROMOTION_RUN_ID ?? '') || !/^\d+$/.test(PROMOTION_RUN_ATTEMPT ?? '') || !GITHUB_REPOSITORY || !GITHUB_TOKEN) {
    throw new Error('repository, token, numeric run ID, and numeric attempt are required');
  }
  const response = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/runs/${PROMOTION_RUN_ID}/attempts/${PROMOTION_RUN_ATTEMPT}`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${GITHUB_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!response.ok) throw new Error(`GitHub workflow-run verification returned HTTP ${response.status}`);
  validatePromotionRun(await response.json(), {
    repository: GITHUB_REPOSITORY,
    runId: PROMOTION_RUN_ID,
    attempt: PROMOTION_RUN_ATTEMPT,
  });
  appendFileSync(GITHUB_OUTPUT, 'verified=true\n');
  console.log('Verified successful main build-images run and attempt.');
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  main().catch((error) => {
    console.error(`verify-promotion-run: ${error.message}`);
    process.exitCode = 1;
  });
}

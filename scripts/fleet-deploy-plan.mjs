#!/usr/bin/env node
// scripts/fleet-deploy-plan.mjs — dry-run deploy plan for a per-fleet config (fleet-ops-210.1).
//
//   node scripts/fleet-deploy-plan.mjs <fleet.json> --release <balena-release-id> [--source-dir <dir>]
//
// The existing release workflows (release-registrar.yml / release-devices.yml) deploy only to the
// fixed repository variables REGISTRAR_FLEET / DEVICES_FLEET. A new instance's apps listed in
// `balena.fleets` are NOT consumed by those workflows. This planner turns a validated
// `status: deployable` Balena config into the exact balena CLI argv for its own two apps, so an
// operator can run them deliberately. It never executes anything: it prints the commands.
//
// Refusals: non-balena targets, example configs, invalid configs, and any app that is an existing
// production fleet (validateFleetConfig enforces the production list).
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { validateFleetConfig } from './fleet-config.mjs';

const RELEASE = /^[0-9a-f]{32}$/;

/**
 * Pure. Returns { errors, plan }. plan is an array of { label, argv } where argv is the
 * balena CLI invocation (argv[0] is 'balena'); empty when errors is non-empty.
 */
export function planBalenaDeploy(cfg, { release, sourceDir = '.', tag = '<release-tag>' } = {}) {
  const errors = validateFleetConfig(cfg);
  if (cfg && cfg.target !== 'balena') errors.push('$.target: deploy plan applies to a balena target only');
  if (cfg && (cfg.status ?? 'deployable') !== 'deployable') {
    errors.push('$.status: only a "deployable" config may be planned for deployment');
  }
  if (typeof release !== 'string' || !RELEASE.test(release)) {
    errors.push('--release: must be a 32-hex balena release id (the commit printed by the deploy)');
  }
  if (errors.length) return { errors, plan: [] };

  const { registrar, devices } = cfg.balena.fleets;
  const note = `${cfg.fleet_id} ${tag}`;
  const plan = [
    {
      label: `deploy registrar -> ${registrar}`,
      argv: ['balena', 'deploy', registrar, '--source', `${sourceDir}/registrar`,
        '--release-tag', 'git-tag', tag, '--note', note],
    },
    {
      label: `deploy devices -> ${devices}`,
      argv: ['balena', 'deploy', devices, '--source', `${sourceDir}/devices`,
        '--release-tag', 'git-tag', tag, '--note', note],
    },
    { label: `pin registrar ${registrar} -> ${release}`, argv: ['balena', 'fleet', 'pin', registrar, release] },
    { label: `pin devices ${devices} -> ${release}`, argv: ['balena', 'fleet', 'pin', devices, release] },
  ];
  return { errors: [], plan };
}

const shellQuote = (s) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

function main(argv) {
  const files = [];
  let release;
  let sourceDir = '.';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--release') release = argv[++i];
    else if (argv[i] === '--source-dir') sourceDir = argv[++i];
    else files.push(argv[i]);
  }
  if (files.length !== 1) throw new Error('usage: fleet-deploy-plan.mjs <fleet.json> --release <id> [--source-dir <dir>]');
  const cfg = JSON.parse(readFileSync(files[0], 'utf8'));
  const { errors, plan } = planBalenaDeploy(cfg, { release, sourceDir });
  if (errors.length) {
    for (const e of errors) console.error(`${files[0]}: ${e}`);
    process.exitCode = 1;
    return;
  }
  console.log(`# dry-run plan for ${cfg.fleet_id} (nothing executed)`);
  for (const step of plan) console.log(`# ${step.label}\n${step.argv.map(shellQuote).join(' ')}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`fleet-deploy-plan: ${e.message}`); process.exitCode = 1; }
}

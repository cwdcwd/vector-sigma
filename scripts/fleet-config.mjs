#!/usr/bin/env node
// scripts/fleet-config.mjs — validate a per-fleet deployment config (platforms/fleets/).
//
//   node scripts/fleet-config.mjs <fleet.json> [...]   # exit 1 on any error
//
// A fleet config selects ONE target (aws | balena), pins the promoted image
// digests (images.json components, arm64 digests), and names the instance's
// own registrar / database / queue / gateway endpoints. It holds no secrets:
// credential-shaped keys are rejected, because secrets are delivered by the
// platform (Secrets Manager / AgentCore Identity / balena dashboard variables).
//
// status: "example" marks a sample that may use placeholder digests and must
// never be deployed; status: "deployable" (the default) must pin real digests.
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const catalog = JSON.parse(readFileSync(new URL('../images.json', import.meta.url), 'utf8'));
const KNOWN_COMPONENTS = Object.keys(catalog.components);

// Every instance must pin these, whatever its target.
export const REQUIRED_COMPONENTS = ['registrar', 'registrant', 'agent', 'hermes', 'litellm', 'scotty'];

// Existing production balena apps this first cut must never reuse (see platforms/balena/*/README.md).
const PRODUCTION_BALENA_FLEETS = new Set(['g_c_d/vector-sigma-master', 'g_c_d/vector-sigma']);

const FLEET_ID = /^[a-z][a-z0-9-]{1,38}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const PLACEHOLDER = /^sha256:(0+|(.)\2+)$/;
const SECRET_KEY = /(password|passwd|secret|token|api[_-]?key|bootstrap|credential|private)/i;
// last_known_good: the digest set a rollback re-pins to (README "Rollback"). Same shape as images.
const TOP_KEYS = ['$schema', 'fleet_id', 'status', 'target', 'images', 'last_known_good', 'endpoints', 'database', 'aws', 'balena'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isHttps = (v) => {
  try { return typeof v === 'string' && new URL(v).protocol === 'https:'; } catch { return false; }
};

function checkNoSecrets(node, path, errors) {
  if (!isObj(node)) return;
  for (const [k, v] of Object.entries(node)) {
    if (SECRET_KEY.test(k)) errors.push(`${path}.${k}: credential-shaped key is not allowed in a fleet config`);
    checkNoSecrets(v, `${path}.${k}`, errors);
  }
}

function checkImages(images, path, errors, placeholdersOk) {
  if (!isObj(images)) { errors.push(`${path}: must be an object of component -> digest`); return; }
  for (const [component, digest] of Object.entries(images)) {
    if (!KNOWN_COMPONENTS.includes(component)) errors.push(`${path}.${component}: not an images.json component`);
    if (typeof digest !== 'string' || !DIGEST.test(digest)) {
      errors.push(`${path}.${component}: must be a pinned sha256 digest (no tags, no floating refs)`);
    } else if (!placeholdersOk && PLACEHOLDER.test(digest)) {
      errors.push(`${path}.${component}: placeholder digest; deployable configs need a promoted digest`);
    }
  }
  for (const c of REQUIRED_COMPONENTS) if (!(c in images)) errors.push(`${path}: missing required component "${c}"`);
}

/** Returns error strings; empty means valid. Pure: no I/O. */
export function validateFleetConfig(cfg) {
  const errors = [];
  if (!isObj(cfg)) return ['config must be a JSON object'];
  checkNoSecrets(cfg, '$', errors);
  for (const k of Object.keys(cfg)) if (!TOP_KEYS.includes(k)) errors.push(`$.${k}: unknown key`);

  if (typeof cfg.fleet_id !== 'string' || !FLEET_ID.test(cfg.fleet_id)) {
    errors.push('$.fleet_id: must match ^[a-z][a-z0-9-]{1,38}$');
  }
  const status = cfg.status ?? 'deployable';
  if (!['example', 'deployable'].includes(status)) errors.push('$.status: must be "example" or "deployable"');
  const isExample = status === 'example';

  const { target } = cfg;
  if (target !== 'aws' && target !== 'balena') errors.push('$.target: must be "aws" or "balena"');

  checkImages(cfg.images, '$.images', errors, isExample);
  if (cfg.last_known_good !== undefined) {
    checkImages(cfg.last_known_good, '$.last_known_good', errors, isExample);
  }

  const ep = cfg.endpoints;
  if (!isObj(ep)) {
    errors.push('$.endpoints: required object');
  } else {
    for (const k of ['registrar_url', 'gateway_url', 'queue_url']) {
      if (!isHttps(ep[k])) errors.push(`$.endpoints.${k}: must be an https URL unique to this instance`);
    }
    if (ep.registrar_url && ep.registrar_url === ep.gateway_url) errors.push('$.endpoints: registrar_url and gateway_url must differ');
  }

  const db = cfg.database;
  if (target === 'aws') {
    if (!isObj(db) || db.kind !== 'rds-postgres' || typeof db.endpoint !== 'string' || !/^[a-z0-9.-]+\.rds\.amazonaws\.com$/.test(db.endpoint)) {
      errors.push('$.database: aws target needs {"kind":"rds-postgres","endpoint":"<host>.rds.amazonaws.com"}');
    }
    if (cfg.balena !== undefined) errors.push('$.balena: not allowed for an aws target');
    const a = cfg.aws;
    if (!isObj(a)) {
      errors.push('$.aws: required for an aws target');
    } else {
      if (typeof a.account !== 'string' || !/^\d{12}$/.test(a.account)) errors.push('$.aws.account: must be a 12-digit account id');
      if (typeof a.region !== 'string' || !/^[a-z]{2}(-[a-z]+)+-\d$/.test(a.region)) errors.push('$.aws.region: must look like us-east-1');
      if (typeof a.agentcore_runtime !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/.test(a.agentcore_runtime)) {
        errors.push('$.aws.agentcore_runtime: must match ^[a-zA-Z][a-zA-Z0-9_]{0,47}$');
      }
      if (typeof a.ecs_cluster !== 'string' || !/^[a-zA-Z0-9_-]{1,255}$/.test(a.ecs_cluster)) errors.push('$.aws.ecs_cluster: invalid name');
    }
  } else if (target === 'balena') {
    if (!isObj(db) || db.kind !== 'container') errors.push('$.database: balena target needs {"kind":"container"}');
    if (cfg.aws !== undefined) errors.push('$.aws: not allowed for a balena target');
    const b = cfg.balena;
    if (!isObj(b) || !isObj(b.fleets)) {
      errors.push('$.balena.fleets: required {"registrar": "<org>/<app>", "devices": "<org>/<app>"}');
    } else {
      for (const k of ['registrar', 'devices']) {
        const name = b.fleets[k];
        if (typeof name !== 'string' || !/^[A-Za-z0-9_]+\/[A-Za-z0-9_-]+$/.test(name)) {
          errors.push(`$.balena.fleets.${k}: must be "<org>/<app>"`);
        } else if (PRODUCTION_BALENA_FLEETS.has(name)) {
          errors.push(`$.balena.fleets.${k}: "${name}" is an existing production fleet; a new instance needs its own app`);
        }
      }
      if (b.fleets.registrar && b.fleets.registrar === b.fleets.devices) errors.push('$.balena.fleets: registrar and devices must differ');
    }
  }
  return errors;
}

function main(argv) {
  if (argv.length === 0) throw new Error('usage: fleet-config.mjs <fleet.json> [...]');
  let bad = 0;
  for (const file of argv) {
    let cfg;
    try { cfg = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { console.error(`${file}: ${e.message}`); bad++; continue; }
    const errs = validateFleetConfig(cfg);
    if (errs.length) {
      bad++;
      for (const e of errs) console.error(`${file}: ${e}`);
    } else {
      const note = (cfg.status ?? 'deployable') === 'example' ? ' [example: not deployable]' : '';
      console.log(`${file}: ok (${cfg.target}, ${cfg.fleet_id})${note}`);
    }
  }
  if (bad) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`fleet-config: ${e.message}`); process.exitCode = 1; }
}

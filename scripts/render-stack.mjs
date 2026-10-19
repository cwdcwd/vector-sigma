#!/usr/bin/env node
// scripts/render-stack.mjs — render the platform-neutral stack definition
// (stack/<name>.yaml) into each platform's compose file.
//
//   node scripts/render-stack.mjs           # write every target
//   node scripts/render-stack.mjs --check   # exit 1 if a committed target is stale
//
// The spec is a compose-shaped document. Each service may carry:
//   x-component: <images.json component>  the image: compose pulls the
//       promoted GHCR image by commit SHA; balena gets the catalog's build
//       block (render-release-compose.mjs pins it to a digest at release).
//   x-secrets: { ENV_KEY: VAR | { var, hint } }  values the platform
//       delivers: compose interpolates fail-closed ${VAR:?}; balena omits
//       them (balenaCloud dashboard variables).
//   x-platforms: [compose, balena]  where the service runs (default: all).
//   x-compose: / x-balena:  per-platform overrides, deep-merged into the
//       service; a null value deletes the key.
// The same x-<platform> blocks at the top level merge into the document.
// Comments in the spec are carried into the rendered files, so the
// rationale for a setting stays next to it.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Document, isMap, isScalar, isSeq, parseDocument, Pair, Scalar, YAMLMap, YAMLSeq } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = 'ghcr.io/cwdcwd/vector-sigma';

// Platform semantics live here, not in the spec.
const PLATFORMS = {
  compose: {
    restart: 'unless-stopped',
    image: (c) => `\${VS_IMAGE_REGISTRY:-${REGISTRY}}/${c}:\${VS_IMAGE_TAG:?set in platforms/compose/.env — the commit SHA of a published build}`,
    secret: (v, hint) => `\${${v}:?set in platforms/compose/.env${hint ? ` — ${hint}` : ''}}`,
  },
  balena: {
    // The supervisor speaks compose v2.4: no ${VAR} substitution (secrets
    // are dashboard variables), no depends_on conditions.
    restart: 'always',
    stopSignal: 'SIGTERM',
    shortDependsOn: true,
    buildContext: '../../..',
  },
};

const STACKS = [
  {
    spec: 'stack/registrar.yaml',
    targets: { compose: 'platforms/compose/compose.yaml', balena: 'platforms/balena/registrar/docker-compose.yml' },
  },
];

const catalog = JSON.parse(readFileSync(path.join(repoRoot, 'images.json'), 'utf8'));
const X_KEYS = ['x-component', 'x-secrets', 'x-platforms', ...Object.keys(PLATFORMS).map((p) => `x-${p}`)];

const keyOf = (pair) => (isScalar(pair.key) ? pair.key.value : pair.key);
const getPair = (map, key) => map.items.find((p) => keyOf(p) === key);
const isNull = (node) => node == null || (isScalar(node) && node.value === null);

function clone(node) {
  return node && typeof node.clone === 'function' ? node.clone() : node;
}

function setPair(map, key, value, commentBefore) {
  const existing = getPair(map, key);
  if (existing) {
    existing.value = typeof value === 'string' ? new Scalar(value) : value;
    return existing;
  }
  const k = new Scalar(key);
  if (commentBefore) k.commentBefore = commentBefore;
  const pair = new Pair(k, typeof value === 'string' ? new Scalar(value) : value);
  map.items.push(pair);
  return pair;
}

/**
 * Deep-merge override map `over` into `base` (both YAMLMap). A null value
 * deletes an existing key; on a key the base lacks it is an ordinary null
 * (how compose declares a volume with default options).
 */
function merge(base, over) {
  // YAML attaches a comment above a map's first key to the map itself;
  // move it onto that key so an override replaces it like any other.
  for (const m of [base, over]) {
    if (m.commentBefore && m.items[0] && !m.items[0].key.commentBefore) {
      m.items[0].key.commentBefore = m.commentBefore;
      m.commentBefore = undefined;
    }
  }
  for (const pair of over.items) {
    const key = keyOf(pair);
    const target = getPair(base, key);
    if (isNull(pair.value) && target) {
      base.items.splice(base.items.indexOf(target), 1);
      continue;
    }
    if (target && isMap(target.value) && isMap(pair.value)) {
      merge(target.value, pair.value);
      if (pair.key.commentBefore) target.key.commentBefore = pair.key.commentBefore;
    } else if (target) {
      target.value = clone(pair.value);
      if (pair.key.commentBefore) target.key.commentBefore = pair.key.commentBefore;
    } else {
      base.items.push(clone(pair));
    }
  }
}

function strip(map) {
  map.items = map.items.filter((p) => !X_KEYS.includes(keyOf(p)));
}

function renderService(name, svc, platform) {
  const cfg = PLATFORMS[platform];
  const out = clone(svc);
  const component = out.get('x-component');
  const secrets = getPair(out, 'x-secrets')?.value;
  const override = getPair(out, `x-${platform}`)?.value;
  strip(out);

  if (component) {
    const entry = catalog.components[component];
    if (!entry) throw new Error(`${name}: x-component '${component}' is not in images.json`);
    let value;
    if (cfg.buildContext) {
      value = new YAMLMap();
      setPair(value, 'context', cfg.buildContext);
      setPair(value, 'dockerfile', entry.dockerfile);
      setPair(out, 'build', value);
    } else {
      setPair(out, 'image', cfg.image(component));
    }
    // Keep image/build first, where a reader looks for it.
    const pair = getPair(out, cfg.buildContext ? 'build' : 'image');
    out.items.splice(out.items.indexOf(pair), 1);
    out.items.unshift(pair);
  }

  if (secrets && cfg.secret) {
    let env = out.get('environment', true);
    if (!env) env = setPair(out, 'environment', new YAMLMap()).value;
    for (const pair of secrets.items) {
      const v = pair.value;
      const varName = isScalar(v) ? v.value : v.get('var');
      const hint = isScalar(v) ? undefined : v.get('hint');
      setPair(env, keyOf(pair), cfg.secret(varName, hint), pair.key.commentBefore);
    }
  }

  if (override) merge(out, override);

  if (cfg.shortDependsOn) {
    const dep = getPair(out, 'depends_on');
    if (dep && isMap(dep.value)) {
      const seq = new YAMLSeq();
      for (const p of dep.value.items) seq.items.push(new Scalar(keyOf(p)));
      dep.value = seq;
    }
  }
  if (!getPair(out, 'restart')) setPair(out, 'restart', cfg.restart);
  if (cfg.stopSignal && !getPair(out, 'stop_signal')) {
    // stop_signal sits just before restart, the order the hand-written files used.
    const restart = getPair(out, 'restart');
    out.items.splice(out.items.indexOf(restart), 0, new Pair(new Scalar('stop_signal'), cfg.stopSignal));
  }
  const env = out.get('environment', true);
  if (env && env.items.length === 0) out.delete('environment');
  return out;
}

export function renderStack(specText, platform, specPath = 'stack/<name>.yaml') {
  const spec = parseDocument(specText);
  if (spec.errors.length) throw spec.errors[0];
  const root = spec.contents;
  const doc = new Document();
  const out = new YAMLMap();

  const top = getPair(root, `x-${platform}`)?.value;
  // A rendered file's header is the comment above its x-<platform> key,
  // after the spec's own 'Header of the rendered ... file:' label (YAML
  // attaches the spec's file header to the first key, so cut at the label).
  const cb = getPair(root, `x-${platform}`)?.key.commentBefore ?? '';
  const header = cb.match(/Header of the rendered [^\n]*:\n([\s\S]*)$/)?.[1] ?? '';
  for (const pair of root.items) {
    const key = keyOf(pair);
    if (X_KEYS.includes(key)) continue;
    if (key === 'services') {
      const services = new YAMLMap();
      for (const sp of pair.value.items) {
        const name = keyOf(sp);
        const only = sp.value.get('x-platforms');
        if (only && !only.items.some((s) => s.value === platform)) continue;
        const rendered = new Pair(clone(sp.key), renderService(name, sp.value, platform));
        services.items.push(rendered);
      }
      out.items.push(new Pair(clone(pair.key), services));
    } else {
      out.items.push(clone(pair));
    }
  }
  if (top) {
    // Top-level scalars (e.g. balena's `version`) lead the document.
    const lead = top.items.filter((p) => !isMap(p.value) && !isSeq(p.value));
    merge(out, top);
    for (const p of lead) {
      const at = getPair(out, keyOf(p));
      out.items.splice(out.items.indexOf(at), 1);
      out.items.unshift(at);
    }
  }
  doc.contents = out;
  const banner =
    ` GENERATED by scripts/render-stack.mjs from ${specPath} — do not edit.\n` +
    ` Change the spec, then run: node scripts/render-stack.mjs\n`;
  doc.commentBefore = banner + (header ? `\n${header}` : '');
  return doc.toString({ lineWidth: 0, indentSeq: true, flowCollectionPadding: false });
}

function main() {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const { spec, targets } of STACKS) {
    const text = readFileSync(path.join(repoRoot, spec), 'utf8');
    for (const [platform, target] of Object.entries(targets)) {
      const rendered = renderStack(text, platform, spec);
      const abs = path.join(repoRoot, target);
      const current = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
      if (current === rendered) continue;
      if (check) {
        console.error(`render-stack: ${target} is stale — run: node scripts/render-stack.mjs`);
        stale++;
      } else {
        writeFileSync(abs, rendered);
        console.log(`render-stack: wrote ${target}`);
      }
    }
  }
  if (stale) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

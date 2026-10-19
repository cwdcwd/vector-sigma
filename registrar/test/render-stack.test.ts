import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { renderStack } from '../../scripts/render-stack.mjs';

/**
 * stack/registrar.yaml is the one definition of the registrar stack; the
 * plain-compose and balena files are rendered from it. These tests keep the
 * rendered files in lockstep with the spec and pin the renderer's
 * platform rules.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');
const spec = read('stack/registrar.yaml');

type Svc = Record<string, unknown> & { environment?: Record<string, string>; depends_on?: unknown };
const services = (text: string) => (parse(text) as { services: Record<string, Svc> }).services;

describe('render-stack: committed files match the spec', () => {
  it.each([
    ['compose', 'platforms/compose/compose.yaml'],
    ['balena', 'platforms/balena/registrar/docker-compose.yml'],
  ])('%s -> %s is up to date (run: node scripts/render-stack.mjs)', (platform, rel) => {
    expect(read(rel)).toBe(renderStack(spec, platform, 'stack/registrar.yaml'));
  });
});

describe('render-stack: platform rules', () => {
  const compose = services(renderStack(spec, 'compose'));
  const balena = services(renderStack(spec, 'balena'));

  it('x-component: compose pulls the SHA-pinned GHCR image; balena gets the catalog build block', () => {
    expect(compose.registrar.image).toMatch(/\/registrar:\$\{VS_IMAGE_TAG:\?/);
    expect(compose.registrar.build).toBeUndefined();
    expect(balena.registrar.build).toEqual({ context: '../../..', dockerfile: 'registrar/Dockerfile' });
    expect(balena.registrar.image).toBeUndefined();
  });

  it('x-secrets: fail-closed interpolation on compose, absent on balena (dashboard variables)', () => {
    expect(compose.dolt.environment?.DOLT_PASSWORD).toBe('${DOLT_PASSWORD:?set in platforms/compose/.env}');
    expect(balena.dolt.environment).not.toHaveProperty('DOLT_PASSWORD');
    for (const [name, svc] of Object.entries(balena)) {
      for (const v of Object.values(svc.environment ?? {})) expect(String(v), name).not.toMatch(/\$\{/);
    }
  });

  it('x-platforms: the serve edge runs on balena only', () => {
    expect(balena).toHaveProperty('tailscale');
    expect(compose).not.toHaveProperty('tailscale');
  });

  it('balena gets short-form depends_on (the supervisor has no conditions); compose keeps them', () => {
    expect(balena.hermes.depends_on).toEqual(['registrant-own']);
    expect(compose.hermes.depends_on).toEqual({ 'registrant-own': { condition: 'service_healthy' } });
  });

  it('no spec-only x- key leaks into a rendered file', () => {
    for (const out of [renderStack(spec, 'compose'), renderStack(spec, 'balena')]) {
      expect(out).not.toMatch(/^\s*x-[a-z]+:/m);
    }
  });
});

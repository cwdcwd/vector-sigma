import { describe, expect, it, afterAll } from 'vitest';
import { createTestEnv, seedAdminKey, seedDevice, type TestEnv } from './helpers.js';

/**
 * AC7b dry-run (fleet-ops-zbq.2): the persona-picker e2e assertions from
 * deploy/e2e.sh, executed against a REAL served editor page over HTTP
 * (socket + cookies + CSRF), on the same app instance the e2e compose
 * stack builds. CI's compose job still runs the full stack; this proves
 * the AC's assertion logic and the page render without docker.
 */
let env: TestEnv;

const BUNDLE = {
  schema_version: 1 as const,
  bundle_version: 1,
  generated_at: '2026-01-01T00:00:00Z',
  files: [
    { path: 'config/agent.env', mode: '0600' as const, content: 'AGENT_NAME=old\nGATEWAY_API_KEY=old-key\n' },
    { path: 'config/secrets.env', mode: '0600' as const, content: 'SLACK_BOT_TOKEN=old-token\n' },
  ],
};

afterAll(async () => {
  if (env?.app) await env.app.close();
});

describe('AC7b dry-run: persona picker over real HTTP (zbq.2)', () => {
  it('serves the editor page with the advisory picker and a valid data island', async () => {
    env = await createTestEnv({ hashParams: { memoryCostKiB: 256, timeCost: 1 } });
    const ADMIN_KEY = 'ak_dryrun-persona-key-01';
    await seedAdminKey(env.db, ADMIN_KEY);
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: BUNDLE });

    const port = 4599;
    await env.app.listen({ port, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${port}`;

    // Login with explicit cookie handling (mirrors tls_curl in e2e.sh).
    const loginPage = await fetch(`${base}/admin/login`);
    const setCookie = loginPage.headers.get('set-cookie') ?? '';
    const csrfCookie = setCookie.split(';')[0];
    const csrfToken = csrfCookie.split('=')[1] ?? '';
    const login = await fetch(`${base}/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: csrfCookie },
      body: new URLSearchParams({ admin_key: ADMIN_KEY, _csrf: csrfToken }).toString(),
      redirect: 'manual',
    });
    expect(login.status).toBe(303);
    const sessionCookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    expect(sessionCookie).toContain('vsigma_admin=');

    const editorRes = await fetch(`${base}/admin/devices/${env.device.uuid}/bundle`, {
      headers: { cookie: `${csrfCookie}; ${sessionCookie}` },
    });
    expect(editorRes.status).toBe(200);
    const html = await editorRes.text();

    // AC7b check 1: advisory copy + unnamed select (never submits)
    expect(html).toContain('Persona pre-fill (advisory)');
    expect(html).toContain('<select id="persona-select">');
    expect(html).not.toMatch(/<select[^>]*\sname=/);

    // AC7b check 2: option coverage — all six library personas
    for (const slug of ['alpha-trion', 'bumblebee', 'grimlock', 'optimus-prime', 'ultra-magnus', 'wheeljack']) {
      expect(html).toContain(`<option value="${slug}">`);
    }

    // AC7b check 3: island parses, non-secret, fleet-agnostic, byte-matches personas/
    const m = html.match(/<script type="application\/json" id="persona-library-data">([\s\S]*?)<\/script>/);
    expect(m).not.toBeNull();
    const island = m![1];
    expect(island.includes('<')).toBe(false);
    const lib = JSON.parse(island) as Array<{ slug: string; soul_contents: string }>;
    expect(lib.map((p) => p.slug).sort()).toEqual(
      ['alpha-trion', 'bumblebee', 'grimlock', 'optimus-prime', 'ultra-magnus', 'wheeljack'].sort(),
    );
    for (const marker of ['sk-', 'xoxb-', 'BEGIN RSA PRIVATE KEY', 'GATEWAY_API_KEY=']) {
      expect(island).not.toContain(marker);
    }
    expect(/doombot|ultronbot|kangbot|thanosbot|lazybaer/i.test(island)).toBe(false);
    const { readFileSync } = await import('node:fs');
    const soul = lib.find((p) => p.slug === 'optimus-prime')!.soul_contents;
    const disk = readFileSync(new URL('../../personas/optimus-prime/SOUL.md', import.meta.url), 'utf8');
    expect(soul).toBe(disk);

    // CSP must keep allowing the page (island is a data block, not executable)
    const csp = editorRes.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self'");
  });
});
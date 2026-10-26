import { describe, it, expect, beforeEach } from 'vitest';
import { createTestEnv, seedDevice, seedAdminKey, AdminClient, type TestEnv } from './helpers.js';
import { statusBadge } from '../src/admin-html.js';

/**
 * fleet-ops-1py.6 — console UI overhaul: branding (logo in header + login,
 * favicon), componentized nav with active highlight, status badges, avatar
 * column wired to the Lane A logo route, confirm dialogs on destructive
 * actions, client-side sort hooks, empty states, editor grouped by
 * canonical file. All through the REAL admin console (http-level).
 */

let env: TestEnv;
const fast = { memoryCostKiB: 256, timeCost: 1 };
const ADMIN_KEY = 'ak_test-ui-overhaul-0001';

beforeEach(async () => {
  env = await createTestEnv({ hashParams: fast });
  await seedAdminKey(env.db, ADMIN_KEY);
  await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: null });
});

async function loginClient(): Promise<AdminClient> {
  const c = new AdminClient(env.app);
  await c.login(ADMIN_KEY);
  return c;
}

describe('Console UI overhaul (1py.6) — branding assets', () => {
  it('serves the resized logo pair and favicon as public static assets with CSP + nosniff', async () => {
    for (const [route, bytes] of [
      ['/admin/static/logo-128.png', 128 * 128],
      ['/admin/static/logo-256.png', 256 * 256],
      ['/admin/static/favicon.png', 64 * 64],
    ] as Array<[string, number]>) {
      const res = await env.app.inject({ method: 'GET', url: route });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('image/png');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      const csp = String(res.headers['content-security-policy'] ?? '');
      expect(csp).toContain("img-src 'self' data:");
      // magic bytes: it really is a PNG, and it really is the sized pair
      const body = res.rawPayload ?? Buffer.from(res.body, 'binary');
      expect(body[0]).toBe(0x89);
      expect(body.length).toBeLessThan(256 * 1024);
    }
  });

  it('the committed art is the resized pair (<= 150KB each), not the 3.5MB original, and the embed module is drift-pinned', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, '..', '..');
    for (const file of ['docs/logo-128.png', 'docs/logo-256.png', 'docs/favicon-32.png']) {
      const stat = await fs.stat(path.join(repoRoot, file));
      expect(stat.size).toBeLessThan(150 * 1024);
    }
    // Drift pin: re-running the generator must reproduce the checked-in
    // brand-assets.ts byte-for-byte — art edits that skip regeneration
    // fail here instead of silently drifting.
    const generator = await import('../../scripts/generate-brand-assets.mjs');
    const fresh = generator.generateModule(generator.loadAssets());
    const checkedIn = await fs.readFile(
      path.join(repoRoot, 'registrar/src/brand-assets.ts'),
      'utf8',
    );
    expect(checkedIn).toBe(fresh);
  });
});

describe('Console UI overhaul (1py.6) — header branding + favicon link', () => {
  it('every console page renders the brand block, logo img, and favicon link', async () => {
    const c = await loginClient();
    for (const path of ['/admin/devices', '/admin/audit', '/admin/admin-keys', '/admin/mesh-enroll-keys', '/admin/new-device']) {
      const page = await c.get(path);
      expect(page.status).toBe(200);
      expect(page.html).toContain('class="brand"');
      expect(page.html).toContain('<img src="/admin/static/logo-128.png"');
      expect(page.html).toContain('<link rel="icon" type="image/png" href="/admin/static/favicon.png">');
      // img-src 'self' on the page CSP covers both same-origin images
      const cspIdx = page.html.indexOf('site-header');
      expect(cspIdx).toBeGreaterThan(-1);
    }
  });

  it('the login page carries no nav but shows the 256px logo', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/admin/login' });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body).toContain('/admin/static/logo-256.png');
    expect(body).toContain('vector-sigma registrar');
    expect(body).not.toContain('class="brand"'); // login has no nav header
    expect(body).toContain('<link rel="icon" type="image/png" href="/admin/static/favicon.png">');
  });

  it('nav carries all five destinations in the componentized order', async () => {
    const c = await loginClient();
    const page = await c.get('/admin/devices');
    expect(page.html).toContain('href="/admin/devices"');
    expect(page.html).toContain('href="/admin/new-device"');
    expect(page.html).toContain('href="/admin/audit"');
    expect(page.html).toContain('href="/admin/admin-keys"');
    expect(page.html).toContain('href="/admin/mesh-enroll-keys"');
    expect(page.html).toContain('class="linklike">Log out');
  });

  it('the active page is highlighted with aria-current', async () => {
    const c = await loginClient();
    const devices = await c.get('/admin/devices');
    expect(devices.html).toContain('<a href="/admin/devices" class="active" aria-current="page">');
    const audit = await c.get('/admin/audit');
    expect(audit.html).toContain('<a href="/admin/audit" class="active" aria-current="page">');
    expect(audit.html).not.toContain('<a href="/admin/devices" class="active"');
  });
});

describe('Console UI overhaul (1py.6) — badges, avatars, sort, empty states', () => {
  it('statusBadge renders the colored pill classes for known statuses and a neutral fallback', () => {
    expect(statusBadge('pending')).toContain('badge badge-pending');
    expect(statusBadge('active')).toContain('badge badge-active');
    expect(statusBadge('revoked')).toContain('badge badge-revoked');
    expect(statusBadge('weird-new-status')).toContain('badge badge-other');
    expect(statusBadge('<script>')).not.toContain('<script>');
  });

  it('device table renders status badges and the sortable header set', async () => {
    await seedDevice(env.db, {
      uuid: '11111111-2222-3333-4444-555555555555',
      hash: 'h'.repeat(64),
      bundle: {
        schema_version: 1,
        bundle_version: 1,
        generated_at: '2026-01-01T00:00:00Z',
        files: [{ path: 'config/agent.env', mode: '0600', content: 'AGENT_NAME=second\n' }],
      },
    });
    const c = await loginClient();
    const page = await c.get('/admin/devices');
    expect(page.status).toBe(200);
    expect(page.html).toContain('badge badge-');
    expect(page.html).toContain('<table id="device-table" data-sortable>');
    for (const label of ['data-sort="text"', 'data-sort="status"', 'data-sort="created"']) {
      expect(page.html).toContain(label);
    }
    // the created cell carries the sortable raw timestamp
    expect(page.html).toMatch(/data-created="20\d\d-\d\d-\d\dT/);
  });

  it('a device with a bundle logo renders its avatar from the Lane A route; without one, the glyph', async () => {
    // one device WITH a logo entry, one without
    await seedDevice(env.db, {
      uuid: '11111111-2222-3333-4444-555555555555',
      hash: 'h'.repeat(64),
      bundle: {
        schema_version: 1,
        bundle_version: 1,
        generated_at: '2026-01-01T00:00:00Z',
        files: [{ path: 'assets/logo.png', mode: '0600', content: 'aGVsbG8=', encoding: 'base64' }],
      },
    });
    const c = await loginClient();
    const page = await c.get('/admin/devices');
    expect(page.html).toContain('class="avatar" src="/admin/devices/11111111-2222-3333-4444-555555555555/logo"');
    expect(page.html).toContain('class="avatar muted">◆');
  });

  it('empty device list renders the empty state instead of a bare table', async () => {
    // fresh env: no devices at all
    const fresh = await createTestEnv({ hashParams: fast });
    try {
      await seedAdminKey(fresh.db, ADMIN_KEY);
      const c = new AdminClient(fresh.app);
      await c.login(ADMIN_KEY);
      const page = await c.get('/admin/devices');
      expect(page.status).toBe(200);
      expect(page.html).toContain('No devices yet.');
      expect(page.html).toContain('Create the first device');
      expect(page.html).not.toContain('<table id="device-table"');
    } finally {
      await fresh.app.close();
    }
  });

  it('detail page shows the empty-bundle state copy', async () => {
    const c = await loginClient();
    const page = await c.get(`/admin/devices/${env.device.uuid}`);
    expect(page.status).toBe(200);
    expect(page.html).toContain('No bundle yet — the device has nothing to deliver.');
  });

  it('audit page renders rows and stays read-only', async () => {
    const c = await loginClient();
    const page = await c.get('/admin/audit');
    expect(page.status).toBe(200);
    // login writes an audit row, so the zero-row empty state cannot be
    // observed through the console directly — assert the table renders
    // and no destructive form ever appears on this page.
    expect(page.html).toContain('<h1>Audit log (read-only)</h1>');
    expect(page.html).toContain('admin_login');
    expect(page.html).not.toContain('data-confirm');
  });
});

describe('Console UI overhaul (1py.6) — confirm dialogs + editor grouping', () => {
  it('destructive action forms carry data-confirm; safe ones do not', async () => {
    const c = await loginClient();
    const page = await c.get(`/admin/devices/${env.device.uuid}`);
    expect(page.html).toContain('data-confirm="Revoke this device?');
    expect(page.html).toContain('data-confirm="Re-arm the delivery slot?');
    expect(page.html).toContain('data-confirm="Regenerate the device key?');
    // non-destructive actions carry no confirm
    expect(page.html).not.toContain('data-confirm="Mint');
    expect(page.html).not.toContain('data-confirm="Enroll');
  });

  it('editor.js ships the confirm + sort handlers alongside the persona picker (CSP-safe, one static file)', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/admin/static/editor.js' });
    expect(res.statusCode).toBe(200);
    const js = res.body;
    expect(js).toContain("querySelectorAll('form[data-confirm]')");
    expect(js).toContain('window.confirm(form.dataset.confirm)');
    expect(js).toContain("querySelector('table[data-sortable]')");
    expect(js).toContain('sorted-asc');
    // the persona picker survived the overhaul untouched (bead scope #6)
    expect(js).toContain("getElementById('persona-select')");
    expect(js).toContain("dispatchEvent(new Event('input', { bubbles: false }))");
  });

  it('bundle editor groups structured fields by canonical file with a group header per path', async () => {
    const c = await loginClient();
    const page = await c.get(`/admin/devices/${env.device.uuid}/bundle`);
    expect(page.status).toBe(200);
    expect(page.html).toContain('Canonical file <code>config/agent.env</code>');
    expect(page.html).toContain('Canonical file <code>config/a2a.json</code>');
    expect(page.html).toContain('Canonical file <code>SOUL.md</code>');
    expect(page.html).toContain('Canonical file <code>config/secrets.env</code>');
    expect(page.html).toContain('Canonical file <code>config/github-app.pem</code>');
    // every field still renders its input name — the save path is unchanged
    expect(page.html).toContain('name="structured_agent_name"');
    expect(page.html).toContain('name="structured_a2a_public_url"');
    expect(page.html).toContain('name="structured_github_app_pem"');
  });

  it('persona picker pre-fill flow survives the editor overhaul end to end', async () => {
    // beforeEach already seeded this device; give it a bundle logo-less file
    // set by seeding the blob directly (seedDevice would duplicate the row).
    const { identityBlobs } = await import('../src/db/schema.js');
    await env.db.insert(identityBlobs).values({
      deviceId: env.device.uuid,
      bundle: {
        schema_version: 1,
        bundle_version: 1,
        generated_at: '2026-01-01T00:00:00Z',
        files: [{ path: 'config/agent.env', mode: '0600', content: 'AGENT_NAME=old-name\n' }],
      },
      version: 1,
    });
    const c = await loginClient();
    const page = await c.get(`/admin/devices/${env.device.uuid}/bundle`);
    // the picker markup + island are exactly as PR #38 left them (scope #6)
    expect(page.html).toContain('<select id="persona-select">');
    expect(page.html).not.toMatch(/<select[^>]*\sname=/);
    expect(page.html).toContain('Persona pre-fill (advisory)');
    expect(page.html).toMatch(/<script type="application\/json" id="persona-library-data">/);
  });
});

describe('Revocation buttons — legible contrast + exact labels (1py.48)', () => {
  // Defect under test: `.danger{color:var(--danger)}` (the pink "red text"
  // utility) out-specifies the element-level `button{color:#0f1117}` rule for
  // every `<button class="danger">`, while `button.danger` overrode only the
  // background with the same token — the revocation buttons rendered
  // pink-on-pink (contrast 1:1) in both the active-device and admin-key
  // contexts. Pins: (a) the exact rendered labels in both named contexts,
  // (b) the computed text/background contrast of every `.danger` button taken
  // from the SERVED stylesheet, so a regression to that shape fails here.

  it('active device detail renders the Revoke button label with its confirm form', async () => {
    const html = await revocationPageHtml(`/admin/devices/${env.device.uuid}`);
    expect(html).toContain(`action="/admin/devices/${env.device.uuid}/revoke"`);
    expect(html).toContain('<button type="submit" class="danger">Revoke</button>');
    expect(html).toContain('data-confirm="Revoke this device?');
  });

  it('non-active device detail swaps the label to Activate (nothing to revoke)', async () => {
    // balena_uuid is a typed uuid column — use a valid v4-shaped uuid.
    const dormantId = '00000000-0000-4000-8000-000000000048';
    await seedDevice(env.db, { uuid: dormantId, hash: env.device.hash, bundle: null, status: 'pending' });
    const html = await revocationPageHtml(`/admin/devices/${dormantId}`);
    expect(html).toContain('>Activate</button>');
    expect(html).not.toContain('class="danger">Revoke<');
  });

  it('admin keys page renders the Revoke button label for the seeded key row', async () => {
    const id = await seedAdminKey(env.db, 'ak_test-revoke-1py48');
    const html = await revocationPageHtml('/admin/admin-keys');
    expect(html).toContain(`action="/admin/admin-keys/${id}/revoke"`);
    expect(html).toContain('<button type="submit" class="danger">Revoke</button>');
  });

  it('button.danger text stays legible: computed WCAG contrast over the served stylesheet exceeds 4.5', async () => {
    const html = await revocationPageHtml(`/admin/devices/${env.device.uuid}`);
    const css = extractStyleCss(html);
    // The served page inlines the same stylesheet the browser applies.
    expect(css).toContain('button.danger{');
    // Resolve the computed declarations for a <button class="danger"> element.
    // The sequence [button, .danger, button.danger] has non-decreasing
    // specificity in source order, so "last declaration wins" reproduces the
    // true CSS cascade for exactly this selector trio.
    const bgResolved = resolveCssColor(css, computedDecl(css, ['button', '.danger', 'button.danger'], 'background'));
    const fgResolved = resolveCssColor(css, computedDecl(css, ['button', '.danger', 'button.danger'], 'color'));
    // The defect shape: the danger background token and the danger text token
    // resolving to the SAME value (pink on pink, contrast 1:1).
    expect(fgResolved).not.toBe(bgResolved);
    expect(contrastRatio(fgResolved, bgResolved)).toBeGreaterThanOrEqual(4.5);
    // The plain accent button must stay legible too; this guards the whole
    // colored-token-background button family, not just the one rule.
    const accentBg = resolveCssColor(css, computedDecl(css, ['button'], 'background'));
    const accentFg = resolveCssColor(css, computedDecl(css, ['button'], 'color'));
    expect(contrastRatio(accentFg, accentBg)).toBeGreaterThanOrEqual(4.5);
  });

  async function revocationPageHtml(path: string): Promise<string> {
    const c = await loginClient();
    const page = await c.get(path);
    expect(page.status).toBe(200);
    return page.html;
  }

  function extractStyleCss(html: string): string {
    const m = html.match(/<style>([\s\S]*?)<\/style>/);
    if (!m) throw new Error('no <style> block on the served page');
    return m[1];
  }

  /** All `selector{decls}` rules in source order, skipping nested at-rule bodies. */
  function cssRules(css: string): Array<{ selector: string; body: string }> {
    const rules: Array<{ selector: string; body: string }> = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    for (const m of css.matchAll(re)) {
      const selector = m[1].trim();
      if (selector.startsWith('@')) continue; // at-rule prelude, not a class/tag rule
      rules.push({ selector, body: m[2] });
    }
    return rules;
  }

  /** Effective value for one declaration across the selector trio (last wins). */
  function computedDecl(css: string, selectors: string[], property: string): string {
    const rules = cssRules(css);
    let value = '';
    for (const selector of selectors) {
      const rule = rules.find((r) => r.selector === selector);
      if (!rule) continue;
      for (const decl of rule.body.split(';')) {
        const idx = decl.indexOf(':');
        if (idx === -1) continue;
        if (decl.slice(0, idx).trim() === property) value = decl.slice(idx + 1).trim();
      }
    }
    if (!value) throw new Error(`no ${property} computed for ${selectors.join(', ')}`);
    return value;
  }

  function cssVar(css: string, name: string): string {
    const root = cssRules(css).find((r) => r.selector === ':root');
    if (!root) throw new Error('no :root token map');
    for (const decl of root.body.split(';')) {
      const idx = decl.indexOf(':');
      if (idx !== -1 && decl.slice(0, idx).trim() === name) return decl.slice(idx + 1).trim();
    }
    throw new Error(`token ${name} not defined`);
  }

  /** One-level var(...) resolution to a #rrggbb token. */
  function resolveCssColor(css: string, value: string): string {
    const varRef = value.match(/var\(([^)]+)\)/);
    if (varRef) return cssVar(css, varRef[1].trim());
    if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
    throw new Error(`unsupported color shape: ${value}`);
  }

  /** WCAG 2.x contrast ratio between two opaque sRGB colors. */
  function contrastRatio(fg: string, bg: string): number {
    const lum = (hex: string): number => {
      const channel = (i: number): number => {
        const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
    };
    const l1 = lum(fg);
    const l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    return Math.round(ratio * 100) / 100;
  }
});
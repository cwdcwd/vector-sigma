import { describe, it, expect, beforeEach } from 'vitest';
import {
  createTestEnv,
  seedDevice,
  seedAdminKey,
  AdminClient,
  asStatusBody,
  type TestEnv,
} from './helpers.js';

let env: TestEnv;
const fast = { memoryCostKiB: 256, timeCost: 1 };

const ADMIN_KEY = 'ak_test-admin-key-0001';
const SECRET_BUNDLE = {
  schema_version: 1 as const,
  bundle_version: 1,
  generated_at: '2026-01-01T00:00:00Z',
  files: [
    {
      path: 'config/agent.env',
      mode: '0600' as const,
      content: 'AGENT_NAME=old-name\nGATEWAY_API_KEY=old-gateway-key\n',
    },
    {
      path: 'config/secrets.env',
      mode: '0600' as const,
      content: 'SLACK_BOT_TOKEN=old-slack-token\n',
    },
  ],
};

beforeEach(async () => {
  env = await createTestEnv({ hashParams: fast });
  await seedAdminKey(env.db, ADMIN_KEY);
});

async function loginClient(): Promise<AdminClient> {
  const c = new AdminClient(env.app);
  const res = await c.login(ADMIN_KEY);
  expect(res.status).toBe(303);
  expect(c.hasSession()).toBe(true);
  return c;
}

async function deliveredBundle(): Promise<{
  files: Array<{ path: string; content: string }>;
}> {
  const boot = await env.request({
    method: 'POST',
    url: '/v1/bootstrap',
    body: { balena_uuid: env.device.uuid },
    key: env.device.key,
  });
  expect(boot.status).toBe(200);
  return boot.body.bundle as { files: Array<{ path: string; content: string }> };
}

function baseForm(existingCount: string): Record<string, string> {
  const f: Record<string, string> = {
    _csrf: '',
    existing_count: existingCount,
    new_count: '3',
  };
  const paths = ['config/agent.env', 'config/secrets.env'];
  for (let i = 0; i < Number(existingCount); i++) {
    f[`existing_path_${i}`] = paths[i];
    f[`existing_content_${i}`] = '';
  }
  return f;
}

describe('Admin console — structured bundle editor (f57.11)', () => {
  it('renders the structured section on the editor page with all nine fields', async () => {
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: SECRET_BUNDLE });
    const c = await loginClient();
    const page = await c.get(`/admin/devices/${env.device.uuid}/bundle`);
    expect(page.status).toBe(200);
    for (const name of [
      'structured_agent_name',
      'structured_model_route',
      'structured_gateway_api_key',
      'structured_extra_env',
      'structured_soul_contents',
      'structured_a2a_identity_key',
      'structured_a2a_trusted_peers',
      'structured_slack_bot_token',
      'structured_github_app_pem',
    ]) {
      expect(page.html).toContain(`name="${name}"`);
    }
    // Secret inputs are password type (masked), non-secret are text
    expect(page.html).toContain('type="password" name="structured_gateway_api_key"');
    expect(page.html).toContain('type="text" name="structured_agent_name"');
    // Existing bundle file with a canonical path marks the field overridden
    expect(page.html).toContain('overridden by uploaded file');
    // The editor never renders existing secret content
    expect(page.html).not.toContain('old-gateway-key');
    expect(page.html).not.toContain('old-slack-token');
    // Every structured input carries data-path for the diff preview island
    expect((page.html.match(/data-path="config\/agent.env"/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it('structured save renders canonical files and bumps version through the shared rotate path', async () => {
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: SECRET_BUNDLE });
    const c = await loginClient();
    const csrf = await c.csrfFrom(`/admin/devices/${env.device.uuid}/bundle`);
    const form = baseForm('2');
    form._csrf = csrf;
    Object.assign(form, {
      structured_agent_name: 'doombot',
      structured_model_route: 'openai/gpt-5.2',
      structured_gateway_api_key: 'sk-new-gateway',
      structured_extra_env: 'LOG_LEVEL=debug',
      structured_soul_contents: '# SOUL\n\nYou are Doom.\n',
      structured_a2a_identity_key: 'a2a-key-new',
      structured_a2a_trusted_peers: 'ultronbot\nkangbot',
      structured_slack_bot_token: 'xoxb-new-slack',
      structured_github_app_pem: '-----BEGIN RSA PRIVATE KEY-----\nxyz\n-----END RSA PRIVATE KEY-----\n',
    });
    const res = await c.postForm(`/admin/devices/${env.device.uuid}/bundle`, form);
    expect(res.status).toBe(303);

    const status = asStatusBody(
      (
        await env.request({
          method: 'GET',
          url: `/v1/status?balena_uuid=${env.device.uuid}`,
          key: env.device.key,
        })
      ).body,
    );
    expect(status.bundle_version).toBe(2);
    expect(status.slot.state).toBe('armed');

    const bundle = await deliveredBundle();
    const byPath = new Map(bundle.files.map((f) => [f.path, f.content]));
    // Field-level merge with the prior agent.env: AGENT_NAME and
    // GATEWAY_API_KEY lines replaced in place, MODEL_ROUTE + extras appended.
    expect(byPath.get('config/agent.env')).toBe(
      'AGENT_NAME=doombot\nGATEWAY_API_KEY=sk-new-gateway\nMODEL_ROUTE=openai/gpt-5.2\nLOG_LEVEL=debug\n',
    );
    expect(byPath.get('SOUL.md')).toBe('# SOUL\n\nYou are Doom.\n');
    expect(byPath.get('config/a2a.json')).toBe(
      JSON.stringify(
        { identity_key: 'a2a-key-new', trusted_peers: ['ultronbot', 'kangbot'] },
        null,
        2,
      ) + '\n',
    );
    // secrets.env line-merge keeps the prior token line and adds SLACK
    expect(byPath.get('config/secrets.env')).toBe(
      'SLACK_BOT_TOKEN=xoxb-new-slack\n',
    );
    expect(byPath.get('config/github-app.pem')).toBe(
      '-----BEGIN RSA PRIVATE KEY-----\nxyz\n-----END RSA PRIVATE KEY-----\n',
    );
  });

  it('pre-fills non-secret fields from the current bundle; secrets stay blank (AC4)', async () => {
    const FULL_BUNDLE = {
      schema_version: 1 as const,
      bundle_version: 1,
      generated_at: '2026-01-01T00:00:00Z',
      files: [
        {
          path: 'config/agent.env',
          mode: '0600' as const,
          content: 'AGENT_NAME=bundle-agent\nMODEL_ROUTE=ollama/glm-5.3\nGATEWAY_API_KEY=live-gateway-key\nLOG_LEVEL=info\n',
        },
        { path: 'SOUL.md', mode: '0600' as const, content: '# Current soul\n\nVerbatim.\n' },
        {
          path: 'config/a2a.json',
          mode: '0600' as const,
          content: JSON.stringify({ identity_key: 'live-identity-key', trusted_peers: ['ultronbot', 'kangbot'] }, null, 2) + '\n',
        },
        { path: 'config/secrets.env', mode: '0600' as const, content: 'SLACK_BOT_TOKEN=live-slack-token\n' },
        { path: 'config/github-app.pem', mode: '0600' as const, content: '-----BEGIN RSA PRIVATE KEY-----\nlive\n-----END RSA PRIVATE KEY-----\n' },
      ],
    };
    await seedDevice(env.db, {
      uuid: env.device.uuid,
      hash: env.device.hash,
      bundle: FULL_BUNDLE,
      agentName: 'row-agent-name',
    });
    const c = await loginClient();
    const page = await c.get(`/admin/devices/${env.device.uuid}/bundle`);
    expect(page.status).toBe(200);
    // Non-secret values pre-filled (row name wins for agent_name)
    expect(page.html).toContain('value="row-agent-name"');
    expect(page.html).toContain('value="ollama/glm-5.3"');
    expect(page.html).toContain('# Current soul');
    expect(page.html).toContain('ultronbot\nkangbot');
    // extra_env pre-fill carries the non-managed lines
    expect(page.html).toContain('LOG_LEVEL=info');
    // Secrets NEVER render — not as value=, not anywhere. (The PEM input's
    // PLACEHOLDER legitimately contains the marker text; the secret body
    // 'live\n' must not.)
    expect(page.html).not.toContain('live-gateway-key');
    expect(page.html).not.toContain('live-identity-key');
    expect(page.html).not.toContain('live-slack-token');
    expect(page.html).not.toContain('-----BEGIN RSA PRIVATE KEY-----\nlive');
    // Secret inputs render with an empty value attribute
    expect(page.html).toContain(
      'type="password" name="structured_gateway_api_key" data-path="config/agent.env" placeholder="sk-…" value=""',
    );
  });

  it('blank secret fields keep existing values (field-level write-only semantics)', async () => {
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: SECRET_BUNDLE });
    const c = await loginClient();
    const csrf = await c.csrfFrom(`/admin/devices/${env.device.uuid}/bundle`);
    const form = baseForm('2');
    form._csrf = csrf;
    Object.assign(form, {
      structured_agent_name: 'renamed-agent',
      structured_gateway_api_key: '', // blank → keep old-gateway-key
      structured_slack_bot_token: '', // blank → keep old-slack-token
    });
    const res = await c.postForm(`/admin/devices/${env.device.uuid}/bundle`, form);
    expect(res.status).toBe(303);
    const bundle = await deliveredBundle();
    const byPath = new Map(bundle.files.map((f) => [f.path, f.content]));
    // agent.env: only the AGENT_NAME line changed; gateway key survived
    expect(byPath.get('config/agent.env')).toBe(
      'AGENT_NAME=renamed-agent\nGATEWAY_API_KEY=old-gateway-key\n',
    );
    // secrets.env untouched entirely (no set field targeted it)
    expect(byPath.get('config/secrets.env')).toBe('SLACK_BOT_TOKEN=old-slack-token\n');
  });

  it('raw upload with the SAME canonical name replaces the rendered section', async () => {
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: SECRET_BUNDLE });
    const c = await loginClient();
    const csrf = await c.csrfFrom(`/admin/devices/${env.device.uuid}/bundle`);
    const form = baseForm('2');
    form._csrf = csrf;
    form.existing_content_0 = 'AGENT_NAME=manual-override\n'; // same canonical path
    Object.assign(form, {
      structured_agent_name: 'doombot',
      structured_model_route: 'openai/gpt-5.2',
      structured_slack_bot_token: 'xoxb-new-slack',
    });
    const res = await c.postForm(`/admin/devices/${env.device.uuid}/bundle`, form);
    expect(res.status).toBe(303);
    const bundle = await deliveredBundle();
    const byPath = new Map(bundle.files.map((f) => [f.path, f.content]));
    // The raw upload WINS: no rendered merge into agent.env
    expect(byPath.get('config/agent.env')).toBe('AGENT_NAME=manual-override\n');
    // Other canonicals render normally
    expect(byPath.get('config/secrets.env')).toBe('SLACK_BOT_TOKEN=xoxb-new-slack\n');
  });

  it('new-file raw upload with a canonical name also wins over the render', async () => {
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: SECRET_BUNDLE });
    const c = await loginClient();
    const csrf = await c.csrfFrom(`/admin/devices/${env.device.uuid}/bundle`);
    const form = baseForm('2');
    form._csrf = csrf;
    form.new_path_0 = 'SOUL.md';
    form.new_content_0 = '# Raw soul wins\n';
    Object.assign(form, {
      structured_soul_contents: '# Rendered soul\n',
    });
    const res = await c.postForm(`/admin/devices/${env.device.uuid}/bundle`, form);
    expect(res.status).toBe(303);
    const bundle = await deliveredBundle();
    const byPath = new Map(bundle.files.map((f) => [f.path, f.content]));
    expect(byPath.get('SOUL.md')).toBe('# Raw soul wins\n');
  });

  it('malformed extra_env line bounces back to the editor with the actionable message', async () => {
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: SECRET_BUNDLE });
    const c = await loginClient();
    const csrf = await c.csrfFrom(`/admin/devices/${env.device.uuid}/bundle`);
    const form = baseForm('2');
    form._csrf = csrf;
    Object.assign(form, { structured_extra_env: 'THIS IS NOT VALID ENV' });
    const res = await c.postForm(`/admin/devices/${env.device.uuid}/bundle`, form);
    expect(res.status).toBe(400);
    expect(res.html).toContain('extra_env line is not KEY=VALUE');
    // Nothing was saved: version still 1, slot still consumed-by-bootstrap
    const status = asStatusBody(
      (
        await env.request({
          method: 'GET',
          url: `/v1/status?balena_uuid=${env.device.uuid}`,
          key: env.device.key,
        })
      ).body,
    );
    expect(status.bundle_version).toBe(1);
  });

  it('console structured save and API rotate keep version continuity (one code path)', async () => {
    await seedDevice(env.db, { uuid: env.device.uuid, hash: env.device.hash, bundle: SECRET_BUNDLE });
    // API rotate first → v2
    await env.request({
      method: 'POST',
      url: '/v1/rotate',
      body: { balena_uuid: env.device.uuid, files: SECRET_BUNDLE.files },
      key: ADMIN_KEY,
    });
    const c = await loginClient();
    const csrf = await c.csrfFrom(`/admin/devices/${env.device.uuid}/bundle`);
    const form = baseForm('2');
    form._csrf = csrf;
    Object.assign(form, { structured_agent_name: 'doombot' });
    const res = await c.postForm(`/admin/devices/${env.device.uuid}/bundle`, form);
    expect(res.status).toBe(303);
    const status = asStatusBody(
      (
        await env.request({
          method: 'GET',
          url: `/v1/status?balena_uuid=${env.device.uuid}`,
          key: env.device.key,
        })
      ).body,
    );
    expect(status.bundle_version).toBe(3);
  });
});
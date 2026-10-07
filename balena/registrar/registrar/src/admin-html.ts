import type { StructuredFields } from './structured-fields.js';
import { PERSONA_LIBRARY, type PersonaPreset } from './persona-library.js';

/**
 * HTML rendering for the admin console. Zero-framework, server-rendered,
 * per spec. Every dynamic value passes through esc() at its interpolation
 * point; secret values are never passed into any render function at all
 * (the editor shows masked placeholders, never existing content).
 */

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface DeviceRowView {
  balenaUuid: string;
  agentName: string;
  status: string;
  createdAt: Date;
  notes: string | null;
}

export interface SlotRowView {
  state: string;
  deliveryCount: number;
  deliveredAt: Date | null;
}

export interface BlobRowView {
  version: number;
  fileCount: number;
  updatedAt: Date;
}

function nav(csrfToken: string): string {
  return `<nav class="nav"><a href="/admin/devices">Devices</a> <a href="/admin/audit">Audit</a> <a href="/admin/admin-keys">Admin keys</a> <a href="/admin/mesh-enroll-keys">Mesh-enroll keys</a> <a href="/admin/new-device">New device</a> <form method="post" action="/admin/logout" class="inline-form"><input type="hidden" name="_csrf" value="${esc(csrfToken)}"><button type="submit" class="linklike">Log out</button></form></nav>`;
}

export interface PageOpts {
  csrfToken?: string;
  showNav?: boolean;
}

export function page(title: string, body: string, opts?: PageOpts): string {
  const showNav = opts?.showNav !== false;
  const navHtml = showNav ? nav(opts?.csrfToken ?? '') : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · vector-sigma registrar</title>
<style>
:root{--bg:#0f1117;--fg:#e6e8ee;--muted:#8b93a7;--card:#181b25;--line:#262b3a;--accent:#7aa2f7;--danger:#f7768e;--ok:#9ece6a}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:960px;margin:0 auto;padding:24px 16px}
nav.nav{display:flex;gap:16px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--card)}
nav a{color:var(--accent);text-decoration:none}
.linklike{background:none;border:none;color:var(--muted);cursor:pointer;font:inherit;padding:0}
.inline-form{display:inline;margin-left:auto}
h1{font-size:20px;margin:16px 0}
h2{font-size:16px;margin:12px 0}
table{border-collapse:collapse;width:100%;margin:8px 0}
th,td{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}
th{color:var(--muted);font-weight:500;background:var(--card)}
code{background:var(--card);padding:1px 5px;border-radius:3px;font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px;margin:12px 0}
.muted{color:var(--muted)}
.danger{color:var(--danger)}
.ok{color:var(--ok)}
input[type=text],input[type=password],textarea{width:100%;background:#12141c;color:var(--fg);border:1px solid var(--line);border-radius:4px;padding:8px;font:inherit}
textarea{min-height:80px;font-family:ui-monospace,monospace}
button{background:var(--accent);color:#0f1117;border:none;border-radius:4px;padding:8px 16px;font:inherit;font-weight:600;cursor:pointer}
button.linklike{color:var(--muted);font-weight:400;padding:0;background:none}
label{display:block;margin:10px 0 4px;color:var(--muted)}
.secret-once{background:#1a2333;border:1px solid var(--accent);border-radius:4px;padding:12px;font-family:ui-monospace,monospace;word-break:break-all}
fieldset{border:1px solid var(--line);border-radius:8px;margin:12px 0}
fieldset legend{color:var(--muted);padding:0 6px}
.hidden{display:none}
</style>
</head>
<body>
${navHtml}
<main>
${body}
</main>
<script src="/admin/static/editor.js" defer></script>
</body>
</html>`;
}

export function loginPage(csrfToken: string, error?: string, status?: 'locked'): string {
  return page(
    'Login',
    `<h1>Admin login</h1>
${error ? `<p class="danger">${esc(error)}</p>` : ''}
${status === 'locked' ? `<p class="danger">Too many failed attempts. Try again later.</p>` : ''}
<form method="post" action="/admin/login">
<input type="hidden" name="_csrf" value="${esc(csrfToken)}">
<label>Admin key</label>
<input type="password" name="admin_key" required autofocus>
<button type="submit">Log in</button>
</form>`,
    { showNav: false },
  );
}

export function dashboardPage(
  devices: DeviceRowView[],
  slots: Map<string, SlotRowView>,
  blobs: Map<string, BlobRowView>,
  csrfToken: string,
): string {
  const rows = devices
    .map((d) => {
      const slot = slots.get(d.balenaUuid);
      const blob = blobs.get(d.balenaUuid);
      return `<tr>
<td><a href="/admin/devices/${esc(d.balenaUuid)}">${esc(d.agentName)}</a></td>
<td><code>${esc(d.balenaUuid)}</code></td>
<td>${esc(d.status)}</td>
<td>${blob ? String(blob.version) : '<span class="muted">—</span>'}</td>
<td>${slot ? `${esc(slot.state)} (${slot.deliveryCount})` : '<span class="muted">—</span>'}</td>
<td>${esc(d.createdAt.toISOString().slice(0, 19))}Z</td>
</tr>`;
    })
    .join('\n');
  return page(
    'Devices',
    `<h1>Devices</h1>
<table>
<tr><th>Agent</th><th>UUID</th><th>Status</th><th>Bundle v</th><th>Slot (deliveries)</th><th>Created</th></tr>
${rows}
</table>
<p><a href="/admin/new-device">+ New device</a></p>`,
    { csrfToken },
  );
}

export interface DeviceDetailView {
  device: DeviceRowView;
  slot: SlotRowView | null;
  blob: (BlobRowView & { files: Array<{ path: string; bytes: number }> }) | null;
  csrfToken: string;
  messages?: Array<{ kind: 'ok' | 'danger'; text: string }>;
  /** Plaintext device key shown exactly once after (re)generation; never stored. */
  keyOnce?: string | null;
}

export function deviceDetailPage(v: DeviceDetailView): string {
  const d = v.device;
  const msgs = (v.messages ?? [])
    .map((m) => `<p class="${m.kind}">${esc(m.text)}</p>`)
    .join('\n');
  const keyOnce = v.keyOnce
    ? `<div class="card"><h2>New device key — shown once, never stored</h2><div class="secret-once">${esc(v.keyOnce)}</div><p class="muted">Store it in the platform variables now; it cannot be retrieved again.</p></div>`
    : '';
  const slot = v.slot;
  const blob = v.blob;
  const fileRows = (blob?.files ?? [])
    .map(
      (f) =>
        `<tr><td><code>${esc(f.path)}</code></td><td>${f.bytes} bytes</td><td class="muted">masked — write-only</td></tr>`,
    )
    .join('\n');
  const toggleForm =
    d.status === 'active'
      ? `<form method="post" action="/admin/devices/${esc(d.balenaUuid)}/revoke"><input type="hidden" name="_csrf" value="${esc(v.csrfToken)}"><button type="submit" class="danger">Revoke</button></form>`
      : `<form method="post" action="/admin/devices/${esc(d.balenaUuid)}/activate"><input type="hidden" name="_csrf" value="${esc(v.csrfToken)}"><button type="submit">Activate</button></form>`;
  const actions = `<div class="card"><h2>Actions</h2>
<form method="post" action="/admin/devices/${esc(d.balenaUuid)}/re-arm"><input type="hidden" name="_csrf" value="${esc(v.csrfToken)}"><button type="submit">Re-arm slot</button></form>
${toggleForm}
<form method="post" action="/admin/devices/${esc(d.balenaUuid)}/regen-key"><input type="hidden" name="_csrf" value="${esc(v.csrfToken)}"><button type="submit">Regenerate device key</button></form>
<form method="post" action="/admin/devices/${esc(d.balenaUuid)}/mint-memory-keys"><input type="hidden" name="_csrf" value="${esc(v.csrfToken)}"><button type="submit">Mint memory keys</button></form>
<form method="post" action="/admin/devices/${esc(d.balenaUuid)}/mesh-enroll"><input type="hidden" name="_csrf" value="${esc(v.csrfToken)}"><button type="submit">Enroll in A2A mesh</button></form>
</div>`;
  return page(
    d.agentName,
    `${msgs}
${keyOnce}
<div class="card"><h2>${esc(d.agentName)}</h2>
<p><span class="muted">UUID</span> <code>${esc(d.balenaUuid)}</code></p>
<p><span class="muted">Status</span> ${esc(d.status)} &nbsp; <span class="muted">Created</span> ${esc(d.createdAt.toISOString())}</p>
${d.notes ? `<p><span class="muted">Notes</span> ${esc(d.notes)}</p>` : ''}
${slot ? `<p><span class="muted">Slot</span> ${esc(slot.state)} · ${slot.deliveryCount} deliveries · last ${slot.deliveredAt ? esc(slot.deliveredAt.toISOString()) : 'never'}</p>` : ''}
</div>
<div class="card"><h2>Bundle${blob ? ` · v${blob.version}` : ''}</h2>
${
  blob
    ? `<table><tr><th>Path</th><th>Size</th><th>Content</th></tr>${fileRows}</table><p><a href="/admin/devices/${esc(d.balenaUuid)}/bundle">Edit bundle</a> · updated ${esc(blob.updatedAt.toISOString())}</p>`
    : `<p class="muted">No bundle yet.</p><p><a href="/admin/devices/${esc(d.balenaUuid)}/bundle">Create one</a></p>`
}
</div>
${actions}`,
    { csrfToken: v.csrfToken },
  );
}

export interface EditorView {
  device: DeviceRowView;
  /** Existing files: path + byte size ONLY — content never leaves the DB. */
  existing: Array<{ path: string; bytes: number }>;
  version: number | null;
  csrfToken: string;
  error?: string;
  /**
   * Non-secret pre-fill values for the structured section (f57.11),
   * derived server-side from the current bundle. SECRET fields are never
   * pre-filled — their inputs render blank (write-only).
   */
  preFill?: StructuredFields;
}

/**
 * Structured editor section rows (f57.11). One row per owner-ruled field;
 * `secret` marks write-only inputs (blank = keep existing); `canonical`
 * names the file the field renders into (displayed to the operator);
 * `overridden` is computed by the caller from the existing bundle's file
 * paths (an existing bundle file with the same canonical path means a raw
 * upload previously won — the form warns, it does not silently render).
 */
export interface StructuredFieldRow {
  name: string;
  label: string;
  canonical: string;
  secret: boolean;
  multiline: boolean;
  placeholder: string;
  hint?: string;
}

export const STRUCTURED_FIELD_ROWS: StructuredFieldRow[] = [
  { name: 'agent_name', label: 'Agent name', canonical: 'config/agent.env', secret: false, multiline: false, placeholder: 'agent-name', hint: 'Rendered as the AGENT_NAME= line of config/agent.env.' },
  { name: 'model_route', label: 'Model route', canonical: 'config/agent.env', secret: false, multiline: false, placeholder: 'openai/gpt-5.2' },
  { name: 'gateway_api_key', label: 'Gateway API key', canonical: 'config/agent.env', secret: true, multiline: false, placeholder: 'sk-…', hint: 'Write-only: blank keeps the existing value.' },
  { name: 'extra_env', label: 'Extra env (KEY=VALUE lines)', canonical: 'config/agent.env', secret: false, multiline: true, placeholder: 'LOG_LEVEL=debug\nA2A_UUID=…' },
  { name: 'soul_contents', label: 'SOUL.md contents', canonical: 'SOUL.md', secret: false, multiline: true, placeholder: '# SOUL\n\nYou are …' },
  { name: 'a2a_identity_key', label: 'A2A identity key', canonical: 'config/a2a.json', secret: true, multiline: false, placeholder: 'a2a-key…', hint: 'Write-only: blank keeps the existing value. Devices mesh through the master gateway (/a2a/* pass-through): set A2A_PUBLIC_URL on the device to http://<master-LAN-IP>:4000 — see balena/registrar/README.md.' },
  { name: 'a2a_trusted_peers', label: 'A2A trusted peers', canonical: 'config/a2a.json', secret: false, multiline: true, placeholder: 'peer-a\npeer-b', hint: 'One agent id per line. Peer traffic rides the master device gateway at /a2a/* (fleet-ops-f57.12): each device points A2A_PUBLIC_URL at http://<master-LAN-IP>:4000 so its card is served by the VS gateway, not ai.lan.' },
  { name: 'a2a_public_url', label: 'A2A public URL', canonical: 'config/a2a.json', secret: false, multiline: false, placeholder: 'http://<this-agent-origin>:9900', hint: 'The PROXY-DIALABLE origin of THIS agent (j7g.1) — the master gateway\'s proxy follows it to deliver peer traffic (compose-internal for primus, the device\'s LAN/tailnet address for a device). NOT the mesh edge; peers call you through the gateway at /a2a/<name>.' },
  { name: 'a2a_peer_tokens', label: 'A2A peer tokens', canonical: 'config/a2a.json', secret: true, multiline: true, placeholder: 'primus:sk-…\nwheeljack:sk-…', hint: 'Write-only: blank keeps the existing value. One mesh peer per line as name:key (j7g.1) — the peer\'s A2A identity key, minted on the VS gateway. Outbound calls present the caller\'s own identity; this map stages the trusted peers\' keys for inbound-verified mesh traffic.' },
  { name: 'slack_bot_token', label: 'Slack bot token', canonical: 'config/secrets.env', secret: true, multiline: false, placeholder: 'xoxb-…', hint: 'Write-only: blank keeps the existing value.' },
  { name: 'github_app_pem', label: 'GitHub App PEM', canonical: 'config/github-app.pem', secret: true, multiline: true, placeholder: '-----BEGIN RSA PRIVATE KEY-----\n…\n-----END RSA PRIVATE KEY-----', hint: 'Write-only: blank keeps the existing value.' },
];

/**
 * Persona pre-fill picker (fleet-ops-zbq.2), rendered from the embedded
 * library (persona-library.ts, generated from personas/). Advisory only:
 * the select carries NO name attribute, so it never submits anything —
 * the operator's browser fills the four non-secret identity fields and
 * the existing structured-fields -> canonical-files -> rotate save path
 * is untouched. Secrets are never offered and never touched.
 *
 * The data island is a non-executing JSON block (CSP script-src 'self'
 * allows it — same shape as JSON-LD): `<` is escaped to a \\u003c escape
 * inside the serialized string so no text can ever terminate the block
 * early, and JSON.parse of textContent restores the exact bytes.
 */
function personaPicker(): string {
  if (PERSONA_LIBRARY.length === 0) return '';
  const options = PERSONA_LIBRARY.map(
    (p) => `<option value="${esc(p.slug)}">${esc(p.name)} — ${esc(p.description)}</option>`,
  ).join('\n');
  const island = JSON.stringify(PERSONA_LIBRARY).replace(/</g, '\\u003c');
  return `<fieldset class="persona-picker">
<legend>Persona pre-fill (advisory)</legend>
<p class="muted">Pick a library persona to load its defaults into the four identity fields below — agent name, model route, extra env, SOUL. Review and edit before saving: the fill is a starting point, never a contract. Secret fields are never touched.</p>
<label for="persona-select">Persona</label>
<select id="persona-select">
<option value="">— pick a persona (optional) —</option>
${options}
</select>
<script type="application/json" id="persona-library-data">${island}</script>
</fieldset>`;
}

export function bundleEditorPage(v: EditorView): string {
  const existingRows = v.existing
    .map(
      (f, i) => `<fieldset>
<legend>Existing file</legend>
<input type="hidden" name="existing_path_${i}" value="${esc(f.path)}">
<p><code>${esc(f.path)}</code> · ${f.bytes} bytes · <span class="muted">content masked (write-only secret)</span></p>
<label>New content (leave blank to keep existing)</label>
<textarea name="existing_content_${i}" data-path="${esc(f.path)}"></textarea>
</fieldset>`,
    )
    .join('\n');
  const structuredRows = STRUCTURED_FIELD_ROWS.map((row) => {
    const overridden = v.existing.some((f) => f.path === row.canonical);
    // Non-secret fields pre-fill with the current value (AC4: only secret
    // fields are write-only); secret inputs always render blank. The
    // preFill map itself is derived server-side by buildFormPreFill with
    // a SECRETISH filter — secret-looking keys from raw uploads never
    // reach the page even through the non-secret fields.
    const current = row.secret ? '' : (v.preFill?.[row.name as keyof StructuredFields] ?? '');
    const input = row.multiline
      ? `<textarea name="structured_${esc(row.name)}" rows="4" data-path="${esc(row.canonical)}" placeholder="${esc(row.placeholder)}">${esc(current)}</textarea>`
      : `<input type="${row.secret ? 'password' : 'text'}" name="structured_${esc(row.name)}" data-path="${esc(row.canonical)}" placeholder="${esc(row.placeholder)}" value="${esc(current)}" autocomplete="off">`;
    return `<fieldset class="structured-field">
<legend>${esc(row.label)}</legend>
<p class="muted">renders to <code>${esc(row.canonical)}</code>${row.secret ? ' · write-only (blank = keep existing)' : ''}${overridden ? ' · <span class="danger">overridden by uploaded file</span>' : ''}</p>
${input}
${row.hint ? `<p class="muted">${esc(row.hint)}</p>` : ''}
</fieldset>`;
  }).join('\n');
  const newRows = Array.from({ length: 3 })
    .map(
      (_x, i) => `<fieldset class="new-file">
<legend>New file</legend>
<label>Path</label>
<input type="text" name="new_path_${i}" placeholder="config/agent.env">
<label>Content</label>
<textarea name="new_content_${i}"></textarea>
</fieldset>`,
    )
    .join('\n');
  return page(
    `Bundle editor · ${v.device.agentName}`,
    `<h1>Bundle editor — ${esc(v.device.agentName)}</h1>
${v.error ? `<p class="danger">${esc(v.error)}</p>` : ''}
<p class="muted">Current version: ${v.version ?? 'none'}. Saving bumps the version, arms the delivery slot, and writes an audit row — the same code path as POST /v1/rotate.</p>
<form method="post" action="/admin/devices/${esc(v.device.balenaUuid)}/bundle">
<input type="hidden" name="_csrf" value="${esc(v.csrfToken)}">
<input type="hidden" name="existing_count" value="${v.existing.length}">
<input type="hidden" name="new_count" value="3">
${personaPicker()}
<fieldset>
<legend>Structured identity</legend>
<p class="muted">Fields below render to their canonical files via fixed templates. A raw file upload with the same canonical name replaces the rendered section.</p>
${structuredRows}
</fieldset>
${existingRows}
${newRows}
<p><button type="submit">Save bundle</button> <a href="/admin/devices/${esc(v.device.balenaUuid)}">Cancel</a></p>
</form>
<div id="diff-preview" class="card hidden"><h2>Diff preview</h2><pre id="diff-out"></pre></div>`,
    { csrfToken: v.csrfToken },
  );
}

export function newDevicePage(csrfToken: string, error?: string): string {
  return page(
    'New device',
    `<h1>New device</h1>
${error ? `<p class="danger">${esc(error)}</p>` : ''}
<form method="post" action="/admin/new-device">
<input type="hidden" name="_csrf" value="${esc(csrfToken)}">
<label>Agent name (unique)</label>
<input type="text" name="agent_name" required>
<label>Device UUID (balena)</label>
<input type="text" name="balena_uuid" required>
<label>Notes (optional)</label>
<input type="text" name="notes">
<button type="submit">Create device</button>
</form>`,
    { csrfToken },
  );
}

export function auditPage(rows: Array<Record<string, string | number | null>>, csrfToken: string): string {
  const trs = rows
    .map((r) => {
      const occurred = String(r.occurred_at ?? '');
      const dev = r.device_id
        ? `<a href="/admin/devices/${esc(String(r.device_id))}"><code>${esc(String(r.device_id).slice(0, 8))}…</code></a>`
        : '<span class="muted">—</span>';
      return `<tr><td>${occurred.slice(0, 19)}Z</td><td>${esc(String(r.outcome))}</td><td>${
        r.reason ? esc(String(r.reason)) : '<span class="muted">—</span>'
      }</td><td>${dev}</td><td>${
        r.key_id ? '<code>' + esc(String(r.key_id)) + '</code>' : '<span class="muted">—</span>'
      }</td><td>${r.source_ip ? esc(String(r.source_ip)) : '<span class="muted">—</span>'}</td></tr>`;
    })
    .join('\n');
  return page(
    'Audit',
    `<h1>Audit log (read-only)</h1>
<table>
<tr><th>When</th><th>Outcome</th><th>Reason</th><th>Device</th><th>Key id</th><th>Source IP</th></tr>
${trs}
</table>`,
    { csrfToken },
  );
}

/** One-time plaintext key display after new-device creation. */
export function newDeviceResultPage(
  agentName: string,
  uuid: string,
  keyOnce: string,
  csrfToken: string,
): string {
  return page(
    agentName,
    `<h1>Device created: ${esc(agentName)}</h1>
<div class="card"><h2>Device key — shown once, never stored</h2><div class="secret-once">${esc(keyOnce)}</div>
<p class="muted">Set this as REGISTRAR_KEY in the device platform variables now. It cannot be retrieved again; regenerate it if lost.</p></div>
<p>Device status is <code>pending</code> — activate it from the <a href="/admin/devices/${esc(uuid)}">device page</a>.</p>
<p><a href="/admin/devices">Dashboard</a></p>`,
    { csrfToken },
  );
}

// ---- Admin-key UI (fleet-ops-w5d) -------------------------------------------------

/**
 * First-run bootstrap form. Reachable ONLY while admin_keys is empty —
 * the routes 404 once any key exists. Same double-submit CSRF shape as
 * the login form; the mint posts here exactly once.
 */
export function setupPage(csrfToken: string, error?: string, status?: 'locked'): string {
  return page(
    'First-run setup',
    `<h1>First admin key</h1>
<p class="muted">No admin key exists yet. Mint the first one here — after this, this page is gone (404) and keys are managed from the console's <a href="/admin/admin-keys">Admin keys</a> page.</p>
${error ? `<p class="danger">${esc(error)}</p>` : ''}
${status === 'locked' ? `<p class="danger">Too many failed attempts. Try again later.</p>` : ''}
<form method="post" action="/admin/setup">
<input type="hidden" name="_csrf" value="${esc(csrfToken)}">
<label>Label (e.g. bootstrap, owner-2026)</label>
<input type="text" name="label" required autofocus>
<button type="submit">Mint first admin key</button>
</form>`,
    { showNav: false },
  );
}

/**
 * One-time display of the first admin key. The plaintext is shown here
 * and nowhere else — never stored, never logged, never re-displayable.
 * The mint created a session, so the owner continues logged-in.
 */
export function setupResultPage(label: string, keyOnce: string, keyId: number): string {
  return page(
    'Admin key minted',
    `<h1>First admin key minted</h1>
<div class="card"><h2>Admin key (label: ${esc(label)}) — shown once, never stored</h2><div class="secret-once">${esc(keyOnce)}</div>
<p class="muted">Store it in your password manager NOW. It cannot be retrieved again — a lost key is revoked and re-minted from the console.</p></div>
<p>You are logged in (row id ${keyId}). Manage keys — mint more, revoke old ones — from the <a href="/admin/admin-keys">Admin keys</a> page.</p>
<p><a href="/admin/devices">Dashboard</a></p>`,
  );
}

/** Row view for the session-gated key list. */
export interface AdminKeyRowView {
  id: number;
  label: string;
}

/** Session-gated key management: list + mint + revoke (the rotation path). */
export function adminKeysPage(rows: AdminKeyRowView[], csrfToken: string, error?: string): string {
  const trs = rows
    .map(
      (r) => `<tr><td>${r.id}</td><td>${esc(r.label)}</td><td>
<form method="post" action="/admin/admin-keys/${r.id}/revoke"><input type="hidden" name="_csrf" value="${esc(csrfToken)}"><button type="submit" class="danger">Revoke</button></form>
</td></tr>`,
    )
    .join('\n');
  return page(
    'Admin keys',
    `<h1>Admin keys</h1>
${error ? `<p class="danger">${esc(error)}</p>` : ''}
<table>
<tr><th>Id</th><th>Label</th><th></th></tr>
${trs}
</table>
<div class="card"><h2>Mint a new key</h2>
<p class="muted">Shown once on the next page — same custody as every other key. Rotation: mint the new one, log in with it, revoke the old row.</p>
<form method="post" action="/admin/admin-keys">
<input type="hidden" name="_csrf" value="${esc(csrfToken)}">
<label>Label</label>
<input type="text" name="label" required>
<button type="submit">Mint key</button>
</form>
</div>`,
    { csrfToken },
  );
}

/** One-time display of a session-minted key (identical custody to setup). */
export function adminKeyMintedPage(
  label: string,
  keyOnce: string,
  keyId: number,
  csrfToken: string,
): string {
  return page(
    'Admin key minted',
    `<h1>Admin key minted</h1>
<div class="card"><h2>Admin key (label: ${esc(label)}) — shown once, never stored</h2><div class="secret-once">${esc(keyOnce)}</div>
<p class="muted">Store it in your password manager NOW. It cannot be retrieved again.</p></div>
<p>Row id ${keyId}. <a href="/admin/admin-keys">Back to admin keys</a></p>`,
    { csrfToken },
  );
}

/**
 * Mesh-enroll machine keys (fleet-ops-j7g.1): primus's scoped key rows
 * for the /v1/mesh-enroll action. Same custody shape as admin keys —
 * mint show-once, revoke = kill switch — plus the agent binding (the
 * key authenticates AS its agent row for the audit trail).
 */
export interface MeshEnrollKeyRowView {
  id: number;
  agentName: string;
  lastUsedAt: Date | null;
}

export function meshEnrollKeysPage(
  rows: MeshEnrollKeyRowView[],
  csrfToken: string,
  error?: string,
): string {
  const trs = rows
    .map(
      (r) => `<tr><td>${r.id}</td><td>${esc(r.agentName)}</td><td>${r.lastUsedAt ? esc(r.lastUsedAt.toISOString()) : 'never'}</td><td>
<form method="post" action="/admin/mesh-enroll-keys/${r.id}/revoke"><input type="hidden" name="_csrf" value="${esc(csrfToken)}"><button type="submit" class="danger">Revoke</button></form>
</td></tr>`,
    )
    .join('\n');
  return page(
    'Mesh-enroll keys',
    `<h1>Mesh-enroll keys (primus machine auth)</h1>
${error ? `<p class="danger">${esc(error)}</p>` : ''}
<p class="muted">Scoped machine keys for the <code>/v1/mesh-enroll</code> action — primus authenticates with one to enroll agents into the A2A mesh (mint or open the sentinel <code>vs-&lt;agent&gt;-a2a</code> key, merge both sides' bundles, register the gateway card row). Deleting a row revokes it instantly (the owner kill switch). The key never mints gateway keys by itself — the registrar holds the mint credential; this key only triggers the registrar-side action.</p>
<table>
<tr><th>Id</th><th>Agent</th><th>Last used</th><th></th></tr>
${trs}
</table>
<div class="card"><h2>Mint a new mesh-enroll key</h2>
<p class="muted">Shown once on the next page. Give the value to the agent's operator (primus: set it as <code>MESH_ENROLL_KEY</code> on the service env — never in image layers). Rotation: mint the new one, deliver, revoke the old row.</p>
<form method="post" action="/admin/mesh-enroll-keys">
<input type="hidden" name="_csrf" value="${esc(csrfToken)}">
<label>Agent name</label>
<input type="text" name="agent_name" required pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]*">
<button type="submit">Mint key</button>
</form>
</div>`,
    { csrfToken },
  );
}

export function meshEnrollKeyMintedPage(
  agentName: string,
  keyOnce: string,
  keyId: number,
  csrfToken: string,
): string {
  return page(
    'Mesh-enroll key minted',
    `<h1>Mesh-enroll key minted</h1>
<div class="card"><h2>Mesh-enroll key (agent: ${esc(agentName)}) — shown once, never stored</h2><div class="secret-once">${esc(keyOnce)}</div>
<p class="muted">Store it in your password manager NOW. On primus, set it as the <code>MESH_ENROLL_KEY</code> service variable — never in image layers. It cannot be retrieved again.</p></div>
<p>Row id ${keyId}. <a href="/admin/mesh-enroll-keys">Back to mesh-enroll keys</a></p>`,
    { csrfToken },
  );
}
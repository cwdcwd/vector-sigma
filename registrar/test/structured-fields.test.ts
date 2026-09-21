import { describe, expect, it } from 'vitest';
import {
  CANONICAL_PATHS,
  FIELD_NAMES,
  SECRET_FIELDS,
  parseEnvLine,
  renderCanonicalFiles,
  InvalidExtraEnvError,
} from '../src/structured-fields.js';

const AGENT_ENV = CANONICAL_PATHS.agentEnv;

function contentsOf(files: ReturnType<typeof renderCanonicalFiles>): Map<string, string> {
  return new Map(files.map((f) => [f.path, f.content]));
}

describe('structured-fields — renderCanonicalFiles (f57.11)', () => {
  it('renders the full field set into the five canonical files (no prior bundle)', () => {
    const out = renderCanonicalFiles({
      agent_name: 'doombot',
      model_route: 'openai/gpt-5.2',
      gateway_api_key: 'sk-gateway-secret',
      extra_env: 'LOG_LEVEL=debug\nA2A_UUID=doombot-1',
      soul_contents: '# SOUL\n\nYou are Doom.\n',
      a2a_identity_key: 'a2a-identity-secret',
      a2a_trusted_peers: 'ultronbot\nkangbot, thanosbot',
      slack_bot_token: 'xoxb-slack-secret',
      github_app_pem: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n',
    });
    const byPath = contentsOf(out);

    expect(byPath.get(AGENT_ENV)).toBe(
      'AGENT_NAME=doombot\nMODEL_ROUTE=openai/gpt-5.2\nGATEWAY_API_KEY=sk-gateway-secret\nLOG_LEVEL=debug\nA2A_UUID=doombot-1\n',
    );
    expect(byPath.get(CANONICAL_PATHS.soul)).toBe('# SOUL\n\nYou are Doom.\n');
    const a2a = JSON.parse(byPath.get(CANONICAL_PATHS.a2a) ?? '{}');
    expect(a2a).toEqual({
      identity_key: 'a2a-identity-secret',
      trusted_peers: ['ultronbot', 'kangbot', 'thanosbot'],
    });
    expect(byPath.get(CANONICAL_PATHS.secretsEnv)).toBe('SLACK_BOT_TOKEN=xoxb-slack-secret\n');
    expect(byPath.get(CANONICAL_PATHS.githubAppPem)).toContain('BEGIN RSA PRIVATE KEY');
    for (const f of out) expect(f.mode).toBe('0600');
  });

  it('blank fields render nothing — existing bundle untouched by blank save', () => {
    expect(renderCanonicalFiles({})).toEqual([]);
    expect(renderCanonicalFiles({ agent_name: '   ', soul_contents: '\n \n' })).toEqual([]);
  });

  it('env merge replaces set keys IN PLACE and appends new keys, keeping other lines', () => {
    const existing = new Map([
      [AGENT_ENV, 'AGENT_NAME=old\nGATEWAY_API_KEY=old-key\n# a comment\nEXTRA=keep-me\n'],
    ]);
    const out = renderCanonicalFiles({ agent_name: 'new-name', model_route: 'm/x' }, existing);
    const env = contentsOf(out).get(AGENT_ENV) ?? '';
    // AGENT_NAME replaced in place; GATEWAY_API_KEY line KEPT (blank field);
    // comment kept; MODEL_ROUTE appended; EXTRA kept.
    expect(env).toBe(
      'AGENT_NAME=new-name\nGATEWAY_API_KEY=old-key\n# a comment\nEXTRA=keep-me\nMODEL_ROUTE=m/x\n',
    );
  });

  it('blank secret field keeps the existing value line (field-level keep)', () => {
    const existing = new Map([[AGENT_ENV, 'GATEWAY_API_KEY=sk-previous\n']]);
    // agent_name set, gateway blank → gateway line survives the save
    const out = renderCanonicalFiles({ agent_name: 'doombot' }, existing);
    expect(contentsOf(out).get(AGENT_ENV)).toBe('GATEWAY_API_KEY=sk-previous\nAGENT_NAME=doombot\n');
  });

  it('set secret field replaces its line in place', () => {
    const existing = new Map([[AGENT_ENV, 'GATEWAY_API_KEY=sk-previous\nAGENT_NAME=x\n']]);
    const out = renderCanonicalFiles({ gateway_api_key: 'sk-new' }, existing);
    expect(contentsOf(out).get(AGENT_ENV)).toBe('GATEWAY_API_KEY=sk-new\nAGENT_NAME=x\n');
  });

  it('a2a.json object-merges with the existing file; unknown prior keys survive', () => {
    const existing = new Map([
      [CANONICAL_PATHS.a2a, JSON.stringify({ identity_key: 'old', custom: 'kept' }, null, 2) + '\n'],
    ]);
    const out = renderCanonicalFiles({ a2a_trusted_peers: 'kangbot' }, existing);
    const a2a = JSON.parse(contentsOf(out).get(CANONICAL_PATHS.a2a) ?? '{}');
    expect(a2a).toEqual({ identity_key: 'old', custom: 'kept', trusted_peers: ['kangbot'] });
  });

  it('a2a.json over non-JSON prior content starts fresh (raw upload garbage tolerance)', () => {
    const existing = new Map([[CANONICAL_PATHS.a2a, 'not json at all']]);
    const out = renderCanonicalFiles({ a2a_identity_key: 'k' }, existing);
    expect(JSON.parse(contentsOf(out).get(CANONICAL_PATHS.a2a) ?? '{}')).toEqual({ identity_key: 'k' });
  });

  it('verbatim files (SOUL.md, PEM) replace whole when set, keep when blank', () => {
    const existing = new Map([
      [CANONICAL_PATHS.soul, 'old soul\n'],
      [CANONICAL_PATHS.githubAppPem, 'old pem\n'],
    ]);
    const onlySoul = renderCanonicalFiles({ soul_contents: 'new soul\n' }, existing);
    expect(contentsOf(onlySoul).get(CANONICAL_PATHS.soul)).toBe('new soul\n');
    expect(contentsOf(onlySoul).has(CANONICAL_PATHS.githubAppPem)).toBe(false);
  });

  it('secrets.env line-merges (existing SIMULATED_SECRET survives a token save)', () => {
    const existing = new Map([[CANONICAL_PATHS.secretsEnv, 'SIMULATED_SECRET=e2e-rotate-me\n']]);
    const out = renderCanonicalFiles({ slack_bot_token: 'xoxb-new' }, existing);
    expect(contentsOf(out).get(CANONICAL_PATHS.secretsEnv)).toBe(
      'SIMULATED_SECRET=e2e-rotate-me\nSLACK_BOT_TOKEN=xoxb-new\n',
    );
  });

  it('malformed extra_env line refuses the save with an actionable error', () => {
    expect(() => renderCanonicalFiles({ extra_env: 'BAD LINE' })).toThrow(InvalidExtraEnvError);
    expect(() => renderCanonicalFiles({ extra_env: '9BAD=v' })).toThrow(InvalidExtraEnvError);
    // comments are allowed through untouched
    const out = renderCanonicalFiles({ extra_env: '# comment\nGOOD=1' });
    expect(contentsOf(out).get(AGENT_ENV)).toBe('# comment\nGOOD=1\n');
  });

  it('field set matches the owner-ruled nine; secret set matches the ruled four', () => {
    expect([...FIELD_NAMES].sort()).toEqual(
      [
        'a2a_identity_key',
        'a2a_trusted_peers',
        'agent_name',
        'extra_env',
        'gateway_api_key',
        'github_app_pem',
        'model_route',
        'slack_bot_token',
        'soul_contents',
      ].sort(),
    );
    expect([...SECRET_FIELDS].sort()).toEqual(
      ['a2a_identity_key', 'gateway_api_key', 'github_app_pem', 'slack_bot_token'].sort(),
    );
  });
});

describe('structured-fields — parseEnvLine', () => {
  it('accepts well-formed KEY=VALUE pairs', () => {
    expect(parseEnvLine('FOO=bar')).toEqual({ key: 'FOO', value: 'bar' });
    expect(parseEnvLine(' FOO = bar baz ')).toEqual({ key: 'FOO', value: 'bar baz' });
    expect(parseEnvLine('_X9=y=1')).toEqual({ key: '_X9', value: 'y=1' });
  });
  it('comment/blank lines parse to empty keys (kept verbatim by the merge)', () => {
    expect(parseEnvLine('# hi')).toEqual({ key: '', value: '' });
    expect(parseEnvLine('')).toEqual({ key: '', value: '' });
  });
  it('rejects malformed lines', () => {
    expect(() => parseEnvLine('novalue')).toThrow(InvalidExtraEnvError);
    expect(() => parseEnvLine('=value')).toThrow(InvalidExtraEnvError);
    expect(() => parseEnvLine('BAD-KEY=v')).toThrow(InvalidExtraEnvError);
  });
});
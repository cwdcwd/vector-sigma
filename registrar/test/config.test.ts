import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

/**
 * Boot-config fail-loud (fleet-ops-f57.7).
 *
 * SESSION_SECRET is the HMAC key for admin-console session cookies. It
 * used to carry a silent default ('vsigma-change-me-session-secret'),
 * so a registrar missing its balena fleet variable would boot happily
 * with an insecure, publicly-known secret. These tests pin the fix:
 * missing or short (<16) SESSION_SECRET must fail loadConfig with a
 * message naming the variable AND the fix path (balena fleet/service
 * variable), and a valid environment must still parse unchanged.
 */

const validEnv = {
  DATABASE_URL: 'postgres://registrar:secret@localhost:5432/vector_sigma',
  SESSION_SECRET: 'a-strong-random-session-secret-0123456789',
};

describe('registrar config — SESSION_SECRET is fail-loud', () => {
  it('rejects a missing SESSION_SECRET, naming the variable and the balena fix', () => {
    const { SESSION_SECRET: _omitted, ...envWithoutSecret } = validEnv;
    expect(() => loadConfig(envWithoutSecret)).toThrow(
      /SESSION_SECRET is required.*balena fleet\/service variable/,
    );
    expect(() => loadConfig(envWithoutSecret)).toThrow(
      /invalid registrar configuration/,
    );
  });

  it('rejects a short (<16 chars) SESSION_SECRET with the same fix path', () => {
    expect(() => loadConfig({ ...validEnv, SESSION_SECRET: 'too-short' })).toThrow(
      /SESSION_SECRET must be at least 16 characters.*balena fleet\/service variable/,
    );
  });

  it('accepts a valid environment and maps it to RegistrarConfig', () => {
    const c = loadConfig(validEnv);
    expect(c.sessionSecret).toBe(validEnv.SESSION_SECRET);
    expect(c.databaseUrl).toBe(validEnv.DATABASE_URL);
  });

  it('keeps the documented defaults for optional variables', () => {
    const c = loadConfig(validEnv);
    expect(c.port).toBe(3000);
    expect(c.host).toBe('0.0.0.0');
    expect(c.logLevel).toBe('info');
    expect(c.trustProxy).toBe(false);
    expect(c.rateLimitWindowMs).toBe(900_000);
    expect(c.rateLimitMaxFailures).toBe(5);
  });

});

/**
 * DATABASE_URL built from parts (fleet-ops-f57.8).
 *
 * Owner ruling: "The db URL should really be based on the docker host
 * name of the container in the composition. There should actually be
 * very little set from the outside by myself." DATABASE_URL becomes an
 * optional whole-URL override; when absent the registrar builds it from
 * DB_HOST (default 'postgres' — the compose service name), DB_PORT
 * (default 5432), POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB, and
 * fails startup naming every missing part plus the balena fix path.
 */
describe('registrar config — DATABASE_URL built from parts (fleet-ops-f57.8)', () => {
  const secret = 'a-strong-random-session-secret-0123456789';
  const partEnv = {
    POSTGRES_USER: 'vsigma',
    POSTGRES_PASSWORD: 's3cret-pw',
    POSTGRES_DB: 'vsigma',
    SESSION_SECRET: secret,
  };

  it('builds the database URL from parts when DATABASE_URL is absent', () => {
    const c = loadConfig(partEnv);
    expect(c.databaseUrl).toBe('postgres://vsigma:s3cret-pw@postgres:5432/vsigma');
  });

  it('URL-encodes user/password and honors DB_HOST/DB_PORT overrides', () => {
    const c = loadConfig({
      ...partEnv,
      DB_HOST: 'db.internal',
      DB_PORT: '5433',
      POSTGRES_USER: 'u ser',
      POSTGRES_PASSWORD: 'p@ss:w/rd',
    });
    expect(c.databaseUrl).toBe('postgres://u%20ser:p%40ss%3Aw%2Frd@db.internal:5433/vsigma');
  });

  it('fails loud naming each missing part and the balena fix path', () => {
    const { POSTGRES_USER: _u, POSTGRES_PASSWORD: _p, ...env } = partEnv;
    expect(() => loadConfig(env)).toThrow(
      /DATABASE_URL is unset and required part\(s\) are missing: POSTGRES_USER, POSTGRES_PASSWORD — set each as a balena fleet\/service variable/,
    );
  });

  it('treats empty or whitespace-only parts as missing', () => {
    expect(() => loadConfig({ ...partEnv, POSTGRES_PASSWORD: '   ' })).toThrow(
      /required part\(s\) are missing: POSTGRES_PASSWORD/,
    );
  });

  it('DATABASE_URL set overrides the parts entirely', () => {
    const c = loadConfig({ ...partEnv, DATABASE_URL: 'postgres://external.example.com:5432/other' });
    expect(c.databaseUrl).toBe('postgres://external.example.com:5432/other');
  });

  it('DATABASE_URL set but empty fails loud naming the variable', () => {
    expect(() => loadConfig({ ...partEnv, DATABASE_URL: '   ' })).toThrow(
      /DATABASE_URL is set but empty/,
    );
  });
});
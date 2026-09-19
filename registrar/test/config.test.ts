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

  it('still requires DATABASE_URL with no default', () => {
    const { DATABASE_URL: _omitted, ...envWithoutDb } = validEnv;
    expect(() => loadConfig(envWithoutDb)).toThrow(/invalid registrar configuration/);
  });
});
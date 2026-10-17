import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

describe('A2A sender identity-key invariant', () => {
  it('wires all shipped Hermes peer senders to the own identity key', () => {
    for (const file of [
      'deploy/vs-a2a-wiring.sh',
      'balena/devices/agent/vs-a2a-wiring.sh',
      'balena/registrar/vs-a2a-wiring.sh',
    ]) {
      const source = read(file);
      expect(source).toContain('"auth": {"type": "bearer", "token": "${A2A_OWN_IDENTITY_KEY}"}');
      expect(source).not.toMatch(/"auth"\s*:\s*\{[^}]*GATEWAY_API_KEY/s);
      expect(source).not.toMatch(/"auth"\s*:\s*\{[^}]*LITELLM_MASTER_KEY/s);
    }
  });

  it('authenticates the E2E A2A message/send with bundle identity, never a gateway key', () => {
    const source = read('deploy/e2e.sh');
    const start = source.indexOf('# 5. the round-trip: message/send');
    const end = source.indexOf('reply="$(head -c 600 /tmp/ac14-rpc.json', start);
    const send = source.slice(start, end);
    expect(send).toContain('a2a_identity');
    expect(send).toContain('identity_key');
    expect(send).toContain('Authorization: Bearer $a2a_identity');
    expect(send).not.toMatch(/Authorization: Bearer \$?(?:LITELLM_MASTER_KEY|GATEWAY_API_KEY)/);
    expect(send).not.toMatch(/(?:LITELLM_MASTER_KEY|GATEWAY_API_KEY).*Authorization/);
  });
});

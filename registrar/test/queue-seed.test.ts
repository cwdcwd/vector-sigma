import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Queue-seed contract guard (fleet-ops-1py.2).
 *
 * balena/registrar/queue-seed/ holds the VS queue's opening board as
 * repo artifacts: initial-beads.json (the bd create --graph seed — the
 * ONLY fleet-verified hierarchy format: bd create -f silently drops
 * parent links and rejects --dry-run) + README.md (the one-time run
 * procedure primus executes). The seed is primus's to run, once, with
 * his baked bd — this guard pins the JSON's shape so nothing drifts
 * between review and the seed run:
 *
 *   1. --graph schema: top-level nodes (+ empty edges), commit_message
 *      present; every node has key/title/type/description; parent_key
 *      only ever references a key defined in the same file.
 *   2. The board shape: four umbrella epics per active workstream
 *      (area: labels, primus-assigned, P2) + the four deferred lanes
 *      as children (queue/registrar/devices/ops coverage).
 *   3. Honest attribution: the graph JSON never carries credentials
 *      (the password arrives via BEADS_DOLT_PASSWORD, never baked).
 *   4. The README documents the one-time run: dry-run first, verify
 *      per-node with bd show, never bd init, actor=primus.
 *   5. The maintainer designation files (MAINTAINERS.md names
 *      vectorsigma-primus[bot]; CODEOWNERS is advisory-only in-file —
 *      bots cannot resolve as code owners).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const seedDir = path.join(repoRoot, 'balena/registrar/queue-seed');

interface SeedNode {
  key: string;
  title: string;
  type: string;
  priority: number;
  labels: string[];
  assignee?: string;
  parent_key?: string;
  description: string;
}

const seedRaw = readFileSync(path.join(seedDir, 'initial-beads.json'), 'utf8');
const seed = JSON.parse(seedRaw) as {
  commit_message?: unknown;
  nodes: SeedNode[];
  edges: unknown[];
};
const nodes = seed.nodes;
const epics = nodes.filter((n) => n.type === 'epic');
const lanes = nodes.filter((n) => n.type !== 'epic');

describe('queue seed contract (fleet-ops-1py.2)', () => {
  it('is a bd --graph plan: commit_message + nodes, edges array present', () => {
    expect(typeof seed.commit_message).toBe('string');
    expect(seed.commit_message).not.toBe('');
    expect(Array.isArray(seed.nodes)).toBe(true);
    expect(Array.isArray(seed.edges)).toBe(true);
    // The -f markdown format's silent-parent-drop is why this file is
    // JSON; the edges array stays empty (parent_key carries hierarchy).
    expect(seed.edges).toEqual([]);
  });

  it('every node carries the full field set; parent_key references exist', () => {
    const keys = new Set(nodes.map((n) => n.key));
    expect(keys.size).toBe(nodes.length); // no duplicate keys
    for (const n of nodes) {
      expect(n.key, `node ${n.title} missing key`).toBeTruthy();
      expect(n.title).toBeTruthy();
      expect(n.type).toBeTruthy();
      expect(n.priority).toBeGreaterThanOrEqual(0);
      expect(n.priority).toBeLessThanOrEqual(4); // bd 0-4/P0-P4
      expect(Array.isArray(n.labels)).toBe(true);
      expect(n.description).toBeTruthy();
    }
    for (const n of nodes) {
      if (n.parent_key) {
        expect(
          keys.has(n.parent_key),
          `node ${n.key} parents unknown key ${n.parent_key}`,
        ).toBe(true);
      }
    }
  });

  it('four umbrella epics, one per active workstream, primus-assigned, staying open', () => {
    expect(epics).toHaveLength(4);
    const areas = new Set(epics.map((n) => n.labels.find((l) => l.startsWith('area:'))));
    expect(areas.has('area:queue')).toBe(true);
    expect(areas.has('area:registrar')).toBe(true);
    expect(areas.has('area:devices')).toBe(true);
    expect(areas.has('area:infra')).toBe(true);
    for (const e of epics) {
      expect(e.assignee).toBe('primus'); // the curator owns the umbrellas
      expect(e.parent_key).toBeUndefined(); // umbrellas are top-level
      expect(e.description).toMatch(/UMBRELLA STAYS OPEN/); // never close on child completion
    }
  });

  it('the four deferred lanes are children with real parents and content', () => {
    expect(lanes).toHaveLength(4);
    for (const l of lanes) {
      expect(l.parent_key).toBeTruthy();
      expect(epics.map((e) => e.key)).toContain(l.parent_key!);
    }
    // Lane identity anchors (the fleet contract references).
    const joined = JSON.stringify(nodes);
    expect(joined).toContain('vs-dolt-true-rotation');
    expect(joined).toContain('vs-ntp-clock-gate');
    expect(joined).toContain('vs-devices-runtime-swap');
    expect(joined).toContain('vs-device-onboarding-runbook');
    // Owner-call lanes route to the owner, never agent self-service.
    const rotation = nodes.find((n) => n.key === 'lane-dolt-rotation')!;
    expect(rotation.labels).toContain('owner-call');
    expect(rotation.assignee).toBe('lazybaer');
    const ntp = nodes.find((n) => n.key === 'lane-ntp-diagnostics')!;
    expect(ntp.labels).toContain('owner-call');
    expect(ntp.assignee).toBe('lazybaer');
  });

  it('carries the queue contract id and no credentials', () => {
    // The canonical project_id is the fleet contract (bcde5891-…);
    // the seed references it so primus cross-checks at run time.
    expect(seedRaw).toContain('bcde5891-5482-4eb0-a223-8533504832d6');
    // The password NEVER lives in the seed (BEADS_DOLT_PASSWORD is
    // env-delivered; a secret in the seed would be a repo leak).
    expect(seedRaw).not.toMatch(/BEADS_DOLT_PASSWORD\s*[:=]\s*\S+/);
    expect(seedRaw).not.toMatch(
      new RegExp("password[^\"'\\n]*[:=]\\s*[\"'][^\"']+[\"']", 'i'),
    );
  });

  it('README documents the one-time run: dry-run, bd-show verify, never init', () => {
    const readme = readFileSync(path.join(seedDir, 'README.md'), 'utf8');
    expect(readme).toMatch(/--dry-run/);
    expect(readme).toMatch(/bd create --graph/);
    expect(readme).toMatch(/bd show/); // trust bd show, not ASCII art
    expect(readme).toMatch(/never\s+runs?\s+`?bd init/i);
    expect(readme).toMatch(/actor/); // actor=primus attribution check
    expect(readme).toMatch(/backup\.enabled/); // b1r hook posture check
    // One-time: the README warns re-running duplicates the board.
    expect(readme).toMatch(/re-run(ning)? the seed/i);
  });

  it('MAINTAINERS.md names vectorsigma-primus[bot] with honest bot framing', () => {
    const maintainers = readFileSync(path.join(repoRoot, 'MAINTAINERS.md'), 'utf8');
    expect(maintainers).toContain('vectorsigma-primus[bot]');
    expect(maintainers).toContain('5137374'); // App VectorSigma-Primus id
    expect(maintainers).toMatch(/documented designation, not a GitHub-enforced role/i);
  });

  it('CODEOWNERS marks the bot entry advisory-only in-file (bots cannot gate)', () => {
    const codeowners = readFileSync(
      path.join(repoRoot, '.github/CODEOWNERS'),
      'utf8',
    );
    expect(codeowners).toMatch(/^\* @vectorsigma-primus\[bot\]$/m);
    expect(codeowners).toMatch(/ADVISORY-ONLY/i);
    expect(codeowners).toMatch(/require_code_owner_review/i); // the tripwire is named in-file
  });
});
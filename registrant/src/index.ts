import { loadConfig } from './config.js';
import { run } from './run.js';
import { SystemdTimesyncdProbe } from './clock-gate.js';

const config = loadConfig();
const result = await run(config, {
  clockProbe: new SystemdTimesyncdProbe(),
  fetchImpl: fetch,
});

if (result.kind === 'bootstrapped') {
  console.log(
    `[registrant] identity bootstrapped: bundle_version=${result.bundleVersion}`,
  );
} else if (result.kind === 'blocked') {
  // Unreachable in production (oneShot is never set there): the resident
  // grace poll keeps the process alive. Tests surface this kind directly.
  console.log(
    `[registrant] identity blocked: ${result.reason} (HTTP ${result.httpStatus}) — see ACTION REQUIRED above`,
  );
} else {
  console.log(
    `[registrant] identity present: bundle_version=${result.bundleVersion}`,
  );
}
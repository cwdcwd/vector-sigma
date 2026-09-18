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
} else {
  console.log(
    `[registrant] identity present: bundle_version=${result.bundleVersion}`,
  );
}
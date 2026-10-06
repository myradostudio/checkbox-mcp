// Runs the compiled test files with the built-in Node.js test runner.
//
// The files are passed explicitly instead of relying on `node --test` discovery:
// discovery rules differ between Node 20 and 22, and newer versions would also
// pick up the TypeScript sources in tests/, which are not runnable as they are.

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = readdirSync(new URL('../build-test/tests/', import.meta.url))
  .filter((file) => file.endsWith('.test.js'))
  .sort()
  .map((file) => `build-test/tests/${file}`);

if (files.length === 0) {
  console.error('No compiled tests found. Run `npm test`, which builds them first.');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);

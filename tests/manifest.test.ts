/**
 * Keeps the things that are easy to forget in sync: versions across
 * package.json, server.json and the code, the environment variables declared for
 * the MCP registry, and the tool and variable lists in both READMEs.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { DEFAULT_API_URL } from '../src/config.js';
import { readTools } from '../src/tools/read.js';
import { writeTools } from '../src/tools/write.js';
import { SERVER_VERSION } from '../src/version.js';

// Compiled to build-test/tests/, two levels below the repository root.
const ROOT = new URL('../../', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, ROOT), 'utf8');

const packageJson = JSON.parse(read('package.json'));
const serverJson = JSON.parse(read('server.json'));
const npmPackage = serverJson.packages[0];

const ENV_VARS = [...new Set(read('src/config.ts').match(/CHECKBOX_[A-Z_]+/g))].sort();

describe('package.json', () => {
  it('is the published package described in the README', () => {
    assert.equal(packageJson.name, '@myradostudio/checkbox-mcp');
    assert.equal(packageJson.version, SERVER_VERSION);
    assert.equal(packageJson.license, 'MIT');
    assert.equal(packageJson.author, 'Myrado Studio <hello@myradostudio.com>');
    assert.equal(packageJson.type, 'module');
    assert.deepEqual(packageJson.engines, { node: '>=20' });
    assert.equal(packageJson.publishConfig.access, 'public');
  });

  it('exposes one executable that exists after the build and starts with a shebang', () => {
    assert.deepEqual(packageJson.bin, { 'checkbox-mcp': 'dist/index.js' });
    assert.ok(existsSync(new URL('dist/index.js', ROOT)), 'run the build first');
    assert.ok(read('dist/index.js').startsWith('#!/usr/bin/env node\n'));
  });

  it('publishes only the build output and the documents', () => {
    assert.deepEqual(packageJson.files, [
      'dist',
      'server.json',
      'README.md',
      'README.uk.md',
      'CHANGELOG.md',
      'SECURITY.md',
      'LICENSE',
    ]);
    for (const file of packageJson.files) assert.ok(existsSync(new URL(file, ROOT)), `${file} is missing`);
  });

  it('has two runtime dependencies only', () => {
    assert.deepEqual(Object.keys(packageJson.dependencies).sort(), ['@modelcontextprotocol/server', 'zod']);
  });
});

describe('server.json', () => {
  it('matches package.json, which is how the registry verifies ownership', () => {
    assert.equal(serverJson.name, 'com.myradostudio/checkbox');
    assert.equal(serverJson.name, packageJson.mcpName);
    assert.equal(serverJson.version, packageJson.version);
    assert.equal(npmPackage.registryType, 'npm');
    assert.equal(npmPackage.identifier, packageJson.name);
    assert.equal(npmPackage.version, packageJson.version);
    assert.deepEqual(npmPackage.transport, { type: 'stdio' });
  });

  it('respects the limits of the registry schema', () => {
    assert.ok(serverJson.description.length <= 100, 'description is limited to 100 characters');
    assert.ok(serverJson.title.length <= 100);
    assert.match(serverJson.name, /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    assert.match(serverJson.$schema, /^https:\/\/static\.modelcontextprotocol\.io\/schemas\/\d{4}-\d{2}-\d{2}\/server\.schema\.json$/);
  });

  it('declares exactly the environment variables the server reads', () => {
    const declared = npmPackage.environmentVariables.map((variable: { name: string }) => variable.name).sort();
    assert.deepEqual(declared, ENV_VARS);
    assert.deepEqual(ENV_VARS, [
      'CHECKBOX_ALLOW_WRITE',
      'CHECKBOX_API_URL',
      'CHECKBOX_LICENSE_KEY',
      'CHECKBOX_LOGIN',
      'CHECKBOX_PASSWORD',
      'CHECKBOX_PIN_CODE',
    ]);
  });

  it('marks credentials as secrets and documents the defaults', () => {
    const variables = new Map<string, Record<string, unknown>>(
      npmPackage.environmentVariables.map((variable: { name: string }) => [variable.name, variable]),
    );
    for (const name of ['CHECKBOX_PASSWORD', 'CHECKBOX_PIN_CODE', 'CHECKBOX_LICENSE_KEY']) {
      assert.equal(variables.get(name)?.['isSecret'], true, name);
    }
    assert.equal(variables.get('CHECKBOX_API_URL')?.['default'], DEFAULT_API_URL);
    assert.equal(variables.get('CHECKBOX_ALLOW_WRITE')?.['default'], 'false');
  });
});

describe('documentation', () => {
  const tools = [...readTools, ...writeTools];

  for (const file of ['README.md', 'README.uk.md']) {
    it(`${file} lists every tool and every environment variable`, () => {
      const text = read(file);
      for (const tool of tools) assert.ok(text.includes(`\`${tool.name}\``), `${file} does not mention ${tool.name}`);
      for (const name of ENV_VARS) assert.ok(text.includes(`\`${name}\``), `${file} does not mention ${name}`);
    });

    it(`${file} documents no tool that does not exist`, () => {
      const documented = [...read(file).matchAll(/^\| `([a-z_]+)` \|/gm)].map((match) => match[1]);
      const known = new Set(tools.map((tool) => tool.name));
      assert.equal(documented.length, tools.length, 'one table row per tool');
      for (const name of documented) assert.ok(known.has(name ?? ''), `${file} documents unknown tool ${name}`);
    });
  }

  it('states that the project is unofficial, in both languages', () => {
    assert.match(read('README.md'), /not affiliated with or endorsed by Checkbox/);
    assert.match(read('README.uk.md'), /не пов’язаний|не пов'язаний/);
  });

  it('has a changelog entry for the current version and an MIT license for the studio', () => {
    assert.ok(read('CHANGELOG.md').includes(`## [${SERVER_VERSION}]`));
    assert.match(read('LICENSE'), /^MIT License\n\nCopyright \(c\) 2026 Myrado Studio\n/);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConfigError, DEFAULT_API_URL, loadConfig } from '../src/config.js';

function problemsOf(env: Record<string, string>): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError, 'expected a ConfigError');
    return error.problems;
  }
  assert.fail('expected the configuration to be rejected');
}

describe('loadConfig', () => {
  it('accepts login and password, defaulting to production and read-only', () => {
    const config = loadConfig({ CHECKBOX_LOGIN: 'cashier', CHECKBOX_PASSWORD: 'secret' });
    assert.deepEqual(config.auth, { method: 'password', login: 'cashier', password: 'secret' });
    assert.equal(config.apiUrl, DEFAULT_API_URL);
    assert.equal(config.apiUrl, 'https://api.checkbox.ua');
    assert.equal(config.allowWrite, false);
    assert.equal(config.licenseKey, undefined);
    assert.deepEqual(config.notices, []);
  });

  it('accepts a PIN code together with a license key', () => {
    const config = loadConfig({ CHECKBOX_PIN_CODE: '1234567890', CHECKBOX_LICENSE_KEY: 'license' });
    assert.deepEqual(config.auth, { method: 'pin', pinCode: '1234567890' });
    assert.equal(config.licenseKey, 'license');
  });

  it('prefers the PIN code when both methods are configured and says so', () => {
    const config = loadConfig({
      CHECKBOX_PIN_CODE: '1234567890',
      CHECKBOX_LICENSE_KEY: 'license',
      CHECKBOX_LOGIN: 'cashier',
      CHECKBOX_PASSWORD: 'secret',
    });
    assert.equal(config.auth.method, 'pin');
    assert.equal(config.notices.length, 1);
    assert.match(config.notices[0] ?? '', /signing in with the PIN code/);
  });

  it('treats blank values as unset and trims whitespace', () => {
    const config = loadConfig({
      CHECKBOX_LOGIN: '  cashier ',
      CHECKBOX_PASSWORD: 'secret',
      CHECKBOX_PIN_CODE: '   ',
      CHECKBOX_LICENSE_KEY: '',
      CHECKBOX_API_URL: '',
      CHECKBOX_ALLOW_WRITE: '',
    });
    assert.deepEqual(config.auth, { method: 'password', login: 'cashier', password: 'secret' });
    assert.equal(config.licenseKey, undefined);
    assert.equal(config.allowWrite, false);
  });

  it('does not alter a password that starts or ends with a space', () => {
    const config = loadConfig({ CHECKBOX_LOGIN: 'cashier', CHECKBOX_PASSWORD: ' pass word ' });
    assert.deepEqual(config.auth, { method: 'password', login: 'cashier', password: ' pass word ' });
  });

  it('rejects missing credentials with an actionable message', () => {
    const problems = problemsOf({});
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /CHECKBOX_PIN_CODE.*CHECKBOX_LICENSE_KEY.*CHECKBOX_LOGIN.*CHECKBOX_PASSWORD/);
  });

  it('rejects a login without a password and a password without a login', () => {
    assert.match(problemsOf({ CHECKBOX_LOGIN: 'cashier' })[0] ?? '', /must be set together/);
    assert.match(problemsOf({ CHECKBOX_PASSWORD: 'secret' })[0] ?? '', /must be set together/);
  });

  it('rejects a PIN code without a license key', () => {
    assert.match(problemsOf({ CHECKBOX_PIN_CODE: '1234567890' })[0] ?? '', /requires CHECKBOX_LICENSE_KEY/);
  });

  it('enables write tools only for an explicit truthy value', () => {
    const base = { CHECKBOX_LOGIN: 'cashier', CHECKBOX_PASSWORD: 'secret', CHECKBOX_LICENSE_KEY: 'license' };
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
      assert.equal(loadConfig({ ...base, CHECKBOX_ALLOW_WRITE: value }).allowWrite, true, value);
    }
    for (const value of ['0', 'false', 'no', 'off']) {
      assert.equal(loadConfig({ ...base, CHECKBOX_ALLOW_WRITE: value }).allowWrite, false, value);
    }
  });

  it('rejects an unrecognised CHECKBOX_ALLOW_WRITE instead of guessing', () => {
    const problems = problemsOf({ CHECKBOX_LOGIN: 'cashier', CHECKBOX_PASSWORD: 'secret', CHECKBOX_ALLOW_WRITE: 'maybe' });
    assert.match(problems[0] ?? '', /CHECKBOX_ALLOW_WRITE must be 1/);
  });

  it('requires a license key for write mode', () => {
    const problems = problemsOf({ CHECKBOX_LOGIN: 'cashier', CHECKBOX_PASSWORD: 'secret', CHECKBOX_ALLOW_WRITE: '1' });
    assert.match(problems[0] ?? '', /CHECKBOX_ALLOW_WRITE=1 requires CHECKBOX_LICENSE_KEY/);
  });

  it('normalises the API URL to its origin', () => {
    const config = loadConfig({
      CHECKBOX_LOGIN: 'cashier',
      CHECKBOX_PASSWORD: 'secret',
      CHECKBOX_API_URL: 'https://api.example.test/',
    });
    assert.equal(config.apiUrl, 'https://api.example.test');
  });

  it('allows plain http only for localhost', () => {
    const base = { CHECKBOX_LOGIN: 'cashier', CHECKBOX_PASSWORD: 'secret' };
    assert.equal(loadConfig({ ...base, CHECKBOX_API_URL: 'http://127.0.0.1:8080' }).apiUrl, 'http://127.0.0.1:8080');
    assert.equal(loadConfig({ ...base, CHECKBOX_API_URL: 'http://localhost:8080' }).apiUrl, 'http://localhost:8080');
    assert.match(problemsOf({ ...base, CHECKBOX_API_URL: 'http://api.example.test' })[0] ?? '', /must use https/);
  });

  it('rejects API URLs with a path, credentials or garbage', () => {
    const base = { CHECKBOX_LOGIN: 'cashier', CHECKBOX_PASSWORD: 'secret' };
    assert.match(problemsOf({ ...base, CHECKBOX_API_URL: 'https://api.checkbox.ua/api/v1' })[0] ?? '', /origin only/);
    assert.match(problemsOf({ ...base, CHECKBOX_API_URL: 'https://user:pass@api.checkbox.ua' })[0] ?? '', /credentials/);
    assert.match(problemsOf({ ...base, CHECKBOX_API_URL: 'not a url' })[0] ?? '', /not a valid URL/);
  });

  it('reports every problem at once and never echoes secret values', () => {
    const env = {
      CHECKBOX_LOGIN: 'cashier',
      CHECKBOX_API_URL: 'ftp://files.example.test',
      CHECKBOX_ALLOW_WRITE: 'sure',
      CHECKBOX_LICENSE_KEY: 'super-secret-license',
    };
    const problems = problemsOf(env);
    assert.equal(problems.length, 3);
    assert.ok(!problems.join('\n').includes('super-secret-license'));
  });
});

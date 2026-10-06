/**
 * Environment-based configuration.
 *
 * Everything is validated once at startup. Problems are collected and reported
 * together so a user fixing their MCP client config does not have to restart
 * the server once per mistake.
 */

export const DEFAULT_API_URL = 'https://api.checkbox.ua';
export const DEFAULT_TIMEOUT_MS = 30_000;

export type AuthConfig =
  | { readonly method: 'pin'; readonly pinCode: string }
  | { readonly method: 'password'; readonly login: string; readonly password: string };

export interface Config {
  /** API origin without a trailing slash, e.g. `https://api.checkbox.ua`. */
  readonly apiUrl: string;
  readonly auth: AuthConfig;
  /** Cash register license key (`X-License-Key`). */
  readonly licenseKey: string | undefined;
  /** When false (the default) no write tool is registered at all. */
  readonly allowWrite: boolean;
  readonly timeoutMs: number;
  /** Non-fatal remarks to print on stderr at startup. Never contain secrets. */
  readonly notices: readonly string[];
}

export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['', '0', 'false', 'no', 'off']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Reads a variable, treating blank values (common in config templates) as unset. */
function read(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function parseApiUrl(raw: string | undefined, problems: string[]): string {
  if (raw === undefined) return DEFAULT_API_URL;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    problems.push(`CHECKBOX_API_URL is not a valid URL (expected something like ${DEFAULT_API_URL}).`);
    return DEFAULT_API_URL;
  }

  const isLoopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    problems.push('CHECKBOX_API_URL must use https:// (plain http:// is accepted only for localhost).');
  }
  if (url.username !== '' || url.password !== '') {
    problems.push('CHECKBOX_API_URL must not contain credentials.');
  }
  if (url.pathname.replace(/\/+$/, '') !== '' || url.search !== '' || url.hash !== '') {
    problems.push(
      `CHECKBOX_API_URL must be the API origin only, without a path or query (for example ${DEFAULT_API_URL}).`,
    );
  }
  return url.origin;
}

function parseAllowWrite(raw: string | undefined, problems: string[]): boolean {
  const value = (raw ?? '').toLowerCase();
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  // Fail closed and loudly: a typo must never silently enable or disable fiscal writes.
  problems.push('CHECKBOX_ALLOW_WRITE must be 1 (enable write tools) or 0 (read-only, the default).');
  return false;
}

/**
 * Builds the configuration from environment variables.
 * @throws {ConfigError} listing every problem found.
 */
export function loadConfig(env: Env): Config {
  const problems: string[] = [];
  const notices: string[] = [];

  const login = read(env, 'CHECKBOX_LOGIN');
  // Not trimmed: unlike the other values, a password may start or end with a space.
  const password = read(env, 'CHECKBOX_PASSWORD') === undefined ? undefined : env['CHECKBOX_PASSWORD'];
  const pinCode = read(env, 'CHECKBOX_PIN_CODE');
  const licenseKey = read(env, 'CHECKBOX_LICENSE_KEY');
  const apiUrl = parseApiUrl(read(env, 'CHECKBOX_API_URL'), problems);
  const allowWrite = parseAllowWrite(read(env, 'CHECKBOX_ALLOW_WRITE'), problems);

  let auth: AuthConfig | undefined;
  if (pinCode !== undefined) {
    if (licenseKey === undefined) {
      problems.push('CHECKBOX_PIN_CODE requires CHECKBOX_LICENSE_KEY (PIN sign-in is bound to a cash register).');
    }
    if (login !== undefined || password !== undefined) {
      notices.push('Both CHECKBOX_PIN_CODE and CHECKBOX_LOGIN/CHECKBOX_PASSWORD are set; signing in with the PIN code.');
    }
    auth = { method: 'pin', pinCode };
  } else if (login !== undefined && password !== undefined) {
    auth = { method: 'password', login, password };
  } else if (login !== undefined || password !== undefined) {
    problems.push('CHECKBOX_LOGIN and CHECKBOX_PASSWORD must be set together.');
  } else {
    problems.push(
      'No cashier credentials. Set CHECKBOX_PIN_CODE together with CHECKBOX_LICENSE_KEY, or CHECKBOX_LOGIN together with CHECKBOX_PASSWORD.',
    );
  }

  if (allowWrite && licenseKey === undefined) {
    problems.push('CHECKBOX_ALLOW_WRITE=1 requires CHECKBOX_LICENSE_KEY (a shift is opened on a specific cash register).');
  }

  if (problems.length > 0 || auth === undefined) {
    throw new ConfigError(problems);
  }

  return { apiUrl, auth, licenseKey, allowWrite, timeoutMs: DEFAULT_TIMEOUT_MS, notices };
}

/**
 * Minimal HTTP client for the Checkbox API.
 *
 * Responsibilities:
 *  - sign in lazily (PIN code or login/password) and keep the token in memory only;
 *  - re-authenticate once when the API answers 401 to an authenticated call, but
 *    never within a minute of the previous sign-in, so a 401 that is not about
 *    the token cannot burn through the cashier's token slots;
 *  - apply a timeout to every request and never follow redirects;
 *  - turn failures into typed errors whose messages never contain secrets.
 *
 * Nothing is logged here: request and response bodies can contain customer
 * contact data and must not end up in a log file.
 */

import type { Config } from './config.js';
import { ENDPOINTS, type Endpoint } from './endpoints.js';
import {
  CheckboxApiError,
  CheckboxTransportError,
  MissingLicenseKeyError,
  SignInError,
  UnexpectedResponseError,
} from './errors.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type QueryValue = string | number | boolean | readonly string[] | undefined;

export interface RequestOptions {
  readonly pathParams?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, QueryValue>>;
  /** JSON request body. Omitted entirely when undefined. */
  readonly body?: unknown;
}

export interface CheckboxClientOptions {
  readonly config: Config;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
  /** Injectable clock for tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

const SIGN_OUT_TIMEOUT_MS = 3_000;
/**
 * Checkbox documents HTTP 401 both for an invalid token and for an invalid license
 * key, and allows a cashier at most three valid tokens, removing older ones as new
 * ones are issued. A token that was issued less than a minute ago is therefore not
 * replaced on a 401: otherwise a wrong license key would sign in on every call and
 * push out the tokens of the cashier's other devices.
 */
const REAUTH_COOLDOWN_MS = 60_000;
const MAX_ERROR_BODY_CHARS = 500;
const REDACTED = '[redacted]';

export class CheckboxClient {
  private readonly config: Config;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private token: string | undefined;
  private lastSignInAt: number | undefined;
  private signInFlight: Promise<string> | undefined;
  private closing: Promise<void> | undefined;
  /** Every token of this process, so that a revoked one is still scrubbed from error texts. */
  private readonly issuedTokens = new Set<string>();

  constructor(options: CheckboxClientOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
  }

  /** Calls an API operation and returns the parsed JSON body (or the text body for text endpoints). */
  async request<T = unknown>(endpoint: Endpoint, options: RequestOptions = {}): Promise<T> {
    if (!endpoint.auth) {
      return this.parse<T>(endpoint, await this.send(endpoint, options, undefined));
    }

    const token = await this.getToken();
    let response = await this.send(endpoint, options, token);

    if (response.status === 401) {
      if (this.token === token) {
        // Nobody has replaced the rejected token yet: decide whether to sign in again.
        if (!this.canReauthenticate()) return this.parse<T>(endpoint, response);
        this.token = undefined;
      }
      // A 401 means the request was refused for authentication, so repeating it once
      // with a fresh token is safe even for write operations.
      discard(response);
      response = await this.send(endpoint, options, await this.getToken());
    }

    return this.parse<T>(endpoint, response);
  }

  /**
   * Ends the session: waits for a sign-in that is under way, revokes the token
   * (best effort) and refuses further authenticated requests. Never throws.
   */
  close(): Promise<void> {
    this.closing ??= this.revokeToken();
    return this.closing;
  }

  private async revokeToken(): Promise<void> {
    // Without this a token obtained by a sign-in still in flight would never be revoked.
    await this.signInFlight?.catch(() => undefined);

    const token = this.token;
    this.token = undefined;
    if (token === undefined) return;
    try {
      discard(await this.send(ENDPOINTS.signOut, {}, token, SIGN_OUT_TIMEOUT_MS));
    } catch {
      // The process is shutting down; there is nobody to report this to.
    }
  }

  private canReauthenticate(): boolean {
    return this.lastSignInAt === undefined || this.now() - this.lastSignInAt >= REAUTH_COOLDOWN_MS;
  }

  private getToken(): Promise<string> {
    if (this.closing !== undefined) {
      return Promise.reject(new Error('The server is shutting down; the request was not sent.'));
    }
    if (this.token !== undefined) return Promise.resolve(this.token);
    // Concurrent tool calls share one sign-in instead of each consuming a token slot.
    this.signInFlight ??= this.signIn().finally(() => {
      this.signInFlight = undefined;
    });
    return this.signInFlight;
  }

  private async signIn(): Promise<string> {
    const { auth } = this.config;
    const [endpoint, body] =
      auth.method === 'pin'
        ? ([ENDPOINTS.signInPinCode, { pin_code: auth.pinCode }] as const)
        : ([ENDPOINTS.signIn, { login: auth.login, password: auth.password }] as const);

    let result: unknown;
    try {
      result = await this.parse<unknown>(endpoint, await this.send(endpoint, { body }, undefined));
    } catch (error) {
      if (error instanceof CheckboxApiError) {
        throw new CheckboxApiError(error.status, `Sign-in failed: ${error.message}`, error.details);
      }
      throw error;
    }

    const token = (result as { access_token?: unknown } | null)?.access_token;
    if (typeof token !== 'string' || token === '') {
      throw new SignInError('Sign-in failed: the response of the Checkbox API did not contain an access token.');
    }
    this.token = token;
    this.lastSignInAt = this.now();
    this.issuedTokens.add(token);
    return token;
  }

  private async send(
    endpoint: Endpoint,
    options: RequestOptions,
    token: string | undefined,
    timeoutMs: number = this.config.timeoutMs,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: endpoint.response === 'text' ? 'text/plain' : 'application/json',
      'X-Client-Name': SERVER_NAME,
      'X-Client-Version': SERVER_VERSION,
    };
    if (token !== undefined) headers['Authorization'] = `Bearer ${token}`;

    if (endpoint.licenseKey !== 'none') {
      const { licenseKey } = this.config;
      if (licenseKey !== undefined) headers['X-License-Key'] = licenseKey;
      else if (endpoint.licenseKey === 'required') throw new MissingLicenseKeyError();
    }

    const url = buildUrl(this.config.apiUrl, endpoint, options);
    const init: RequestInit = {
      method: endpoint.method,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      // A redirect would forward the license key to another host, and a redirected
      // POST is repeated as a GET without its body. Neither may happen silently.
      redirect: 'manual',
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    try {
      return await this.fetchImpl(url, init);
    } catch (error) {
      throw this.toTransportError(endpoint, error, timeoutMs);
    }
  }

  private async parse<T>(endpoint: Endpoint, response: Response): Promise<T> {
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      // The headers arrived but the body did not: the timeout or the connection cut it off.
      throw this.toTransportError(endpoint, error, this.config.timeoutMs);
    }

    if (response.status >= 300 && response.status < 400) {
      throw new UnexpectedResponseError(
        `${endpoint.method} ${endpoint.path} was answered with a redirect (HTTP ${response.status}), which the server does not follow. Check that CHECKBOX_API_URL is the API origin itself.`,
      );
    }
    if (!response.ok) {
      throw this.toApiError(response.status, response.statusText, text);
    }
    if (endpoint.response === 'text') {
      return text as T;
    }
    if (text.trim() === '') {
      return null as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new UnexpectedResponseError(
        `${endpoint.method} ${endpoint.path} was answered with HTTP ${response.status} and a body that is not valid JSON.`,
      );
    }
  }

  private toTransportError(endpoint: Endpoint, error: unknown, timeoutMs: number): CheckboxTransportError {
    const operation = `${endpoint.method} ${endpoint.path}`;
    if (isTimeout(error)) {
      return new CheckboxTransportError('timeout', `${operation} timed out after ${timeoutMs / 1000} s.`);
    }
    return new CheckboxTransportError(
      'network',
      this.scrub(`${operation} failed: no usable response from ${this.config.apiUrl} (${networkCause(error)}).`),
    );
  }

  private toApiError(status: number, statusText: string, text: string): CheckboxApiError {
    // Scrub before truncating: a secret cut in half by the limit would no longer be recognised.
    let message = this.scrub(text.trim()).slice(0, MAX_ERROR_BODY_CHARS) || statusText || 'Empty error response.';
    let details: string[] = [];

    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === 'object') {
        const { message: apiMessage, detail } = parsed as { message?: unknown; detail?: unknown };
        details = formatValidationDetails(detail).map((line) => this.scrub(line));
        if (typeof apiMessage === 'string' && apiMessage !== '') {
          message = this.scrub(apiMessage).slice(0, MAX_ERROR_BODY_CHARS);
        } else if (details.length > 0) {
          message = 'Validation error.';
        }
      }
    } catch {
      // Not JSON (for example an HTML error page from a proxy): keep the truncated text.
    }

    return new CheckboxApiError(status, message, details);
  }

  /** Defence in depth: removes configured secrets from any text that leaves the client. */
  private scrub(text: string): string {
    const { auth, licenseKey } = this.config;
    const secrets = [auth.method === 'pin' ? auth.pinCode : auth.password, licenseKey, ...this.issuedTokens].filter(
      (secret): secret is string => secret !== undefined && secret.length >= 4,
    );

    let result = text;
    for (const secret of secrets) result = result.split(secret).join(REDACTED);
    return result;
  }
}

/** Releases the connection of a response whose body is not needed, without waiting for it. */
function discard(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

function buildUrl(apiUrl: string, endpoint: Endpoint, options: RequestOptions): string {
  const path = endpoint.path.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = options.pathParams?.[name];
    if (value === undefined || value === '') {
      throw new Error(`Missing path parameter "${name}" for ${endpoint.path}.`);
    }
    // encodeURIComponent leaves dots alone, and URL parsing would resolve "." and ".."
    // as path segments, redirecting the request to a different endpoint.
    if (value === '.' || value === '..') {
      throw new Error(`Invalid value for path parameter "${name}".`);
    }
    return encodeURIComponent(value);
  });

  const url = new URL(apiUrl + path);
  for (const [name, value] of Object.entries(options.query ?? {})) {
    if (value === undefined) continue;
    if (typeof value === 'object') {
      // Array filters are sent as repeated keys: ?shift_id=a&shift_id=b
      for (const item of value) url.searchParams.append(name, item);
    } else {
      url.searchParams.append(name, String(value));
    }
  }
  return url.toString();
}

/** Formats `detail` of a 422 response. Only `loc` and `msg` are used: other fields may echo request data. */
function formatValidationDetails(detail: unknown): string[] {
  if (!Array.isArray(detail)) return [];
  const lines: string[] = [];
  for (const item of detail) {
    if (item === null || typeof item !== 'object') continue;
    const { loc, msg } = item as { loc?: unknown; msg?: unknown };
    if (typeof msg !== 'string') continue;
    const path = Array.isArray(loc) ? loc.filter((part) => part !== 'body').join('.') : '';
    lines.push(path === '' ? msg : `${path}: ${msg}`);
  }
  return lines;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

function networkCause(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error';
  const cause = error.cause as { code?: unknown; message?: unknown } | undefined;
  if (typeof cause?.code === 'string') return cause.code;
  if (typeof cause?.message === 'string') return cause.message;
  return error.message;
}

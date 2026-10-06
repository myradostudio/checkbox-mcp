/**
 * Error types and the single place where an error becomes text for the model.
 *
 * Tool handlers never let a stack trace reach the MCP client: `describeError`
 * turns any thrown value into a short, actionable message.
 */

/** The API answered with a non-2xx status. */
export class CheckboxApiError extends Error {
  readonly status: number;
  /** Field-level validation problems (HTTP 422), already formatted as `path: message`. */
  readonly details: readonly string[];

  constructor(status: number, message: string, details: readonly string[] = []) {
    super(message);
    this.name = 'CheckboxApiError';
    this.status = status;
    this.details = details;
  }
}

/** No usable HTTP response: the request timed out or the network failed. */
export class CheckboxTransportError extends Error {
  readonly kind: 'timeout' | 'network';

  constructor(kind: 'timeout' | 'network', message: string) {
    super(message);
    this.name = 'CheckboxTransportError';
    this.kind = kind;
  }
}

/**
 * A response arrived but cannot be interpreted: a redirect, or a success status
 * with a body that is not JSON. For a write this leaves the outcome unknown.
 */
export class UnexpectedResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnexpectedResponseError';
  }
}

/** Sign-in did not produce a token, so the actual request was never sent. */
export class SignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignInError';
  }
}

/** A tool needs `X-License-Key` but CHECKBOX_LICENSE_KEY is not configured. */
export class MissingLicenseKeyError extends Error {
  constructor() {
    super(
      'This operation needs the cash register license key. Set CHECKBOX_LICENSE_KEY in the MCP server configuration and restart the server.',
    );
    this.name = 'MissingLicenseKeyError';
  }
}

/** A problem the tool itself detected (bad combination of arguments, unexpected response shape). */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

// HTTP statuses documented in the Checkbox wiki error table (https://wiki.checkbox.ua/uk/api).
const STATUS_HINTS: Readonly<Record<number, string>> = {
  401: 'Checkbox rejected the access token or the license key. Check the cashier credentials and CHECKBOX_LICENSE_KEY.',
  403: 'Checkbox refused the operation for this cashier, cash register or organization (wrong credentials, missing permission, blocked or deactivated account).',
  429: 'Rate limit reached or the object is still being processed. Wait a few seconds before retrying.',
};

export function describeError(error: unknown): string {
  if (error instanceof CheckboxApiError) {
    const lines = [`Checkbox API error (HTTP ${error.status}): ${error.message}`];
    for (const detail of error.details) lines.push(`  - ${detail}`);
    const hint = STATUS_HINTS[error.status];
    if (hint !== undefined) lines.push(hint);
    return lines.join('\n');
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unexpected error.';
}

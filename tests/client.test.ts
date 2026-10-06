import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CheckboxClient, type FetchLike } from '../src/client.js';
import { ENDPOINTS } from '../src/endpoints.js';
import { CheckboxApiError, CheckboxTransportError, MissingLicenseKeyError, describeError } from '../src/errors.js';
import { SERVER_NAME, SERVER_VERSION } from '../src/version.js';
import { FakeApi, hang, json, text } from './support/fake-api.js';
import { LICENSE_KEY, PASSWORD, PIN_AUTH, PIN_CODE, testConfig } from './support/harness.js';
import { assertMatchesSpec } from './support/spec.js';

const ME = '/api/v1/cashier/me';

function setup(overrides: Parameters<typeof testConfig>[0] = {}, now?: () => number) {
  const api = new FakeApi();
  const config = testConfig(overrides);
  const client = new CheckboxClient({ config, fetch: api.fetch, ...(now ? { now } : {}) });
  return { api, client, config };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected the promise to reject');
}

describe('authentication', () => {
  it('signs in with login and password on first use and sends the bearer token', async () => {
    const { api, client } = setup();
    api.on('GET', ME, json({ id: 'cashier-1' }));

    assert.deepEqual(await client.request(ENDPOINTS.cashierProfile), { id: 'cashier-1' });

    const [signIn, me] = api.requests;
    assert.equal(api.requests.length, 2);
    assert.equal(assertMatchesSpec(signIn!), 'POST /api/v1/cashier/signin');
    assert.deepEqual(signIn!.body, { login: 'cashier_login', password: PASSWORD });
    assert.equal(signIn!.headers['x-license-key'], undefined);
    assert.equal(assertMatchesSpec(me!), 'GET /api/v1/cashier/me');
    assert.equal(me!.headers['authorization'], 'Bearer token-1');
  });

  it('signs in with a PIN code and the license key header', async () => {
    const { api, client } = setup({ auth: PIN_AUTH });
    api.on('GET', ME, json({}));

    await client.request(ENDPOINTS.cashierProfile);

    const signIn = api.requests[0]!;
    assert.equal(assertMatchesSpec(signIn), 'POST /api/v1/cashier/signinPinCode');
    assert.deepEqual(signIn.body, { pin_code: PIN_CODE });
    assert.equal(signIn.headers['x-license-key'], LICENSE_KEY);
  });

  it('identifies itself to Checkbox on every request', async () => {
    const { api, client } = setup();
    api.on('GET', ME, json({}));

    await client.request(ENDPOINTS.cashierProfile);

    for (const request of api.requests) {
      assert.equal(request.headers['x-client-name'], SERVER_NAME);
      assert.equal(request.headers['x-client-version'], SERVER_VERSION);
    }
  });

  it('keeps the token in memory and reuses it', async () => {
    const { api, client } = setup();
    api.on('GET', ME, json({}));

    await client.request(ENDPOINTS.cashierProfile);
    await client.request(ENDPOINTS.cashierProfile);
    await client.request(ENDPOINTS.cashierProfile);

    assert.equal(api.signIns, 1);
    assert.deepEqual(
      api.callsTo(ME).map((request) => request.headers['authorization']),
      ['Bearer token-1', 'Bearer token-1', 'Bearer token-1'],
    );
  });

  it('shares one sign-in between concurrent requests', async () => {
    const { api, client } = setup();
    api.on('GET', ME, json({}));

    await Promise.all([
      client.request(ENDPOINTS.cashierProfile),
      client.request(ENDPOINTS.cashierProfile),
      client.request(ENDPOINTS.cashierProfile),
    ]);

    assert.equal(api.signIns, 1);
  });

  it('re-authenticates once on 401 and repeats the request with the new token', async () => {
    const { api, client } = setup();
    api.on('GET', ME, (request) =>
      request.headers['authorization'] === 'Bearer token-1'
        ? json({ message: 'Невірний токен доступу' }, 401)
        : json({ id: 'cashier-1' }),
    );

    assert.deepEqual(await client.request(ENDPOINTS.cashierProfile), { id: 'cashier-1' });

    assert.equal(api.signIns, 2);
    assert.deepEqual(
      api.callsTo(ME).map((request) => request.headers['authorization']),
      ['Bearer token-1', 'Bearer token-2'],
    );
  });

  it('repeats a write request after 401 with the same body', async () => {
    const { api, client } = setup();
    api.on('POST', '/api/v1/receipts/service', (request) =>
      request.headers['authorization'] === 'Bearer token-1' ? json({ message: 'expired' }, 401) : json({ id: 'r1' }, 201),
    );
    const body = { id: '5b0e0f0a-1c1d-4e2f-8a3b-4c5d6e7f8a9b', payment: { type: 'CASH', value: 100 } };

    await client.request(ENDPOINTS.serviceReceipt, { body });

    const calls = api.callsTo('/api/v1/receipts/service');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0]!.body, body);
    assert.deepEqual(calls[1]!.body, body);
  });

  it('gives up after a second 401 instead of looping', async () => {
    const { api, client } = setup();
    api.on('GET', ME, json({ message: 'Невірний ключ ліцензії' }, 401));

    const error = await rejection(client.request(ENDPOINTS.cashierProfile));

    assert.ok(error instanceof CheckboxApiError);
    assert.equal(error.status, 401);
    assert.equal(api.signIns, 2);
    assert.equal(api.callsTo(ME).length, 2);
  });

  it('does not sign in again on every 401 within the cooldown', async () => {
    let clock = 1_000_000;
    const { api, client } = setup({}, () => clock);
    api.on('GET', ME, json({ message: 'Невірний ключ ліцензії' }, 401));

    await rejection(client.request(ENDPOINTS.cashierProfile));
    assert.equal(api.signIns, 2);

    // Still inside the cooldown: the 401 is reported, no token slot is consumed.
    clock += 30_000;
    await rejection(client.request(ENDPOINTS.cashierProfile));
    await rejection(client.request(ENDPOINTS.cashierProfile));
    assert.equal(api.signIns, 2);

    // After the cooldown one more attempt is allowed.
    clock += 31_000;
    await rejection(client.request(ENDPOINTS.cashierProfile));
    assert.equal(api.signIns, 3);
  });

  it('recovers concurrent requests that all hit the same revoked token', async () => {
    const { api, client } = setup();
    api.on('GET', ME, json({}));
    await client.request(ENDPOINTS.cashierProfile);

    api.on('GET', ME, (request) =>
      request.headers['authorization'] === 'Bearer token-1' ? json({ message: 'revoked' }, 401) : json({ ok: true }),
    );
    const results = await Promise.all([
      client.request(ENDPOINTS.cashierProfile),
      client.request(ENDPOINTS.cashierProfile),
    ]);

    assert.deepEqual(results, [{ ok: true }, { ok: true }]);
    assert.equal(api.signIns, 2);
  });

  it('reports a failed sign-in with the API message', async () => {
    const { api, client } = setup();
    api.on('POST', '/api/v1/cashier/signin', json({ message: 'Невірні дані' }, 403));

    const error = await rejection(client.request(ENDPOINTS.cashierProfile));

    assert.ok(error instanceof CheckboxApiError);
    assert.equal(error.status, 403);
    assert.equal(error.message, 'Sign-in failed: Невірні дані');
    assert.equal(api.callsTo(ME).length, 0);
  });

  it('rejects a sign-in response without a token', async () => {
    const { api, client } = setup();
    api.on('POST', '/api/v1/cashier/signin', json({ token_type: 'bearer' }));

    const error = await rejection(client.request(ENDPOINTS.cashierProfile));

    assert.match((error as Error).message, /^Sign-in failed: .* did not contain an access token.$/);
    assert.equal(api.callsTo(ME).length, 0);
  });

  it('does not sign in for operations that are not secured', async () => {
    const { api, client } = setup();
    api.on('GET', '/api/v1/cash-registers/info', json({ id: 'register' }));

    await client.request(ENDPOINTS.cashRegisterInfo);

    assert.equal(api.signIns, 0);
    const request = api.requests[0]!;
    assert.equal(assertMatchesSpec(request), 'GET /api/v1/cash-registers/info');
    assert.equal(request.headers['authorization'], undefined);
    assert.equal(request.headers['x-license-key'], LICENSE_KEY);
  });

  it('fails before any request when a required license key is not configured', async () => {
    const { api, client } = setup({ licenseKey: undefined });

    const error = await rejection(client.request(ENDPOINTS.cashRegisterInfo));

    assert.ok(error instanceof MissingLicenseKeyError);
    assert.match(error.message, /CHECKBOX_LICENSE_KEY/);
    assert.equal(api.requests.length, 0);
  });

  it('sends an optional license key only when configured', async () => {
    const withKey = setup();
    withKey.api.on('GET', '/api/v1/orders', json({ results: [] }));
    await withKey.client.request(ENDPOINTS.orders);
    assert.equal(withKey.api.callsTo('/api/v1/orders')[0]!.headers['x-license-key'], LICENSE_KEY);

    const withoutKey = setup({ licenseKey: undefined });
    withoutKey.api.on('GET', '/api/v1/orders', json({ results: [] }));
    await withoutKey.client.request(ENDPOINTS.orders);
    assert.equal(withoutKey.api.callsTo('/api/v1/orders')[0]!.headers['x-license-key'], undefined);
  });
});

describe('sign-out', () => {
  it('revokes the token and forgets it', async () => {
    const { api, client } = setup();
    api.on('GET', ME, json({}));
    api.on('POST', '/api/v1/cashier/signout', new Response(null, { status: 205 }));
    await client.request(ENDPOINTS.cashierProfile);

    await client.signOut();

    const signOut = api.callsTo('/api/v1/cashier/signout');
    assert.equal(signOut.length, 1);
    assert.equal(assertMatchesSpec(signOut[0]!), 'POST /api/v1/cashier/signout');
    assert.equal(signOut[0]!.headers['authorization'], 'Bearer token-1');

    await client.request(ENDPOINTS.cashierProfile);
    assert.equal(api.signIns, 2, 'a later request signs in again');
  });

  it('does nothing when no token was ever obtained', async () => {
    const { api, client } = setup();
    await client.signOut();
    assert.equal(api.requests.length, 0);
  });

  it('never throws, even when the API is unreachable', async () => {
    const { api, client } = setup();
    api.on('GET', ME, json({}));
    api.on('POST', '/api/v1/cashier/signout', () => {
      throw new TypeError('fetch failed');
    });
    await client.request(ENDPOINTS.cashierProfile);

    await client.signOut();
  });
});

describe('requests', () => {
  it('encodes path parameters and repeats array query parameters', async () => {
    const { api, client } = setup();
    api.on('GET', /^\/api\/v1\/orders\//, json({}));
    api.on('GET', '/api/v1/shifts', json({ results: [] }));

    await client.request(ENDPOINTS.order, { pathParams: { order_id: '../cashier/me?x=1' } });
    await client.request(ENDPOINTS.shifts, {
      query: { statuses: ['OPENED', 'CLOSED'], desc: true, limit: 10, from_date: undefined },
    });

    const [order] = api.callsTo(/orders/);
    assert.equal(order!.url.pathname, '/api/v1/orders/..%2Fcashier%2Fme%3Fx%3D1');
    const [shifts] = api.callsTo('/api/v1/shifts');
    assert.equal(shifts!.url.search, '?statuses=OPENED&statuses=CLOSED&desc=true&limit=10');
  });

  it('refuses to build a URL with a missing path parameter', async () => {
    const { client } = setup();
    const error = await rejection(client.request(ENDPOINTS.shift, { pathParams: {} }));
    assert.equal((error as Error).message, 'Missing path parameter "shift_id" for /api/v1/shifts/{shift_id}.');
  });

  it('refuses dot segments that would redirect the request to another endpoint', async () => {
    const { api, client } = setup();
    for (const value of ['.', '..']) {
      const error = await rejection(client.request(ENDPOINTS.order, { pathParams: { order_id: value } }));
      assert.equal((error as Error).message, 'Invalid value for path parameter "order_id".');
    }
    assert.equal(api.callsTo(/orders/).length, 0);
  });

  it('returns text for text endpoints and null for empty JSON bodies', async () => {
    const { api, client } = setup();
    api.on('GET', /\/text$/, text('ТОВ "ТЕСТ"\nСУМА 135.00'));
    api.on('POST', /\/email$/, new Response('', { status: 200 }));

    const receiptText = await client.request(ENDPOINTS.receiptText, {
      pathParams: { receipt_id: '5b0e0f0a-1c1d-4e2f-8a3b-4c5d6e7f8a9b' },
    });
    const sent = await client.request(ENDPOINTS.receiptEmail, {
      pathParams: { receipt_id: '5b0e0f0a-1c1d-4e2f-8a3b-4c5d6e7f8a9b' },
      body: ['a@example.com'],
    });

    assert.equal(receiptText, 'ТОВ "ТЕСТ"\nСУМА 135.00');
    assert.equal(sent, null);
    assert.equal(api.callsTo(/\/text$/)[0]!.headers['accept'], 'text/plain');
  });

  it('sends no body and no content type when there is nothing to send', async () => {
    const { api, client } = setup();
    api.on('POST', '/api/v1/shifts/close', json({ id: 's1', status: 'CLOSING' }, 202));

    await client.request(ENDPOINTS.closeShift);

    const [close] = api.callsTo('/api/v1/shifts/close');
    assert.equal(close!.body, undefined);
    assert.equal(close!.headers['content-type'], undefined);
  });
});

describe('error mapping', () => {
  it('uses the message of the API error body', async () => {
    const { api, client } = setup();
    api.on('GET', ME, json({ message: 'Зміну не відкрито' }, 400));

    const error = await rejection(client.request(ENDPOINTS.cashierProfile));

    assert.ok(error instanceof CheckboxApiError);
    assert.equal(error.status, 400);
    assert.equal(error.message, 'Зміну не відкрито');
    assert.equal(describeError(error), 'Checkbox API error (HTTP 400): Зміну не відкрито');
  });

  it('lists validation details of a 422 without echoing submitted values', async () => {
    const { api, client } = setup();
    api.on(
      'POST',
      '/api/v1/receipts/sell',
      json(
        {
          message: 'Validation error',
          detail: [
            { loc: ['body', 'goods', 0, 'good', 'price'], msg: 'ensure this value is greater than 0', type: 'value_error' },
            { loc: ['body', 'delivery', 'email'], msg: 'value is not a valid email address', input: 'client@example.com' },
          ],
        },
        422,
      ),
    );

    const error = await rejection(client.request(ENDPOINTS.sellReceipt, { body: {} }));

    assert.ok(error instanceof CheckboxApiError);
    assert.deepEqual(error.details, [
      'goods.0.good.price: ensure this value is greater than 0',
      'delivery.email: value is not a valid email address',
    ]);
    const description = describeError(error);
    assert.match(description, /^Checkbox API error \(HTTP 422\): Validation error\n {2}- goods\.0\.good\.price/);
    assert.ok(!description.includes('client@example.com'));
  });

  it('adds a hint for 401, 403 and 429', async () => {
    assert.match(describeError(new CheckboxApiError(401, 'x')), /cashier credentials and CHECKBOX_LICENSE_KEY/);
    assert.match(describeError(new CheckboxApiError(403, 'x')), /refused the operation/);
    assert.match(describeError(new CheckboxApiError(429, 'x')), /Wait a few seconds/);
  });

  it('truncates a non-JSON error body', async () => {
    const { api, client } = setup();
    api.on('GET', ME, text(`<html>${'x'.repeat(5000)}</html>`, 502));

    const error = await rejection(client.request(ENDPOINTS.cashierProfile));

    assert.ok(error instanceof CheckboxApiError);
    assert.equal(error.status, 502);
    assert.ok(error.message.length <= 500);
  });

  it('rejects a successful response that is not JSON', async () => {
    const { api, client } = setup();
    api.on('GET', ME, text('<html>maintenance</html>'));

    const error = await rejection(client.request(ENDPOINTS.cashierProfile));

    assert.equal(
      (error as Error).message,
      'GET /api/v1/cashier/me: the Checkbox API answered with a body that is not valid JSON.',
    );
  });

  it('removes configured secrets and the token from error messages', async () => {
    const { api, client } = setup();
    api.on('GET', ME, (request) =>
      json({ message: `bad ${PASSWORD} ${LICENSE_KEY} ${request.headers['authorization']}` }, 400),
    );

    const error = await rejection(client.request(ENDPOINTS.cashierProfile));

    assert.equal((error as Error).message, 'bad [redacted] [redacted] Bearer [redacted]');
  });

  it('turns a timeout into a transport error', async () => {
    const hangingFetch: FetchLike = (_url, init) => hang(init);
    const client = new CheckboxClient({ config: testConfig({ timeoutMs: 20 }), fetch: hangingFetch });

    const error = await rejection(client.request(ENDPOINTS.cashRegisterInfo));

    assert.ok(error instanceof CheckboxTransportError);
    assert.equal(error.kind, 'timeout');
    assert.equal(error.message, 'GET /api/v1/cash-registers/info timed out after 0.02 s.');
  });

  it('turns a network failure into a transport error without a stack', async () => {
    const failingFetch: FetchLike = () =>
      Promise.reject(new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }) }));
    const client = new CheckboxClient({ config: testConfig(), fetch: failingFetch });

    const error = await rejection(client.request(ENDPOINTS.cashRegisterInfo));

    assert.ok(error instanceof CheckboxTransportError);
    assert.equal(error.kind, 'network');
    assert.equal(
      describeError(error),
      'GET /api/v1/cash-registers/info failed: could not reach https://api.checkbox.test (ENOTFOUND).',
    );
  });
});

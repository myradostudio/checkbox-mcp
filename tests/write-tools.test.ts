/**
 * Write tools: registered only with CHECKBOX_ALLOW_WRITE=1, and every request
 * they send is checked against the OpenAPI snapshot.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import type { FetchLike } from '../src/client.js';
import { FakeApi, hang, json, text, type RecordedRequest } from './support/fake-api.js';
import * as fx from './support/fixtures.js';
import { createHarness, LICENSE_KEY, type Harness } from './support/harness.js';
import { assertMatchesSpec } from './support/spec.js';

const WRITE_TOOLS = [
  'open_shift',
  'close_shift',
  'create_sale_receipt',
  'create_return_receipt',
  'create_service_receipt',
  'send_receipt_email',
  'send_receipt_sms',
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RECEIPT_ID = '0b7e2f6a-9d1c-4f3e-8a2b-5c6d7e8f9a0b';

let harness: Harness | undefined;

async function start(allowWrite = true, api = new FakeApi()): Promise<Harness> {
  harness = await createHarness({ allowWrite }, api);
  return harness;
}

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

function onlyRequest(h: Harness, operation: string): RecordedRequest {
  assert.equal(h.api.toolRequests.length, 1, 'expected exactly one API request');
  const request = h.api.toolRequests[0]!;
  assert.equal(assertMatchesSpec(request), operation);
  return request;
}

/** Echoes a created receipt the way the API does: the submitted id, status CREATED. */
function acceptReceipt(h: Harness, path: string, type: string, extra: Record<string, unknown> = {}): void {
  h.api.on('POST', path, (request) =>
    json({ ...fx.receipt, id: (request.body as { id: string }).id, type, status: 'CREATED', fiscal_code: null, ...extra }, 201),
  );
}

describe('write tools are opt-in', () => {
  it('are absent without CHECKBOX_ALLOW_WRITE', async () => {
    const h = await start(false);

    const { tools } = await h.mcp.listTools();
    const names = tools.map((tool) => tool.name);

    assert.equal(names.length, 16);
    for (const name of WRITE_TOOLS) assert.ok(!names.includes(name), `${name} must not be registered`);
    assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true));
  });

  it('cannot be called without CHECKBOX_ALLOW_WRITE', async () => {
    const h = await start(false);

    for (const name of WRITE_TOOLS) {
      const outcome = await h.mcp.callTool({ name, arguments: {} }).then(
        (result) => (result.isError === true ? 'refused' : 'executed'),
        () => 'refused',
      );
      assert.equal(outcome, 'refused', name);
    }
    assert.equal(h.api.requests.length, 0, 'nothing may reach the API');
  });

  it('are present with CHECKBOX_ALLOW_WRITE=1, next to the read tools', async () => {
    const h = await start(true);

    const { tools } = await h.mcp.listTools();
    const names = tools.map((tool) => tool.name);

    assert.equal(names.length, 23);
    for (const name of WRITE_TOOLS) assert.ok(names.includes(name), `${name} must be registered`);
  });
});

describe('shifts', () => {
  it('open_shift posts a generated id with the license key', async () => {
    const h = await start();
    h.api.on('POST', '/api/v1/shifts', (request) =>
      json({ ...fx.shift, id: (request.body as { id: string }).id, status: 'CREATED', opened_at: null }, 202),
    );

    const result = await h.call('open_shift');

    const request = onlyRequest(h, 'POST /api/v1/shifts');
    const { id } = request.body as { id: string };
    assert.match(id, UUID);
    assert.deepEqual(request.body, { id });
    assert.equal(request.headers['x-license-key'], LICENSE_KEY);
    assert.equal(result.isError, false);
    assert.match(result.text, new RegExp(`open shift ${id}`));
    assert.match(result.text, /"status": "CREATED"/);
  });

  it('open_shift and close_shift say how to check when the outcome is unknown', async () => {
    const h = await start();
    h.api.on('POST', '/api/v1/shifts', json({ message: 'Bad gateway' }, 502));
    h.api.on('POST', '/api/v1/shifts/close', json({ message: 'Bad gateway' }, 502));

    const opened = await h.call('open_shift', { id: fx.IDS.shift });
    const closed = await h.call('close_shift');

    for (const result of [opened, closed]) {
      assert.equal(result.isError, true);
      assert.ok(
        result.text.startsWith('Checkbox API error (HTTP 502): Bad gateway\nIt is unknown whether Checkbox registered the operation'),
        result.text,
      );
      assert.match(result.text, /get_current_shift/);
    }
    assert.ok(opened.text.includes(`with the same id ${fx.IDS.shift}`));
  });

  it('open_shift uses the id supplied by the caller', async () => {
    const h = await start();
    h.api.on('POST', '/api/v1/shifts', json({ ...fx.shift, id: fx.IDS.shift, status: 'CREATED' }, 202));

    await h.call('open_shift', { id: fx.IDS.shift });

    assert.deepEqual(onlyRequest(h, 'POST /api/v1/shifts').body, { id: fx.IDS.shift });
  });

  it('close_shift posts without a body so that Checkbox builds the Z-report', async () => {
    const h = await start();
    h.api.on('POST', '/api/v1/shifts/close', json({ ...fx.shift, status: 'CLOSING' }, 202));

    const result = await h.call('close_shift');

    const request = onlyRequest(h, 'POST /api/v1/shifts/close');
    assert.equal(request.body, undefined);
    assert.equal(request.headers['x-license-key'], undefined);
    assert.match(result.text, /"status": "CLOSING"/);
  });

  it('close_shift does not expose a way to skip the client-name check', async () => {
    const h = await start();

    const result = await h.call('close_shift', { skip_client_name_check: true });

    assert.equal(result.isError, true);
    assert.equal(h.api.requests.length, 0);
  });
});

describe('create_sale_receipt', () => {
  const sale = {
    goods: [
      { code: 'A1', name: 'Кава мелена 250 г', price: 13550, quantity: 2000, tax_codes: [8], barcode: '4820000000017' },
      { code: 'B2', name: 'Цукор', price: 4000, quantity: 500 },
    ],
    payments: [{ type: 'CASH', value: 29100 }],
  };

  it('maps the arguments to the ReceiptSellPayload of the spec', async () => {
    const h = await start();
    acceptReceipt(h, '/api/v1/receipts/sell', 'SELL');

    const result = await h.call('create_sale_receipt', sale);

    const request = onlyRequest(h, 'POST /api/v1/receipts/sell');
    const body = request.body as { id: string };
    assert.match(body.id, UUID);
    assert.deepEqual(body, {
      id: body.id,
      goods: [
        { good: { code: 'A1', name: 'Кава мелена 250 г', price: 13550, tax: [8], barcode: '4820000000017' }, quantity: 2000 },
        { good: { code: 'B2', name: 'Цукор', price: 4000 }, quantity: 500 },
      ],
      payments: [{ type: 'CASH', value: 29100 }],
    });
    assert.equal(result.isError, false);
    assert.match(result.text, new RegExp(`accepted receipt ${body.id} with status CREATED`));
    assert.match(result.text, /call get_receipt with this id until the status is DONE/);
  });

  it('passes through discounts, delivery, card details, rounding and texts', async () => {
    const h = await start();
    acceptReceipt(h, '/api/v1/receipts/sell', 'SELL');

    await h.call('create_sale_receipt', {
      id: RECEIPT_ID,
      goods: [
        {
          code: 'A1',
          name: 'Кава',
          price: 13550,
          quantity: 1000,
          tax_codes: [5, 2],
          uktzed: '0901',
          excise_barcodes: ['AENX936821'],
          good_id: fx.IDS.good,
          discounts: [{ type: 'DISCOUNT', mode: 'PERCENT', value: 10, name: 'Акція' }],
        },
      ],
      payments: [
        {
          type: 'CASHLESS',
          value: 11195,
          label: 'Картка',
          card_mask: 'XXXXXXXXXXXX6734',
          bank_name: 'Test Bank',
          auth_code: '078111',
          rrn: '305817547111',
          payment_system: 'VISA',
          terminal: 'S1LF0EUR',
          acquirer_and_seller: 'TB-0001',
          receipt_no: '15',
        },
      ],
      discounts: [{ type: 'DISCOUNT', mode: 'VALUE', value: 1000, tax_codes: [5] }],
      delivery: { email: 'customer@example.com', phone: '380501112233' },
      rounding_mode: 'ROUND_50',
      header: 'Дякуємо!',
      footer: 'Обмін протягом 14 днів',
    });

    const request = onlyRequest(h, 'POST /api/v1/receipts/sell');
    assert.deepEqual(request.body, {
      id: RECEIPT_ID,
      goods: [
        {
          good: { code: 'A1', name: 'Кава', price: 13550, tax: [5, 2], uktzed: '0901', excise_barcodes: ['AENX936821'] },
          good_id: fx.IDS.good,
          quantity: 1000,
          discounts: [{ type: 'DISCOUNT', mode: 'PERCENT', value: 10, name: 'Акція' }],
        },
      ],
      payments: [
        {
          type: 'CASHLESS',
          value: 11195,
          label: 'Картка',
          card_mask: 'XXXXXXXXXXXX6734',
          bank_name: 'Test Bank',
          auth_code: '078111',
          rrn: '305817547111',
          payment_system: 'VISA',
          terminal: 'S1LF0EUR',
          acquirer_and_seller: 'TB-0001',
          receipt_no: '15',
        },
      ],
      discounts: [{ type: 'DISCOUNT', mode: 'VALUE', value: 1000, tax_codes: [5] }],
      delivery: { email: 'customer@example.com', phone: '380501112233' },
      rounding_mode: 'ROUND_50',
      header: 'Дякуємо!',
      footer: 'Обмін протягом 14 днів',
    });
  });

  it('returns a summary and does not echo the customer contact', async () => {
    const h = await start();
    acceptReceipt(h, '/api/v1/receipts/sell', 'SELL');

    const result = await h.call('create_sale_receipt', { ...sale, delivery: { email: 'customer@example.com' } });

    assert.equal(result.isError, false);
    assert.match(result.text, /"total_sum": 13550/);
    assert.ok(!result.text.includes('customer@example.com'));
  });

  it('flags test receipts as non-fiscal', async () => {
    const h = await start();
    acceptReceipt(h, '/api/v1/receipts/sell', 'SELL', { is_test: true });

    const result = await h.call('create_sale_receipt', sale);

    assert.match(result.text, /test receipt \(is_test\): it is not a fiscal document/);
  });

  it('rejects unknown fields instead of dropping them', async () => {
    const h = await start();

    const topLevel = await h.call('create_sale_receipt', { ...sale, discount: [{ type: 'DISCOUNT', mode: 'VALUE', value: 500 }] });
    const nested = await h.call('create_sale_receipt', {
      ...sale,
      goods: [{ code: 'A1', name: 'Кава', price: 13550, qty: 1 }],
    });

    assert.equal(topLevel.isError, true);
    assert.equal(nested.isError, true);
    assert.equal(h.api.requests.length, 0, 'an invalid receipt must never reach the API');
  });

  it('rejects amounts that are not positive integers in kopecks', async () => {
    const h = await start();
    const withPrice = (price: unknown) => ({ ...sale, goods: [{ code: 'A1', name: 'Кава', price, quantity: 1000 }] });

    for (const price of [135.5, 0, -100, '13550', 100_000_000_000]) {
      const result = await h.call('create_sale_receipt', withPrice(price));
      assert.equal(result.isError, true, `price ${String(price)}`);
    }
    const noGoods = await h.call('create_sale_receipt', { ...sale, goods: [] });
    const noPayments = await h.call('create_sale_receipt', { ...sale, payments: [] });
    assert.equal(noGoods.isError, true);
    assert.equal(noPayments.isError, true);
    assert.equal(h.api.requests.length, 0);
  });

  it('rejects card details on a cash payment', async () => {
    const h = await start();

    const result = await h.call('create_sale_receipt', { ...sale, payments: [{ type: 'CASH', value: 29100, rrn: '305817547111' }] });

    assert.equal(result.isError, true);
    assert.equal(result.text, 'payments[0]: "rrn" is allowed only for CASHLESS payments.');
    assert.equal(h.api.requests.length, 0);
  });

  it('reports an API refusal as a tool error with the API message', async () => {
    const h = await start();
    h.api.on('POST', '/api/v1/receipts/sell', json({ message: 'Зміну не відкрито' }, 400));

    const result = await h.call('create_sale_receipt', sale);

    assert.equal(result.isError, true);
    assert.equal(result.text, 'Checkbox API error (HTTP 400): Зміну не відкрито');
  });

  it('on a timeout explains that the outcome is unknown and how to retry safely', async () => {
    const api = new FakeApi();
    const answer = api.fetch;
    const hangOnSell: FetchLike = (url, init) => (url.endsWith('/receipts/sell') ? hang(init) : answer(url, init));
    harness = await createHarness({ allowWrite: true, timeoutMs: 30 }, Object.assign(api, { fetch: hangOnSell }));

    const result = await harness.call('create_sale_receipt', { ...sale, id: RECEIPT_ID });

    assert.equal(result.isError, true);
    assert.match(result.text, /^POST \/api\/v1\/receipts\/sell timed out after 0\.03 s\.\n/);
    assert.match(result.text, /It is unknown whether Checkbox registered the operation\. Do not simply repeat the call\./);
    assert.match(result.text, new RegExp(`First call get_receipt with id ${RECEIPT_ID}`));
    assert.match(result.text, new RegExp(`again with the same id ${RECEIPT_ID}`));
  });

  it('treats gateway errors, 429 and unreadable answers as an unknown outcome too', async () => {
    // In all these cases Checkbox may have registered the receipt. A plain error would
    // invite a second call without the id, and with it a duplicate fiscal document.
    const answers: [string, () => Response][] = [
      ['HTTP 504', () => text('<html>Gateway Time-out</html>', 504)],
      ['HTTP 502', () => json({ message: 'Bad gateway' }, 502)],
      ['HTTP 429', () => json({ message: 'Too many requests' }, 429)],
      ['not valid JSON', () => text('<html>ok</html>', 201)],
      ['redirect', () => new Response(null, { status: 307, headers: { location: 'https://elsewhere.example/' } })],
    ];
    for (const [label, answer] of answers) {
      const h = await start();
      h.api.on('POST', '/api/v1/receipts/sell', answer);

      const result = await h.call('create_sale_receipt', sale);

      const { id } = h.api.callsTo('/api/v1/receipts/sell')[0]!.body as { id: string };
      assert.equal(result.isError, true, label);
      assert.ok(result.text.includes(label), `${label}: ${result.text}`);
      assert.match(result.text, /It is unknown whether Checkbox registered the operation/, label);
      assert.ok(result.text.includes(`again with the same id ${id}`), `${label}: names the generated id`);
      assert.equal(h.api.callsTo('/api/v1/receipts/sell').length, 1, `${label}: the server itself does not retry`);
      await h.close();
    }
    harness = undefined;
  });

  it('reports definite refusals without that warning', async () => {
    for (const status of [400, 403, 404, 422]) {
      const h = await start();
      h.api.on('POST', '/api/v1/receipts/sell', json({ message: 'Відмовлено' }, status));

      const result = await h.call('create_sale_receipt', sale);

      assert.equal(result.isError, true);
      assert.ok(result.text.startsWith(`Checkbox API error (HTTP ${status}): Відмовлено`), result.text);
      assert.doesNotMatch(result.text, /unknown whether/);
      await h.close();
    }
    harness = undefined;
  });
});

describe('create_return_receipt', () => {
  it('marks every line as a return and links the sale receipt', async () => {
    const h = await start();
    acceptReceipt(h, '/api/v1/receipts/sell', 'RETURN');

    const result = await h.call('create_return_receipt', {
      related_receipt_id: fx.IDS.receipt,
      goods: [
        { code: 'A1', name: 'Кава мелена 250 г', price: 13550, quantity: 1000 },
        { code: 'B2', name: 'Цукор', price: 4000, quantity: 500 },
      ],
      payments: [{ type: 'CASH', value: 15550 }],
    });

    const request = onlyRequest(h, 'POST /api/v1/receipts/sell');
    const body = request.body as { id: string };
    assert.deepEqual(body, {
      id: body.id,
      goods: [
        { good: { code: 'A1', name: 'Кава мелена 250 г', price: 13550 }, quantity: 1000, is_return: true },
        { good: { code: 'B2', name: 'Цукор', price: 4000 }, quantity: 500, is_return: true },
      ],
      payments: [{ type: 'CASH', value: 15550 }],
      related_receipt_id: fx.IDS.receipt,
    });
    assert.match(result.text, /"type": "RETURN"/);
  });

  it('a sale never carries the return flag or a related receipt', async () => {
    const h = await start();
    acceptReceipt(h, '/api/v1/receipts/sell', 'SELL');

    const refused = await h.call('create_sale_receipt', {
      related_receipt_id: fx.IDS.receipt,
      goods: [{ code: 'A1', name: 'Кава', price: 13550, quantity: 1000 }],
      payments: [{ type: 'CASH', value: 13550 }],
    });
    assert.equal(refused.isError, true, 'related_receipt_id is not an argument of a sale');

    await h.call('create_sale_receipt', {
      goods: [{ code: 'A1', name: 'Кава', price: 13550, quantity: 1000 }],
      payments: [{ type: 'CASH', value: 13550 }],
    });
    const body = onlyRequest(h, 'POST /api/v1/receipts/sell').body as { goods: Record<string, unknown>[] };
    assert.equal('is_return' in body.goods[0]!, false);
  });
});

describe('create_service_receipt', () => {
  it('cash_in sends a positive amount', async () => {
    const h = await start();
    acceptReceipt(h, '/api/v1/receipts/service', 'SERVICE_IN', { goods: [], payments: [{ type: 'CASH', value: 50000, label: 'Готівка' }] });

    const result = await h.call('create_service_receipt', { operation: 'cash_in', amount: 50000 });

    const request = onlyRequest(h, 'POST /api/v1/receipts/service');
    const body = request.body as { id: string };
    assert.match(body.id, UUID);
    assert.deepEqual(body, { id: body.id, payment: { type: 'CASH', value: 50000 } });
    assert.match(result.text, /"type": "SERVICE_IN"/);
  });

  it('cash_out sends the amount with a minus sign', async () => {
    const h = await start();
    acceptReceipt(h, '/api/v1/receipts/service', 'SERVICE_OUT');

    await h.call('create_service_receipt', { id: RECEIPT_ID, operation: 'cash_out', amount: 20000 });

    assert.deepEqual(onlyRequest(h, 'POST /api/v1/receipts/service').body, {
      id: RECEIPT_ID,
      payment: { type: 'CASH', value: -20000 },
    });
  });

  it('rejects a negative amount: the direction comes from the operation only', async () => {
    const h = await start();

    const result = await h.call('create_service_receipt', { operation: 'cash_in', amount: -20000 });

    assert.equal(result.isError, true);
    assert.equal(h.api.requests.length, 0);
  });
});

describe('sending a receipt', () => {
  it('send_receipt_email posts the list of addresses', async () => {
    const h = await start();
    h.api.on('POST', `/api/v1/receipts/${fx.IDS.receipt}/email`, json({ ok: true }));

    const result = await h.call('send_receipt_email', {
      receipt_id: fx.IDS.receipt,
      emails: ['customer@example.com', 'accountant@example.com'],
    });

    const request = onlyRequest(h, 'POST /api/v1/receipts/{receipt_id}/email');
    assert.deepEqual(request.body, ['customer@example.com', 'accountant@example.com']);
    assert.equal(result.isError, false);
    assert.match(result.text, /to 2 address\(es\)/);
    assert.ok(!result.text.includes('customer@example.com'));
  });

  it('send_receipt_email copes with an empty response body', async () => {
    const h = await start();
    h.api.on('POST', `/api/v1/receipts/${fx.IDS.receipt}/email`, new Response(null, { status: 200 }));

    const result = await h.call('send_receipt_email', { receipt_id: fx.IDS.receipt, emails: ['customer@example.com'] });

    assert.equal(result.isError, false);
    assert.equal(result.text, `Checkbox accepted the request to e-mail receipt ${fx.IDS.receipt} to 1 address(es).`);
  });

  it('send_receipt_email rejects malformed addresses', async () => {
    const h = await start();

    const result = await h.call('send_receipt_email', { receipt_id: fx.IDS.receipt, emails: ['not-an-email'] });

    assert.equal(result.isError, true);
    assert.equal(h.api.requests.length, 0);
  });

  it('send_receipt_sms posts the phone number in the format of the spec', async () => {
    const h = await start();
    h.api.on('POST', `/api/v1/receipts/${fx.IDS.receipt}/sms`, json({ ok: true }));

    const result = await h.call('send_receipt_sms', { receipt_id: fx.IDS.receipt, phone: '380501112233' });

    const request = onlyRequest(h, 'POST /api/v1/receipts/{receipt_id}/sms');
    assert.deepEqual(request.body, { phone: '380501112233' });
    assert.ok(!result.text.includes('380501112233'));
  });

  it('send_receipt_sms rejects numbers in another format', async () => {
    const h = await start();

    for (const phone of ['+380501112233', '0501112233', '38050111223']) {
      const result = await h.call('send_receipt_sms', { receipt_id: fx.IDS.receipt, phone });
      assert.equal(result.isError, true, phone);
    }
    assert.equal(h.api.requests.length, 0);
  });
});

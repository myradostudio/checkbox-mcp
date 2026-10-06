/**
 * Every read tool is called through a real MCP client. Each request the server
 * sends is checked against the OpenAPI snapshot (assertMatchesSpec) and against
 * what the tool is documented to do.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { json, page, text, type RecordedRequest } from './support/fake-api.js';
import * as fx from './support/fixtures.js';
import { createHarness, LICENSE_KEY, type Harness } from './support/harness.js';
import { assertMatchesSpec } from './support/spec.js';

let harness: Harness | undefined;

async function start(overrides: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  harness = await createHarness(overrides);
  return harness;
}

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** The single request a tool sent, verified against the spec. */
function onlyRequest(h: Harness, operation: string): RecordedRequest {
  assert.equal(h.api.toolRequests.length, 1, 'expected exactly one API request');
  const request = h.api.toolRequests[0]!;
  assert.equal(assertMatchesSpec(request), operation);
  return request;
}

const query = (request: RecordedRequest) => Object.fromEntries(request.url.searchParams.entries());

describe('cashier and cash registers', () => {
  it('get_cashier_profile calls GET /cashier/me and hides the personal tax number', async () => {
    const h = await start();
    h.api.on('GET', '/api/v1/cashier/me', json(fx.cashier));

    const profile = await h.callJson('get_cashier_profile');

    onlyRequest(h, 'GET /api/v1/cashier/me');
    assert.equal(profile.full_name, 'Тестовий касир');
    assert.equal(profile.is_test, true);
    assert.equal(profile.organization.edrpou, '00000000');
    assert.equal('nin' in profile, false);
  });

  it('list_cash_registers passes filters and returns summaries', async () => {
    const h = await start();
    h.api.on('GET', '/api/v1/cash-registers', page([fx.cashRegister]));

    const result = await h.callJson('list_cash_registers', { in_use: true, fiscal_number: 'TEST000001' });

    const request = onlyRequest(h, 'GET /api/v1/cash-registers');
    assert.deepEqual(query(request), { in_use: 'true', fiscal_number: 'TEST000001', limit: '25', offset: '0' });
    assert.deepEqual(result.results[0], {
      id: fx.IDS.cashRegister,
      fiscal_number: 'TEST000001',
      number: '1',
      active: true,
      is_test: true,
      offline_mode: false,
      stay_offline: false,
      address: 'м. Київ, вул. Тестова, 1',
      type: 0,
      branch: { id: fx.IDS.branch, name: 'Магазин на Тестовій', address: 'м. Київ, вул. Тестова, 1' },
      shift: {
        id: fx.IDS.shift,
        serial: 43,
        status: 'OPENED',
        opened_at: '2026-10-06T06:00:02+00:00',
        created_at: '2026-10-06T06:00:00+00:00',
        balance: fx.shift.balance,
        cashier: { id: fx.IDS.cashier, full_name: 'Тестовий касир' },
      },
    });
  });

  it('get_cash_register by id calls GET /cash-registers/{id}', async () => {
    const h = await start();
    h.api.on('GET', `/api/v1/cash-registers/${fx.IDS.cashRegister}`, json(fx.cashRegister));

    const register = await h.callJson('get_cash_register', { cash_register_id: fx.IDS.cashRegister });

    const request = onlyRequest(h, 'GET /api/v1/cash-registers/{cash_register_id}');
    assert.equal(request.headers['x-license-key'], undefined);
    assert.equal(register.offline_mode, false);
    assert.equal(register.shift.cashier.nin, undefined, 'nested personal tax numbers are removed too');
  });

  it('get_cash_register without an id uses the license key and no token', async () => {
    const h = await start();
    h.api.on('GET', '/api/v1/cash-registers/info', json(fx.cashRegisterInfo));

    const register = await h.callJson('get_cash_register');

    const request = onlyRequest(h, 'GET /api/v1/cash-registers/info');
    assert.equal(request.headers['x-license-key'], LICENSE_KEY);
    assert.equal(h.api.signIns, 0);
    assert.equal(register.title, 'Каса 1');
  });

  it('get_cash_register without an id explains a missing license key', async () => {
    const h = await start({ licenseKey: undefined });

    const result = await h.call('get_cash_register');

    assert.equal(result.isError, true);
    assert.match(result.text, /Set CHECKBOX_LICENSE_KEY/);
    assert.equal(h.api.requests.length, 0);
  });

  it('get_offline_status combines offline codes and offline time', async () => {
    const h = await start();
    h.api.on('GET', '/api/v1/cash-registers/get-offline-codes-count', json({ available: 1800, enough_offline_codes: true }));
    h.api.on('GET', '/api/v1/cash-registers/get-offline-time', json({ status: { current: 0, total: 5400 }, sessions: [] }));

    const status = await h.callJson('get_offline_status', {
      from_date: '2026-10-01T00:00:00+03:00',
      to_date: '2026-10-07T00:00:00+03:00',
    });

    assert.equal(h.api.toolRequests.length, 2);
    const operations = h.api.toolRequests.map(assertMatchesSpec).sort();
    assert.deepEqual(operations, [
      'GET /api/v1/cash-registers/get-offline-codes-count',
      'GET /api/v1/cash-registers/get-offline-time',
    ]);
    const [timeRequest] = h.api.callsTo('/api/v1/cash-registers/get-offline-time');
    assert.deepEqual(query(timeRequest!), { from_date: '2026-10-01T00:00:00+03:00', to_date: '2026-10-07T00:00:00+03:00' });
    assert.deepEqual(status, {
      offline_codes: { available: 1800, enough_offline_codes: true },
      offline_time: { status: { current: 0, total: 5400 }, sessions: [] },
    });
  });
});

describe('shifts', () => {
  it('get_current_shift calls GET /cashier/shift', async () => {
    const h = await start();
    h.api.on('GET', '/api/v1/cashier/shift', json(fx.shift));

    const shift = await h.callJson('get_current_shift');

    onlyRequest(h, 'GET /api/v1/cashier/shift');
    assert.equal(shift.status, 'OPENED');
    assert.equal(shift.balance.cash_sales, 13550);
  });

  it('get_current_shift says so when no shift is open', async () => {
    const h = await start();
    h.api.on('GET', '/api/v1/cashier/shift', json(null));

    const result = await h.call('get_current_shift');

    assert.equal(result.isError, false);
    assert.equal(result.text, 'The cashier has no open shift.');
  });

  it('list_shifts lists the cashier shifts, newest first by default', async () => {
    const h = await start();
    h.api.on('GET', '/api/v1/shifts', page([fx.shift]));

    const result = await h.callJson('list_shifts', {
      statuses: ['OPENED', 'CLOSED'],
      from_date: '2026-10-01T00:00:00+03:00',
    });

    const request = onlyRequest(h, 'GET /api/v1/shifts');
    assert.deepEqual(request.url.searchParams.getAll('statuses'), ['OPENED', 'CLOSED']);
    assert.equal(request.url.searchParams.get('desc'), 'true');
    assert.equal(request.url.searchParams.get('from_date'), '2026-10-01T00:00:00+03:00');
    assert.deepEqual(result.results[0], {
      id: fx.IDS.shift,
      serial: 43,
      status: 'OPENED',
      opened_at: '2026-10-06T06:00:02+00:00',
      created_at: '2026-10-06T06:00:00+00:00',
      balance: fx.shift.balance,
      cash_register: { id: fx.IDS.cashRegister, fiscal_number: 'TEST000001', number: '1' },
      cashier: { id: fx.IDS.cashier, full_name: 'Тестовий касир' },
    });
  });

  it('list_shifts with scope cash_register uses the license key endpoint and its lower cap', async () => {
    const h = await start();
    h.api.on('GET', '/api/v1/cash-registers/shifts', page([]));

    const result = await h.callJson('list_shifts', { scope: 'cash_register', limit: 100, newest_first: false });

    const request = onlyRequest(h, 'GET /api/v1/cash-registers/shifts');
    assert.equal(request.url.searchParams.get('limit'), '50');
    assert.equal(request.url.searchParams.get('desc'), 'false');
    assert.equal(request.headers['x-license-key'], LICENSE_KEY);
    assert.equal(result.pagination.limit, 50);
  });

  it('get_shift calls GET /shifts/{id}', async () => {
    const h = await start();
    h.api.on('GET', `/api/v1/shifts/${fx.IDS.shift}`, json(fx.shift));

    const shift = await h.callJson('get_shift', { shift_id: fx.IDS.shift });

    onlyRequest(h, 'GET /api/v1/shifts/{shift_id}');
    assert.equal(shift.initial_transaction.type, 'SHIFT_OPEN');
  });

  it('get_shift rejects an id that is not a UUID before calling the API', async () => {
    const h = await start();

    const result = await h.call('get_shift', { shift_id: '../cashier/me' });

    assert.equal(result.isError, true);
    assert.match(result.text, /Must be a UUID/);
    assert.equal(h.api.requests.length, 0);
  });
});

describe('receipts', () => {
  it('search_receipts maps every filter to the query parameters of the spec', async () => {
    const h = await start();
    h.api.on('GET', '/api/v1/receipts/search', page([fx.receipt]));

    await h.callJson('search_receipts', {
      from_date: '2026-10-06T00:00:00+03:00',
      to_date: '2026-10-07T00:00:00+03:00',
      fiscal_code: 'TEST-abc123',
      barcode: '2000000000017',
      shift_ids: [fx.IDS.shift],
      cash_register_ids: [fx.IDS.cashRegister],
      branch_ids: [fx.IDS.branch],
      all_cashiers: true,
      newest_first: false,
      limit: 10,
      offset: 20,
    });

    const request = onlyRequest(h, 'GET /api/v1/receipts/search');
    assert.deepEqual(query(request), {
      from_date: '2026-10-06T00:00:00+03:00',
      to_date: '2026-10-07T00:00:00+03:00',
      fiscal_code: 'TEST-abc123',
      barcode: '2000000000017',
      shift_id: fx.IDS.shift,
      cash_register_id: fx.IDS.cashRegister,
      branch_id: fx.IDS.branch,
      self_receipts: 'false',
      desc: 'false',
      limit: '10',
      offset: '20',
    });
  });

  it('search_receipts leaves the API default for own receipts and sorts newest first', async () => {
    const h = await start();
    h.api.on('GET', '/api/v1/receipts/search', page([]));

    await h.callJson('search_receipts');

    const request = onlyRequest(h, 'GET /api/v1/receipts/search');
    assert.deepEqual(query(request), { desc: 'true', limit: '25', offset: '0' });
  });

  it('search_receipts returns compact summaries without customer contacts', async () => {
    const h = await start();
    h.api.on('GET', '/api/v1/receipts/search', page([fx.receipt]));

    const result = await h.callJson('search_receipts');

    assert.deepEqual(result.results, [
      {
        id: fx.IDS.receipt,
        serial: 12,
        type: 'SELL',
        status: 'DONE',
        fiscal_code: 'TEST-abc123',
        fiscal_date: '2026-10-06T08:15:00+00:00',
        created_at: '2026-10-06T08:15:00+00:00',
        total_sum: 13550,
        total_payment: 13550,
        total_rest: 0,
        round_sum: 0,
        is_test: true,
        is_created_offline: false,
        is_sent_dps: true,
        shift_id: fx.IDS.shift,
        cash_register_id: fx.IDS.cashRegister,
        cashier_id: fx.IDS.cashier,
        goods: [{ code: 'A1', name: 'Кава мелена 250 г', price: 13550, quantity: 1000, sum: 13550, is_return: false }],
        payments: [{ type: 'CASH', label: 'Готівка', value: 13550 }],
        shift: { id: fx.IDS.shift, serial: 43 },
      },
    ]);
    assert.ok(!JSON.stringify(result).includes('customer@example.com'));
  });

  it('get_receipt returns the full record as JSON by default', async () => {
    const h = await start();
    h.api.on('GET', `/api/v1/receipts/${fx.IDS.receipt}`, json(fx.receipt));

    const receipt = await h.callJson('get_receipt', { receipt_id: fx.IDS.receipt });

    onlyRequest(h, 'GET /api/v1/receipts/{receipt_id}');
    assert.equal(receipt.tax_url, fx.receipt.tax_url);
    assert.equal(receipt.goods[0].taxes[0].label, 'Без ПДВ');
  });

  it('get_receipt with format text returns the printable receipt unchanged', async () => {
    const h = await start();
    const printed = '        ФОП Тестовий\nКава мелена 250 г     135.50\nСУМА                  135.50';
    h.api.on('GET', `/api/v1/receipts/${fx.IDS.receipt}/text`, text(printed));

    const result = await h.call('get_receipt', { receipt_id: fx.IDS.receipt, format: 'text' });

    const request = onlyRequest(h, 'GET /api/v1/receipts/{receipt_id}/text');
    assert.equal(request.headers['authorization'], undefined, 'the text endpoint is not secured in the spec');
    assert.equal(result.text, printed);
  });

  it('get_receipt accepts the 11-character short id', async () => {
    const h = await start();
    h.api.on('GET', '/api/v1/receipts/Ab3-xY_9zQ1', json(fx.receipt));

    await h.callJson('get_receipt', { receipt_id: 'Ab3-xY_9zQ1' });

    onlyRequest(h, 'GET /api/v1/receipts/{receipt_id}');
  });

  it('get_receipt passes on the "still being created" answer', async () => {
    const h = await start();
    h.api.on('GET', `/api/v1/receipts/${fx.IDS.receipt}`, json({ message: 'Вказаний чек створюється, повторіть запит пізніше' }, 429));

    const result = await h.call('get_receipt', { receipt_id: fx.IDS.receipt });

    assert.equal(result.isError, true);
    assert.match(result.text, /^Checkbox API error \(HTTP 429\): Вказаний чек створюється/);
    assert.match(result.text, /Wait a few seconds/);
  });
});

describe('reports', () => {
  it('list_reports maps report_type Z to is_z_report=true', async () => {
    const h = await start();
    h.api.on('GET', '/api/v1/reports/search', page([fx.report]));

    const result = await h.callJson('list_reports', {
      report_type: 'Z',
      from_date: '2026-10-01T00:00:00+03:00',
      to_date: '2026-10-07T00:00:00+03:00',
      cash_register_ids: [fx.IDS.cashRegister],
      shift_ids: [fx.IDS.shift],
      serial: 7,
    });

    const request = onlyRequest(h, 'GET /api/v1/reports/search');
    assert.deepEqual(query(request), {
      from_date: '2026-10-01T00:00:00+03:00',
      to_date: '2026-10-07T00:00:00+03:00',
      shift_id: fx.IDS.shift,
      cash_register_id: fx.IDS.cashRegister,
      serial: '7',
      is_z_report: 'true',
      desc: 'true',
      limit: '25',
      offset: '0',
    });
    assert.deepEqual(result.results[0], {
      id: fx.IDS.report,
      serial: 7,
      is_z_report: true,
      fiscal_code: 'TEST-z0007',
      created_at: '2026-10-06T18:00:00+00:00',
      shift_id: fx.IDS.shift,
      sell_receipts_count: 1,
      return_receipts_count: 0,
      cash_withdrawal_receipts_count: 0,
      initial: 50000,
      balance: 63550,
      payments: [{ type: 'CASH', label: 'Готівка', sell_sum: 13550, return_sum: 0, service_in: 50000, service_out: 0 }],
    });
  });

  it('list_reports maps report_type X to is_z_report=false and omits it otherwise', async () => {
    const h = await start();
    h.api.on('GET', '/api/v1/reports/search', page([]));

    await h.callJson('list_reports', { report_type: 'X' });
    await h.callJson('list_reports');

    const [onlyX, both] = h.api.toolRequests;
    assert.equal(assertMatchesSpec(onlyX!), 'GET /api/v1/reports/search');
    assert.equal(onlyX!.url.searchParams.get('is_z_report'), 'false');
    assert.equal(both!.url.searchParams.has('is_z_report'), false);
  });

  it('get_report returns JSON by default and text on request', async () => {
    const h = await start();
    h.api.on('GET', `/api/v1/reports/${fx.IDS.report}`, json(fx.report));
    h.api.on('GET', `/api/v1/reports/${fx.IDS.report}/text`, text('Z-ЗВІТ № 7'));

    const report = await h.callJson('get_report', { report_id: fx.IDS.report });
    const printed = await h.call('get_report', { report_id: fx.IDS.report, format: 'text' });

    const [jsonRequest, textRequest] = h.api.toolRequests;
    assert.equal(assertMatchesSpec(jsonRequest!), 'GET /api/v1/reports/{report_id}');
    assert.equal(assertMatchesSpec(textRequest!), 'GET /api/v1/reports/{report_id}/text');
    assert.equal(report.taxes[0].label, 'Без ПДВ');
    assert.equal(printed.text, 'Z-ЗВІТ № 7');
  });

  it('get_periodical_report sends the period and the license key, without a token', async () => {
    const h = await start();
    h.api.on('GET', '/api/v1/reports/periodical', text('ПЕРІОДИЧНИЙ ЗВІТ'));

    const result = await h.call('get_periodical_report', {
      from_date: '2026-09-01T00:00:00+03:00',
      to_date: '2026-09-30T23:59:59+03:00',
      short: true,
    });

    const request = onlyRequest(h, 'GET /api/v1/reports/periodical');
    assert.deepEqual(query(request), {
      from_date: '2026-09-01T00:00:00+03:00',
      to_date: '2026-09-30T23:59:59+03:00',
      is_short: 'true',
    });
    assert.equal(request.headers['x-license-key'], LICENSE_KEY);
    assert.equal(h.api.signIns, 0);
    assert.equal(result.text, 'ПЕРІОДИЧНИЙ ЗВІТ');
  });

  it('get_periodical_report rejects a reversed period without calling the API', async () => {
    const h = await start();

    const result = await h.call('get_periodical_report', {
      from_date: '2026-09-30T00:00:00+03:00',
      to_date: '2026-09-01T00:00:00+03:00',
    });

    assert.equal(result.isError, true);
    assert.equal(result.text, 'from_date must not be later than to_date.');
    assert.equal(h.api.requests.length, 0);
  });

  it('rejects dates without a UTC offset', async () => {
    const h = await start();

    for (const value of ['2026-09-01', '2026-09-01T00:00:00', 'yesterday', '2026-13-45T00:00:00+03:00']) {
      const result = await h.call('list_reports', { from_date: value });
      assert.equal(result.isError, true, value);
    }
    assert.equal(h.api.requests.length, 0);
  });
});

describe('goods, taxes and orders', () => {
  it('search_goods sends the search text and group', async () => {
    const h = await start();
    h.api.on('GET', '/api/v1/goods', json({ meta: { limit: 5, offset: 0 }, results: [fx.good], use_leftovers: true }));

    const result = await h.callJson('search_goods', { query: 'кава', group_id: fx.IDS.branch, limit: 5 });

    const request = onlyRequest(h, 'GET /api/v1/goods');
    assert.deepEqual(query(request), { query: 'кава', group_id: fx.IDS.branch, limit: '5', offset: '0' });
    assert.deepEqual(result.results[0], {
      id: fx.IDS.good,
      code: 'A1',
      name: 'Кава мелена 250 г',
      price: 13550,
      barcode: '4820000000017',
      uktzed: '0901',
      group_name: 'Кава',
      count: 24,
      is_weight: false,
      taxes: [{ code: 8, symbol: 'З', label: 'Без ПДВ', rate: 0 }],
    });
  });

  it('list_taxes calls GET /cashier/tax', async () => {
    const h = await start();
    h.api.on('GET', '/api/v1/cashier/tax', json(fx.taxes));

    const taxes = await h.callJson('list_taxes');

    onlyRequest(h, 'GET /api/v1/cashier/tax');
    assert.deepEqual(taxes.map((tax: { code: number }) => tax.code), [8, 5]);
  });

  it('list_orders maps filters and leaves customer data out of the summary', async () => {
    const h = await start();
    h.api.on('GET', '/api/v1/orders', json({ meta: { limit: 25, offset: 0, total_items: 1 }, results: [fx.order] }));

    const result = await h.callJson('list_orders', {
      statuses: ['PENDING'],
      external_order_id: 'WEB-1042',
      delivered_from_date: '2026-10-01T00:00:00+03:00',
      whole_organization: true,
    });

    const request = onlyRequest(h, 'GET /api/v1/orders');
    assert.deepEqual(query(request), {
      status: 'PENDING',
      order_id: 'WEB-1042',
      delivered_from_date: '2026-10-01T00:00:00+03:00',
      orders_all: 'true',
      desc: 'true',
      limit: '25',
      offset: '0',
    });
    assert.equal(request.headers['x-license-key'], LICENSE_KEY);
    assert.deepEqual(result, {
      pagination: { limit: 25, offset: 0, returned: 1, next_offset: null, total_items: 1 },
      results: [
        {
          id: fx.IDS.order,
          order_id: 'WEB-1042',
          status: 'PENDING',
          custom_status: 'NEW',
          is_paid: false,
          payment_method: 'CASH_ON_DELIVERY',
          not_fiscalize: false,
          created_at: '2026-10-06T09:00:00+00:00',
          receipt_id: fx.IDS.receipt,
          goods_count: 1,
          delivery_time: '2026-10-07T12:00:00+00:00',
        },
      ],
    });
    const serialised = JSON.stringify(result);
    assert.ok(!serialised.includes('Олена') && !serialised.includes('380501112233') && !serialised.includes('customer@'));
  });

  it('get_order returns the full order', async () => {
    const h = await start();
    h.api.on('GET', `/api/v1/orders/${fx.IDS.order}`, json(fx.order));

    const order = await h.callJson('get_order', { order_id: fx.IDS.order, whole_organization: true });

    const request = onlyRequest(h, 'GET /api/v1/orders/{order_id}');
    assert.deepEqual(query(request), { orders_all: 'true' });
    assert.equal(order.delivery_details.client_name, 'Олена Тестова');
  });
});

describe('pagination', () => {
  it('uses a default page of 25', async () => {
    const h = await start();
    h.api.on('GET', '/api/v1/receipts/search', page([]));

    const result = await h.callJson('search_receipts');

    assert.equal(h.api.toolRequests[0]!.url.searchParams.get('limit'), '25');
    assert.deepEqual(result.pagination, { limit: 25, offset: 0, returned: 0, next_offset: null });
  });

  it('clamps the page size to the hard cap of 100 on every list tool', async () => {
    const h = await start();
    const lists: [string, string][] = [
      ['list_cash_registers', '/api/v1/cash-registers'],
      ['list_shifts', '/api/v1/shifts'],
      ['search_receipts', '/api/v1/receipts/search'],
      ['list_reports', '/api/v1/reports/search'],
      ['search_goods', '/api/v1/goods'],
      ['list_orders', '/api/v1/orders'],
    ];
    for (const [tool, path] of lists) {
      h.api.on('GET', path, page([]));
      const result = await h.callJson(tool, { limit: 100_000 });
      const [request] = h.api.callsTo(path);
      assert.equal(request!.url.searchParams.get('limit'), '100', tool);
      assert.equal(result.pagination.limit, 100, tool);
      assertMatchesSpec(request!);
    }
  });

  it('reports next_offset when a full page came back', async () => {
    const h = await start();
    h.api.on('GET', '/api/v1/receipts/search', page([fx.receipt, fx.receipt]));

    const result = await h.callJson('search_receipts', { limit: 2, offset: 4 });

    assert.deepEqual(result.pagination, { limit: 2, offset: 4, returned: 2, next_offset: 6 });
  });

  it('rejects a zero or negative page size and a negative offset', async () => {
    const h = await start();

    for (const args of [{ limit: 0 }, { limit: -5 }, { limit: 2.5 }, { offset: -1 }]) {
      const result = await h.call('search_receipts', args);
      assert.equal(result.isError, true, JSON.stringify(args));
    }
    assert.equal(h.api.requests.length, 0);
  });

  it('reports an unexpected list shape as a tool error', async () => {
    const h = await start();
    h.api.on('GET', '/api/v1/receipts/search', json({ unexpected: true }));

    const result = await h.call('search_receipts');

    assert.equal(result.isError, true);
    assert.match(result.text, /a paginated list was expected/);
  });
});

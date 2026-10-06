/**
 * Catalogue of the Checkbox API operations this server calls.
 *
 * Paths, the need for a bearer token and the need for `X-License-Key` are taken
 * from the official OpenAPI document (https://api.checkbox.ua/api/openapi.json).
 * tests/spec.test.ts compares every entry with a snapshot of that document, so
 * an endpoint cannot be added or changed here without the spec agreeing.
 */

export interface Endpoint {
  readonly method: 'GET' | 'POST';
  /** Path template; `{name}` segments are filled from path parameters. */
  readonly path: string;
  /** Whether the operation is secured with the cashier bearer token. */
  readonly auth: boolean;
  /** Whether the operation takes the cash register license key header. */
  readonly licenseKey: 'required' | 'optional' | 'none';
  readonly response: 'json' | 'text';
}

type Options = Partial<Pick<Endpoint, 'auth' | 'licenseKey' | 'response'>>;

function endpoint(method: Endpoint['method'], path: string, options: Options = {}): Endpoint {
  return { method, path, auth: true, licenseKey: 'none', response: 'json', ...options };
}

export const ENDPOINTS = {
  // Cashier session
  signIn: endpoint('POST', '/api/v1/cashier/signin', { auth: false }),
  signInPinCode: endpoint('POST', '/api/v1/cashier/signinPinCode', { auth: false, licenseKey: 'required' }),
  signOut: endpoint('POST', '/api/v1/cashier/signout'),
  cashierProfile: endpoint('GET', '/api/v1/cashier/me'),
  cashierShift: endpoint('GET', '/api/v1/cashier/shift'),
  cashierTaxes: endpoint('GET', '/api/v1/cashier/tax'),

  // Cash registers
  cashRegisters: endpoint('GET', '/api/v1/cash-registers'),
  cashRegister: endpoint('GET', '/api/v1/cash-registers/{cash_register_id}'),
  cashRegisterInfo: endpoint('GET', '/api/v1/cash-registers/info', { auth: false, licenseKey: 'required' }),
  cashRegisterShifts: endpoint('GET', '/api/v1/cash-registers/shifts', { auth: false, licenseKey: 'required' }),
  offlineCodesCount: endpoint('GET', '/api/v1/cash-registers/get-offline-codes-count', { licenseKey: 'required' }),
  offlineTime: endpoint('GET', '/api/v1/cash-registers/get-offline-time', { licenseKey: 'required' }),

  // Shifts
  shifts: endpoint('GET', '/api/v1/shifts'),
  shift: endpoint('GET', '/api/v1/shifts/{shift_id}'),
  openShift: endpoint('POST', '/api/v1/shifts', { licenseKey: 'required' }),
  closeShift: endpoint('POST', '/api/v1/shifts/close'),

  // Receipts
  receiptsSearch: endpoint('GET', '/api/v1/receipts/search'),
  receipt: endpoint('GET', '/api/v1/receipts/{receipt_id}'),
  receiptText: endpoint('GET', '/api/v1/receipts/{receipt_id}/text', { auth: false, response: 'text' }),
  sellReceipt: endpoint('POST', '/api/v1/receipts/sell'),
  serviceReceipt: endpoint('POST', '/api/v1/receipts/service'),
  receiptEmail: endpoint('POST', '/api/v1/receipts/{receipt_id}/email'),
  receiptSms: endpoint('POST', '/api/v1/receipts/{receipt_id}/sms'),

  // Reports
  reportsSearch: endpoint('GET', '/api/v1/reports/search'),
  report: endpoint('GET', '/api/v1/reports/{report_id}'),
  reportText: endpoint('GET', '/api/v1/reports/{report_id}/text', { auth: false, response: 'text' }),
  periodicalReport: endpoint('GET', '/api/v1/reports/periodical', {
    auth: false,
    licenseKey: 'required',
    response: 'text',
  }),

  // Catalogue and orders
  goods: endpoint('GET', '/api/v1/goods'),
  orders: endpoint('GET', '/api/v1/orders', { licenseKey: 'optional' }),
  order: endpoint('GET', '/api/v1/orders/{order_id}'),
} as const satisfies Record<string, Endpoint>;

export type EndpointName = keyof typeof ENDPOINTS;

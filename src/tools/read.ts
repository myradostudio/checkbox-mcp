/**
 * Read-only tools. They only issue GET requests and are always registered.
 *
 * Units, as documented by Checkbox: money amounts are integers in kopecks
 * (1 UAH = 100) and quantities are integers in thousandths (1 piece = 1000).
 */

import { z } from 'zod';

import { ENDPOINTS } from '../endpoints.js';
import { ToolError } from '../errors.js';
import { dateTime, limit, offset, paginated, receiptId, resolvePage, uuid, uuidList } from './schemas.js';
import {
  summarizeCashRegister,
  summarizeGood,
  summarizeOrder,
  summarizeReceipt,
  summarizeReport,
  summarizeShift,
} from './summaries.js';
import { defineTool, READ_ONLY, type AnyTool } from './types.js';

/** `GET /api/v1/cash-registers/shifts` does not accept more than 50 records per page. */
const CASH_REGISTER_SHIFTS_MAX_LIMIT = 50;

const SHIFT_STATUSES = ['CREATED', 'OPENING', 'OPENED', 'CLOSING', 'CLOSED'] as const;
const ORDER_STATUSES = ['PENDING', 'SAVING', 'SUCCESS', 'CANCELLED'] as const;

const format = z
  .enum(['json', 'text'])
  .optional()
  .describe('"json" (default) returns the structured object; "text" returns the printable plain-text form.');

export const readTools: readonly AnyTool[] = [
  defineTool({
    name: 'get_cashier_profile',
    title: 'Who am I: cashier and organization',
    description:
      'Returns the cashier this server is signed in as: name, permissions, signature type, whether it is a test cashier (is_test), and the organization (title, EDRPOU, tax number, VAT status, offline and SMS settings). Call this first to learn whose data the other tools will show.',
    access: 'read',
    inputSchema: z.object({}),
    annotations: READ_ONLY,
    handler: async (_args, { client }) => ({ data: await client.request(ENDPOINTS.cashierProfile) }),
  }),

  defineTool({
    name: 'list_cash_registers',
    title: 'List cash registers',
    description:
      'Lists the cash registers (ПРРО) available to the cashier, each with its fiscal number, address, branch, online/offline mode and the currently open shift if there is one. Use the returned ids to filter receipts and reports.',
    access: 'read',
    inputSchema: z.object({
      in_use: z.boolean().optional().describe('Filter by whether the cash register is currently in use.'),
      fiscal_number: z.string().min(1).optional().describe('Fiscal number of the cash register.'),
      limit,
      offset,
    }),
    annotations: READ_ONLY,
    handler: async (args, { client }) => {
      const page = resolvePage(args);
      const response = await client.request(ENDPOINTS.cashRegisters, {
        query: { in_use: args.in_use, fiscal_number: args.fiscal_number, ...page },
      });
      return { data: paginated(response, page, summarizeCashRegister) };
    },
  }),

  defineTool({
    name: 'get_cash_register',
    title: 'Get a cash register',
    description:
      'Returns one cash register (ПРРО). With cash_register_id: full details including offline_mode (true means the register works offline) and the open shift. Without it: the register that CHECKBOX_LICENSE_KEY belongs to, including its title, address, has_shift, is_test and the numbers of the last documents.',
    access: 'read',
    inputSchema: z.object({
      cash_register_id: uuid('Cash register id').optional(),
    }),
    annotations: READ_ONLY,
    handler: async (args, { client }) => {
      const data =
        args.cash_register_id === undefined
          ? await client.request(ENDPOINTS.cashRegisterInfo)
          : await client.request(ENDPOINTS.cashRegister, { pathParams: { cash_register_id: args.cash_register_id } });
      return { data };
    },
  }),

  defineTool({
    name: 'get_offline_status',
    title: 'Offline mode status',
    description:
      'Reports how the cash register behind CHECKBOX_LICENSE_KEY stands with offline mode: how many offline fiscal codes are available and whether that is enough, plus the offline sessions and total offline time, optionally limited to a period. Checkbox documents a limit of 36 hours offline in a row and 168 hours per month. Durations are passed through as the API returns them.',
    access: 'read',
    inputSchema: z.object({
      from_date: dateTime('Count offline time from this moment.').optional(),
      to_date: dateTime('Count offline time up to this moment.').optional(),
    }),
    annotations: READ_ONLY,
    handler: async (args, { client }) => {
      const [offlineCodes, offlineTime] = await Promise.all([
        client.request(ENDPOINTS.offlineCodesCount),
        client.request(ENDPOINTS.offlineTime, { query: { from_date: args.from_date, to_date: args.to_date } }),
      ]);
      return { data: { offline_codes: offlineCodes, offline_time: offlineTime } };
    },
  }),

  defineTool({
    name: 'get_current_shift',
    title: 'Current shift of the cashier',
    description:
      'Returns the active shift (зміна) of the signed-in cashier: status, opening time, cash register, running balance (cash and card sales, returns, service cash in/out) and per-tax totals. Tells you when the cashier has no open shift.',
    access: 'read',
    inputSchema: z.object({}),
    annotations: READ_ONLY,
    handler: async (_args, { client }) => {
      const shift = await client.request(ENDPOINTS.cashierShift);
      return shift === null ? { note: 'The cashier has no open shift.' } : { data: shift };
    },
  }),

  defineTool({
    name: 'list_shifts',
    title: 'List shifts',
    description:
      'Lists shifts (зміни) with status, open and close times, balance and the Z-report reference. scope "cashier" (default) lists shifts of the signed-in cashier; scope "cash_register" lists shifts of the cash register behind CHECKBOX_LICENSE_KEY, whoever opened them (page size capped at 50). Use get_shift for the full record.',
    access: 'read',
    inputSchema: z.object({
      scope: z.enum(['cashier', 'cash_register']).optional().describe('Whose shifts to list. Default "cashier".'),
      statuses: z.array(z.enum(SHIFT_STATUSES)).min(1).optional().describe('Only shifts in these statuses.'),
      from_date: dateTime('Only shifts from this moment.').optional(),
      to_date: dateTime('Only shifts up to this moment.').optional(),
      newest_first: z.boolean().optional().describe('Sort from newest to oldest. Default true.'),
      limit,
      offset,
    }),
    annotations: READ_ONLY,
    handler: async (args, { client }) => {
      const byCashRegister = args.scope === 'cash_register';
      const page = resolvePage(args, byCashRegister ? CASH_REGISTER_SHIFTS_MAX_LIMIT : undefined);
      const response = await client.request(byCashRegister ? ENDPOINTS.cashRegisterShifts : ENDPOINTS.shifts, {
        query: {
          statuses: args.statuses,
          from_date: args.from_date,
          to_date: args.to_date,
          desc: args.newest_first ?? true,
          ...page,
        },
      });
      return { data: paginated(response, page, summarizeShift) };
    },
  }),

  defineTool({
    name: 'get_shift',
    title: 'Get a shift',
    description:
      'Returns one shift (зміна) in full: status, cashier, cash register, balance, per-tax totals, the opening and closing transactions and the embedded Z-report once the shift is closed.',
    access: 'read',
    inputSchema: z.object({ shift_id: uuid('Shift id') }),
    annotations: READ_ONLY,
    handler: async (args, { client }) => ({
      data: await client.request(ENDPOINTS.shift, { pathParams: { shift_id: args.shift_id } }),
    }),
  }),

  defineTool({
    name: 'search_receipts',
    title: 'Search receipts',
    description:
      'Finds receipts (чеки) by period, fiscal number, barcode, shift, cash register or branch. Returns a summary per receipt: type (SELL, RETURN, SERVICE_IN, SERVICE_OUT, ...), status (DONE means fiscalized), fiscal number, totals, goods and payments. The API has no filter by status or type, so filter the returned rows yourself. By default only receipts created by the signed-in cashier are returned. Use get_receipt for the full record.',
    access: 'read',
    inputSchema: z.object({
      from_date: dateTime('Receipts from this moment.').optional(),
      to_date: dateTime('Receipts before this moment.').optional(),
      fiscal_code: z.string().min(1).optional().describe('Fiscal number of the receipt.'),
      barcode: z.string().min(1).optional().describe('Barcode of the receipt.'),
      shift_ids: uuidList('Only receipts of these shifts'),
      cash_register_ids: uuidList('Only receipts of these cash registers'),
      branch_ids: uuidList('Only receipts of these branches'),
      all_cashiers: z
        .boolean()
        .optional()
        .describe(
          'Set true to ask for receipts of every cashier instead of only the signed-in one. Whether that is allowed depends on the cashier permissions in Checkbox.',
        ),
      newest_first: z.boolean().optional().describe('Sort from newest to oldest. Default true.'),
      limit,
      offset,
    }),
    annotations: READ_ONLY,
    handler: async (args, { client }) => {
      const page = resolvePage(args);
      const response = await client.request(ENDPOINTS.receiptsSearch, {
        query: {
          from_date: args.from_date,
          to_date: args.to_date,
          fiscal_code: args.fiscal_code,
          barcode: args.barcode,
          shift_id: args.shift_ids,
          cash_register_id: args.cash_register_ids,
          branch_id: args.branch_ids,
          // The API default is self_receipts=true; only override it on request.
          self_receipts: args.all_cashiers === true ? false : undefined,
          desc: args.newest_first ?? true,
          ...page,
        },
      });
      return { data: paginated(response, page, summarizeReceipt) };
    },
  }),

  defineTool({
    name: 'get_receipt',
    title: 'Get a receipt',
    description:
      'Returns one receipt (чек). format "json": the full record with goods, payments, taxes, discounts, fiscal number, status and the link to the tax service (tax_url). format "text": the receipt exactly as it is printed. A receipt that was created a moment ago can answer "still being created"; retry after a second.',
    access: 'read',
    inputSchema: z.object({ receipt_id: receiptId, format }),
    annotations: READ_ONLY,
    handler: async (args, { client }) => ({
      data: await client.request(args.format === 'text' ? ENDPOINTS.receiptText : ENDPOINTS.receipt, {
        pathParams: { receipt_id: args.receipt_id },
      }),
    }),
  }),

  defineTool({
    name: 'list_reports',
    title: 'List X and Z reports',
    description:
      'Lists X-reports (interim, non-fiscal) and Z-reports (end of shift) with receipt counts, cash balance and totals per payment form. Filter by period, shift, cash register, serial number or report type. Use get_report for tax breakdowns or the printable text.',
    access: 'read',
    inputSchema: z.object({
      report_type: z.enum(['X', 'Z']).optional().describe('Only X-reports or only Z-reports. Default: both.'),
      from_date: dateTime('Reports from this moment.').optional(),
      to_date: dateTime('Reports before this moment.').optional(),
      shift_ids: uuidList('Only reports of these shifts'),
      cash_register_ids: uuidList('Only reports of these cash registers'),
      serial: z.number().int().min(1).optional().describe('Serial number of the report.'),
      newest_first: z.boolean().optional().describe('Sort from newest to oldest. Default true.'),
      limit,
      offset,
    }),
    annotations: READ_ONLY,
    handler: async (args, { client }) => {
      const page = resolvePage(args);
      const response = await client.request(ENDPOINTS.reportsSearch, {
        query: {
          from_date: args.from_date,
          to_date: args.to_date,
          shift_id: args.shift_ids,
          cash_register_id: args.cash_register_ids,
          serial: args.serial,
          is_z_report: args.report_type === undefined ? undefined : args.report_type === 'Z',
          desc: args.newest_first ?? true,
          ...page,
        },
      });
      return { data: paginated(response, page, summarizeReport) };
    },
  }),

  defineTool({
    name: 'get_report',
    title: 'Get an X or Z report',
    description:
      'Returns one X- or Z-report. format "json": the full record with totals per payment form and per tax rate, receipt counts, rounding and cash balance. format "text": the report exactly as it is printed.',
    access: 'read',
    inputSchema: z.object({ report_id: uuid('Report id'), format }),
    annotations: READ_ONLY,
    handler: async (args, { client }) => ({
      data: await client.request(args.format === 'text' ? ENDPOINTS.reportText : ENDPOINTS.report, {
        pathParams: { report_id: args.report_id },
      }),
    }),
  }),

  defineTool({
    name: 'get_periodical_report',
    title: 'Periodical report for a date range',
    description:
      'Returns the periodical report (періодичний звіт) of the cash register behind CHECKBOX_LICENSE_KEY for a date range, as printable text: totals built from the Z-reports of the period, by tax rate and payment form, returns, cash in the register and each Z-report with its number and date. The API offers this report as text only.',
    access: 'read',
    inputSchema: z.object({
      from_date: dateTime('Start of the period.'),
      to_date: dateTime('End of the period.'),
      short: z.boolean().optional().describe('Request the short form of the report. Default false.'),
    }),
    annotations: READ_ONLY,
    handler: async (args, { client }) => {
      if (Date.parse(args.from_date) > Date.parse(args.to_date)) {
        throw new ToolError('from_date must not be later than to_date.');
      }
      return {
        data: await client.request(ENDPOINTS.periodicalReport, {
          query: { from_date: args.from_date, to_date: args.to_date, is_short: args.short },
        }),
      };
    },
  }),

  defineTool({
    name: 'search_goods',
    title: 'Search the goods catalogue',
    description:
      'Searches the goods catalogue (номенклатура) kept in Checkbox. Returns code, name, price in kopecks, barcode, UKTZED code, group, tax rates and stock count where the organization tracks it. The catalogue can be empty when the organization does not keep its goods in Checkbox.',
    access: 'read',
    inputSchema: z.object({
      query: z.string().min(1).optional().describe('Search text.'),
      group_id: uuid('Only goods of this group').optional(),
      limit,
      offset,
    }),
    annotations: READ_ONLY,
    handler: async (args, { client }) => {
      const page = resolvePage(args);
      const response = await client.request(ENDPOINTS.goods, {
        query: { query: args.query, group_id: args.group_id, ...page },
      });
      return { data: paginated(response, page, summarizeGood) };
    },
  }),

  defineTool({
    name: 'list_taxes',
    title: 'List tax rates',
    description:
      'Lists the tax rates configured for the organization: numeric code, letter symbol, label, rate and extra rate in percent, and whether the tax is included in the price. The numeric code is what a receipt line refers to in its tax list.',
    access: 'read',
    inputSchema: z.object({}),
    annotations: READ_ONLY,
    handler: async (_args, { client }) => ({ data: await client.request(ENDPOINTS.cashierTaxes) }),
  }),

  defineTool({
    name: 'list_orders',
    title: 'List orders',
    description:
      'Lists orders (замовлення): draft receipts that an external system created in Checkbox, to be fiscalized by a courier after delivery and payment. Returns status, payment state and method, and the linked receipt id. Customer delivery details are left out here; get_order returns them.',
    access: 'read',
    inputSchema: z.object({
      statuses: z.array(z.enum(ORDER_STATUSES)).min(1).optional().describe('Only orders in these statuses.'),
      external_order_id: z.string().min(1).optional().describe('Order id in the delivery service.'),
      delivered_from_date: dateTime('Orders delivered from this moment.').optional(),
      delivered_to_date: dateTime('Orders delivered before this moment.').optional(),
      whole_organization: z
        .boolean()
        .optional()
        .describe('Set true to list orders of the whole organization. Default false.'),
      newest_first: z.boolean().optional().describe('Sort from newest to oldest. Default true.'),
      limit,
      offset,
    }),
    annotations: READ_ONLY,
    handler: async (args, { client }) => {
      const page = resolvePage(args);
      const response = await client.request(ENDPOINTS.orders, {
        query: {
          status: args.statuses,
          order_id: args.external_order_id,
          delivered_from_date: args.delivered_from_date,
          delivered_to_date: args.delivered_to_date,
          orders_all: args.whole_organization,
          desc: args.newest_first ?? true,
          ...page,
        },
      });
      return { data: paginated(response, page, summarizeOrder) };
    },
  }),

  defineTool({
    name: 'get_order',
    title: 'Get an order',
    description:
      'Returns one order in full: status, payment, the receipt draft with goods and payments, and the delivery details. The result contains personal data of the customer (name, phone number, address); do not repeat it unless the user asks for it.',
    access: 'read',
    inputSchema: z.object({
      order_id: z.string().min(1).max(128).describe('Order id as returned by list_orders (field "id").'),
      whole_organization: z
        .boolean()
        .optional()
        .describe('Set true to look the order up across the whole organization. Default false.'),
    }),
    annotations: READ_ONLY,
    handler: async (args, { client }) => ({
      data: await client.request(ENDPOINTS.order, {
        pathParams: { order_id: args.order_id },
        query: { orders_all: args.whole_organization },
      }),
    }),
  }),
];

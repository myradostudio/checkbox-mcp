/**
 * Write tools. They are registered only when CHECKBOX_ALLOW_WRITE=1.
 *
 * Input schemas are strict (unknown keys are rejected) on purpose: a misspelled
 * field such as "discount" must fail loudly instead of being dropped silently and
 * producing a fiscal receipt with the wrong total.
 */

import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { CheckboxClient, RequestOptions } from '../client.js';
import { ENDPOINTS, type Endpoint } from '../endpoints.js';
import { CheckboxTransportError, ToolError } from '../errors.js';
import { isObject, receiptId, uuid } from './schemas.js';
import { summarizeReceipt, summarizeShift } from './summaries.js';
import { defineTool, FISCAL_WRITE, NON_FISCAL_WRITE, type AnyTool, type ToolOutput } from './types.js';

const FISCAL_NOTICE =
  'A receipt is a fiscal document: it is reported to the State Tax Service of Ukraine and cannot be edited or deleted afterwards. A mistake can only be compensated with a separate return receipt. Confirm the goods, amounts and payment form with the user before calling.';

/** The API limits amounts to less than 100 000 000 000 kopecks. */
const MAX_AMOUNT = 99_999_999_999;

const kopecks = (what: string) =>
  z.number().int().min(1).max(MAX_AMOUNT).describe(`${what}, in kopecks (1 UAH = 100 kopecks; 135.50 UAH = 13550).`);

const taxCodes = z
  .array(z.number().int())
  .min(1)
  .max(2)
  .optional()
  .describe(
    'Numeric tax codes from list_taxes. Omit for goods that are not taxable. With two codes put VAT first and excise second.',
  );

const idempotencyId = (what: string) =>
  uuid(`Id for the new ${what}`)
    .optional()
    .describe(
      `UUID for the new ${what}. Generated when omitted. Checkbox rejects a second document with the same id, so when a call ends with a timeout, retry with the id reported in the error.`,
    );

const discount = z.strictObject({
  type: z.enum(['DISCOUNT', 'EXTRA_CHARGE']).describe('DISCOUNT lowers the amount, EXTRA_CHARGE raises it.'),
  mode: z.enum(['VALUE', 'PERCENT']).describe('VALUE: an absolute amount in kopecks. PERCENT: a percentage.'),
  value: z.number().min(0).describe('Kopecks for mode VALUE, percent for mode PERCENT.'),
  name: z.string().min(1).optional().describe('Name printed on the receipt.'),
  tax_codes: taxCodes.describe('Tax codes of the goods the discount applies to, needed when those goods are taxed.'),
});

const goodsLine = z.strictObject({
  code: z.string().min(1).max(256).describe('Product code (article).'),
  name: z.string().min(1).describe('Product name as printed on the receipt.'),
  price: kopecks('Price of one unit'),
  quantity: z
    .number()
    .int()
    .min(1)
    .describe('Quantity in thousandths: 1000 = 1 piece, 2250 = 2.25 kg, 500 = half a unit.'),
  tax_codes: taxCodes,
  barcode: z.string().min(1).max(4096).optional().describe('Product barcode.'),
  uktzed: z.string().min(1).max(64).optional().describe('UKTZED code, where the law requires it.'),
  excise_barcodes: z.array(z.string().min(1)).min(1).optional().describe('Excise stamp codes.'),
  good_id: uuid('Id of the product in the Checkbox goods catalogue (from search_goods)').optional(),
  discounts: z.array(discount).min(1).optional().describe('Discounts or extra charges for this line only.'),
});

const CARD_FIELDS = [
  'card_mask',
  'bank_name',
  'auth_code',
  'rrn',
  'payment_system',
  'terminal',
  'acquirer_and_seller',
  'receipt_no',
] as const;

const payment = z.strictObject({
  type: z.enum(['CASH', 'CASHLESS']).describe('CASH, or CASHLESS for cards and any other non-cash form.'),
  value: kopecks('Amount paid with this form'),
  label: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe('Name of the payment form on the receipt. The API defaults to "Готівка" for CASH and "Картка" for CASHLESS.'),
  card_mask: z.string().min(1).max(19).optional().describe('CASHLESS only: masked card number.'),
  bank_name: z.string().min(1).optional().describe('CASHLESS only: bank name.'),
  auth_code: z.string().min(1).optional().describe('CASHLESS only: authorization code of the bank operation.'),
  rrn: z.string().min(1).optional().describe('CASHLESS only: retrieval reference number of the bank transaction.'),
  payment_system: z.string().min(1).optional().describe('CASHLESS only: payment system, e.g. VISA.'),
  terminal: z.string().min(1).optional().describe('CASHLESS only: payment terminal id.'),
  acquirer_and_seller: z.string().min(1).optional().describe('CASHLESS only: acquirer and merchant id.'),
  receipt_no: z.string().min(1).optional().describe('CASHLESS only: number of the bank slip.'),
});

const delivery = z
  .strictObject({
    email: z.email().optional().describe('Customer e-mail for a copy of the receipt.'),
    phone: z
      .string()
      .regex(/^380\d{9}$/, 'Must be 380 followed by 9 digits.')
      .optional()
      .describe('Customer phone as 380XXXXXXXXX for a copy by SMS/Viber. Works only when that paid service is enabled in Checkbox.'),
  })
  .optional()
  .describe('Where Checkbox should send a copy of the receipt.');

const receiptFields = {
  goods: z.array(goodsLine).min(1).max(500).describe('Receipt lines.'),
  discounts: z.array(discount).min(1).optional().describe('Discounts or extra charges for the whole receipt.'),
  delivery,
  rounding_mode: z
    .enum(['ROUND_10', 'ROUND_50'])
    .optional()
    .describe('Cash rounding: ROUND_50 rounds to 50 kopecks (rule in force since 2025-10-01), ROUND_10 to 10 kopecks. The payment amount must already be rounded.'),
  header: z.string().min(1).optional().describe('Text printed above the goods.'),
  footer: z.string().min(1).optional().describe('Text printed below the totals.'),
};

type GoodsLine = z.infer<typeof goodsLine>;
type Payment = z.infer<typeof payment>;
type Discount = z.infer<typeof discount>;

interface SellArguments {
  goods: GoodsLine[];
  payments: Payment[];
  discounts?: Discount[] | undefined;
  delivery?: z.infer<typeof delivery>;
  rounding_mode?: 'ROUND_10' | 'ROUND_50' | undefined;
  header?: string | undefined;
  footer?: string | undefined;
  related_receipt_id?: string | undefined;
}

/** Drops keys whose value is undefined so they are not serialised at all. */
function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Maps the flat tool arguments onto the `ReceiptSellPayload` schema of the API. */
export function buildSellPayload(id: string, args: SellArguments, isReturn: boolean): Record<string, unknown> {
  for (const [index, item] of args.payments.entries()) {
    const cardField = CARD_FIELDS.find((field) => item[field] !== undefined);
    if (item.type === 'CASH' && cardField !== undefined) {
      throw new ToolError(`payments[${index}]: "${cardField}" is allowed only for CASHLESS payments.`);
    }
  }

  return compact({
    id,
    goods: args.goods.map((line) =>
      compact({
        good: compact({
          code: line.code,
          name: line.name,
          price: line.price,
          tax: line.tax_codes,
          barcode: line.barcode,
          uktzed: line.uktzed,
          excise_barcodes: line.excise_barcodes,
        }),
        good_id: line.good_id,
        quantity: line.quantity,
        // Sent only for returns: for a sale the API default (false) applies.
        is_return: isReturn ? true : undefined,
        discounts: line.discounts?.map(compact),
      }),
    ),
    payments: args.payments.map(compact),
    discounts: args.discounts?.map(compact),
    delivery: args.delivery === undefined ? undefined : compact(args.delivery),
    rounding_mode: args.rounding_mode,
    header: args.header,
    footer: args.footer,
    related_receipt_id: args.related_receipt_id,
  });
}

/**
 * Sends a request that creates a fiscal document. If no response arrives, the
 * outcome is unknown: the error tells the model how to find out instead of
 * inviting a blind retry that could register the document twice.
 */
async function submit(
  client: CheckboxClient,
  endpoint: Endpoint,
  options: RequestOptions,
  recovery: string,
): Promise<unknown> {
  try {
    return await client.request(endpoint, options);
  } catch (error) {
    if (error instanceof CheckboxTransportError) {
      throw new ToolError(
        `${error.message} It is unknown whether Checkbox registered the operation. Do not simply repeat the call. ${recovery}`,
      );
    }
    throw error;
  }
}

function receiptResult(id: string, response: unknown): ToolOutput {
  const receipt = isObject(response) ? response : {};
  const status = typeof receipt['status'] === 'string' ? receipt['status'] : 'unknown';
  const notes = [
    `Checkbox accepted receipt ${id} with status ${status}.`,
    'Fiscalization is asynchronous: call get_receipt with this id until the status is DONE.',
    'ERROR means the receipt was not registered: fix the cause and create a new receipt with a new id.',
  ];
  if (receipt['is_test'] === true) {
    notes.push('This is a test receipt (is_test): it is not a fiscal document and must not be handed to a customer.');
  }
  return { note: notes.join(' '), data: summarizeReceipt(receipt) };
}

const receiptRecovery = (id: string) =>
  `First call get_receipt with id ${id}. If the receipt does not exist, call this tool again with the same id ${id}, which makes a duplicate impossible.`;

export const writeTools: readonly AnyTool[] = [
  defineTool({
    name: 'open_shift',
    title: 'Open a shift',
    description:
      'Opens a new shift (зміна) for the signed-in cashier on the cash register behind CHECKBOX_LICENSE_KEY. This is a fiscal action reported to the tax service; it cannot be undone, only ended by closing the shift. Opening is asynchronous: the shift starts as CREATED and becomes OPENED once it is signed and delivered, usually within seconds; CLOSED right after creation means the opening was refused (see initial_transaction). Check with get_current_shift. Checkbox warns that a shift opened through the API must not be operated from the Checkbox Kasa or Manager apps at the same time.',
    access: 'write',
    inputSchema: z.strictObject({ id: idempotencyId('shift') }),
    annotations: FISCAL_WRITE,
    handler: async (args, { client }) => {
      const id = args.id ?? randomUUID();
      const shift = await submit(
        client,
        ENDPOINTS.openShift,
        { body: { id } },
        `First call get_current_shift. If no shift was opened, call this tool again with the same id ${id}.`,
      );
      return {
        note: `Checkbox accepted the request to open shift ${id}. Call get_current_shift until the status is OPENED before creating receipts.`,
        data: isObject(shift) ? summarizeShift(shift) : shift,
      };
    },
  }),

  defineTool({
    name: 'close_shift',
    title: 'Close the shift (Z-report)',
    description:
      'Closes the current shift of the signed-in cashier and creates its Z-report, which is reported to the tax service. This is irreversible: a closed shift cannot be reopened and no more receipts can be added to it; a new shift must be opened to keep selling. Closing is asynchronous: the shift goes to CLOSING and then CLOSED. Checkbox verifies that a shift is closed by the same client program that opened it; this server does not override that check, so a shift opened in another app is expected to be refused. Confirm with the user before calling.',
    access: 'write',
    inputSchema: z.strictObject({}),
    annotations: FISCAL_WRITE,
    handler: async (_args, { client }) => {
      // An empty body makes Checkbox build the Z-report itself, which is what its documentation recommends.
      const shift = await submit(
        client,
        ENDPOINTS.closeShift,
        {},
        'Call get_current_shift: if it reports no open shift, or a shift in status CLOSING or CLOSED, the request went through.',
      );
      return {
        note: 'Checkbox accepted the request to close the shift. Call get_shift with this id until the status is CLOSED; the Z-report is then available through list_reports.',
        data: isObject(shift) ? summarizeShift(shift) : shift,
      };
    },
  }),

  defineTool({
    name: 'create_sale_receipt',
    title: 'Create a sale receipt',
    description: `Creates and fiscalizes a sale receipt (чек продажу) in the open shift of the signed-in cashier. ${FISCAL_NOTICE} Prices and payments are in kopecks, quantities in thousandths (1000 = 1 piece). The payments must cover the receipt total. Requires an open shift (see get_current_shift). Checkbox accepts at most two receipts per second per cash register.`,
    access: 'write',
    inputSchema: z.strictObject({
      id: idempotencyId('receipt'),
      payments: z.array(payment).min(1).max(10).describe('How the customer pays. The amounts must cover the receipt total.'),
      ...receiptFields,
    }),
    annotations: FISCAL_WRITE,
    handler: async (args, { client }) => {
      const id = args.id ?? randomUUID();
      const body = buildSellPayload(id, args, false);
      return receiptResult(id, await submit(client, ENDPOINTS.sellReceipt, { body }, receiptRecovery(id)));
    },
  }),

  defineTool({
    name: 'create_return_receipt',
    title: 'Create a return receipt',
    description: `Creates and fiscalizes a return receipt (чек повернення) in the open shift of the signed-in cashier: every listed line is returned to the seller and the money goes back to the customer. ${FISCAL_NOTICE} A return receipt cannot be cancelled either. List only the goods and quantities that are actually returned, with the prices of the original sale; amounts are positive, in kopecks. Pass related_receipt_id to link the return to the sale. Checkbox refuses to return more than was sold and to pay out more cash than the register holds.`,
    access: 'write',
    inputSchema: z.strictObject({
      id: idempotencyId('receipt'),
      related_receipt_id: uuid('Id of the sale receipt that is being returned').optional(),
      payments: z.array(payment).min(1).max(10).describe('How the money is given back, as positive amounts.'),
      ...receiptFields,
    }),
    annotations: FISCAL_WRITE,
    handler: async (args, { client }) => {
      const id = args.id ?? randomUUID();
      const body = buildSellPayload(id, args, true);
      return receiptResult(id, await submit(client, ENDPOINTS.sellReceipt, { body }, receiptRecovery(id)));
    },
  }),

  defineTool({
    name: 'create_service_receipt',
    title: 'Service cash in or cash out',
    description:
      'Creates a service receipt (службове внесення / службова видача) in the open shift: "cash_in" puts cash into the register, for example change at the start of the day; "cash_out" takes cash out, for example a collection. It is not a sale, but it changes the cash balance, is included in the Z-report sent to the tax service, and cannot be edited or deleted afterwards. Confirm the amount and direction with the user before calling.',
    access: 'write',
    inputSchema: z.strictObject({
      id: idempotencyId('receipt'),
      operation: z.enum(['cash_in', 'cash_out']).describe('cash_in adds cash to the register, cash_out removes it.'),
      amount: kopecks('Amount of cash, always positive'),
    }),
    annotations: FISCAL_WRITE,
    handler: async (args, { client }) => {
      const id = args.id ?? randomUUID();
      // The API tells the two operations apart by the sign of the amount.
      const value = args.operation === 'cash_in' ? args.amount : -args.amount;
      const body = { id, payment: { type: 'CASH', value } };
      return receiptResult(id, await submit(client, ENDPOINTS.serviceReceipt, { body }, receiptRecovery(id)));
    },
  }),

  defineTool({
    name: 'send_receipt_email',
    title: 'E-mail a receipt',
    description:
      'Asks Checkbox to e-mail a copy of an existing receipt to the given addresses. Does not change any fiscal data, but the message cannot be recalled: confirm the addresses with the user.',
    access: 'write',
    inputSchema: z.strictObject({
      receipt_id: receiptId,
      emails: z.array(z.email()).min(1).max(10).describe('Recipient e-mail addresses.'),
    }),
    annotations: NON_FISCAL_WRITE,
    handler: async (args, { client }) => {
      const data = await client.request(ENDPOINTS.receiptEmail, {
        pathParams: { receipt_id: args.receipt_id },
        body: args.emails,
      });
      return {
        note: `Checkbox accepted the request to e-mail receipt ${args.receipt_id} to ${args.emails.length} address(es).`,
        data,
      };
    },
  }),

  defineTool({
    name: 'send_receipt_sms',
    title: 'Send a receipt by SMS or Viber',
    description:
      'Asks Checkbox to send a copy of an existing receipt to a phone number by Viber or SMS. This is a paid Checkbox service that must be activated in the Checkbox portal first. Does not change any fiscal data, but the message cannot be recalled: confirm the number with the user.',
    access: 'write',
    inputSchema: z.strictObject({
      receipt_id: receiptId,
      phone: z
        .string()
        .regex(/^380\d{9}$/, 'Must be 380 followed by 9 digits.')
        .describe('Recipient phone number as 380XXXXXXXXX, without "+".'),
    }),
    annotations: NON_FISCAL_WRITE,
    handler: async (args, { client }) => {
      const data = await client.request(ENDPOINTS.receiptSms, {
        pathParams: { receipt_id: args.receipt_id },
        body: { phone: args.phone },
      });
      return { note: `Checkbox accepted the request to send receipt ${args.receipt_id} by SMS/Viber.`, data };
    },
  }),
];

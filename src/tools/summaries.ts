/**
 * Compact projections for list tools.
 *
 * Full API objects are large (a receipt embeds its shift, cashier, cash register
 * and tax tables). List tools return these summaries to keep the model's context
 * small; the matching `get_*` tool returns the complete object.
 *
 * Field names come from the response schemas of the OpenAPI document. Every
 * function tolerates missing fields, so an API change degrades to a sparser
 * summary instead of an error.
 */

import { isObject } from './schemas.js';

type Json = Record<string, unknown>;

/** Copies the listed keys that are present and not null. */
function pick(source: unknown, keys: readonly string[]): Json {
  const result: Json = {};
  if (!isObject(source)) return result;
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null) result[key] = value;
  }
  return result;
}

function pickNested(source: Json, key: string, keys: readonly string[]): Json {
  const nested = pick(source[key], keys);
  return Object.keys(nested).length > 0 ? { [key]: nested } : {};
}

function list(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

export function summarizeReceipt(receipt: Json): Json {
  return {
    ...pick(receipt, [
      'id',
      'serial',
      'type',
      'status',
      'fiscal_code',
      'fiscal_date',
      'created_at',
      'total_sum',
      'total_payment',
      'total_rest',
      'round_sum',
      'is_test',
      'is_created_offline',
      'is_sent_dps',
      'related_receipt_id',
      'order_id',
      'shift_id',
      'cash_register_id',
      'cashier_id',
    ]),
    goods: list(receipt['goods']).map((item) => ({
      // Full receipts nest the product under `good`; the short form may be flat.
      ...pick(isObject(item['good']) ? item['good'] : item, ['code', 'name', 'price']),
      ...pick(item, ['quantity', 'sum', 'is_return']),
    })),
    payments: list(receipt['payments']).map((payment) => pick(payment, ['type', 'label', 'value'])),
    ...pickNested(receipt, 'shift', ['id', 'serial']),
    ...pickNested(receipt, 'cash_register', ['id', 'fiscal_number']),
    ...pickNested(receipt, 'branch', ['id', 'name', 'address']),
  };
}

export function summarizeShift(shift: Json): Json {
  return {
    ...pick(shift, ['id', 'serial', 'status', 'opened_at', 'closed_at', 'created_at', 'emergency_close', 'balance']),
    ...pickNested(shift, 'cash_register', ['id', 'fiscal_number', 'number']),
    ...pickNested(shift, 'cashier', ['id', 'full_name']),
    ...pickNested(shift, 'z_report', ['id', 'serial', 'fiscal_code']),
  };
}

export function summarizeReport(report: Json): Json {
  return {
    ...pick(report, [
      'id',
      'serial',
      'is_z_report',
      'fiscal_code',
      'fiscal_date',
      'created_at',
      'shift_id',
      'sell_receipts_count',
      'return_receipts_count',
      'cash_withdrawal_receipts_count',
      'initial',
      'balance',
      'discounts_sum',
      'extra_charge_sum',
    ]),
    payments: list(report['payments']).map((payment) =>
      pick(payment, ['type', 'label', 'sell_sum', 'return_sum', 'service_in', 'service_out']),
    ),
  };
}

export function summarizeCashRegister(register: Json): Json {
  const shift = register['shift'];
  return {
    ...pick(register, [
      'id',
      'fiscal_number',
      'number',
      'active',
      'is_test',
      'offline_mode',
      'stay_offline',
      'address',
      'type',
    ]),
    ...pickNested(register, 'branch', ['id', 'name', 'address']),
    ...(isObject(shift) ? { shift: summarizeShift(shift) } : {}),
  };
}

export function summarizeGood(good: Json): Json {
  return {
    ...pick(good, ['id', 'code', 'name', 'price', 'barcode', 'uktzed', 'group_id', 'group_name', 'count', 'is_weight']),
    taxes: list(good['taxes']).map((tax) => pick(tax, ['code', 'symbol', 'label', 'rate', 'extra_rate'])),
  };
}

/** Leaves out the receipt draft and the delivery details (customer name, phone, address). */
export function summarizeOrder(order: Json): Json {
  const draft = isObject(order['receipt_draft']) ? order['receipt_draft'] : {};
  const delivery = isObject(order['delivery_details']) ? order['delivery_details'] : {};
  return {
    ...pick(order, [
      'id',
      'order_id',
      'status',
      'custom_status',
      'is_paid',
      'payment_method',
      'not_fiscalize',
      'created_at',
      'updated_at',
    ]),
    ...pick(draft, ['receipt_id']),
    goods_count: list(draft['goods']).length,
    ...pick(delivery, ['delivery_time']),
  };
}

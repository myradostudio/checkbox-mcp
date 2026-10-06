/**
 * Response fixtures shaped after the response schemas of the Checkbox OpenAPI
 * document. All identifiers, names and numbers are made up.
 */

export const IDS = {
  cashier: '04da40aa-e28e-42b7-8d51-6cb6ee800001',
  organization: '9f0c7c1e-5a55-4f6f-9d0a-000000000002',
  cashRegister: 'c13876dd-e51e-433f-a61c-f2c426300003',
  branch: '7c1d2e3f-4a5b-4c6d-8e7f-000000000004',
  shift: 'cec5dd7e-837c-46c6-a0ba-03a61cd00005',
  receipt: '36ba6627-379d-4fe9-bcce-7e06ad500006',
  report: '1ec62f49-c35f-4ff9-ab46-8d2e83100007',
  good: '94433d09-c47e-48a1-8010-570099e00008',
  order: 'd2a1b0c9-8e7f-4a6b-9c5d-000000000009',
  transaction: '1bde6e04-31e6-41d3-9a65-4b8d46500010',
} as const;

export const cashier = {
  id: IDS.cashier,
  full_name: 'Тестовий касир',
  nin: '1234567890',
  key_id: 'test_key',
  signature_type: 'TEST',
  permissions: { sales: true, returns: true, service_in: true, service_out: true },
  created_at: '2026-01-10T09:00:00+00:00',
  is_test: true,
  organization: {
    id: IDS.organization,
    title: 'ФОП Тестовий',
    edrpou: '00000000',
    tax_number: '000000000000',
    is_vat: false,
    can_send_sms: false,
  },
};

const cashRegisterRef = { id: IDS.cashRegister, fiscal_number: 'TEST000001', active: true, number: '1' };

const balance = {
  initial: 50000,
  balance: 63550,
  cash_sales: 13550,
  card_sales: 42000,
  cash_returns: 0,
  card_returns: 0,
  service_in: 50000,
  service_out: 0,
};

const transaction = {
  id: IDS.transaction,
  type: 'SHIFT_OPEN',
  serial: 157,
  status: 'DONE',
  request_signed_at: '2026-10-06T06:00:01+00:00',
  previous_hash: 'a'.repeat(64),
};

export const shift = {
  id: IDS.shift,
  serial: 43,
  status: 'OPENED',
  z_report: null,
  opened_at: '2026-10-06T06:00:02+00:00',
  closed_at: null,
  initial_transaction: transaction,
  closing_transaction: null,
  created_at: '2026-10-06T06:00:00+00:00',
  balance,
  taxes: [{ code: 8, label: 'Без ПДВ', symbol: 'З', rate: 0, included: true, sales: 0, returns: 0 }],
  cash_register: cashRegisterRef,
  cashier: { id: IDS.cashier, full_name: 'Тестовий касир', nin: '1234567890', key_id: 'test_key', signature_type: 'TEST' },
};

export const receipt = {
  id: IDS.receipt,
  serial: 12,
  status: 'DONE',
  type: 'SELL',
  goods: [
    {
      good: { code: 'A1', name: 'Кава мелена 250 г', price: 13550, barcode: '4820000000017' },
      quantity: 1000,
      sum: 13550,
      is_return: false,
      taxes: [{ code: 8, label: 'Без ПДВ', symbol: 'З', rate: 0, included: true, value: 0, extra_value: 0 }],
      discounts: [],
    },
  ],
  payments: [{ type: 'CASH', value: 13550, label: 'Готівка' }],
  total_sum: 13550,
  total_payment: 13550,
  total_rest: 0,
  round_sum: 0,
  fiscal_code: 'TEST-abc123',
  fiscal_date: '2026-10-06T08:15:00+00:00',
  taxes: [{ code: 8, label: 'Без ПДВ', symbol: 'З', rate: 0, included: true, value: 0, extra_value: 0 }],
  discounts: [],
  created_at: '2026-10-06T08:15:00+00:00',
  is_created_offline: false,
  is_sent_dps: true,
  is_test: true,
  transaction: { ...transaction, type: 'RECEIPT' },
  delivery: { email: 'customer@example.com' },
  tax_url: 'https://cabinet.tax.gov.ua/cashregs/check?id=TEST-abc123',
  shift_id: IDS.shift,
  cashier_id: IDS.cashier,
  cash_register_id: IDS.cashRegister,
  organization_id: IDS.organization,
  shift,
};

export const report = {
  id: IDS.report,
  shift_id: IDS.shift,
  serial: 7,
  is_z_report: true,
  fiscal_code: 'TEST-z0007',
  payments: [
    {
      id: 'aaaaaaaa-0000-4000-8000-000000000011',
      type: 'CASH',
      label: 'Готівка',
      sell_sum: 13550,
      return_sum: 0,
      service_in: 50000,
      service_out: 0,
      cash_withdrawal: 0,
      cash_withdrawal_commission: 0,
    },
  ],
  taxes: [{ id: 'aaaaaaaa-0000-4000-8000-000000000012', code: 8, label: 'Без ПДВ', symbol: 'З', rate: 0, sell_sum: 0, return_sum: 0 }],
  sell_receipts_count: 1,
  return_receipts_count: 0,
  cash_withdrawal_receipts_count: 0,
  transfers_count: 0,
  transfers_sum: 0,
  balance: 63550,
  initial: 50000,
  sales_round_up: 0,
  sales_round_down: 0,
  created_at: '2026-10-06T18:00:00+00:00',
};

export const cashRegister = {
  ...cashRegisterRef,
  created_at: '2026-01-10T09:00:00+00:00',
  is_test: true,
  shift: { ...shift, cash_register: undefined },
  offline_mode: false,
  stay_offline: false,
  branch: {
    id: IDS.branch,
    name: 'Магазин на Тестовій',
    address: 'м. Київ, вул. Тестова, 1',
    organization: cashier.organization,
  },
  address: 'м. Київ, вул. Тестова, 1',
  type: 0,
};

export const cashRegisterInfo = {
  id: IDS.cashRegister,
  organization_id: IDS.organization,
  fiscal_number: 'TEST000001',
  number: '1',
  address: 'м. Київ, вул. Тестова, 1',
  title: 'Каса 1',
  offline_mode: false,
  stay_offline: false,
  has_shift: true,
  documents_state: { last_receipt_code: 12, last_report_code: 7, last_z_report_code: 6 },
  is_test: true,
};

export const good = {
  id: IDS.good,
  code: 'A1',
  name: 'Кава мелена 250 г',
  price: 13550,
  type: 'good',
  barcode: '4820000000017',
  group_name: 'Кава',
  uktzed: '0901',
  taxes: [{ id: 'aaaaaaaa-0000-4000-8000-000000000013', code: 8, label: 'Без ПДВ', symbol: 'З', rate: 0, included: true }],
  count: 24,
  is_weight: false,
  created_at: '2026-02-01T10:00:00+00:00',
  children: [],
  branches_info: [{ branch_id: IDS.branch, count: 24 }],
};

export const taxes = [
  { id: 'aaaaaaaa-0000-4000-8000-000000000014', code: 8, label: 'Без ПДВ', symbol: 'З', rate: 0, included: true, no_vat: true },
  { id: 'aaaaaaaa-0000-4000-8000-000000000015', code: 5, label: 'ПДВ 20%', symbol: 'Є', rate: 20, included: true, no_vat: false },
];

export const order = {
  id: IDS.order,
  order_id: 'WEB-1042',
  status: 'PENDING',
  custom_status: 'NEW',
  is_paid: false,
  payment_method: 'CASH_ON_DELIVERY',
  receipt_draft: {
    receipt_id: IDS.receipt,
    goods: [{ good: { code: 'A1', name: 'Кава мелена 250 г', price: 13550 }, quantity: 2000 }],
    delivery: { email: 'customer@example.com' },
  },
  delivery_details: {
    client_name: 'Олена Тестова',
    client_phone_number: '380501112233',
    address: { city: 'Київ', street: 'Тестова', building: '1' },
    delivery_time: '2026-10-07T12:00:00+00:00',
  },
  created_at: '2026-10-06T09:00:00+00:00',
  not_fiscalize: false,
};

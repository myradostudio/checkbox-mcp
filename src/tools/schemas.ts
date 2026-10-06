/** Zod building blocks shared by the tool input schemas, plus pagination helpers. */

import { z } from 'zod';

import { ToolError } from '../errors.js';

export const DEFAULT_LIMIT = 25;
/** Hard cap on page size. The receipts endpoints of the API do not accept more than 100. */
export const MAX_LIMIT = 100;

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** The API also accepts an 11-character short receipt id (spec pattern `^[\w-]{11}$`). */
const RECEIPT_ID_PATTERN = new RegExp(`${UUID_PATTERN.source}|^[\\w-]{11}$`);

export const uuid = (what: string) => z.string().regex(UUID_PATTERN, 'Must be a UUID.').describe(`${what} (UUID).`);

export const receiptId = z
  .string()
  .regex(RECEIPT_ID_PATTERN, 'Must be a receipt UUID or an 11-character short receipt id.')
  .describe('Receipt id: the UUID, or the 11-character short id.');

export const uuidList = (what: string) =>
  z.array(z.string().regex(UUID_PATTERN, 'Must be a UUID.')).min(1).max(20).optional().describe(`${what} (UUIDs).`);

/**
 * A short pattern instead of `z.iso.datetime()`: the latter puts a 400-character
 * regular expression into the JSON Schema of every date argument of every tool.
 */
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export const dateTime = (what: string) =>
  z
    .string()
    .regex(DATE_TIME_PATTERN, 'Must be an ISO 8601 date-time with a UTC offset, e.g. 2026-10-01T00:00:00+03:00.')
    .refine((value) => !Number.isNaN(Date.parse(value)), 'Not a valid date-time.')
    .describe(
      `${what} ISO 8601 with a UTC offset, e.g. 2026-10-01T00:00:00+03:00 (Kyiv is +02:00 in winter, +03:00 in summer).`,
    );

export const limit = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe(`Page size. Default ${DEFAULT_LIMIT}; values above the cap (${MAX_LIMIT} unless stated otherwise) are clamped.`);

export const offset = z.number().int().min(0).optional().describe('Number of records to skip, for paging. Default 0.');

export interface Page {
  readonly limit: number;
  readonly offset: number;
}

export function resolvePage(args: { limit?: number | undefined; offset?: number | undefined }, cap = MAX_LIMIT): Page {
  return { limit: Math.min(args.limit ?? DEFAULT_LIMIT, cap), offset: args.offset ?? 0 };
}

type Json = Record<string, unknown>;

export function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Wraps a paginated API response (`{ meta, results }`) into the shape every list
 * tool returns. The API reports a total only for some resources, so `next_offset`
 * is derived: a full page means there may be more.
 */
export function paginated(response: unknown, page: Page, mapItem: (item: Json) => unknown = (item) => item) {
  if (!isObject(response) || !Array.isArray(response['results'])) {
    throw new ToolError('Unexpected response from the Checkbox API: a paginated list was expected.');
  }
  const results = response['results'].filter(isObject).map(mapItem);
  const meta = isObject(response['meta']) ? response['meta'] : {};
  const total = meta['total_items'];

  return {
    pagination: {
      limit: page.limit,
      offset: page.offset,
      returned: results.length,
      next_offset: results.length >= page.limit ? page.offset + results.length : null,
      ...(typeof total === 'number' ? { total_items: total } : {}),
    },
    results,
  };
}

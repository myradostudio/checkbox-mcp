/**
 * Checks recorded requests against the snapshot of the official OpenAPI document
 * (spec/checkbox-api.snapshot.json, refreshed with `npm run spec:update`).
 *
 * This is a deliberately small JSON Schema checker covering the keywords the
 * Checkbox document uses for the operations this server calls. Unknown object
 * properties are reported: the server must not send fields the API does not define.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type { RecordedRequest } from './fake-api.js';

type Schema = Record<string, unknown>;

interface Parameter {
  readonly name: string;
  readonly in: 'query' | 'header' | 'path';
  readonly required: boolean;
  readonly schema: Schema;
}

export interface Operation {
  readonly security: boolean;
  readonly parameters: readonly Parameter[];
  readonly responseTypes: readonly string[];
  readonly requestBody?: { readonly required: boolean; readonly schema: Schema };
}

interface Snapshot {
  readonly source: string;
  readonly version: string;
  readonly operations: Readonly<Record<string, Operation>>;
  readonly schemas: Readonly<Record<string, Schema>>;
}

// Compiled tests live in build-test/tests/support/, three levels below the repository root.
export const snapshot = JSON.parse(
  readFileSync(new URL('../../../spec/checkbox-api.snapshot.json', import.meta.url), 'utf8'),
) as Snapshot;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolve(schema: Schema): Schema {
  const ref = schema['$ref'];
  if (typeof ref !== 'string') return schema;
  const name = ref.split('/').pop() ?? '';
  const target = snapshot.schemas[name];
  assert.ok(target, `schema ${name} is missing from the snapshot`);
  return target;
}

const FORMATS: Readonly<Record<string, RegExp>> = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
  'date-time': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/,
};

/** Returns a list of violations; an empty list means the value fits the schema. */
export function validate(rawSchema: Schema, value: unknown, path: string): string[] {
  const schema = resolve(rawSchema);
  const errors: string[] = [];

  for (const part of (schema['allOf'] as Schema[] | undefined) ?? []) {
    errors.push(...validate(part, value, path));
  }
  const alternatives = (schema['anyOf'] ?? schema['oneOf']) as Schema[] | undefined;
  if (alternatives !== undefined) {
    const results = alternatives.map((alternative) => validate(alternative, value, path));
    if (!results.some((result) => result.length === 0)) {
      errors.push(`${path}: fits none of the alternatives (${results.map((result) => result[0]).join(' | ')})`);
    }
  }

  const allowed = schema['enum'] as unknown[] | undefined;
  if (allowed !== undefined && !allowed.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(allowed)}`);
  }

  const type = schema['type'] ?? (schema['properties'] !== undefined ? 'object' : undefined);
  switch (type) {
    case 'string': {
      if (typeof value !== 'string') return [...errors, `${path}: expected a string`];
      const { minLength, maxLength, pattern, format } = schema as {
        minLength?: number;
        maxLength?: number;
        pattern?: string;
        format?: string;
      };
      if (minLength !== undefined && value.length < minLength) errors.push(`${path}: shorter than ${minLength}`);
      if (maxLength !== undefined && value.length > maxLength) errors.push(`${path}: longer than ${maxLength}`);
      if (pattern !== undefined && !new RegExp(pattern).test(value)) errors.push(`${path}: does not match ${pattern}`);
      const formatPattern = format === undefined ? undefined : FORMATS[format];
      if (formatPattern !== undefined && !formatPattern.test(value)) errors.push(`${path}: is not a valid ${format}`);
      break;
    }
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || (type === 'integer' && !Number.isInteger(value))) {
        return [...errors, `${path}: expected ${type === 'integer' ? 'an integer' : 'a number'}`];
      }
      const { minimum, maximum, exclusiveMinimum, exclusiveMaximum } = schema as Record<string, number | undefined>;
      if (minimum !== undefined && value < minimum) errors.push(`${path}: below ${minimum}`);
      if (maximum !== undefined && value > maximum) errors.push(`${path}: above ${maximum}`);
      if (exclusiveMinimum !== undefined && value <= exclusiveMinimum) errors.push(`${path}: not above ${exclusiveMinimum}`);
      if (exclusiveMaximum !== undefined && value >= exclusiveMaximum) errors.push(`${path}: not below ${exclusiveMaximum}`);
      break;
    }
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${path}: expected a boolean`);
      break;
    case 'array': {
      if (!Array.isArray(value)) return [...errors, `${path}: expected an array`];
      const { minItems, maxItems, items } = schema as { minItems?: number; maxItems?: number; items?: Schema };
      if (minItems !== undefined && value.length < minItems) errors.push(`${path}: fewer than ${minItems} items`);
      if (maxItems !== undefined && value.length > maxItems) errors.push(`${path}: more than ${maxItems} items`);
      if (items !== undefined) {
        value.forEach((item, index) => errors.push(...validate(items, item, `${path}[${index}]`)));
      }
      break;
    }
    case 'object': {
      if (!isObject(value)) return [...errors, `${path}: expected an object`];
      const properties = schema['properties'] as Record<string, Schema> | undefined;
      for (const name of (schema['required'] as string[] | undefined) ?? []) {
        if (value[name] === undefined) errors.push(`${path}.${name}: required by the spec but missing`);
      }
      if (properties !== undefined) {
        for (const [name, item] of Object.entries(value)) {
          const property = properties[name];
          if (property === undefined) errors.push(`${path}.${name}: not defined in the spec`);
          else errors.push(...validate(property, item, `${path}.${name}`));
        }
      }
      break;
    }
    default:
      break;
  }
  return errors;
}

/** Converts a query-string value to the type its schema declares, as the API server would. */
function coerce(schema: Schema, raw: string): unknown {
  const type = resolve(schema)['type'];
  if (type === 'integer' || type === 'number') return /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
  if (type === 'boolean') return raw === 'true' ? true : raw === 'false' ? false : raw;
  return raw;
}

function findOperation(request: RecordedRequest): { key: string; operation: Operation; pathParams: Record<string, string> } {
  for (const [key, operation] of Object.entries(snapshot.operations)) {
    const [method = '', template = ''] = key.split(' ');
    if (method !== request.method) continue;
    const names: string[] = [];
    const pattern = template.replace(/\{(\w+)\}/g, (_match, name: string) => {
      names.push(name);
      return '([^/]+)';
    });
    const match = new RegExp(`^${pattern}$`).exec(request.url.pathname);
    if (match === null) continue;
    // A literal segment such as /receipts/search must not be taken for /receipts/{receipt_id}.
    const literal = Object.keys(snapshot.operations).some(
      (other) => other !== key && other === `${request.method} ${request.url.pathname}`,
    );
    if (literal) continue;
    const pathParams = Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1] ?? '')]));
    return { key, operation, pathParams };
  }
  assert.fail(`${request.method} ${request.url.pathname} is not an operation of the Checkbox OpenAPI snapshot`);
}

/**
 * Asserts that a request the server sent is valid according to the spec:
 * known operation, declared and well-typed query and path parameters, the
 * right authentication headers, and a body that fits the request schema.
 * Returns the matched operation key, e.g. `GET /api/v1/receipts/search`.
 */
export function assertMatchesSpec(request: RecordedRequest): string {
  const { key, operation, pathParams } = findOperation(request);
  const errors: string[] = [];
  const parameters = (location: Parameter['in']) => operation.parameters.filter((parameter) => parameter.in === location);

  for (const parameter of parameters('path')) {
    errors.push(...validate(parameter.schema, pathParams[parameter.name], `path.${parameter.name}`));
  }

  const query = parameters('query');
  for (const name of new Set(request.url.searchParams.keys())) {
    const parameter = query.find((candidate) => candidate.name === name);
    if (parameter === undefined) {
      errors.push(`query.${name}: not a query parameter of ${key}`);
      continue;
    }
    const schema = resolve(parameter.schema);
    const values = request.url.searchParams.getAll(name);
    if (schema['type'] === 'array') {
      const items = (schema['items'] as Schema | undefined) ?? {};
      errors.push(...validate(schema, values.map((value) => coerce(items, value)), `query.${name}`));
    } else {
      if (values.length !== 1) errors.push(`query.${name}: sent ${values.length} times but is not an array`);
      errors.push(...validate(schema, coerce(schema, values[0] ?? ''), `query.${name}`));
    }
  }
  for (const parameter of query) {
    if (parameter.required && !request.url.searchParams.has(parameter.name)) {
      errors.push(`query.${parameter.name}: required by the spec but missing`);
    }
  }

  const licenseHeader = parameters('header').find((parameter) => parameter.name === 'X-License-Key');
  const sentLicense = request.headers['x-license-key'];
  if (licenseHeader === undefined && sentLicense !== undefined) {
    errors.push('header X-License-Key: sent to an operation that does not take it');
  }
  if (licenseHeader?.required === true && sentLicense === undefined) {
    errors.push('header X-License-Key: required by the spec but missing');
  }

  const authorization = request.headers['authorization'];
  if (operation.security && !/^Bearer \S+$/.test(authorization ?? '')) {
    errors.push('header Authorization: the operation is secured but no bearer token was sent');
  }
  if (!operation.security && authorization !== undefined) {
    errors.push('header Authorization: a token was sent to an operation that is not secured');
  }
  for (const header of ['x-client-name', 'x-client-version']) {
    if (!request.headers[header]) errors.push(`header ${header}: Checkbox asks every integration to send it`);
  }

  if (operation.requestBody === undefined) {
    if (request.body !== undefined) errors.push('body: the operation does not take a request body');
  } else if (request.body === undefined) {
    if (operation.requestBody.required) errors.push('body: required by the spec but missing');
  } else {
    errors.push(...validate(operation.requestBody.schema, request.body, 'body'));
    if (request.headers['content-type'] !== 'application/json') {
      errors.push('header Content-Type: must be application/json when a body is sent');
    }
  }

  assert.deepEqual(errors, [], `${request.method} ${request.url.pathname}${request.url.search} violates the spec`);
  return key;
}

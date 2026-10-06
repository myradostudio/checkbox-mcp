/**
 * The endpoint catalogue (src/endpoints.ts) must agree with the snapshot of the
 * official OpenAPI document: same operations, same authentication requirements.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ENDPOINTS, type Endpoint } from '../src/endpoints.js';
import { snapshot, validate } from './support/spec.js';

const entries = Object.entries(ENDPOINTS) as [string, Endpoint][];

describe('endpoint catalogue vs. OpenAPI snapshot', () => {
  it('uses a snapshot taken from the official document', () => {
    assert.equal(snapshot.source, 'https://api.checkbox.ua/api/openapi.json');
    assert.match(snapshot.version, /^\d+\.\d+\.\d+/);
  });

  it('covers exactly the operations in the catalogue', () => {
    const catalogue = entries.map(([, endpoint]) => `${endpoint.method} ${endpoint.path}`).sort();
    assert.deepEqual(Object.keys(snapshot.operations).sort(), catalogue);
  });

  for (const [name, endpoint] of entries) {
    it(`${name}: ${endpoint.method} ${endpoint.path}`, () => {
      const operation = snapshot.operations[`${endpoint.method} ${endpoint.path}`];
      assert.ok(operation, 'operation is missing from the snapshot');

      assert.equal(endpoint.auth, operation.security, 'bearer token requirement');

      const licenseHeader = operation.parameters.find(
        (parameter) => parameter.in === 'header' && parameter.name === 'X-License-Key',
      );
      const expected = licenseHeader === undefined ? 'none' : licenseHeader.required ? 'required' : 'optional';
      assert.equal(endpoint.licenseKey, expected, 'X-License-Key requirement');

      const expectedType = endpoint.response === 'text' ? 'text/plain' : 'application/json';
      assert.ok(operation.responseTypes.includes(expectedType), `responds with ${expectedType}`);

      const templateParams = [...endpoint.path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      const specParams = operation.parameters.filter((parameter) => parameter.in === 'path').map((parameter) => parameter.name);
      assert.deepEqual(templateParams.sort(), specParams.sort(), 'path parameters');
    });
  }
});

describe('spec checker', () => {
  const sell = { $ref: '#/components/schemas/ReceiptSellPayload' };
  const good = { code: 'A1', name: 'Кава', price: 4500 };

  it('accepts a minimal valid sale payload', () => {
    assert.deepEqual(validate(sell, { goods: [{ good, quantity: 1000 }] }, 'body'), []);
  });

  it('reports fields the spec does not define', () => {
    const errors = validate(sell, { goods: [{ good, quantity: 1000, qty: 1 }], discount: [] }, 'body');
    assert.deepEqual(errors, ['body.goods[0].qty: not defined in the spec', 'body.discount: not defined in the spec']);
  });

  it('reports missing required fields and wrong types', () => {
    const errors = validate(sell, { goods: [{ good: { code: 'A1', price: '45' }, quantity: 0 }] }, 'body');
    assert.deepEqual(errors, [
      'body.goods[0].good.name: required by the spec but missing',
      'body.goods[0].good.price: expected an integer',
      'body.goods[0].quantity: not above 0',
    ]);
  });

  it('checks enums behind references and alternatives', () => {
    const payments = (type: string) => validate(sell, { goods: [{ good, quantity: 1000 }], payments: [{ type, value: 4500 }] }, 'body');
    assert.deepEqual(payments('CASH'), []);
    assert.deepEqual(payments('CASHLESS'), []);
    assert.equal(payments('BITCOIN').length, 1);
  });
});

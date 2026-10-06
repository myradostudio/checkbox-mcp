/** Tool metadata, annotations, server instructions and error rendering. */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { z } from 'zod';

import { CheckboxClient } from '../src/client.js';
import { runTool, selectTools } from '../src/server.js';
import { defineTool, READ_ONLY } from '../src/tools/types.js';
import { SERVER_NAME, SERVER_VERSION } from '../src/version.js';
import { FakeApi, json } from './support/fake-api.js';
import { createHarness, LICENSE_KEY, PASSWORD, testConfig, type Harness } from './support/harness.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const FISCAL_TOOLS = ['open_shift', 'close_shift', 'create_sale_receipt', 'create_return_receipt', 'create_service_receipt'];
const MESSAGE_TOOLS = ['send_receipt_email', 'send_receipt_sms'];

describe('server metadata', () => {
  it('introduces itself with its name, version and read-only instructions', async () => {
    harness = await createHarness();

    assert.deepEqual(
      { name: harness.mcp.getServerVersion()?.name, version: harness.mcp.getServerVersion()?.version },
      { name: SERVER_NAME, version: SERVER_VERSION },
    );
    const instructions = harness.mcp.getInstructions() ?? '';
    assert.match(instructions, /Unofficial/);
    assert.match(instructions, /kopecks/);
    assert.match(instructions, /read-only mode/);
    assert.doesNotMatch(instructions, /Write tools are enabled/);
  });

  it('warns about fiscal records in the instructions when write tools are enabled', async () => {
    harness = await createHarness({ allowWrite: true });

    const instructions = harness.mcp.getInstructions() ?? '';
    assert.match(instructions, /Write tools are enabled/);
    assert.match(instructions, /cannot be deleted or edited/);
    assert.match(instructions, /explicit confirmation from the user/);
  });

  it('describes every tool: unique snake_case name, title, description, object schema', async () => {
    harness = await createHarness({ allowWrite: true });

    const { tools } = await harness.mcp.listTools();

    assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
    for (const tool of tools) {
      assert.match(tool.name, /^[a-z]+(_[a-z]+)+$/, tool.name);
      assert.ok((tool.title ?? '').length > 0, `${tool.name}: title`);
      assert.ok((tool.description ?? '').length >= 80, `${tool.name}: description`);
      assert.equal(tool.inputSchema.type, 'object', `${tool.name}: input schema`);
    }
  });

  it('documents every argument of every tool', async () => {
    harness = await createHarness({ allowWrite: true });

    const { tools } = await harness.mcp.listTools();

    for (const tool of tools) {
      const properties = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
      for (const [name, property] of Object.entries(properties)) {
        assert.ok((property.description ?? '').length > 0, `${tool.name}.${name} has no description`);
      }
    }
  });
});

describe('annotations', () => {
  it('marks read tools as read-only and idempotent', async () => {
    harness = await createHarness();

    const { tools } = await harness.mcp.listTools();

    for (const tool of tools) {
      assert.deepEqual(
        tool.annotations,
        { title: tool.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        tool.name,
      );
    }
  });

  it('marks fiscal write tools as destructive and not idempotent', async () => {
    harness = await createHarness({ allowWrite: true });

    const { tools } = await harness.mcp.listTools();

    for (const name of FISCAL_TOOLS) {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.deepEqual(
        tool?.annotations,
        { title: tool?.title, readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        name,
      );
    }
  });

  it('marks message tools as writes that are neither destructive nor idempotent', async () => {
    harness = await createHarness({ allowWrite: true });

    const { tools } = await harness.mcp.listTools();

    for (const name of MESSAGE_TOOLS) {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.deepEqual(
        tool?.annotations,
        { title: tool?.title, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        name,
      );
    }
  });

  it('no read tool is ever backed by anything but GET', async () => {
    // Guards the read-only promise at the source: a read tool that sends a POST fails here.
    const api = new FakeApi();
    api.on('GET', /.*/, json({ meta: {}, results: [] }));
    harness = await createHarness({}, api);
    const id = '0b7e2f6a-9d1c-4f3e-8a2b-5c6d7e8f9a0b';
    const period = { from_date: '2026-10-01T00:00:00+03:00', to_date: '2026-10-02T00:00:00+03:00' };
    const sampleArguments: Record<string, Record<string, unknown>> = {
      get_cash_register: { cash_register_id: id },
      get_shift: { shift_id: id },
      get_receipt: { receipt_id: id },
      get_report: { report_id: id },
      get_periodical_report: period,
      get_order: { order_id: id },
    };

    for (const tool of selectTools(testConfig())) {
      await harness.call(tool.name, sampleArguments[tool.name] ?? {});
    }

    assert.ok(api.toolRequests.length >= 16);
    assert.deepEqual([...new Set(api.toolRequests.map((request) => request.method))], ['GET']);
  });
});

describe('fiscal warnings', () => {
  it('receipt tools state plainly that a receipt cannot be deleted', async () => {
    harness = await createHarness({ allowWrite: true });

    const { tools } = await harness.mcp.listTools();

    for (const name of ['create_sale_receipt', 'create_return_receipt']) {
      const description = tools.find((tool) => tool.name === name)?.description ?? '';
      assert.match(description, /A receipt is a fiscal document/, name);
      assert.match(description, /cannot be edited or deleted/, name);
      assert.match(description, /State Tax Service/, name);
    }
    const service = tools.find((tool) => tool.name === 'create_service_receipt')?.description ?? '';
    assert.match(service, /cannot be edited or deleted/);
    const close = tools.find((tool) => tool.name === 'close_shift')?.description ?? '';
    assert.match(close, /irreversible/);
  });
});

describe('error rendering', () => {
  it('returns API errors as isError results with the API message', async () => {
    harness = await createHarness();
    harness.api.on('GET', '/api/v1/cashier/me', json({ message: 'Касира деактивовано' }, 403));

    const result = await harness.call('get_cashier_profile');

    assert.equal(result.isError, true);
    assert.match(result.text, /^Checkbox API error \(HTTP 403\): Касира деактивовано\n/);
  });

  it('returns a failed sign-in as a tool error without leaking credentials', async () => {
    harness = await createHarness();
    harness.api.on('POST', '/api/v1/cashier/signin', json({ message: 'Невірні дані' }, 403));

    const result = await harness.call('get_cashier_profile');

    assert.equal(result.isError, true);
    assert.match(result.text, /Sign-in failed: Невірні дані/);
    assert.ok(!result.text.includes(PASSWORD));
    assert.ok(!result.text.includes(LICENSE_KEY));
  });

  it('never exposes a stack trace, whatever a handler throws', async () => {
    const config = testConfig();
    const context = { config, client: new CheckboxClient({ config, fetch: new FakeApi().fetch }) };
    const failing = (thrown: unknown) =>
      defineTool({
        name: 'failing_tool',
        title: 'Failing tool',
        description: 'Always fails.',
        access: 'read',
        inputSchema: z.object({}),
        annotations: READ_ONLY,
        handler: async () => {
          throw thrown;
        },
      });

    const fromError = await runTool(failing(new TypeError("Cannot read properties of undefined (reading 'x')")), {}, context);
    const fromString = await runTool(failing('plain string'), {}, context);

    assert.deepEqual(fromError, {
      content: [{ type: 'text', text: "Cannot read properties of undefined (reading 'x')" }],
      isError: true,
    });
    assert.deepEqual(fromString, { content: [{ type: 'text', text: 'Unexpected error.' }], isError: true });
    assert.doesNotMatch(JSON.stringify(fromError), /\bat .*\.js/);
  });
});

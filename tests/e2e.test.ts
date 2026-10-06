/**
 * End to end: the built server (dist/index.js) is started as a child process,
 * exactly as an MCP host starts it, and driven over stdio. The Checkbox API is a
 * local HTTP server on 127.0.0.1, so nothing leaves the machine.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';

// Compiled to build-test/tests/e2e.test.js; the server build is in dist/.
const SERVER_ENTRY = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

const LOGIN = 'e2e_cashier';
const PASSWORD = 'e2e-password-do-not-log';
const LICENSE_KEY = 'e2e-license-key-do-not-log';
const TOKEN = 'e2e-access-token-do-not-log';

interface ApiCall {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

let api: Server;
let apiUrl: string;
const apiCalls: ApiCall[] = [];

before(async () => {
  api = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      const path = request.url ?? '';
      apiCalls.push({ method: request.method ?? '', path, headers: request.headers, body });
      const reply = (status: number, payload: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(payload === undefined ? '' : JSON.stringify(payload));
      };
      if (request.method === 'POST' && path === '/api/v1/cashier/signin') {
        reply(200, { type: 'bearer', token_type: 'bearer', access_token: TOKEN });
      } else if (request.method === 'GET' && path === '/api/v1/cashier/me') {
        reply(200, { id: '04da40aa-e28e-42b7-8d51-6cb6ee800001', full_name: 'Тестовий касир', nin: '1234567890', is_test: true });
      } else if (request.method === 'POST' && path === '/api/v1/cashier/signout') {
        reply(205, undefined);
      } else {
        reply(404, { message: 'Not found' });
      }
    });
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((resolve) => api.close(resolve));
});

function serverEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...getDefaultEnvironment(),
    CHECKBOX_LOGIN: LOGIN,
    CHECKBOX_PASSWORD: PASSWORD,
    CHECKBOX_LICENSE_KEY: LICENSE_KEY,
    CHECKBOX_API_URL: apiUrl,
    ...extra,
  };
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return condition();
}

describe('stdio server process', () => {
  it('serves an MCP client: lists the read tools, calls one, signs out on disconnect', async () => {
    apiCalls.length = 0;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_ENTRY],
      env: serverEnv(),
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    // "legacy" is the 2025-era handshake, spoken by every host that has not moved to the 2026 protocol.
    const client = new Client({ name: 'e2e-test', version: '1.0.0' }, { versionNegotiation: { mode: 'legacy' } });
    await client.connect(transport);
    assert.match(client.getNegotiatedProtocolVersion() ?? '', /^2025-/);

    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [
        'get_cashier_profile',
        'list_cash_registers',
        'get_cash_register',
        'get_offline_status',
        'get_current_shift',
        'list_shifts',
        'get_shift',
        'search_receipts',
        'get_receipt',
        'list_reports',
        'get_report',
        'get_periodical_report',
        'search_goods',
        'list_taxes',
        'list_orders',
        'get_order',
      ],
    );
    assert.equal(apiCalls.length, 0, 'listing tools must not contact the API');

    const result = await client.callTool({ name: 'get_cashier_profile', arguments: {} });
    const content = result.content as { type: string; text: string }[];
    assert.notEqual(result.isError, true);
    assert.deepEqual(JSON.parse(content[0]!.text), {
      id: '04da40aa-e28e-42b7-8d51-6cb6ee800001',
      full_name: 'Тестовий касир',
      is_test: true,
    });

    const [signIn, me] = apiCalls;
    assert.equal(`${signIn?.method} ${signIn?.path}`, 'POST /api/v1/cashier/signin');
    assert.deepEqual(JSON.parse(signIn!.body), { login: LOGIN, password: PASSWORD });
    assert.equal(`${me?.method} ${me?.path}`, 'GET /api/v1/cashier/me');
    assert.equal(me?.headers['authorization'], `Bearer ${TOKEN}`);
    assert.equal(me?.headers['x-client-name'], 'checkbox-mcp');
    assert.match(String(me?.headers['x-client-version']), /^\d+\.\d+\.\d+$/);

    await client.close();

    const signedOut = await waitFor(() => apiCalls.some((call) => call.path === '/api/v1/cashier/signout'), 3_000);
    assert.ok(signedOut, 'the token is revoked when the client disconnects');

    assert.match(stderr, /\[checkbox-mcp\] v\d+\.\d+\.\d+ listening on stdio; read-only;/);
    for (const secret of [PASSWORD, LICENSE_KEY, TOKEN]) {
      assert.ok(!stderr.includes(secret), 'secrets must never be written to stderr');
    }
  });

  it('adds the write tools when CHECKBOX_ALLOW_WRITE=1, also for a client of the 2026 protocol', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_ENTRY],
      env: serverEnv({ CHECKBOX_ALLOW_WRITE: '1' }),
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    // "auto" negotiates the newest protocol revision; the first test used the 2025-era handshake.
    const client = new Client({ name: 'e2e-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(transport);

    const protocolVersion = client.getNegotiatedProtocolVersion() ?? '';
    const { tools } = await client.listTools();
    await client.close();

    assert.ok(protocolVersion >= '2026-07-28', `negotiated ${protocolVersion}`);
    assert.equal(tools.length, 23);
    assert.deepEqual(
      tools.filter((tool) => tool.annotations?.readOnlyHint !== true).map((tool) => tool.name),
      [
        'open_shift',
        'close_shift',
        'create_sale_receipt',
        'create_return_receipt',
        'create_service_receipt',
        'send_receipt_email',
        'send_receipt_sms',
      ],
    );
    assert.match(stderr, /WRITE TOOLS ENABLED/);
  });

  it('speaks plain JSON-RPC to a 2025-era client, keeps stdout clean and exits when stdin closes', async () => {
    const child = spawn(process.execPath, [SERVER_ENTRY], { env: serverEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.once('close', resolve));

    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw-client', version: '1.0.0' } },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

    const answered = await waitFor(() => stdout.split('\n').filter(Boolean).length >= 2, 10_000);
    assert.ok(answered, 'the server answered both requests');
    child.stdin.end();
    const exitCode = await Promise.race([exited, new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 5_000))]);
    if (exitCode === 'timeout') child.kill();

    const messages = stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id: number; result: Record<string, unknown> });
    assert.equal(messages.length, 2, 'stdout carries protocol messages only');
    assert.equal(messages[0]?.id, 1);
    assert.equal(messages[0]?.result['protocolVersion'], '2025-06-18');
    assert.equal(messages[1]?.id, 2);
    assert.equal((messages[1]?.result['tools'] as unknown[]).length, 16);
    assert.equal(exitCode, 0, 'the process ends by itself once the client is gone');
  });

  it('refuses to start without credentials: message on stderr, nothing on stdout, exit code 1', () => {
    const result = spawnSync(process.execPath, [SERVER_ENTRY], {
      env: { ...getDefaultEnvironment(), CHECKBOX_ALLOW_WRITE: '1' },
      encoding: 'utf8',
      timeout: 15_000,
    });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /\[checkbox-mcp\] Invalid configuration:/);
    assert.match(result.stderr, /No cashier credentials/);
    assert.match(result.stderr, /CHECKBOX_ALLOW_WRITE=1 requires CHECKBOX_LICENSE_KEY/);
  });
});

#!/usr/bin/env node
/**
 * Entry point: `npx -y @myradostudio/checkbox-mcp`.
 *
 * stdout carries the MCP protocol, so every diagnostic goes to stderr.
 */

import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { CheckboxClient } from './client.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { createServer } from './server.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

function log(message: string): void {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}

function main(): void {
  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    log(error.message);
    log('See the README for the list of environment variables.');
    process.exitCode = 1;
    return;
  }
  for (const notice of config.notices) log(notice);

  const client = new CheckboxClient({ config });

  const handle = serveStdio(() => createServer({ config, client }), {
    // Only the error type is logged: the message of a parse error can quote the
    // offending input, and tool arguments may contain customer data.
    onerror: (error) => log(`Transport error (${error.name}).`),
  });

  // The token is revoked when the connection really ends, so it does not occupy
  // one of the cashier's token slots after the MCP client is gone (best effort).
  // The trigger is stdin reaching its end, not `server.onclose`: while negotiating
  // the protocol version the SDK may build a server instance and discard it again.
  const endSession = (): void => void client.close();
  process.stdin.once('end', endSession);
  process.stdin.once('close', endSession);

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void handle
      .close()
      .catch(() => undefined)
      .then(() => client.close())
      .finally(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const mode = config.allowWrite ? 'WRITE TOOLS ENABLED (fiscal operations are possible)' : 'read-only';
  log(`v${SERVER_VERSION} listening on stdio; ${mode}; API ${config.apiUrl}; sign-in by ${config.auth.method}.`);
}

try {
  main();
} catch (error) {
  log(`Fatal: ${error instanceof Error ? error.message : 'unexpected error'}`);
  process.exitCode = 1;
}

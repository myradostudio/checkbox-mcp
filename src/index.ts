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

  // The token is released when the connection ends, so it does not occupy one of
  // the cashier's token slots after the MCP client is gone. Best effort only.
  let signOut: Promise<void> | undefined;
  const signOutOnce = (): Promise<void> => (signOut ??= client.signOut());

  const handle = serveStdio(
    () => {
      const server = createServer({ config, client });
      server.server.onclose = () => void signOutOnce();
      return server;
    },
    { onerror: (error) => log(`Transport error: ${error.message}`) },
  );

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void handle
      .close()
      .catch(() => undefined)
      .then(signOutOnce)
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

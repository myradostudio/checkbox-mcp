/**
 * Builds the MCP server: picks the tools allowed by the configuration and wires
 * each one to the SDK with uniform result rendering and error handling.
 */

import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';

import type { CheckboxClient } from './client.js';
import type { Config } from './config.js';
import { describeError } from './errors.js';
import { readTools } from './tools/read.js';
import type { AnyTool, ToolContext, ToolOutput } from './tools/types.js';
import { writeTools } from './tools/write.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

export interface ServerDependencies {
  readonly config: Config;
  readonly client: CheckboxClient;
}

const READ_ONLY_MODE =
  'This server runs in read-only mode: it cannot open or close shifts, create receipts or send them. If the user asks for that, explain that the operator has to start the server with CHECKBOX_ALLOW_WRITE=1.';

const WRITE_MODE =
  'Write tools are enabled. Shifts and receipts are fiscal records reported to the State Tax Service of Ukraine and cannot be deleted or edited. Never create one on your own initiative: state exactly what will be registered (goods, quantities, amounts, payment form) and get explicit confirmation from the user first.';

function instructions(config: Config): string {
  return [
    'Unofficial MCP server for Checkbox (checkbox.ua), a Ukrainian software cash register (ПРРО). It acts as one cashier of one organization.',
    'Units: every money amount is an integer in kopecks (1 UAH = 100 kopecks, so 13550 means 135.50 UAH); quantities are integers in thousandths (1000 = 1 piece). Convert to hryvnias when talking to the user.',
    'Dates are ISO 8601 with a UTC offset; business time in Ukraine is Europe/Kyiv.',
    'List tools return compact summaries and a pagination block; use next_offset to get the next page and the matching get_* tool for full details.',
    config.allowWrite ? WRITE_MODE : READ_ONLY_MODE,
  ].join('\n');
}

/** Read tools always; write tools only when the operator opted in. */
export function selectTools(config: Config): readonly AnyTool[] {
  return config.allowWrite ? [...readTools, ...writeTools] : readTools;
}

/**
 * Keys removed from every tool result. `nin` is the personal tax number of a
 * cashier: no tool needs it, so it is never sent to the model.
 */
const OMITTED_KEYS = new Set(['nin']);

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !OMITTED_KEYS.has(key))
        .map(([key, item]) => [key, sanitize(item)]),
    );
  }
  return value;
}

function render(output: ToolOutput): CallToolResult {
  const parts: string[] = [];
  if (output.note !== undefined) parts.push(output.note);
  if (output.data !== undefined) {
    parts.push(typeof output.data === 'string' ? output.data : JSON.stringify(sanitize(output.data), null, 2));
  }
  return { content: [{ type: 'text', text: parts.join('\n\n') }] };
}

/** Runs a tool handler. Failures become `isError` results with a plain message, never a stack trace. */
export async function runTool(tool: AnyTool, args: Record<string, unknown>, context: ToolContext): Promise<CallToolResult> {
  try {
    return render(await tool.handler(args, context));
  } catch (error) {
    return { content: [{ type: 'text', text: describeError(error) }], isError: true };
  }
}

export function createServer({ config, client }: ServerDependencies): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, title: 'Checkbox ПРРО (unofficial)', version: SERVER_VERSION },
    { instructions: instructions(config) },
  );
  const context: ToolContext = { config, client };

  for (const tool of selectTools(config)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { title: tool.title, ...tool.annotations },
      },
      (args) => runTool(tool, args, context),
    );
  }

  return server;
}

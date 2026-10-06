import type { z } from 'zod';

import type { CheckboxClient } from '../client.js';
import type { Config } from '../config.js';

export interface ToolContext {
  readonly client: CheckboxClient;
  readonly config: Config;
}

/** What a tool handler returns; `server.ts` renders it as MCP text content. */
export interface ToolOutput {
  /** Short guidance for the model, placed before the data. */
  readonly note?: string;
  /** JSON-serialisable data, or a string for plain-text documents (receipt and report printouts). */
  readonly data?: unknown;
}

export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface ToolDefinition<Schema extends z.ZodObject = z.ZodObject> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** `write` tools are registered only when CHECKBOX_ALLOW_WRITE=1. */
  readonly access: 'read' | 'write';
  readonly inputSchema: Schema;
  readonly annotations: ToolAnnotations;
  readonly handler: (args: z.infer<Schema>, context: ToolContext) => Promise<ToolOutput>;
}

/** A tool with its argument type erased, so tools with different schemas fit in one list. */
export type AnyTool = ToolDefinition<z.ZodObject>;

/** Identity helper that infers the handler's argument type from `inputSchema`. */
export function defineTool<Schema extends z.ZodObject>(tool: ToolDefinition<Schema>): AnyTool {
  return tool as unknown as AnyTool;
}

/** Every tool talks to an external service, hence `openWorldHint: true` everywhere. */
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * Creates or changes fiscal state that cannot be undone (a receipt, an opened or
 * closed shift). Strictly speaking these are additions, but they are irreversible
 * and legally significant, so they are flagged destructive to make MCP clients ask
 * the user for confirmation.
 */
export const FISCAL_WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

/** Has an outside effect (sends a message) but changes no fiscal data. */
export const NON_FISCAL_WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

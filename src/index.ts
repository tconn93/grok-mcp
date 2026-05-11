import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { fileToolDefs, handleFileTool } from "./tools/files.js";
import { shellToolDefs, handleShellTool } from "./tools/shell.js";
import { networkToolDefs, handleNetworkTool } from "./tools/network.js";
import { systemToolDefs, handleSystemTool } from "./tools/system.js";
import { ptyToolDefs, handlePtyTool } from "./tools/pty.js";

const allTools = [
  ...fileToolDefs,
  ...shellToolDefs,
  ...networkToolDefs,
  ...systemToolDefs,
  ...ptyToolDefs,
];

// Route a tool call to the correct handler module
async function dispatch(name: string, args: Record<string, unknown>): Promise<string> {
  const fileTool = new Set(fileToolDefs.map((t) => t.name));
  const shellTool = new Set(shellToolDefs.map((t) => t.name));
  const networkTool = new Set(networkToolDefs.map((t) => t.name));
  const systemTool = new Set(systemToolDefs.map((t) => t.name));
  const ptyTool = new Set(ptyToolDefs.map((t) => t.name));

  if (fileTool.has(name)) return handleFileTool(name, args);
  if (shellTool.has(name)) return handleShellTool(name, args);
  if (networkTool.has(name)) return handleNetworkTool(name, args);
  if (systemTool.has(name)) return handleSystemTool(name, args);
  if (ptyTool.has(name)) return handlePtyTool(name, args);
  throw new Error(`Unknown tool: ${name}`);
}

const server = new Server(
  { name: "grok-mcp", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allTools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const text = await dispatch(name, (args ?? {}) as Record<string, unknown>);
    return { content: [{ type: "text", text }] };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

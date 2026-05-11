import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import http from "http";
import { randomUUID } from "crypto";

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

const fileTool = new Set(fileToolDefs.map((t) => t.name));
const shellTool = new Set(shellToolDefs.map((t) => t.name));
const networkTool = new Set(networkToolDefs.map((t) => t.name));
const systemTool = new Set(systemToolDefs.map((t) => t.name));
const ptyTool = new Set(ptyToolDefs.map((t) => t.name));

async function dispatch(name: string, args: Record<string, unknown>): Promise<string> {
  if (fileTool.has(name)) return handleFileTool(name, args);
  if (shellTool.has(name)) return handleShellTool(name, args);
  if (networkTool.has(name)) return handleNetworkTool(name, args);
  if (systemTool.has(name)) return handleSystemTool(name, args);
  if (ptyTool.has(name)) return handlePtyTool(name, args);
  throw new Error(`Unknown tool: ${name}`);
}

function makeServer(): Server {
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

  return server;
}

// ─── Transport selection ──────────────────────────────────────────────────────

const useStdio = process.argv.includes("--stdio");

if (useStdio) {
  // Stdio mode: MCP client spawns this process directly
  const server = makeServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
} else {
  // HTTP mode: MCP client connects over the network
  const PORT = parseInt(process.env.PORT ?? "8083", 10);
  const HOST = process.env.HOST ?? "0.0.0.0";

  // Session map: sessionId → transport (one per connected client)
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    // CORS — allow connections from any origin (tighten if needed)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // ── Health check ──────────────────────────────────────────────────────────
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", active_sessions: sessions.size }));
      return;
    }

    // ── MCP endpoint ──────────────────────────────────────────────────────────
    if (req.url === "/mcp") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      // Existing session: route to the right transport
      if (sessionId) {
        const transport = sessions.get(sessionId);
        if (!transport) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Session not found: ${sessionId}` }));
          return;
        }
        await transport.handleRequest(req, res);
        return;
      }

      // New session: must be a POST carrying an initialize request
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "New sessions must start with POST /mcp" }));
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          sessions.delete(sid);
          console.error(`[grok-mcp] Session closed: ${sid} | active: ${sessions.size}`);
        }
      };

      const server = makeServer();
      await server.connect(transport);
      await transport.handleRequest(req, res);

      // Session ID is assigned after the first handleRequest resolves
      const sid = transport.sessionId;
      if (sid) {
        sessions.set(sid, transport);
        console.error(`[grok-mcp] New session:    ${sid} | active: ${sessions.size}`);
      }
      return;
    }

    // ── 404 ───────────────────────────────────────────────────────────────────
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found. MCP endpoint is POST /mcp" }));
  });

  httpServer.listen(PORT, HOST, () => {
    console.error(`[grok-mcp] HTTP server listening on http://${HOST}:${PORT}`);
    console.error(`[grok-mcp]   MCP  →  http://${HOST}:${PORT}/mcp`);
    console.error(`[grok-mcp]   Health → http://${HOST}:${PORT}/health`);
    console.error(`[grok-mcp]   Stdio mode: node dist/index.js --stdio`);
  });

  // Graceful shutdown
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      console.error("[grok-mcp] Shutting down...");
      httpServer.close(() => process.exit(0));
    });
  }
}

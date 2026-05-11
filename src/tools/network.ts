import * as net from "net";
import * as dns from "dns/promises";
import * as os from "os";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const networkToolDefs: Tool[] = [
  {
    name: "http_request",
    description: "Make an HTTP/HTTPS request and return status, headers, and body",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full URL to request" },
        method: {
          type: "string",
          description: "HTTP method (default: GET)",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
        },
        headers: {
          type: "object",
          description: "Request headers",
          additionalProperties: { type: "string" },
        },
        body: { type: "string", description: "Request body (for POST/PUT/PATCH)" },
        timeout_ms: { type: "number", description: "Timeout in ms (default: 30000)" },
        max_body_bytes: {
          type: "number",
          description: "Truncate response body to this many bytes (default: 102400 = 100KB)",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "check_port",
    description: "Check whether a TCP port is open on a host",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "Hostname or IP (default: localhost)" },
        port: { type: "number", description: "TCP port number" },
        timeout_ms: { type: "number", description: "Connection timeout in ms (default: 3000)" },
      },
      required: ["port"],
    },
  },
  {
    name: "list_network_interfaces",
    description: "List all network interfaces with their IP addresses and MAC addresses",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "dns_lookup",
    description: "Resolve a hostname via DNS",
    inputSchema: {
      type: "object",
      properties: {
        hostname: { type: "string", description: "Hostname to resolve" },
        record_type: {
          type: "string",
          description: "DNS record type (default: A)",
          enum: ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "PTR", "SRV"],
        },
      },
      required: ["hostname"],
    },
  },
];

export async function handleNetworkTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case "http_request": {
      const url = args.url as string;
      const method = ((args.method as string) ?? "GET").toUpperCase();
      const headers = (args.headers as Record<string, string>) ?? {};
      const body = args.body as string | undefined;
      const timeoutMs = (args.timeout_ms as number) ?? 30_000;
      const maxBodyBytes = (args.max_body_bytes as number) ?? 100 * 1024;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(url, {
          method,
          headers,
          body: body ?? undefined,
          signal: controller.signal,
        });
        clearTimeout(timer);

        const buffer = await response.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        const truncated = bytes.length > maxBodyBytes;
        const bodyText = new TextDecoder().decode(
          truncated ? bytes.slice(0, maxBodyBytes) : bytes
        );

        return JSON.stringify(
          {
            status: response.status,
            status_text: response.statusText,
            headers: Object.fromEntries(response.headers.entries()),
            body: bodyText,
            body_truncated: truncated,
            body_total_bytes: bytes.length,
          },
          null,
          2
        );
      } finally {
        clearTimeout(timer);
      }
    }

    case "check_port": {
      const host = (args.host as string) ?? "localhost";
      const port = args.port as number;
      const timeoutMs = (args.timeout_ms as number) ?? 3_000;

      return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(timeoutMs);

        socket.on("connect", () => {
          socket.destroy();
          resolve(JSON.stringify({ host, port, status: "open" }, null, 2));
        });
        socket.on("timeout", () => {
          socket.destroy();
          resolve(JSON.stringify({ host, port, status: "timeout" }, null, 2));
        });
        socket.on("error", () => {
          resolve(JSON.stringify({ host, port, status: "closed" }, null, 2));
        });
        socket.connect(port, host);
      });
    }

    case "list_network_interfaces": {
      return JSON.stringify(os.networkInterfaces(), null, 2);
    }

    case "dns_lookup": {
      const hostname = args.hostname as string;
      const recordType = (args.record_type as string) ?? "A";
      try {
        const records = await dns.resolve(hostname, recordType as string);
        return JSON.stringify({ hostname, record_type: recordType, records }, null, 2);
      } catch (err: unknown) {
        const e = err as { code?: string; message?: string };
        return JSON.stringify(
          { hostname, record_type: recordType, error: e.code ?? e.message },
          null,
          2
        );
      }
    }

    default:
      throw new Error(`Unknown network tool: ${name}`);
  }
}

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ptySessions, createPtySession } from "../pty-manager.js";

export const ptyToolDefs: Tool[] = [
  {
    name: "session_create",
    description:
      "Create an interactive terminal session (PTY). Use this for stateful shells, SSH, REPLs, or anything that requires stdin back-and-forth. Returns a session_id.",
    inputSchema: {
      type: "object",
      properties: {
        shell: { type: "string", description: "Shell or program to run (default: /bin/bash)" },
        cwd: { type: "string", description: "Starting working directory (default: /)" },
        env: {
          type: "object",
          description: "Extra environment variables",
          additionalProperties: { type: "string" },
        },
        cols: { type: "number", description: "Terminal width in columns (default: 220)" },
        rows: { type: "number", description: "Terminal height in rows (default: 50)" },
      },
    },
  },
  {
    name: "session_write",
    description:
      "Send input to an interactive terminal session. Append \\n to submit a command. Use \\x03 for Ctrl-C, \\x04 for Ctrl-D, \\x1b for Escape.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "session_id returned by session_create" },
        input: { type: "string", description: "Text to send to the terminal" },
      },
      required: ["session_id", "input"],
    },
  },
  {
    name: "session_read",
    description:
      "Read output accumulated in a terminal session since the last read. The buffer is cleared after each read so you only see new output.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "session_id returned by session_create" },
        wait_ms: {
          type: "number",
          description:
            "Wait this many ms before reading to let the process produce output (default: 0)",
        },
      },
      required: ["session_id"],
    },
  },
  {
    name: "session_resize",
    description: "Resize the terminal window of an active session",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "session_id returned by session_create" },
        cols: { type: "number", description: "New terminal width" },
        rows: { type: "number", description: "New terminal height" },
      },
      required: ["session_id", "cols", "rows"],
    },
  },
  {
    name: "session_close",
    description: "Close and terminate an interactive terminal session",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "session_id returned by session_create" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "list_sessions",
    description: "List all interactive terminal sessions and their status",
    inputSchema: {
      type: "object",
      properties: {
        status_filter: {
          type: "string",
          description: "Filter by status (default: all)",
          enum: ["active", "closed", "all"],
        },
      },
    },
  },
];

export async function handlePtyTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case "session_create": {
      const shell = (args.shell as string) ?? "/bin/bash";
      const cwd = (args.cwd as string) ?? "/";
      const env = (args.env as Record<string, string>) ?? {};
      const cols = (args.cols as number) ?? 220;
      const rows = (args.rows as number) ?? 50;
      const { sessionId, pid } = createPtySession(shell, cwd, env, cols, rows);
      return JSON.stringify({ session_id: sessionId, pid, shell, cwd, status: "active" }, null, 2);
    }

    case "session_write": {
      const session = ptySessions.get(args.session_id as string);
      if (!session) return `No session found: ${args.session_id}`;
      if (session.status === "closed") return `Session is closed: ${args.session_id}`;
      session.pty.write(args.input as string);
      return `Input sent to session ${args.session_id as string}`;
    }

    case "session_read": {
      const session = ptySessions.get(args.session_id as string);
      if (!session) return `No session found: ${args.session_id}`;

      const waitMs = (args.wait_ms as number) ?? 0;
      if (waitMs > 0) {
        await new Promise((r) => setTimeout(r, waitMs));
      }

      const output = session.outputBuffer;
      session.outputBuffer = "";
      return JSON.stringify(
        {
          session_id: args.session_id,
          status: session.status,
          output,
          total_output_chars: session.allOutput.length,
        },
        null,
        2
      );
    }

    case "session_resize": {
      const session = ptySessions.get(args.session_id as string);
      if (!session) return `No session found: ${args.session_id}`;
      if (session.status === "closed") return `Session is closed: ${args.session_id}`;
      session.pty.resize(args.cols as number, args.rows as number);
      return `Resized session ${args.session_id as string} to ${args.cols as number}x${args.rows as number}`;
    }

    case "session_close": {
      const session = ptySessions.get(args.session_id as string);
      if (!session) return `No session found: ${args.session_id}`;
      if (session.status === "closed") return `Session already closed: ${args.session_id}`;
      session.pty.kill();
      session.status = "closed";
      session.closedAt = new Date().toISOString();
      return `Session closed: ${args.session_id as string}`;
    }

    case "list_sessions": {
      const filter = (args.status_filter as string) ?? "all";
      const result: Record<string, unknown>[] = [];
      for (const [id, s] of ptySessions.entries()) {
        if (filter === "all" || s.status === filter) {
          result.push({
            session_id: id,
            shell: s.shell,
            cwd: s.cwd,
            pid: s.pid,
            status: s.status,
            started_at: s.startedAt,
            closed_at: s.closedAt,
            total_output_chars: s.allOutput.length,
          });
        }
      }
      if (result.length === 0)
        return filter === "all" ? "No sessions yet." : `No ${filter} sessions.`;
      return JSON.stringify(result, null, 2);
    }

    default:
      throw new Error(`Unknown PTY tool: ${name}`);
  }
}

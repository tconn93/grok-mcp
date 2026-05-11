import { exec } from "child_process";
import { promisify } from "util";
import * as os from "os";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { processes, spawnBackground } from "../process-manager.js";

const execAsync = promisify(exec);

export const shellToolDefs: Tool[] = [
  {
    name: "run_command",
    description: "Run a shell command synchronously and return stdout, stderr, and exit code",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run" },
        cwd: { type: "string", description: "Working directory (default: /)" },
        timeout_ms: { type: "number", description: "Timeout in ms before kill (default: 60000)" },
        env: {
          type: "object",
          description: "Extra environment variables",
          additionalProperties: { type: "string" },
        },
      },
      required: ["command"],
    },
  },
  {
    name: "run_background",
    description:
      "Run a shell command in the background. Returns a session_id — use get_process_output / get_process_status to follow up",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run" },
        cwd: { type: "string", description: "Working directory (default: /)" },
        env: {
          type: "object",
          description: "Extra environment variables",
          additionalProperties: { type: "string" },
        },
      },
      required: ["command"],
    },
  },
  {
    name: "get_process_output",
    description: "Get accumulated stdout/stderr of a background process by session_id",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "session_id returned by run_background" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "get_process_status",
    description: "Get status and metadata of a background process by session_id",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "session_id returned by run_background" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "kill_process",
    description: "Send a signal to a managed background process",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "session_id returned by run_background" },
        signal: { type: "string", description: "Signal to send (default: SIGTERM)" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "list_processes",
    description: "List all tracked background processes",
    inputSchema: {
      type: "object",
      properties: {
        status_filter: {
          type: "string",
          description: "Filter by status (default: all)",
          enum: ["running", "completed", "failed", "killed", "all"],
        },
      },
    },
  },
  {
    name: "get_system_info",
    description:
      "Get VM system info: CPU, memory, disk, uptime, hostname, OS, network interfaces",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_system_processes",
    description: "List running system processes (ps aux). Optionally filter by name",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Filter output to lines containing this string" },
      },
    },
  },
  {
    name: "kill_system_process",
    description: "Send a signal to any system process by PID",
    inputSchema: {
      type: "object",
      properties: {
        pid: { type: "number", description: "PID of the process to signal" },
        signal: { type: "string", description: "Signal to send (default: SIGTERM)" },
      },
      required: ["pid"],
    },
  },
  {
    name: "service_control",
    description: "Control a systemd service: start, stop, restart, status, enable, disable, reload",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "systemctl action to perform",
          enum: ["start", "stop", "restart", "status", "enable", "disable", "reload", "is-active"],
        },
        service: { type: "string", description: "Service name (e.g. nginx, ssh)" },
      },
      required: ["action", "service"],
    },
  },
  {
    name: "list_services",
    description: "List systemd services, optionally filtered by state or name",
    inputSchema: {
      type: "object",
      properties: {
        state: {
          type: "string",
          description: "Filter by state: active, inactive, failed, etc.",
        },
        filter: { type: "string", description: "Only show services whose name contains this string" },
      },
    },
  },
  {
    name: "package_manager",
    description: "Manage system packages via apt: install, remove, update, upgrade, search, info, list",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "Action to perform",
          enum: ["install", "remove", "purge", "update", "upgrade", "search", "info", "list"],
        },
        package: {
          type: "string",
          description: "Package name (required for install, remove, purge, search, info)",
        },
      },
      required: ["action"],
    },
  },
];

export async function handleShellTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case "run_command": {
      const command = args.command as string;
      const cwd = (args.cwd as string) ?? "/";
      const timeout = (args.timeout_ms as number) ?? 60_000;
      const extraEnv = (args.env as Record<string, string>) ?? {};
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd,
          timeout,
          env: { ...process.env, ...extraEnv },
          maxBuffer: 10 * 1024 * 1024,
        });
        return JSON.stringify(
          { exit_code: 0, stdout: stdout.trimEnd(), stderr: stderr.trimEnd() },
          null,
          2
        );
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
        return JSON.stringify(
          {
            exit_code: e.code ?? 1,
            stdout: (e.stdout ?? "").trimEnd(),
            stderr: (e.stderr ?? e.message ?? "").trimEnd(),
          },
          null,
          2
        );
      }
    }

    case "run_background": {
      const command = args.command as string;
      const cwd = (args.cwd as string) ?? "/";
      const extraEnv = (args.env as Record<string, string>) ?? {};
      const { sessionId, pid } = spawnBackground(command, cwd, extraEnv);
      return JSON.stringify(
        { session_id: sessionId, pid, command, cwd, status: "running" },
        null,
        2
      );
    }

    case "get_process_output": {
      const entry = processes.get(args.session_id as string);
      if (!entry) return `No process found: ${args.session_id}`;
      return JSON.stringify(
        {
          session_id: args.session_id,
          status: entry.status,
          exit_code: entry.exitCode,
          stdout: entry.stdout,
          stderr: entry.stderr,
        },
        null,
        2
      );
    }

    case "get_process_status": {
      const entry = processes.get(args.session_id as string);
      if (!entry) return `No process found: ${args.session_id}`;
      return JSON.stringify(
        {
          session_id: args.session_id,
          command: entry.command,
          cwd: entry.cwd,
          pid: entry.pid,
          status: entry.status,
          exit_code: entry.exitCode,
          started_at: entry.startedAt,
          ended_at: entry.endedAt,
        },
        null,
        2
      );
    }

    case "kill_process": {
      const entry = processes.get(args.session_id as string);
      if (!entry) return `No process found: ${args.session_id}`;
      if (entry.status !== "running") return `Process not running (status: ${entry.status})`;
      if (!entry.pid) return `No PID recorded for session`;
      const signal = (args.signal as NodeJS.Signals) ?? "SIGTERM";
      process.kill(entry.pid, signal);
      entry.status = "killed";
      entry.endedAt = new Date().toISOString();
      return `Sent ${signal} to pid ${entry.pid} (session: ${args.session_id})`;
    }

    case "list_processes": {
      const filter = (args.status_filter as string) ?? "all";
      const result: Record<string, unknown>[] = [];
      for (const [id, entry] of processes.entries()) {
        if (filter === "all" || entry.status === filter) {
          result.push({
            session_id: id,
            command: entry.command,
            cwd: entry.cwd,
            pid: entry.pid,
            status: entry.status,
            exit_code: entry.exitCode,
            started_at: entry.startedAt,
            ended_at: entry.endedAt,
          });
        }
      }
      if (result.length === 0)
        return filter === "all"
          ? "No background processes tracked yet."
          : `No processes with status: ${filter}`;
      return JSON.stringify(result, null, 2);
    }

    case "get_system_info": {
      const [df, free, uptime] = await Promise.allSettled([
        execAsync("df -h 2>/dev/null"),
        execAsync("free -h 2>/dev/null"),
        execAsync("uptime 2>/dev/null"),
      ]);
      return JSON.stringify(
        {
          hostname: os.hostname(),
          platform: os.platform(),
          arch: os.arch(),
          os_release: os.release(),
          uptime: uptime.status === "fulfilled" ? uptime.value.stdout.trim() : null,
          cpu_model: os.cpus()[0]?.model ?? "unknown",
          cpu_count: os.cpus().length,
          load_avg_1_5_15: os.loadavg(),
          total_memory_bytes: os.totalmem(),
          free_memory_bytes: os.freemem(),
          memory_usage: free.status === "fulfilled" ? free.value.stdout.trim() : null,
          disk_usage: df.status === "fulfilled" ? df.value.stdout.trim() : null,
          network_interfaces: os.networkInterfaces(),
        },
        null,
        2
      );
    }

    case "list_system_processes": {
      const filter = args.filter as string | undefined;
      let cmd = "ps aux";
      if (filter) cmd += ` | grep -i '${filter.replace(/'/g, "'\\''")}' | grep -v grep`;
      const { stdout } = await execAsync(cmd, { timeout: 10_000 });
      return stdout.trim() || "(no processes matched)";
    }

    case "kill_system_process": {
      const pid = args.pid as number;
      const signal = (args.signal as NodeJS.Signals) ?? "SIGTERM";
      process.kill(pid, signal);
      return `Sent ${signal} to pid ${pid}`;
    }

    case "service_control": {
      const { action, service } = args as { action: string; service: string };
      try {
        const { stdout, stderr } = await execAsync(
          `systemctl ${action} ${service} 2>&1`,
          { timeout: 30_000 }
        );
        return (stdout + stderr).trim() || `systemctl ${action} ${service}: OK`;
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        return ((e.stdout ?? "") + (e.stderr ?? "") || (e.message ?? "")).trim();
      }
    }

    case "list_services": {
      const state = args.state as string | undefined;
      const filter = args.filter as string | undefined;
      const stateFlag = state ? `--state=${state}` : "";
      const { stdout } = await execAsync(
        `systemctl list-units --type=service ${stateFlag} --no-pager --plain 2>/dev/null`,
        { timeout: 10_000 }
      );
      const lines = stdout.split("\n");
      return (filter ? lines.filter((l) => l.includes(filter)) : lines).join("\n").trim();
    }

    case "package_manager": {
      const action = args.action as string;
      const pkg = args.package as string | undefined;
      const aptEnv = { ...process.env, DEBIAN_FRONTEND: "noninteractive" };

      if (action === "install") {
        if (!pkg) throw new Error("package is required for install");
        const { stdout, stderr } = await execAsync(`apt-get install -y ${pkg}`, {
          env: aptEnv,
          timeout: 300_000,
        });
        return (stdout + stderr).trim();
      }
      if (action === "remove") {
        if (!pkg) throw new Error("package is required for remove");
        const { stdout, stderr } = await execAsync(`apt-get remove -y ${pkg}`, {
          env: aptEnv,
          timeout: 120_000,
        });
        return (stdout + stderr).trim();
      }
      if (action === "purge") {
        if (!pkg) throw new Error("package is required for purge");
        const { stdout, stderr } = await execAsync(`apt-get purge -y ${pkg}`, {
          env: aptEnv,
          timeout: 120_000,
        });
        return (stdout + stderr).trim();
      }
      if (action === "update") {
        const { stdout, stderr } = await execAsync("apt-get update", {
          env: aptEnv,
          timeout: 120_000,
        });
        return (stdout + stderr).trim();
      }
      if (action === "upgrade") {
        const { stdout, stderr } = await execAsync("apt-get upgrade -y", {
          env: aptEnv,
          timeout: 300_000,
        });
        return (stdout + stderr).trim();
      }
      if (action === "search") {
        if (!pkg) throw new Error("package is required for search");
        const { stdout } = await execAsync(`apt-cache search ${pkg}`, { timeout: 10_000 });
        return stdout.trim();
      }
      if (action === "info") {
        if (!pkg) throw new Error("package is required for info");
        const { stdout } = await execAsync(`apt-cache show ${pkg}`, { timeout: 10_000 });
        return stdout.trim();
      }
      if (action === "list") {
        const { stdout } = await execAsync("dpkg -l", { timeout: 10_000 });
        return stdout.trim();
      }
      throw new Error(`Unknown package action: ${action}`);
    }

    default:
      throw new Error(`Unknown shell tool: ${name}`);
  }
}

import * as fs from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const execAsync = promisify(exec);

export const systemToolDefs: Tool[] = [
  {
    name: "change_permissions",
    description: "Change file or directory permissions (chmod)",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file or directory" },
        mode: { type: "string", description: "Octal permission string (e.g. '755', '644')" },
        recursive: { type: "boolean", description: "Apply recursively to directories (default: false)" },
      },
      required: ["path", "mode"],
    },
  },
  {
    name: "change_ownership",
    description: "Change file or directory owner and/or group (chown)",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file or directory" },
        owner: { type: "string", description: "Username or UID to set as owner" },
        group: { type: "string", description: "Group name or GID to set (optional)" },
        recursive: { type: "boolean", description: "Apply recursively (default: false)" },
      },
      required: ["path", "owner"],
    },
  },
  {
    name: "get_env",
    description: "Read environment variables. Returns all vars or a specific one",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Variable name to read. Omit to return all variables" },
      },
    },
  },
  {
    name: "set_env",
    description:
      "Set or unset an environment variable for this server process (persists for session)",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Variable name" },
        value: { type: "string", description: "Value to set. Omit to unset the variable" },
      },
      required: ["key"],
    },
  },
  {
    name: "cron_manage",
    description: "List, add, or remove crontab entries",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "Action to perform",
          enum: ["list", "add", "remove", "clear"],
        },
        entry: {
          type: "string",
          description:
            "Full cron entry to add (e.g. '*/5 * * * * /path/script.sh'), or pattern to match for remove",
        },
        user: { type: "string", description: "User whose crontab to manage (default: current user)" },
      },
      required: ["action"],
    },
  },
  {
    name: "get_logs",
    description: "Read system or service logs via journalctl, or tail a log file",
    inputSchema: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description: "systemd service name (e.g. nginx). Omit for kernel/system log",
        },
        file: { type: "string", description: "Path to a log file to tail instead of journalctl" },
        lines: { type: "number", description: "Number of lines to return (default: 100)" },
        since: {
          type: "string",
          description: "Show logs since this time (e.g. '1 hour ago', '2024-01-01')",
        },
        follow: {
          type: "boolean",
          description: "Return a snapshot — live following not supported in tool mode",
        },
      },
    },
  },
  {
    name: "archive",
    description: "Compress or extract archive files (tar, tar.gz, tar.bz2, zip)",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "Action to perform",
          enum: ["compress", "extract", "list"],
        },
        source: { type: "string", description: "Source file or directory path" },
        destination: {
          type: "string",
          description:
            "Output path. For compress: archive filename. For extract: target directory (default: current dir)",
        },
        format: {
          type: "string",
          description: "Archive format for compress (default: tar.gz)",
          enum: ["tar", "tar.gz", "tar.bz2", "zip"],
        },
      },
      required: ["action", "source"],
    },
  },
];

export async function handleSystemTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case "change_permissions": {
      const filePath = args.path as string;
      const mode = args.mode as string;
      const recursive = (args.recursive as boolean) ?? false;

      if (recursive) {
        await execAsync(`chmod -R ${mode} '${filePath}'`);
      } else {
        await fs.chmod(filePath, parseInt(mode, 8));
      }
      return `Permissions set to ${mode}${recursive ? " (recursive)" : ""}: ${filePath}`;
    }

    case "change_ownership": {
      const filePath = args.path as string;
      const owner = args.owner as string;
      const group = args.group as string | undefined;
      const recursive = (args.recursive as boolean) ?? false;
      const target = group ? `${owner}:${group}` : owner;
      const flag = recursive ? "-R " : "";
      await execAsync(`chown ${flag}'${target}' '${filePath}'`);
      return `Ownership set to ${target}${recursive ? " (recursive)" : ""}: ${filePath}`;
    }

    case "get_env": {
      const key = args.key as string | undefined;
      if (key) return process.env[key] ?? `(not set)`;
      return JSON.stringify(process.env, null, 2);
    }

    case "set_env": {
      const key = args.key as string;
      const value = args.value as string | undefined;
      if (value === undefined) {
        delete process.env[key];
        return `Unset: ${key}`;
      }
      process.env[key] = value;
      return `Set: ${key}=${value}`;
    }

    case "cron_manage": {
      const action = args.action as string;
      const userFlag = args.user ? `-u ${args.user as string} ` : "";

      if (action === "list") {
        try {
          const { stdout } = await execAsync(`crontab ${userFlag}-l`);
          return stdout.trim() || "(no cron jobs)";
        } catch {
          return "(no cron jobs)";
        }
      }

      if (action === "clear") {
        await execAsync(`crontab ${userFlag}-r`).catch(() => {});
        return "Cleared all cron jobs";
      }

      if (action === "add") {
        const entry = args.entry as string;
        if (!entry) throw new Error("entry is required for add");
        let current = "";
        try {
          const r = await execAsync(`crontab ${userFlag}-l`);
          current = r.stdout.trim();
        } catch {}
        const lines = current ? current.split("\n") : [];
        lines.push(entry);
        const tmpFile = `/tmp/crontab_tmp_${Date.now()}`;
        await fs.writeFile(tmpFile, lines.join("\n") + "\n");
        await execAsync(`crontab ${userFlag}'${tmpFile}'`);
        await fs.rm(tmpFile, { force: true });
        return `Added cron job: ${entry}`;
      }

      if (action === "remove") {
        const pattern = args.entry as string;
        if (!pattern) throw new Error("entry (pattern) is required for remove");
        let current = "";
        try {
          const r = await execAsync(`crontab ${userFlag}-l`);
          current = r.stdout;
        } catch {}
        const filtered = current
          .split("\n")
          .filter((l) => !l.includes(pattern))
          .join("\n");
        const tmpFile = `/tmp/crontab_tmp_${Date.now()}`;
        await fs.writeFile(tmpFile, filtered + "\n");
        await execAsync(`crontab ${userFlag}'${tmpFile}'`);
        await fs.rm(tmpFile, { force: true });
        return `Removed cron entries matching: ${pattern}`;
      }

      throw new Error(`Unknown cron action: ${action}`);
    }

    case "get_logs": {
      const lines = (args.lines as number) ?? 100;

      if (args.file) {
        const { stdout } = await execAsync(
          `tail -n ${lines} '${args.file as string}'`,
          { timeout: 10_000 }
        );
        return stdout;
      }

      const parts = ["journalctl", "--no-pager", "-o", "short", `-n ${lines}`];
      if (args.service) parts.push(`-u '${args.service as string}'`);
      if (args.since) parts.push(`--since '${args.since as string}'`);

      try {
        const { stdout } = await execAsync(parts.join(" "), { timeout: 10_000 });
        return stdout.trim();
      } catch (err: unknown) {
        const e = err as { message?: string };
        return `Error reading logs: ${e.message ?? String(err)}`;
      }
    }

    case "archive": {
      const action = args.action as string;
      const source = args.source as string;
      const destination = args.destination as string | undefined;
      const format = (args.format as string) ?? "tar.gz";

      if (action === "compress") {
        const dest = destination ?? `${source}.${format === "tar.gz" ? "tar.gz" : format}`;
        const cmds: Record<string, string> = {
          "tar.gz": `tar -czf '${dest}' '${source}'`,
          "tar.bz2": `tar -cjf '${dest}' '${source}'`,
          tar: `tar -cf '${dest}' '${source}'`,
          zip: `zip -r '${dest}' '${source}'`,
        };
        const cmd = cmds[format];
        if (!cmd) throw new Error(`Unsupported format: ${format}`);
        await execAsync(cmd, { timeout: 120_000 });
        return `Compressed: ${source} → ${dest}`;
      }

      if (action === "extract") {
        const dest = destination ?? ".";
        const src = source.toLowerCase();
        let cmd: string;
        if (src.endsWith(".zip")) cmd = `unzip -o '${source}' -d '${dest}'`;
        else if (src.endsWith(".tar.gz") || src.endsWith(".tgz"))
          cmd = `tar -xzf '${source}' -C '${dest}'`;
        else if (src.endsWith(".tar.bz2")) cmd = `tar -xjf '${source}' -C '${dest}'`;
        else if (src.endsWith(".tar")) cmd = `tar -xf '${source}' -C '${dest}'`;
        else throw new Error(`Unrecognized archive extension: ${source}`);
        await execAsync(cmd, { timeout: 120_000 });
        return `Extracted: ${source} → ${dest}`;
      }

      if (action === "list") {
        const src = source.toLowerCase();
        let cmd: string;
        if (src.endsWith(".zip")) cmd = `unzip -l '${source}'`;
        else if (src.endsWith(".tar.gz") || src.endsWith(".tgz"))
          cmd = `tar -tzf '${source}'`;
        else if (src.endsWith(".tar.bz2")) cmd = `tar -tjf '${source}'`;
        else if (src.endsWith(".tar")) cmd = `tar -tf '${source}'`;
        else throw new Error(`Unrecognized archive extension: ${source}`);
        const { stdout } = await execAsync(cmd, { timeout: 30_000 });
        return stdout.trim();
      }

      throw new Error(`Unknown archive action: ${action}`);
    }

    default:
      throw new Error(`Unknown system tool: ${name}`);
  }
}

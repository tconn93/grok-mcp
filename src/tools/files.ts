import * as fs from "fs/promises";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const execAsync = promisify(exec);

export const fileToolDefs: Tool[] = [
  {
    name: "read_file",
    description: "Read the contents of a file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to the file" },
        encoding: { type: "string", description: "File encoding (default: utf8)" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file, creating it (and any missing parent dirs) if needed",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file" },
        content: { type: "string", description: "Content to write" },
        encoding: { type: "string", description: "File encoding (default: utf8)" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "append_file",
    description: "Append content to a file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file" },
        content: { type: "string", description: "Content to append" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "delete_file",
    description: "Delete a file or directory",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file or directory" },
        recursive: { type: "boolean", description: "Recursively delete directories (default: false)" },
      },
      required: ["path"],
    },
  },
  {
    name: "move_file",
    description: "Move or rename a file or directory",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source path" },
        destination: { type: "string", description: "Destination path" },
      },
      required: ["source", "destination"],
    },
  },
  {
    name: "copy_file",
    description: "Copy a file to a new location",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source file path" },
        destination: { type: "string", description: "Destination file path" },
      },
      required: ["source", "destination"],
    },
  },
  {
    name: "list_directory",
    description: "List the contents of a directory",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the directory" },
        show_hidden: { type: "boolean", description: "Include hidden files (default: false)" },
      },
      required: ["path"],
    },
  },
  {
    name: "make_directory",
    description: "Create a directory and any necessary parent directories",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the directory to create" },
      },
      required: ["path"],
    },
  },
  {
    name: "file_info",
    description: "Get metadata about a file or directory: size, permissions, timestamps",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file or directory" },
      },
      required: ["path"],
    },
  },
  {
    name: "find_files",
    description: "Search for files and directories using find-style filters",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Root path to search from" },
        name: { type: "string", description: "Filename glob pattern (e.g. '*.log')" },
        type: {
          type: "string",
          description: "Entry type: f (file), d (directory), l (symlink)",
          enum: ["f", "d", "l"],
        },
        max_depth: { type: "number", description: "Max directory depth to recurse" },
        min_size: { type: "string", description: "Minimum size filter (e.g. '+1M', '+10k')" },
        max_size: { type: "string", description: "Maximum size filter (e.g. '-1M')" },
        max_results: { type: "number", description: "Max number of results (default: 200)" },
      },
      required: ["path"],
    },
  },
  {
    name: "grep_files",
    description: "Search for a pattern inside file contents",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Search pattern (regex supported)" },
        path: { type: "string", description: "Directory or file to search" },
        recursive: { type: "boolean", description: "Search recursively (default: true)" },
        case_insensitive: { type: "boolean", description: "Case-insensitive match (default: false)" },
        line_numbers: { type: "boolean", description: "Show line numbers (default: true)" },
        include: { type: "string", description: "Only search files matching glob (e.g. '*.ts')" },
        exclude: { type: "string", description: "Skip files matching glob (e.g. '*.min.js')" },
        max_results: { type: "number", description: "Max number of matching lines (default: 100)" },
      },
      required: ["pattern", "path"],
    },
  },
];

export async function handleFileTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case "read_file": {
      const encoding = (args.encoding as BufferEncoding) ?? "utf8";
      return await fs.readFile(args.path as string, { encoding });
    }

    case "write_file": {
      const encoding = (args.encoding as BufferEncoding) ?? "utf8";
      await fs.mkdir(path.dirname(args.path as string), { recursive: true });
      await fs.writeFile(args.path as string, args.content as string, { encoding });
      return `Written: ${args.path}`;
    }

    case "append_file": {
      await fs.appendFile(args.path as string, args.content as string, "utf8");
      return `Appended to: ${args.path}`;
    }

    case "delete_file": {
      await fs.rm(args.path as string, {
        recursive: (args.recursive as boolean) ?? false,
        force: true,
      });
      return `Deleted: ${args.path}`;
    }

    case "move_file": {
      await fs.rename(args.source as string, args.destination as string);
      return `Moved: ${args.source} → ${args.destination}`;
    }

    case "copy_file": {
      await fs.copyFile(args.source as string, args.destination as string);
      return `Copied: ${args.source} → ${args.destination}`;
    }

    case "list_directory": {
      const showHidden = (args.show_hidden as boolean) ?? false;
      const entries = await fs.readdir(args.path as string, { withFileTypes: true });
      const filtered = showHidden
        ? entries
        : entries.filter((e) => !e.name.startsWith("."));
      const lines = await Promise.all(
        filtered.map(async (entry) => {
          const full = path.join(args.path as string, entry.name);
          try {
            const stat = await fs.stat(full);
            const t = entry.isDirectory() ? "d" : entry.isSymbolicLink() ? "l" : "-";
            const size = entry.isDirectory() ? "" : `  ${stat.size}B`;
            return `${t}  ${entry.name}${size}`;
          } catch {
            return `?  ${entry.name}`;
          }
        })
      );
      return lines.join("\n") || "(empty directory)";
    }

    case "make_directory": {
      await fs.mkdir(args.path as string, { recursive: true });
      return `Directory created: ${args.path}`;
    }

    case "file_info": {
      const stat = await fs.stat(args.path as string);
      return JSON.stringify(
        {
          path: args.path,
          type: stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "file",
          size_bytes: stat.size,
          permissions: (stat.mode & 0o777).toString(8),
          uid: stat.uid,
          gid: stat.gid,
          created: stat.birthtime.toISOString(),
          modified: stat.mtime.toISOString(),
          accessed: stat.atime.toISOString(),
        },
        null,
        2
      );
    }

    case "find_files": {
      const root = args.path as string;
      const maxResults = (args.max_results as number) ?? 200;
      const parts = ["find", `'${root}'`];
      if (args.max_depth !== undefined) parts.push(`-maxdepth ${args.max_depth as number}`);
      if (args.type) parts.push(`-type ${args.type as string}`);
      if (args.name) parts.push(`-name '${args.name as string}'`);
      if (args.min_size) parts.push(`-size ${args.min_size as string}`);
      if (args.max_size) parts.push(`-size ${args.max_size as string}`);
      parts.push(`2>/dev/null | head -${maxResults}`);
      const { stdout } = await execAsync(parts.join(" "), { timeout: 30_000 });
      return stdout.trim() || "(no results)";
    }

    case "grep_files": {
      const pattern = (args.pattern as string).replace(/'/g, "'\\''");
      const searchPath = args.path as string;
      const recursive = (args.recursive as boolean) ?? true;
      const ci = (args.case_insensitive as boolean) ?? false;
      const ln = (args.line_numbers as boolean) ?? true;
      const maxResults = (args.max_results as number) ?? 100;

      const flags = [
        recursive ? "-r" : "",
        ci ? "-i" : "",
        ln ? "-n" : "",
        args.include ? `--include='${args.include as string}'` : "",
        args.exclude ? `--exclude='${args.exclude as string}'` : "",
      ]
        .filter(Boolean)
        .join(" ");

      const cmd = `grep ${flags} -e '${pattern}' '${searchPath}' 2>/dev/null | head -${maxResults}`;
      try {
        const { stdout } = await execAsync(cmd, { timeout: 30_000 });
        return stdout.trim() || "(no matches)";
      } catch (err: unknown) {
        // grep exits 1 when no matches — not a real error
        const e = err as { code?: number; stdout?: string };
        if (e.code === 1) return "(no matches)";
        throw err;
      }
    }

    default:
      throw new Error(`Unknown file tool: ${name}`);
  }
}

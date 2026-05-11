import { spawn } from "child_process";
import * as crypto from "crypto";

export interface ProcessEntry {
  command: string;
  cwd: string;
  status: "running" | "completed" | "failed" | "killed";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  endedAt: string | null;
  pid: number | undefined;
}

export const processes = new Map<string, ProcessEntry>();

export function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
}

export function spawnBackground(
  command: string,
  cwd: string,
  extraEnv: Record<string, string>
): { sessionId: string; pid: number | undefined } {
  const sessionId = newId("proc");

  const entry: ProcessEntry = {
    command,
    cwd,
    status: "running",
    exitCode: null,
    stdout: "",
    stderr: "",
    startedAt: new Date().toISOString(),
    endedAt: null,
    pid: undefined,
  };
  processes.set(sessionId, entry);

  const child = spawn("bash", ["-c", command], {
    cwd,
    env: { ...process.env, ...extraEnv },
  });

  entry.pid = child.pid;

  child.stdout.on("data", (chunk: Buffer) => {
    entry.stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    entry.stderr += chunk.toString();
  });
  child.on("close", (code: number | null) => {
    entry.exitCode = code;
    entry.status = code === 0 ? "completed" : "failed";
    entry.endedAt = new Date().toISOString();
  });
  child.on("error", (err: Error) => {
    entry.stderr += `\nSpawn error: ${err.message}`;
    entry.status = "failed";
    entry.endedAt = new Date().toISOString();
  });

  return { sessionId, pid: child.pid };
}

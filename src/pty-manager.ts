import { spawn as ptySpawn } from "node-pty";
import type { IPty } from "node-pty";
import { newId } from "./process-manager.js";

export interface PtySession {
  pty: IPty;
  outputBuffer: string;
  allOutput: string;
  status: "active" | "closed";
  shell: string;
  cwd: string;
  pid: number;
  startedAt: string;
  closedAt: string | null;
}

export const ptySessions = new Map<string, PtySession>();

export function createPtySession(
  shell: string,
  cwd: string,
  env: Record<string, string>,
  cols: number,
  rows: number
): { sessionId: string; pid: number } {
  const sessionId = newId("pty");

  const pty = ptySpawn(shell, [], {
    name: "xterm-256color",
    cwd,
    env: { ...process.env, ...env } as Record<string, string>,
    cols,
    rows,
  });

  const session: PtySession = {
    pty,
    outputBuffer: "",
    allOutput: "",
    status: "active",
    shell,
    cwd,
    pid: pty.pid,
    startedAt: new Date().toISOString(),
    closedAt: null,
  };
  ptySessions.set(sessionId, session);

  pty.onData((data: string) => {
    session.outputBuffer += data;
    session.allOutput += data;
  });

  pty.onExit(() => {
    session.status = "closed";
    session.closedAt = new Date().toISOString();
  });

  return { sessionId, pid: pty.pid };
}

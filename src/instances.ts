/**
 * Registry of Godot LSP instances managed by `godot-lsp-cli serve`.
 * Stored at ~/.godot-lsp-cli/instances.json, one entry per project.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Socket, createServer } from "net";

export interface InstanceEntry {
  project: string;
  port: number;
  pid: number;
  godotBin: string;
  startedAt: string;
}

function baseDir(): string {
  return path.join(os.homedir(), ".godot-lsp-cli");
}

export function registryPath(): string {
  return path.join(baseDir(), "instances.json");
}

export function logsDir(): string {
  return path.join(baseDir(), "logs");
}

export function ensureDirs(): void {
  fs.mkdirSync(logsDir(), { recursive: true });
}

function readRaw(): InstanceEntry[] {
  try {
    const text = fs.readFileSync(registryPath(), "utf-8");
    const data = JSON.parse(text);
    if (!Array.isArray(data)) return [];
    return data.filter(
      (e): e is InstanceEntry =>
        e &&
        typeof e.project === "string" &&
        typeof e.port === "number" &&
        typeof e.pid === "number" &&
        typeof e.godotBin === "string" &&
        typeof e.startedAt === "string"
    );
  } catch {
    return [];
  }
}

function writeRaw(entries: InstanceEntry[]): void {
  fs.mkdirSync(baseDir(), { recursive: true });
  fs.writeFileSync(registryPath(), JSON.stringify(entries, null, 2) + "\n");
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isPortOpen(port: number, host = "127.0.0.1", timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const finish = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      finish(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      finish(false);
    });
    socket.connect(port, host);
  });
}

async function isLive(entry: InstanceEntry): Promise<boolean> {
  if (!isPidAlive(entry.pid)) return false;
  return isPortOpen(entry.port);
}

/** Reads the registry, pruning any entry whose pid or port is no longer live. */
export async function readRegistry(): Promise<InstanceEntry[]> {
  const entries = readRaw();
  const live: InstanceEntry[] = [];
  for (const entry of entries) {
    if (await isLive(entry)) live.push(entry);
  }
  if (live.length !== entries.length) writeRaw(live);
  return live;
}

export async function findLiveEntry(project: string): Promise<InstanceEntry | undefined> {
  const entries = await readRegistry();
  return entries.find((e) => e.project === project);
}

export async function upsertEntry(entry: InstanceEntry): Promise<void> {
  const entries = await readRegistry();
  const filtered = entries.filter((e) => e.project !== entry.project);
  filtered.push(entry);
  writeRaw(filtered);
}

export async function removeEntry(project: string): Promise<InstanceEntry | undefined> {
  const entries = await readRegistry();
  const found = entries.find((e) => e.project === project);
  const remaining = entries.filter((e) => e.project !== project);
  writeRaw(remaining);
  return found;
}

export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export function logFilePath(project: string): string {
  const safeName = project.replace(/[\\/:]/g, "_");
  return path.join(logsDir(), `${safeName}.log`);
}

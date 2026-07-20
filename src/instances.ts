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

/**
 * Serializes registry writes across processes via a lock directory, so
 * concurrent serve/stop commands cannot drop each other's entries.
 */
async function withLock<T>(fn: () => T): Promise<T> {
  fs.mkdirSync(baseDir(), { recursive: true });
  const lockDir = path.join(baseDir(), "registry.lock");
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch {
      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > 10000) {
          fs.rmdirSync(lockDir);
          continue;
        }
      } catch {}
      if (Date.now() > deadline) throw new Error(`Timed out waiting for registry lock: ${lockDir}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.rmdirSync(lockDir);
    } catch {}
  }
}

function entryKey(entry: InstanceEntry): string {
  return `${entry.project}|${entry.pid}`;
}

/** Reads the registry, pruning any entry whose pid or port is no longer live. */
export async function readRegistry(): Promise<InstanceEntry[]> {
  const entries = readRaw();
  const live: InstanceEntry[] = [];
  for (const entry of entries) {
    if (await isLive(entry)) live.push(entry);
  }
  if (live.length !== entries.length) {
    const liveKeys = new Set(live.map(entryKey));
    const deadKeys = new Set(entries.map(entryKey).filter((k) => !liveKeys.has(k)));
    await withLock(() => writeRaw(readRaw().filter((e) => !deadKeys.has(entryKey(e)))));
  }
  return live;
}

export async function findLiveEntry(project: string): Promise<InstanceEntry | undefined> {
  const entries = await readRegistry();
  return entries.find((e) => e.project === project);
}

export async function upsertEntry(entry: InstanceEntry): Promise<void> {
  await withLock(() => {
    const filtered = readRaw().filter((e) => e.project !== entry.project);
    filtered.push(entry);
    writeRaw(filtered);
  });
}

export async function removeEntry(project: string): Promise<InstanceEntry | undefined> {
  return withLock(() => {
    const entries = readRaw();
    const found = entries.find((e) => e.project === project);
    writeRaw(entries.filter((e) => e.project !== project));
    return found;
  });
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

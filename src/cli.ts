#!/usr/bin/env node

/**
 * godot-lsp-cli — CLI that talks to Godot's built-in LSP.
 *
 * Usage:
 *   godot-lsp-cli rename <file> <line> <col> <newName> [--host 127.0.0.1] [--port 6005]
 *   godot-lsp-cli references <file> <line> <col>
 *   godot-lsp-cli definition <file> <line> <col>
 *   godot-lsp-cli symbols <file>
 *   godot-lsp-cli hover <file> <line> <col>
 *   godot-lsp-cli diagnostics [file]
 *   godot-lsp-cli workspace-symbols <query>
 *   godot-lsp-cli serve --project <path>
 *   godot-lsp-cli stop --project <path>
 *   godot-lsp-cli list
 *
 * Lines and columns are 0-based (LSP convention).
 * Requires Godot editor or headless LSP running:
 *   godot --editor --headless --lsp-port 6005 --path /your/project
 * or managed via `godot-lsp-cli serve --project <path>`.
 */

import * as path from "path";
import * as fs from "fs";
import { spawn } from "child_process";
import { GodotLspClient, symbolKindName } from "./client.js";
import type { WorkspaceEdit, Location, DocumentSymbol, SymbolInformation, Diagnostic, Range } from "./client.js";
import {
  readRegistry,
  findLiveEntry,
  upsertEntry,
  removeEntry,
  pickFreePort,
  ensureDirs,
  logFilePath,
} from "./instances.js";
import type { InstanceEntry } from "./instances.js";

function usage(): never {
  console.error(`godot-lsp-cli v0.1.0 — CLI for Godot's built-in LSP

Commands:
  rename <file> <line> <col> <newName>   Rename symbol across project
  references <file> <line> <col>         Find all references to symbol
  definition <file> <line> <col>         Go to definition
  declaration <file> <line> <col>        Go to declaration
  symbols <file>                         List symbols in file
  hover <file> <line> <col>              Get hover info for symbol
  native-symbol <class> [member]         Get docs for Godot built-in class/member
  diagnostics [file]                     Show diagnostics (errors/warnings)
  capabilities                           Show LSP server capabilities

  serve --project <path>                 Start (or reuse) a managed Godot LSP instance for a project
  stop --project <path> | --all          Stop managed instance(s)
  list                                   List managed Godot LSP instances

Options:
  --host <host>       LSP server host (default: 127.0.0.1)
  --port <port>       LSP server port (default: 6005)
  --project <path>    Godot project root (improves LSP results, enables instance routing)
  --json              Output as JSON instead of human-readable text

serve-only options:
  --godot <bin>       Path to the Godot binary (default: $GODOT_BIN, then "godot" on PATH)
  --timeout <sec>     Seconds to wait for the LSP to become ready (default: 180)

Lines and columns are 0-based (LSP convention).

Port routing for all non-management commands:
  1. --port, if given, always wins
  2. else, if --project matches a live "serve"-managed instance, its port is used
  3. else, the default port 6005 is used (same as before instance management existed)

Requires Godot LSP running:
  godot --editor --headless --lsp-port 6005 --path /your/project
or managed via:
  godot-lsp-cli serve --project /your/project`);
  process.exit(1);
}

function parseArgs(argv: string[]): {
  command: string;
  args: string[];
  host: string;
  port: number;
  portExplicit: boolean;
  project: string | undefined;
  json: boolean;
} {
  const host = extractFlag(argv, "--host") ?? "127.0.0.1";
  const portRaw = extractFlag(argv, "--port");
  const port = parseInt(portRaw ?? "6005", 10);
  const project = extractFlag(argv, "--project") ?? undefined;
  const json = removeFlag(argv, "--json");

  const command = argv[0] ?? "";
  const args = argv.slice(1);
  return { command, host, port, portExplicit: portRaw !== null, project, json, args };
}

function extractFlag(argv: string[], flag: string): string | null {
  const idx = argv.indexOf(flag);
  if (idx === -1) return null;
  const value = argv[idx + 1];
  argv.splice(idx, 2);
  return value;
}

function removeFlag(argv: string[], flag: string): boolean {
  const idx = argv.indexOf(flag);
  if (idx === -1) return false;
  argv.splice(idx, 1);
  return true;
}

function formatLocation(loc: Location): string {
  const file = decodeURIComponent(loc.uri.replace(/^file:\/\/\//, ""));
  const line = loc.range.start.line;
  const col = loc.range.start.character;
  return `${file}:${line}:${col}`;
}

function formatRange(range: Range): string {
  return `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
}

function formatDiagnostic(diag: Diagnostic): string {
  const severity = ["", "error", "warning", "info", "hint"][diag.severity ?? 1];
  const pos = formatRange(diag.range);
  return `  [${severity}] ${pos}: ${diag.message}`;
}

function printSymbols(symbols: (DocumentSymbol | SymbolInformation)[], indent = 0): void {
  for (const sym of symbols) {
    const prefix = "  ".repeat(indent);
    const kind = symbolKindName(sym.kind);
    if ("range" in sym && "selectionRange" in sym) {
      // DocumentSymbol (hierarchical)
      const ds = sym as DocumentSymbol;
      console.log(`${prefix}${kind} ${ds.name} [${formatRange(ds.range)}]`);
      if (ds.children) printSymbols(ds.children, indent + 1);
    } else {
      // SymbolInformation (flat)
      const si = sym as SymbolInformation;
      console.log(`${prefix}${kind} ${si.name} ${formatLocation(si.location)}`);
    }
  }
}

function decodeUris(obj: unknown): unknown {
  if (typeof obj === "string") {
    if (obj.startsWith("file:///")) {
      return decodeURIComponent(obj);
    }
    return obj;
  }
  if (Array.isArray(obj)) return obj.map(decodeUris);
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const newKey = key.startsWith("file:///") ? decodeURIComponent(key) : key;
      result[newKey] = decodeUris(value);
    }
    return result;
  }
  return obj;
}

function resolveFile(file: string, project?: string): string {
  // If it's already absolute, use as-is
  if (path.isAbsolute(file)) return file;
  // If --project is set, resolve relative to it
  if (project) return path.resolve(project, file);
  // Otherwise resolve from cwd
  return path.resolve(file);
}

function resolveProjectPath(project: string): string {
  return path.resolve(project);
}

function formatEntry(entry: InstanceEntry, status: string): string {
  return `${entry.project}  port=${entry.port}  pid=${entry.pid}  status=${status}  started=${entry.startedAt}`;
}

async function attemptLspHandshake(host: string, port: number, project: string, attemptTimeoutMs: number): Promise<boolean> {
  const client = new GodotLspClient();
  const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), attemptTimeoutMs));
  const attempt = (async () => {
    try {
      await client.connect(host, port, project);
      return true;
    } catch {
      return false;
    }
  })();
  const ok = await Promise.race([attempt, timeout]);
  client.disconnect();
  return ok;
}

async function waitForLsp(host: string, port: number, project: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await attemptLspHandshake(host, port, project, 5000)) return true;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}

async function cmdServe(args: string[], projectFlag: string | undefined, port: number, portExplicit: boolean): Promise<void> {
  if (!projectFlag) {
    console.error("Usage: godot-lsp-cli serve --project <path> [--port N] [--godot <bin>] [--timeout <sec>]");
    process.exit(1);
  }
  const project = resolveProjectPath(projectFlag);
  const godotBin = extractFlag(args, "--godot") ?? process.env.GODOT_BIN ?? "godot";
  const timeoutSec = parseInt(extractFlag(args, "--timeout") ?? "180", 10);

  const existing = await findLiveEntry(project);
  if (existing) {
    console.log(`Already running: ${formatEntry(existing, "live")}`);
    return;
  }

  const targetPort = portExplicit ? port : await pickFreePort();

  ensureDirs();
  const logPath = logFilePath(project);
  const logFd = fs.openSync(logPath, "a");

  const child = spawn(godotBin, ["--headless", "--editor", "--path", project, "--lsp-port", String(targetPort)], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });

  let spawnError: Error | null = null;
  child.on("error", (err) => {
    spawnError = err;
  });
  child.unref();

  console.log(`Starting Godot LSP for ${project} on port ${targetPort} (pid ${child.pid})...`);
  console.log("A fresh project may run a one-time asset import; this can take several minutes.");

  const ok = await waitForLsp("127.0.0.1", targetPort, project, timeoutSec * 1000);

  if (spawnError) {
    console.error(`Failed to start "${godotBin}": ${(spawnError as Error).message}`);
    console.error("Set the Godot binary with --godot <bin>, the GODOT_BIN env var, or ensure \"godot\" is on PATH.");
    process.exit(1);
  }

  if (!ok) {
    console.error(`Timed out waiting for Godot LSP on port ${targetPort} after ${timeoutSec}s. Check log: ${logPath}`);
    process.exit(1);
  }

  const entry: InstanceEntry = {
    project,
    port: targetPort,
    pid: child.pid!,
    godotBin,
    startedAt: new Date().toISOString(),
  };
  await upsertEntry(entry);
  console.log(`Ready: ${formatEntry(entry, "live")}`);
}

async function cmdStop(args: string[], projectFlag: string | undefined): Promise<void> {
  const all = removeFlag(args, "--all");
  if (!all && !projectFlag) {
    console.error("Usage: godot-lsp-cli stop --project <path> | --all");
    process.exit(1);
  }

  const entries = await readRegistry();
  const targets = all ? entries : entries.filter((e) => e.project === resolveProjectPath(projectFlag!));

  if (targets.length === 0) {
    console.log("No matching running instance(s) found.");
    return;
  }

  for (const entry of targets) {
    try {
      process.kill(entry.pid, "SIGTERM");
      console.log(`Stopped ${entry.project} (port ${entry.port}, pid ${entry.pid})`);
    } catch (err) {
      console.log(`Could not signal pid ${entry.pid} for ${entry.project}: ${(err as Error).message}`);
    }
    await removeEntry(entry.project);
  }
}

async function cmdList(): Promise<void> {
  const entries = await readRegistry();
  if (entries.length === 0) {
    console.log("No registered Godot LSP instances.");
    return;
  }
  for (const entry of entries) {
    console.log(formatEntry(entry, "live"));
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) usage();

  const { command, args, host, port, portExplicit, project, json } = parseArgs(argv);

  if (command === "serve") return cmdServe(args, project, port, portExplicit);
  if (command === "stop") return cmdStop(args, project);
  if (command === "list") return cmdList();

  let resolvedPort = port;
  if (!portExplicit && project) {
    const entry = await findLiveEntry(resolveProjectPath(project));
    if (entry) resolvedPort = entry.port;
  }

  const client = new GodotLspClient();

  try {
    await client.connect(host, resolvedPort, project);
  } catch (err) {
    console.error(`Failed to connect to Godot LSP at ${host}:${resolvedPort}`);
    console.error(`Make sure Godot is running with: godot --editor --headless --lsp-port ${resolvedPort} --path /your/project`);
    console.error(`Or start a managed instance: godot-lsp-cli serve --project <path>`);
    process.exit(1);
  }

  try {
    switch (command) {
      case "capabilities": {
        const caps = client.getServerCapabilities();
        console.log(JSON.stringify(caps, null, 2));
        break;
      }
      case "rename": {
        if (args.length < 4) {
          console.error("Usage: godot-lsp-cli rename <file> <line> <col> <newName>");
          process.exit(1);
        }
        const [file, line, col, newName] = args;
        const result = await client.rename(resolveFile(file, project), parseInt(line), parseInt(col), newName);
        if (json) {
          console.log(JSON.stringify(decodeUris(result), null, 2));
        } else if (result?.changes) {
          for (const [uri, edits] of Object.entries(result.changes)) {
            const filePath = decodeURIComponent(uri.replace(/^file:\/\/\//, ""));
            console.log(`${filePath}:`);
            for (const edit of edits) {
              console.log(`  ${formatRange(edit.range)} → "${edit.newText}"`);
            }
          }
        } else if (result?.documentChanges) {
          console.log(JSON.stringify(decodeUris(result.documentChanges), null, 2));
        } else {
          console.log("No changes returned. Symbol may not support rename.");
        }
        break;
      }

      case "references": {
        if (args.length < 3) {
          console.error("Usage: godot-lsp-cli references <file> <line> <col>");
          process.exit(1);
        }
        const [file, line, col] = args;
        const result = await client.references(resolveFile(file, project), parseInt(line), parseInt(col));
        if (json) {
          console.log(JSON.stringify(decodeUris(result), null, 2));
        } else if (result.length === 0) {
          console.log("No references found.");
        } else {
          console.log(`Found ${result.length} reference(s):`);
          for (const loc of result) {
            console.log(`  ${formatLocation(loc)}`);
          }
        }
        break;
      }

      case "definition": {
        if (args.length < 3) {
          console.error("Usage: godot-lsp-cli definition <file> <line> <col>");
          process.exit(1);
        }
        const [file, line, col] = args;
        const result = await client.definition(resolveFile(file, project), parseInt(line), parseInt(col));
        if (json) {
          console.log(JSON.stringify(decodeUris(result), null, 2));
        } else if (!result) {
          console.log("No definition found.");
        } else {
          const locs = Array.isArray(result) ? result : [result];
          for (const loc of locs) {
            console.log(formatLocation(loc));
          }
        }
        break;
      }

      case "declaration": {
        if (args.length < 3) {
          console.error("Usage: godot-lsp-cli declaration <file> <line> <col>");
          process.exit(1);
        }
        const [file, line, col] = args;
        const result = await client.declaration(resolveFile(file, project), parseInt(line), parseInt(col));
        if (json) {
          console.log(JSON.stringify(decodeUris(result), null, 2));
        } else if (!result) {
          console.log("No declaration found.");
        } else {
          const locs = Array.isArray(result) ? result : [result];
          for (const loc of locs) {
            console.log(formatLocation(loc));
          }
        }
        break;
      }

      case "symbols": {
        if (args.length < 1) {
          console.error("Usage: godot-lsp-cli symbols <file>");
          process.exit(1);
        }
        const [file] = args;
        const result = await client.documentSymbols(resolveFile(file, project));
        if (json) {
          console.log(JSON.stringify(decodeUris(result), null, 2));
        } else if (result.length === 0) {
          console.log("No symbols found.");
        } else {
          printSymbols(result);
        }
        break;
      }

      case "hover": {
        if (args.length < 3) {
          console.error("Usage: godot-lsp-cli hover <file> <line> <col>");
          process.exit(1);
        }
        const [file, line, col] = args;
        const result = await client.hover(resolveFile(file, project), parseInt(line), parseInt(col));
        if (json) {
          console.log(JSON.stringify(decodeUris({ hover: result }), null, 2));
        } else {
          console.log(result ?? "No hover info available.");
        }
        break;
      }

      case "diagnostics": {
        // Wait briefly for diagnostics to arrive from server
        await new Promise(resolve => setTimeout(resolve, 2000));
        const file = args[0] ? resolveFile(args[0], project) : undefined;
        const diags = client.getDiagnostics(file);
        if (json) {
          console.log(JSON.stringify(decodeUris(diags instanceof Map ? Object.fromEntries(diags) : diags), null, 2));
        } else if (diags instanceof Map) {
          if (diags.size === 0) {
            console.log("No diagnostics.");
          }
          for (const [uri, fileDiags] of diags) {
            const filePath = decodeURIComponent(uri.replace(/^file:\/\/\//, ""));
            console.log(`${filePath}:`);
            for (const d of fileDiags) {
              console.log(formatDiagnostic(d));
            }
          }
        } else {
          if ((diags as Diagnostic[]).length === 0) {
            console.log("No diagnostics for this file.");
          }
          for (const d of diags as Diagnostic[]) {
            console.log(formatDiagnostic(d));
          }
        }
        break;
      }

      case "native-symbol": {
        if (args.length < 1) {
          console.error("Usage: godot-lsp-cli native-symbol <class> [member]");
          process.exit(1);
        }
        const [nativeClass, memberName] = args;
        const result = await client.nativeSymbol(nativeClass, memberName);
        if (json) {
          console.log(JSON.stringify(decodeUris(result), null, 2));
        } else if (!result) {
          console.log("No documentation found.");
        } else {
          const sym = result as { name: string; detail?: string; documentation?: string; children?: unknown[] };
          console.log(`${sym.name}${sym.detail ? ` — ${sym.detail}` : ""}`);
          if (sym.documentation) {
            console.log(`\n${sym.documentation}`);
          }
          if (sym.children && !memberName) {
            console.log(`\nMembers: ${sym.children.length}`);
          }
        }
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        usage();
    }
  } finally {
    client.disconnect();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

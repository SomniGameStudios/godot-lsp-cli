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
 *
 * Lines and columns are 0-based (LSP convention).
 * Requires Godot editor or headless LSP running:
 *   godot --editor --headless --lsp-port 6005 --path /your/project
 */

import { GodotLspClient, symbolKindName } from "./client.js";
import type { WorkspaceEdit, Location, DocumentSymbol, SymbolInformation, Diagnostic, Range } from "./client.js";

function usage(): never {
  console.error(`godot-lsp-cli v0.1.0 — CLI for Godot's built-in LSP

Commands:
  rename <file> <line> <col> <newName>   Rename symbol across project
  references <file> <line> <col>         Find all references to symbol
  definition <file> <line> <col>         Go to definition
  symbols <file>                         List symbols in file
  hover <file> <line> <col>              Get hover info for symbol
  diagnostics [file]                     Show diagnostics (errors/warnings)
  workspace-symbols <query>              Search symbols across workspace

Options:
  --host <host>       LSP server host (default: 127.0.0.1)
  --port <port>       LSP server port (default: 6005)
  --project <path>    Godot project root (improves LSP results)
  --json              Output as JSON instead of human-readable text

Lines and columns are 0-based (LSP convention).

Requires Godot LSP running:
  godot --editor --headless --lsp-port 6005 --path /your/project`);
  process.exit(1);
}

function parseArgs(argv: string[]): {
  command: string;
  args: string[];
  host: string;
  port: number;
  project: string | undefined;
  json: boolean;
} {
  const host = extractFlag(argv, "--host") ?? "127.0.0.1";
  const port = parseInt(extractFlag(argv, "--port") ?? "6005", 10);
  const project = extractFlag(argv, "--project") ?? undefined;
  const json = removeFlag(argv, "--json");

  const command = argv[0] ?? "";
  const args = argv.slice(1);
  return { command, host, port, project, json, args };
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
  const p = require("path");
  // If it's already absolute, use as-is
  if (p.isAbsolute(file)) return file;
  // If --project is set, resolve relative to it
  if (project) return p.resolve(project, file);
  // Otherwise resolve from cwd
  return p.resolve(file);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) usage();

  const { command, args, host, port, project, json } = parseArgs(argv);
  const client = new GodotLspClient();

  try {
    await client.connect(host, port, project);
  } catch (err) {
    console.error(`Failed to connect to Godot LSP at ${host}:${port}`);
    console.error(`Make sure Godot is running with: godot --editor --headless --lsp-port ${port} --path /your/project`);
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

      case "workspace-symbols": {
        if (args.length < 1) {
          console.error("Usage: godot-lsp-cli workspace-symbols <query>");
          process.exit(1);
        }
        const query = args.join(" ");
        const result = await client.workspaceSymbols(query);
        if (json) {
          console.log(JSON.stringify(decodeUris(result), null, 2));
        } else if (result.length === 0) {
          console.log("No symbols found.");
        } else {
          printSymbols(result);
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

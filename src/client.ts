/**
 * High-level LSP client for Godot.
 * Wraps the transport with LSP protocol methods.
 */

import * as path from "path";
import { GodotLspTransport } from "./transport.js";

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  uri: string;
  range: Range;
}

export interface TextEdit {
  range: Range;
  newText: string;
}

export interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: unknown[];
}

export interface SymbolInformation {
  name: string;
  kind: number;
  location: Location;
  containerName?: string;
}

export interface DocumentSymbol {
  name: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

export interface Diagnostic {
  range: Range;
  severity?: number;
  code?: number | string;
  message: string;
  source?: string;
}

// LSP symbol kind numbers to names
const SYMBOL_KINDS: Record<number, string> = {
  1: "File", 2: "Module", 3: "Namespace", 4: "Package", 5: "Class",
  6: "Method", 7: "Property", 8: "Field", 9: "Constructor", 10: "Enum",
  11: "Interface", 12: "Function", 13: "Variable", 14: "Constant",
  15: "String", 16: "Number", 17: "Boolean", 18: "Array", 19: "Object",
  20: "Key", 21: "Null", 22: "EnumMember", 23: "Struct", 24: "Event",
  25: "Operator", 26: "TypeParameter",
};

export function symbolKindName(kind: number): string {
  return SYMBOL_KINDS[kind] ?? `Unknown(${kind})`;
}

function fileToUri(filePath: string): string {
  const resolved = path.resolve(filePath).replace(/\\/g, "/");
  return `file:///${resolved.replace(/^\//, "")}`;
}

function uriToFile(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\/\//, ""));
}

export class GodotLspClient {
  private transport = new GodotLspTransport();
  private initialized = false;
  private diagnostics = new Map<string, Diagnostic[]>();
  private openedFiles = new Set<string>();
  private serverCapabilities: Record<string, unknown> = {};

  constructor() {
    this.transport.on("notification", (method: string, params: unknown) => {
      if (method === "textDocument/publishDiagnostics") {
        const p = params as { uri: string; diagnostics: Diagnostic[] };
        this.diagnostics.set(p.uri, p.diagnostics);
      }
    });
  }

  async connect(host: string, port: number, projectPath?: string): Promise<void> {
    await this.transport.connect(host, port);
    await this.initialize(projectPath);
  }

  disconnect(): void {
    if (this.initialized) {
      this.transport.notify("shutdown");
    }
    this.transport.disconnect();
  }

  getServerCapabilities(): Record<string, unknown> {
    return this.serverCapabilities;
  }

  private async initialize(projectPath?: string): Promise<void> {
    const rootUri = projectPath ? fileToUri(projectPath) : null;
    const result = await this.transport.request("initialize", {
      processId: process.pid,
      capabilities: {
        textDocument: {
          synchronization: {
            didSave: true,
            willSave: false,
            willSaveWaitUntil: false,
          },
          rename: { prepareSupport: true },
          references: {},
          definition: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          publishDiagnostics: {},
          hover: { contentFormat: ["plaintext", "markdown"] },
        },
        workspace: {
          workspaceEdit: { documentChanges: true },
          symbol: {},
        },
      },
      rootUri,
      rootPath: projectPath ?? null,
    }) as { capabilities: Record<string, unknown> };

    this.serverCapabilities = result.capabilities;
    this.transport.notify("initialized", {});
    this.initialized = true;
  }

  private async ensureOpen(filePath: string): Promise<string> {
    const uri = fileToUri(filePath);
    if (!this.openedFiles.has(uri)) {
      const fs = await import("fs");
      const content = fs.readFileSync(path.resolve(filePath), "utf-8");
      this.transport.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: "gdscript",
          version: 1,
          text: content,
        },
      });
      this.openedFiles.add(uri);
      // Give the server a moment to process the file
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return uri;
  }

  async rename(file: string, line: number, character: number, newName: string): Promise<WorkspaceEdit | null> {
    const uri = await this.ensureOpen(file);
    const result = await this.transport.request("textDocument/rename", {
      textDocument: { uri },
      position: { line, character },
      newName,
    });
    return (result as WorkspaceEdit) ?? null;
  }

  async prepareRename(file: string, line: number, character: number): Promise<Range | null> {
    try {
      const uri = await this.ensureOpen(file);
      const result = await this.transport.request("textDocument/prepareRename", {
        textDocument: { uri },
        position: { line, character },
      });
      return (result as Range) ?? null;
    } catch {
      return null;
    }
  }

  async references(file: string, line: number, character: number, includeDeclaration = true): Promise<Location[]> {
    const uri = await this.ensureOpen(file);
    const result = await this.transport.request("textDocument/references", {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration },
    });
    return (result as Location[]) ?? [];
  }

  async definition(file: string, line: number, character: number): Promise<Location | Location[] | null> {
    const uri = await this.ensureOpen(file);
    const result = await this.transport.request("textDocument/definition", {
      textDocument: { uri },
      position: { line, character },
    });
    return (result as Location | Location[]) ?? null;
  }

  async documentSymbols(file: string): Promise<DocumentSymbol[] | SymbolInformation[]> {
    const uri = await this.ensureOpen(file);
    const result = await this.transport.request("textDocument/documentSymbol", {
      textDocument: { uri },
    });
    return (result as DocumentSymbol[] | SymbolInformation[]) ?? [];
  }

  async hover(file: string, line: number, character: number): Promise<string | null> {
    const uri = await this.ensureOpen(file);
    const result = await this.transport.request("textDocument/hover", {
      textDocument: { uri },
      position: { line, character },
    }) as { contents: { value: string } | string } | null;

    if (!result) return null;
    if (typeof result.contents === "string") return result.contents;
    return result.contents.value ?? null;
  }

  async declaration(file: string, line: number, character: number): Promise<Location | Location[] | null> {
    const uri = await this.ensureOpen(file);
    const result = await this.transport.request("textDocument/declaration", {
      textDocument: { uri },
      position: { line, character },
    });
    return (result as Location | Location[]) ?? null;
  }

  async nativeSymbol(nativeClass: string, symbolName?: string): Promise<unknown> {
    const result = await this.transport.request("textDocument/nativeSymbol", {
      native_class: nativeClass,
      symbol_name: symbolName ?? nativeClass,
    });
    return result;
  }

  getDiagnostics(file?: string): Map<string, Diagnostic[]> | Diagnostic[] {
    if (file) {
      return this.diagnostics.get(fileToUri(file)) ?? [];
    }
    return this.diagnostics;
  }
}

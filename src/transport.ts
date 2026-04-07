/**
 * TCP transport for Godot's LSP server.
 * Adapted from godotengine/godot-vscode-plugin (MIT License).
 * Handles Content-Length framed JSON-RPC messages over TCP.
 */

import { Socket } from "net";
import { EventEmitter } from "events";

const CR = 0x0d; // \r
const LF = 0x0a; // \n
const CRLF = "\r\n";

export class MessageBuffer {
  private buffer: Buffer = Buffer.alloc(0);

  append(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
  }

  tryReadMessage(): string | null {
    // Find header/body separator: \r\n\r\n
    let separatorIndex = -1;
    for (let i = 0; i + 3 < this.buffer.length; i++) {
      if (
        this.buffer[i] === CR &&
        this.buffer[i + 1] === LF &&
        this.buffer[i + 2] === CR &&
        this.buffer[i + 3] === LF
      ) {
        separatorIndex = i;
        break;
      }
    }

    if (separatorIndex === -1) return null;

    // Parse headers
    const headerStr = this.buffer.toString("ascii", 0, separatorIndex);
    const headers: Record<string, string> = {};
    for (const line of headerStr.split(CRLF)) {
      const colonIndex = line.indexOf(":");
      if (colonIndex === -1) continue;
      headers[line.substring(0, colonIndex)] = line.substring(colonIndex + 1).trim();
    }

    const contentLength = parseInt(headers["Content-Length"], 10);
    if (isNaN(contentLength)) return null;

    const bodyStart = separatorIndex + 4;
    const totalLength = bodyStart + contentLength;

    if (this.buffer.length < totalLength) return null;

    const body = this.buffer.toString("utf-8", bodyStart, totalLength);
    this.buffer = this.buffer.subarray(totalLength);
    return body;
  }
}

export interface LspResponse {
  id: number;
  jsonrpc: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class GodotLspTransport extends EventEmitter {
  private socket: Socket | null = null;
  private messageBuffer = new MessageBuffer();
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
  }>();

  async connect(host: string, port: number, timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Connection to ${host}:${port} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      socket.connect(port, host);

      socket.on("connect", () => {
        clearTimeout(timer);
        this.socket = socket;
        resolve();
      });

      socket.on("data", (chunk: Buffer) => {
        this.messageBuffer.append(chunk);
        let msg: string | null;
        while ((msg = this.messageBuffer.tryReadMessage()) !== null) {
          this.handleMessage(msg);
        }
      });

      socket.on("error", (err) => {
        clearTimeout(timer);
        if (!this.socket) {
          reject(err);
        } else {
          this.emit("error", err);
        }
      });

      socket.on("close", () => {
        this.socket = null;
        this.emit("close");
        // Reject all pending requests
        for (const [id, { reject }] of this.pending) {
          reject(new Error("Connection closed"));
        }
        this.pending.clear();
      });
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (!this.socket) throw new Error("Not connected");

    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    this.send(message);

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.socket) throw new Error("Not connected");
    const message = { jsonrpc: "2.0", method, params };
    this.send(message);
  }

  private send(message: object): void {
    const json = JSON.stringify(message);
    const contentLength = Buffer.byteLength(json, "utf-8");
    const header = `Content-Length: ${contentLength}\r\n\r\n`;
    this.socket!.write(header + json);
  }

  private handleMessage(raw: string): void {
    const msg = JSON.parse(raw);

    // Response to a request we sent
    if ("id" in msg && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) {
        reject(new Error(`LSP error ${msg.error.code}: ${msg.error.message}`));
      } else {
        resolve(msg.result);
      }
      return;
    }

    // Server notification (diagnostics, etc.)
    if ("method" in msg && !("id" in msg)) {
      this.emit("notification", msg.method, msg.params);
      return;
    }
  }
}

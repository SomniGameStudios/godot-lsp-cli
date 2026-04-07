# godot-lsp-cli

CLI that talks to Godot's built-in LSP. Rename symbols, find references, go to definition — from the terminal.

Zero runtime dependencies. Works with Godot 4.2+.

## Install

```bash
npm install -g godot-lsp-cli
```

Or run without installing:

```bash
npx godot-lsp-cli <command>
```

## Prerequisites

Godot's LSP server must be running. Start it headless in a separate terminal:

```bash
godot --editor --headless --lsp-port 6005 --path /path/to/your/project
```

## Usage

```bash
godot-lsp-cli <command> [options]
```

All file commands accept relative paths when `--project` is set.
Lines and columns are **0-based** (LSP convention).

### Rename a symbol across the project

```bash
godot-lsp-cli rename game/player/player.gd 10 4 new_name --project .
```

Returns all edits needed (does not write files).

### Find all references

```bash
godot-lsp-cli references game/player/player.gd 10 4 --project .
```

### Go to definition

```bash
godot-lsp-cli definition game/player/player.gd 10 4 --project .
```

### Go to declaration

```bash
godot-lsp-cli declaration game/player/player.gd 10 4 --project .
```

### List symbols in a file

```bash
godot-lsp-cli symbols game/player/player.gd --project .
```

### Hover info (type + docs)

```bash
godot-lsp-cli hover game/player/player.gd 10 4 --project .
```

### Godot built-in class docs

```bash
godot-lsp-cli native-symbol Timer
godot-lsp-cli native-symbol Node2D
```

### Diagnostics (errors/warnings)

```bash
godot-lsp-cli diagnostics game/player/player.gd --project .
godot-lsp-cli diagnostics --project .  # all files
```

### Show LSP capabilities

```bash
godot-lsp-cli capabilities --project .
```

## Options

| Flag | Default | Description |
|---|---|---|
| `--project <path>` | — | Godot project root (enables relative paths) |
| `--port <port>` | 6005 | LSP server port |
| `--host <host>` | 127.0.0.1 | LSP server host |
| `--json` | — | Output as JSON |

## Godot LSP capabilities (4.6.1)

| Feature | Supported |
|---|---|
| Rename symbol | Yes |
| Find references | Yes |
| Go to definition | Yes |
| Go to declaration | Yes |
| Document symbols | Yes |
| Hover | Yes |
| Diagnostics | Yes |
| Native class docs | Yes |
| Workspace symbols | No |

## How it works

Connects to Godot's LSP over TCP using the standard LSP JSON-RPC protocol. The transport layer is adapted from the [official Godot VSCode plugin](https://github.com/godotengine/godot-vscode-plugin).

## AI agent integration

This tool is designed to work with AI coding agents (Claude Code, Cursor, etc.) that can call CLI tools. The `--json` flag outputs structured data for programmatic consumption.

Example workflow for an AI agent:
1. `symbols <file>` — understand file structure
2. `references <file> <line> <col>` — check blast radius before changes
3. `rename <file> <line> <col> <newName> --json` — get edit set
4. Apply edits to files

## License

MIT

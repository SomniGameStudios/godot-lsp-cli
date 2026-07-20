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

Godot's LSP server must be running. If you already have the Godot editor open with your project, **the LSP is already running on port 6005** — no extra setup needed.

If you want to run without the editor (CI, background sessions), start it yourself:

```bash
godot --editor --headless --lsp-port 6005 --path /path/to/your/project
```

or let godot-lsp-cli manage it for you — see [Managing instances](#managing-instances) below, especially useful when you work across multiple projects or worktrees at once.

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
| `--project <path>` | — | Godot project root (enables relative paths, enables instance routing) |
| `--port <port>` | 6005 | LSP server port |
| `--host <host>` | 127.0.0.1 | LSP server host |
| `--json` | — | Output as JSON |

## Managing instances

One Godot LSP server serves one project. If you work on several projects or worktrees at once, godot-lsp-cli can start, track, and stop a headless Godot LSP instance per project, so you only ever pass `--project` and it's routed to the right one.

### Start a managed instance

```bash
godot-lsp-cli serve --project /path/to/your/project
```

Picks a free port, spawns `godot --headless --editor --path <project> --lsp-port <port>` detached from the terminal (it keeps running after the CLI exits), and waits for the LSP to come up before returning. If a live instance for that project already exists, this is a no-op that just prints it.

A freshly opened project can trigger a one-time Godot asset import that takes several minutes; the default wait is 180s (`--timeout <sec>` to change it). Instance logs are written under `~/.godot-lsp-cli/logs/`.

**Godot binary resolution**, in order: `--godot <bin>`, then the `GODOT_BIN` environment variable, then `godot` on your `PATH`.

```bash
godot-lsp-cli serve --project . --godot /Applications/Godot.app/Contents/MacOS/Godot
# or
export GODOT_BIN=/Applications/Godot.app/Contents/MacOS/Godot
godot-lsp-cli serve --project .
```

### List managed instances

```bash
godot-lsp-cli list
```

Stale entries (process gone, or port no longer accepting connections) are pruned automatically whenever the registry is read, so `list` only ever shows live instances.

### Stop a managed instance

```bash
godot-lsp-cli stop --project /path/to/your/project
godot-lsp-cli stop --all
```

### How other commands pick a port

Every non-management command (`rename`, `references`, `symbols`, etc.) resolves its LSP port in this order:

1. `--port`, if given, always wins.
2. Otherwise, if `--project` matches a live `serve`-managed instance, that instance's port is used.
3. Otherwise, the default port `6005` is used — the original behavior, unchanged if you never run `serve`.

The registry lives at `~/.godot-lsp-cli/instances.json`.

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

## Why this exists

We investigated the existing Godot MCP ecosystem before building this:

- [Coding-Solo/godot-mcp](https://github.com/Coding-Solo/godot-mcp) — scene builder, 15 tools, no code intelligence
- [Derfirm/godot-mcp](https://github.com/Derfirm/godot-mcp) — 54-75 tools, no LSP, stale
- [tomyud1/godot-mcp](https://github.com/tomyud1/godot-mcp) — 42 tools, file-level rename only
- [youichi-uda/godot-mcp-pro](https://github.com/youichi-uda/godot-mcp-pro) — 35-169 tools, text-search "references"

**None of them use Godot's built-in LSP.** They're all scene manipulation / game control tools with text-pattern-based search. No semantic rename, no real find-references, no go-to-definition.

We then studied the [official Godot VSCode plugin](https://github.com/godotengine/godot-vscode-plugin) and found that the entire LSP connection is ~200 lines of TCP + JSON-RPC framing. The plugin itself doesn't even use rename or references — but the Godot LSP supports them.

So we built this: a lightweight CLI that talks directly to Godot's LSP for the operations that matter for code refactoring. Zero runtime dependencies, zero MCP overhead.

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

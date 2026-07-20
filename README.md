# godot-lsp-cli

Semantic GDScript code intelligence from the terminal. Real rename, find references, go to definition, hover docs, and diagnostics, answered by the same language server that powers the Godot editor.

```bash
$ godot-lsp-cli references game/player/player.gd 24 9 --project .
Found 4 reference(s):
  game/player/player.gd:24:9
  game/player/player.gd:87:16
  game/enemies/chaser.gd:51:14
  game/ui/health_bar.gd:12:23
```

Grep finds text; the LSP finds the *symbol*. It knows scope, inheritance, and types, so `rename` returns exactly the edits that are safe to apply and `references` skips the identically-named local in an unrelated file. Godot already computes all of this: this CLI just asks for it.

- **Zero setup** if the Godot editor is open: it already runs the LSP on port 6005.
- **Zero runtime dependencies.** One small CLI, plain TCP + JSON-RPC. No plugin, no MCP server.
- **Built for automation.** Every command takes `--json`, so AI coding agents and scripts get structured answers instead of scraping editor UIs or pattern-matching text.

Works with Godot 4.2+.

## Quick start

```bash
npm install -g godot-lsp-cli    # or: npx godot-lsp-cli <command>
```

Open your project in the Godot editor, then:

```bash
godot-lsp-cli symbols game/player/player.gd --project /path/to/project
```

That's it. No editor open, or working on several projects at once? See [Managing instances](#managing-instances).

## Use with AI coding agents

This tool exists largely so that coding agents (Claude Code, Cursor, and similar) can refactor GDScript semantically instead of doing grep-and-edit. A typical agent loop:

1. `symbols <file>` — map the file without reading all of it
2. `references <file> <line> <col>` — check the blast radius before changing anything
3. `rename <file> <line> <col> <newName> --json` — get the exact edit set
4. Apply the edits with the agent's own file tools

`rename` never writes files itself; it returns edits, which keeps the agent in control of every change.

## Commands

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

### Go to definition / declaration

```bash
godot-lsp-cli definition game/player/player.gd 10 4 --project .
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

One Godot LSP server serves one project. If you work on several projects or worktrees at once, or want the LSP without keeping an editor open (CI, background sessions), godot-lsp-cli can start, track, and stop a headless Godot LSP instance per project. You only ever pass `--project`; routing to the right instance is automatic.

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

You can also start the server yourself and skip management entirely:

```bash
godot --editor --headless --lsp-port 6005 --path /path/to/your/project
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

## Godot LSP capabilities (tested on 4.6)

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

## License

MIT

# mcp-vfx-parsers

MCP server for VFX file format parsing. Parse and generate Nuke `.nk`, MaterialX `.mtlx`, and USD ASCII `.usda` files — all via the MCP stdio protocol. Round-trip stable.

## Tools

| Tool | Description |
|------|-------------|
| `parse_nuke` | Parse `.nk` script → JSON AST (nodes, properties, DAG wiring) |
| `parse_mtlx` | Parse `.mtlx` XML → JSON AST (node graphs, inputs, materials) |
| `parse_usda` | Parse `.usda` text → JSON AST (prims, attributes, variants, connections) |
| `generate_nuke` | JSON AST → `.nk` script (round-trip stable) |
| `generate_mtlx` | JSON AST → `.mtlx` XML (round-trip stable) |
| `generate_usda` | JSON AST → `.usda` text (semantic round-trip) |

All tools are **read-only** — they transform text, never touch the filesystem.

## Install

```bash
npx -y mcp-vfx-parsers
```

## Usage with Claude Code

Add to your Claude Code MCP settings (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "vfx-parsers": {
      "command": "npx",
      "args": ["-y", "mcp-vfx-parsers"]
    }
  }
}
```

## Usage with Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "vfx-parsers": {
      "command": "npx",
      "args": ["-y", "mcp-vfx-parsers"]
    }
  }
}
```

## Supported Formats

### Nuke `.nk`

Foundry Nuke compositing scripts. Parses the TCL-based stack-wired node graph format:
- Node types, properties, positions
- Input wiring via `set`/`push` stack directives
- Root settings (merges duplicate Root blocks)
- TCL expressions and UserKnob blocks (preserved as opaque text)
- Escape sequences in quoted values (`\"`, `\\`, `\n`, `\t`, `\r`, `\0`)

### MaterialX `.mtlx`

MaterialX shading network definitions. Parses the XML-based format:
- Node graphs with typed inputs/outputs
- Material assignments
- `nodename` connection references (DAG edge extraction)
- Attribute preservation (quote style, order)
- Comments and XML prolog
- XML entity encoding/decoding (`&amp;`, `&#123;`, `&#x1F;`)

### USD ASCII `.usda`

Pixar Universal Scene Description (ASCII layer format). Full grammar support:
- Prim hierarchy (`def`, `over`, `class`)
- Typed attributes with `uniform`/`custom` modifiers
- `.connect` connections (UsdShade node graphs)
- `.timeSamples` animation data
- Relationships (single + array targets)
- VariantSets with nested variant bodies
- Composition arcs: references, payloads, inherits, specializes
- Layer and prim metadata
- Triple-quoted strings and asset paths (`@...@`, `@@@...@@@`)

## Round-Trip Guarantee

All parsers maintain a strict round-trip invariant:

```
parse(generate(parse(input))) === parse(input)
```

Nuke and MaterialX produce byte-identical output. USDA produces semantically identical output in canonical pretty-print form (comments stripped — documented limitation).

## Safety & Robustness

- **Input size limit**: All tools reject inputs larger than 10 MB
- **Malformed JSON**: Generate tools return clear error messages instead of crashing
- **No filesystem access**: Pure text transforms, safe for sandboxing
- **No eval/exec**: No dynamic code execution
- **No external dependencies**: Only `@modelcontextprotocol/sdk`
- **XXE-safe**: MaterialX parser does not evaluate DOCTYPE/entity declarations
- **Unicode**: Full UTF-8 support across all three parsers

## Development

```bash
git clone https://github.com/MABAAM/mcp-vfx-parsers.git
cd mcp-vfx-parsers
npm install
npm test
node src/server.mjs
```

## Changelog

### v0.2.0

- **Server hardening**: `JSON.parse()` wrapped in safe handler — malformed input returns error instead of crashing the MCP server
- **Input size limits**: All 6 tools reject inputs > 10 MB to prevent memory exhaustion
- **Nuke duplicate Root**: Multiple Root blocks are merged (later values win) instead of silently discarding the first
- **Nuke escape sequences**: `unquote()` now handles `\n`, `\t`, `\r`, `\0` in addition to `\"` and `\\`
- **USDA data preservation**: Non-path values in `.connect` arrays and relationship targets are preserved as `<INVALID:kind:value>` instead of silently dropped

### v0.1.0

- Initial release: 3 parsers (Nuke, MaterialX, USDA), 6 MCP tools, 13 tests

## License

MIT

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

Foundry Nuke compositing scripts. Parses the stack-based node graph format including:
- Node types, properties, positions
- Input wiring via set/push stack directives
- Root settings
- TCL expressions and UserKnob blocks (preserved as opaque text)

### MaterialX `.mtlx`

MaterialX shading network definitions. Parses the XML-based format including:
- Node graphs with typed inputs/outputs
- Material assignments
- `nodename` connection references (DAG edge extraction)
- Attribute preservation (quote style, order)
- Comments and XML prolog

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

## Round-Trip Guarantee

All parsers maintain a strict round-trip invariant:

```
parse(generate(parse(input))) === parse(input)
```

Nuke and MaterialX produce byte-identical output. USDA produces semantically identical output in canonical pretty-print form (comments stripped — documented limitation).

## Development

```bash
git clone https://github.com/MABAAM/mcp-vfx-parsers.git
cd mcp-vfx-parsers
npm install
npm test
node src/server.mjs
```

## License

MIT

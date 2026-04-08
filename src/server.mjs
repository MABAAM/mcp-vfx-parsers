#!/usr/bin/env node
/**
 * MCP server for VFX file format parsing: Nuke .nk, MaterialX .mtlx, USD .usda
 * 6 tools: parse + generate for each format. All read-only, pure transforms.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { parseNk, generateNk, extractLinks as extractNkLinks } from "./parsers/nuke.js";
import { parseMtlx, generateMtlx, extractLinks as extractMtlxLinks } from "./parsers/mtlx.js";
import { parseUsda, generateUsda, extractPrimTree, extractConnections, extractReferences } from "./parsers/usda.js";

const server = new McpServer({ name: "mcp-vfx-parsers", version: "0.1.0" });

const ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

// ── Nuke .nk ────────────────────────────────────────────────────────────────

server.tool(
  "parse_nuke",
  "Parse a Nuke .nk script into a structured AST with nodes, properties, wiring, and DAG edges.",
  { text: z.string().describe("The .nk script text to parse") },
  async ({ text }) => {
    const scene = parseNk(text);
    const links = extractNkLinks(scene);
    return { content: [{ type: "text", text: JSON.stringify({ scene, links }, null, 2) }] };
  },
  { annotations: ANNOTATIONS }
);

server.tool(
  "generate_nuke",
  "Generate a Nuke .nk script from a JSON AST. Round-trip stable: parse(generate(parse(x))) === parse(x).",
  { ast: z.string().describe("JSON string of the NkScene AST") },
  async ({ ast }) => {
    const scene = JSON.parse(ast);
    const text = generateNk(scene);
    return { content: [{ type: "text", text }] };
  },
  { annotations: ANNOTATIONS }
);

// ── MaterialX .mtlx ────────────────────────────────────────────────────────

server.tool(
  "parse_mtlx",
  "Parse a MaterialX .mtlx file into a structured AST with node graphs, inputs, materials, and DAG edges.",
  { text: z.string().describe("The .mtlx XML text to parse") },
  async ({ text }) => {
    const doc = parseMtlx(text);
    const links = extractMtlxLinks(doc);
    return { content: [{ type: "text", text: JSON.stringify({ doc, links }, null, 2) }] };
  },
  { annotations: ANNOTATIONS }
);

server.tool(
  "generate_mtlx",
  "Generate MaterialX .mtlx XML from a JSON AST. Round-trip stable.",
  { ast: z.string().describe("JSON string of the MtlxDoc AST") },
  async ({ ast }) => {
    const doc = JSON.parse(ast);
    const text = generateMtlx(doc);
    return { content: [{ type: "text", text }] };
  },
  { annotations: ANNOTATIONS }
);

// ── USD ASCII .usda ─────────────────────────────────────────────────────────

server.tool(
  "parse_usda",
  "Parse a USD ASCII .usda file into a structured AST with prims, attributes, variants, connections, and composition arcs.",
  { text: z.string().describe("The .usda text to parse") },
  async ({ text }) => {
    const layer = parseUsda(text);
    const primTree = extractPrimTree(layer);
    const connections = extractConnections(layer);
    const references = extractReferences(layer);
    return { content: [{ type: "text", text: JSON.stringify({ layer, primTree, connections, references }, null, 2) }] };
  },
  { annotations: ANNOTATIONS }
);

server.tool(
  "generate_usda",
  "Generate USD ASCII .usda text from a JSON AST. Semantic round-trip: canonical pretty-print form.",
  { ast: z.string().describe("JSON string of the UsdaLayer AST") },
  async ({ ast }) => {
    const layer = JSON.parse(ast);
    const text = generateUsda(layer);
    return { content: [{ type: "text", text }] };
  },
  { annotations: ANNOTATIONS }
);

// ── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

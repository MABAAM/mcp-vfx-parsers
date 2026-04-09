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

const MAX_INPUT_BYTES = 10 * 1024 * 1024; // 10 MB

/** Safely parse JSON with a clear error message instead of crashing. */
function safeJsonParse(str, label) {
  try { return JSON.parse(str); }
  catch (e) { throw new Error(`Invalid JSON for ${label}: ${e.message}`); }
}

/** Guard against oversized inputs. */
function checkSize(text, label) {
  if (text.length > MAX_INPUT_BYTES) {
    throw new Error(`${label} input too large (${(text.length / 1024 / 1024).toFixed(1)} MB, max ${MAX_INPUT_BYTES / 1024 / 1024} MB)`);
  }
}

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
    checkSize(text, "parse_nuke");
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
    checkSize(ast, "generate_nuke");
    const scene = safeJsonParse(ast, "NkScene");
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
    checkSize(text, "parse_mtlx");
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
    checkSize(ast, "generate_mtlx");
    const doc = safeJsonParse(ast, "MtlxDoc");
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
    checkSize(text, "parse_usda");
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
    checkSize(ast, "generate_usda");
    const layer = safeJsonParse(ast, "UsdaLayer");
    const text = generateUsda(layer);
    return { content: [{ type: "text", text }] };
  },
  { annotations: ANNOTATIONS }
);

// ── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

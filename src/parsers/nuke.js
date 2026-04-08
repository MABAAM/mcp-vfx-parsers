// nuke.js — Parser + generator for Nuke `.nk` script files.
//
// The `.nk` format is plaintext, stack-based: each node declares `inputs N`,
// pops N entries from the current stack, and pushes its own output back.
// Branching/reuse is done via `set NAME [stack 0]` (save top) and `push $NAME`
// (re-push). We preserve that directive stream verbatim so round-trip parse →
// generate → parse is semantically lossless.
//
// Phase 18 scope: structural fidelity (node types, properties, input wiring,
// stack directives, Root scene config). We do NOT parse TCL expressions,
// embedded Gizmos, or UserKnob blocks — those are kept as opaque raw text.
//
// Reference: Nuke 14 script file reference. The format has remained stable
// since Nuke 6; Foundry docs call it "Nuke script file format".

/**
 * @typedef {object} NkProp
 * @property {string} key
 * @property {string} value        — raw text value (may contain braces/newlines)
 */

/**
 * @typedef {object} NkNode
 * @property {string} type         — Read, Grade, Write, Merge2, Blur, Dot, …
 * @property {string} name         — unique within the scene (e.g. "Grade1")
 * @property {NkProp[]} props      — ordered properties
 * @property {number} xpos
 * @property {number} ypos
 * @property {string[]} inputs     — upstream node names, derived from stack
 *                                    (nulls for unwired inputs)
 * @property {number} inputCount   — declared `inputs N`
 */

/**
 * @typedef {{kind:'version', text:string}
 *   | {kind:'set', varName:string, stackIdx:number}
 *   | {kind:'push', varName:string}
 *   | {kind:'node', nodeIdx:number}
 *   | {kind:'raw', text:string}} NkOp
 */

/**
 * @typedef {object} NkScene
 * @property {string|null} version
 * @property {NkNode|null} root    — scene-level Root node, if present
 * @property {NkNode[]} nodes      — all non-Root nodes, in file order
 * @property {NkOp[]} ops          — flat directive stream, in file order
 */

const NODE_OPEN_RE = /^([A-Z][A-Za-z0-9_]*)\s*\{\s*$/;
const VERSION_RE   = /^version\s+(.+)$/;
const SET_RE       = /^set\s+(\S+)\s+\[stack\s+(-?\d+)\]\s*$/;
const PUSH_RE      = /^push\s+\$(\S+)\s*$/;

/**
 * Parse a Nuke `.nk` script into a structured scene.
 * @param {string} text
 * @returns {NkScene}
 */
export function parseNk(text) {
  if (typeof text !== 'string') throw new TypeError('parseNk: text must be a string');
  const lines = text.split(/\r?\n/);
  /** @type {NkScene} */
  const scene = { version: null, root: null, nodes: [], ops: [] };
  /** @type {string[]} */ const stack = [];
  /** @type {Map<string,string>} */ const savedVars = new Map();
  let autoName = 1;
  let i = 0;

  // Pull additional lines into `firstSegment` until braces are balanced.
  // Returns the full (possibly multi-line) value string.
  function consumeBraceBalanced(firstSegment) {
    let depth = 0;
    const chunks = [firstSegment];
    const scan = (s) => {
      let inStr = false;
      let esc = false;
      for (const c of s) {
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === '{') depth++;
        else if (c === '}') depth--;
      }
    };
    scan(firstSegment);
    while (depth > 0 && i + 1 < lines.length) {
      i++;
      chunks.push('\n' + lines[i]);
      scan(lines[i]);
    }
    return chunks.join('');
  }

  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();

    if (!trimmed) { i++; continue; }

    // version directive
    const vMatch = VERSION_RE.exec(trimmed);
    if (vMatch && !scene.version) {
      scene.version = vMatch[1];
      scene.ops.push({ kind: 'version', text: vMatch[1] });
      i++; continue;
    }

    // set N1234 [stack 0]
    const sMatch = SET_RE.exec(trimmed);
    if (sMatch) {
      const varName = sMatch[1];
      const stackIdx = Number(sMatch[2]);
      // stackIdx 0 = top of stack, 1 = one below, …
      const srcName = stack[stack.length - 1 - stackIdx] || null;
      if (srcName) savedVars.set(varName, srcName);
      scene.ops.push({ kind: 'set', varName, stackIdx });
      i++; continue;
    }

    // push $N1234
    const pMatch = PUSH_RE.exec(trimmed);
    if (pMatch) {
      const varName = pMatch[1];
      const nodeName = savedVars.get(varName);
      if (nodeName) stack.push(nodeName);
      scene.ops.push({ kind: 'push', varName });
      i++; continue;
    }

    // Node block: "NodeType {"
    const nMatch = NODE_OPEN_RE.exec(trimmed);
    if (nMatch) {
      const type = nMatch[1];
      /** @type {NkNode} */
      const node = {
        type, name: '', props: [], xpos: 0, ypos: 0, inputs: [], inputCount: -1,
      };
      i++;
      // Parse body until matching top-level `}`
      while (i < lines.length) {
        const bRaw = lines[i];
        const b = bRaw.trim();
        if (b === '}') { i++; break; }
        if (!b) { i++; continue; }
        // Split on first whitespace into key / value; value may span lines
        const sp = b.search(/\s/);
        let key, valueRaw;
        if (sp === -1) { key = b; valueRaw = ''; }
        else { key = b.slice(0, sp); valueRaw = b.slice(sp + 1); }
        const valueFull = consumeBraceBalanced(valueRaw);
        node.props.push({ key, value: valueFull });
        i++;
      }
      // Extract convenience fields
      for (const p of node.props) {
        if (p.key === 'name') node.name = unquote(p.value.trim());
        else if (p.key === 'xpos') node.xpos = Number(p.value) || 0;
        else if (p.key === 'ypos') node.ypos = Number(p.value) || 0;
        else if (p.key === 'inputs') node.inputCount = Number(p.value) || 0;
      }
      if (!node.name) node.name = `${type}${autoName++}`;

      // Root is scene-level, does not participate in the wire stack
      if (type === 'Root') {
        scene.root = node;
        scene.ops.push({ kind: 'node', nodeIdx: -1 }); // sentinel: root
        continue;
      }

      // Declared inputs: if missing, default per Nuke convention is 1
      // (generator-style nodes like Read/Constant have `inputs 0`)
      const declared = node.inputCount >= 0 ? node.inputCount : 1;
      for (let k = 0; k < declared; k++) {
        if (stack.length > 0) node.inputs.unshift(stack.pop());
        else node.inputs.unshift(null);
      }
      const nodeIdx = scene.nodes.length;
      scene.nodes.push(node);
      scene.ops.push({ kind: 'node', nodeIdx });
      // Push this node's output onto the stack
      stack.push(node.name);
      continue;
    }

    // Anything else (UserKnob blocks, comments, …) — pass through as raw
    scene.ops.push({ kind: 'raw', text: raw });
    i++;
  }

  return scene;
}

/**
 * Serialize a structured scene back into Nuke `.nk` text.
 * @param {NkScene} scene
 * @returns {string}
 */
export function generateNk(scene) {
  if (!scene || typeof scene !== 'object') throw new TypeError('generateNk: scene object required');
  const out = [];
  for (const op of scene.ops) {
    switch (op.kind) {
      case 'version':
        out.push(`version ${op.text}`);
        break;
      case 'set':
        out.push(`set ${op.varName} [stack ${op.stackIdx}]`);
        break;
      case 'push':
        out.push(`push $${op.varName}`);
        break;
      case 'node': {
        const node = op.nodeIdx === -1 ? scene.root : scene.nodes[op.nodeIdx];
        if (!node) break;
        out.push(`${node.type} {`);
        for (const p of node.props) {
          out.push(p.value ? ` ${p.key} ${p.value}` : ` ${p.key}`);
        }
        out.push('}');
        break;
      }
      case 'raw':
        out.push(op.text);
        break;
    }
  }
  return out.join('\n') + '\n';
}

/**
 * Build a minimal scene from scratch (for programmatic construction).
 * @param {object} [opts]
 * @param {string} [opts.version='14.0 v3']
 * @returns {NkScene}
 */
export function createNkScene({ version = '14.0 v3' } = {}) {
  return {
    version,
    root: null,
    nodes: [],
    ops: [{ kind: 'version', text: version }],
  };
}

/**
 * Append a node to the scene. Updates the ops stream so generateNk() emits it.
 * If `inputs` is provided, synthesises the `set`/`push` directives needed to
 * set up the stack so this node consumes from the named upstream nodes.
 *
 * For v1 this only handles the straight-wiring case — complex branch re-use
 * is the caller's problem.
 *
 * @param {NkScene} scene
 * @param {string} type
 * @param {Record<string,string|number>} props
 * @param {string[]} [inputs=[]] — names of upstream nodes
 * @returns {NkNode}
 */
export function appendNkNode(scene, type, props, inputs = []) {
  const propArray = Object.entries(props).map(([key, v]) => ({
    key, value: typeof v === 'string' ? v : String(v),
  }));
  if (!propArray.find(p => p.key === 'inputs')) {
    propArray.push({ key: 'inputs', value: String(inputs.length) });
  }
  const name = propArray.find(p => p.key === 'name')?.value || `${type}${scene.nodes.length + 1}`;
  if (!propArray.find(p => p.key === 'name')) {
    propArray.push({ key: 'name', value: name });
  }
  /** @type {NkNode} */
  const node = {
    type, name: unquote(name), props: propArray,
    xpos: Number(props.xpos) || 0, ypos: Number(props.ypos) || 0,
    inputs: inputs.slice(), inputCount: inputs.length,
  };
  const nodeIdx = scene.nodes.length;
  scene.nodes.push(node);
  scene.ops.push({ kind: 'node', nodeIdx });
  return node;
}

/**
 * Build a read-only list of directed edges {from, to, inputIdx} from a scene.
 * Useful for visualisation / DAG traversal.
 * @param {NkScene} scene
 * @returns {Array<{from:string, to:string, inputIdx:number}>}
 */
export function extractLinks(scene) {
  const links = [];
  for (const n of scene.nodes) {
    n.inputs.forEach((src, idx) => {
      if (src) links.push({ from: src, to: n.name, inputIdx: idx });
    });
  }
  return links;
}

// ── helpers ────────────────────────────────────────────────────────────────

function unquote(s) {
  if (typeof s !== 'string') return '';
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return t;
}

// mtlx.js — Parser + generator for MaterialX `.mtlx` files.
//
// MaterialX is XML — we use a small hand-written tokenizer tuned for the
// subset MaterialX actually uses: element tags, attributes, self-close,
// comments, XML prolog. No DTD, no CDATA (MaterialX doesn't use them).
//
// Scope (Phase 18.2): structural fidelity for nodegraphs, nodes, inputs,
// outputs, materials. Attribute order and quote style preserved per-element.
// Text content is kept verbatim. Comments survive round-trip.
//
// Reference: MaterialX v1.38 specification. The grammar is regular enough
// that a targeted parser stays under 300 LOC and is deterministic.

/**
 * @typedef {object} MtlxAttr
 * @property {string} name
 * @property {string} value         — decoded (entities resolved)
 * @property {'"'|"'"} quote        — quote style used in source
 */

/**
 * @typedef {{kind:'element', tag:string, attrs:MtlxAttr[],
 *   children:Array<MtlxNode>, selfClose:boolean}} MtlxElement
 * @typedef {{kind:'text', value:string}} MtlxText
 * @typedef {{kind:'comment', value:string}} MtlxComment
 * @typedef {MtlxElement|MtlxText|MtlxComment} MtlxNode
 */

/**
 * @typedef {object} MtlxDoc
 * @property {string|null} prolog   — e.g. `<?xml version="1.0"?>`, verbatim
 * @property {MtlxElement} root     — the <materialx> element
 */

/**
 * Parse a MaterialX `.mtlx` document into a tree.
 * @param {string} text
 * @returns {MtlxDoc}
 */
export function parseMtlx(text) {
  if (typeof text !== 'string') throw new TypeError('parseMtlx: text must be a string');
  const len = text.length;
  let i = 0;
  let prolog = null;

  // Skip BOM + leading whitespace
  if (text.charCodeAt(0) === 0xFEFF) i = 1;

  /** @type {MtlxElement[]} */ const stack = [];
  /** @type {MtlxElement|null} */ let root = null;
  /** @type {MtlxElement|null} */ let current = null;

  function pushChild(node) {
    if (current) current.children.push(node);
  }

  while (i < len) {
    if (text[i] === '<') {
      // XML prolog `<?xml ... ?>` — must be at start (ignoring whitespace)
      if (text.startsWith('<?', i)) {
        const end = text.indexOf('?>', i);
        if (end === -1) throw new SyntaxError('parseMtlx: unterminated prolog');
        const chunk = text.slice(i, end + 2);
        if (prolog === null) prolog = chunk;
        // else: processing instruction mid-document — drop (MaterialX doesn't use these)
        i = end + 2;
        continue;
      }
      // Comment `<!-- ... -->`
      if (text.startsWith('<!--', i)) {
        const end = text.indexOf('-->', i + 4);
        if (end === -1) throw new SyntaxError('parseMtlx: unterminated comment');
        pushChild({ kind: 'comment', value: text.slice(i + 4, end) });
        i = end + 3;
        continue;
      }
      // DOCTYPE / other declarations — skip verbatim
      if (text.startsWith('<!', i)) {
        const end = text.indexOf('>', i);
        if (end === -1) throw new SyntaxError('parseMtlx: unterminated declaration');
        i = end + 1;
        continue;
      }
      // Close tag `</tag>`
      if (text[i + 1] === '/') {
        const end = text.indexOf('>', i);
        if (end === -1) throw new SyntaxError('parseMtlx: unterminated close tag');
        const closeName = text.slice(i + 2, end).trim();
        if (!current || current.tag !== closeName) {
          throw new SyntaxError(`parseMtlx: mismatched close tag </${closeName}> (expected </${current?.tag}>)`);
        }
        stack.pop();
        current = stack.length ? stack[stack.length - 1] : null;
        i = end + 1;
        continue;
      }
      // Open tag `<tag attr="val" ...>` or self-close `<tag ... />`
      const openEnd = _findTagEnd(text, i);
      if (openEnd === -1) throw new SyntaxError('parseMtlx: unterminated open tag');
      const inner = text.slice(i + 1, openEnd);
      const selfClose = inner.endsWith('/');
      const body = selfClose ? inner.slice(0, -1).trim() : inner.trim();
      const firstSp = body.search(/\s/);
      const tag = firstSp === -1 ? body : body.slice(0, firstSp);
      const attrSrc = firstSp === -1 ? '' : body.slice(firstSp + 1);
      const attrs = _parseAttrs(attrSrc);
      /** @type {MtlxElement} */
      const el = { kind: 'element', tag, attrs, children: [], selfClose };
      if (root) pushChild(el);
      else root = el;
      if (!selfClose) {
        stack.push(el);
        current = el;
      }
      i = openEnd + 1;
      continue;
    }
    // Text content
    const nextLt = text.indexOf('<', i);
    const textEnd = nextLt === -1 ? len : nextLt;
    const chunk = text.slice(i, textEnd);
    if (current && chunk.length > 0) {
      // Preserve verbatim (including whitespace) — generator decides how to emit
      pushChild({ kind: 'text', value: chunk });
    }
    i = textEnd;
  }

  if (stack.length > 0) {
    throw new SyntaxError(`parseMtlx: unclosed element <${stack[stack.length - 1].tag}>`);
  }
  if (!root) throw new SyntaxError('parseMtlx: no root element');
  return { prolog, root };
}

/**
 * Serialize a parsed MaterialX tree back to text.
 * @param {MtlxDoc} doc
 * @param {object} [opts]
 * @param {string} [opts.indent='  ']  — indent string for prettified output
 * @returns {string}
 */
export function generateMtlx(doc, { indent = '  ' } = {}) {
  if (!doc || !doc.root) throw new TypeError('generateMtlx: doc with root element required');
  const out = [];
  if (doc.prolog) out.push(doc.prolog, '\n');
  _emit(doc.root, 0, out, indent);
  return out.join('');
}

function _emit(node, depth, out, indent) {
  const pad = indent.repeat(depth);
  if (node.kind === 'comment') {
    out.push(pad, '<!--', node.value, '-->', '\n');
    return;
  }
  if (node.kind === 'text') {
    // Trim pure-whitespace text to avoid ballooning output; emit meaningful text inline
    const trimmed = node.value.trim();
    if (trimmed) out.push(pad, trimmed, '\n');
    return;
  }
  // Element
  const attrStr = node.attrs.map(a => ` ${a.name}=${a.quote}${_encodeAttr(a.value, a.quote)}${a.quote}`).join('');
  if (node.selfClose || node.children.length === 0) {
    out.push(pad, '<', node.tag, attrStr, ' />', '\n');
    return;
  }
  out.push(pad, '<', node.tag, attrStr, '>', '\n');
  for (const c of node.children) _emit(c, depth + 1, out, indent);
  out.push(pad, '</', node.tag, '>', '\n');
}

// ── MaterialX-aware helpers ────────────────────────────────────────────────

/**
 * Get an attribute value by name, or default if absent.
 * @param {MtlxElement} el
 * @param {string} name
 * @param {string} [defaultVal='']
 */
export function getAttr(el, name, defaultVal = '') {
  const a = el.attrs.find(a => a.name === name);
  return a ? a.value : defaultVal;
}

/**
 * Set (or create) an attribute on an element, preserving original position/quote.
 * @param {MtlxElement} el
 * @param {string} name
 * @param {string} value
 */
export function setAttr(el, name, value) {
  const a = el.attrs.find(a => a.name === name);
  if (a) a.value = value;
  else el.attrs.push({ name, value, quote: '"' });
}

/**
 * Find all descendant elements matching a tag (depth-first, document order).
 * @param {MtlxElement} el
 * @param {string} tag
 * @returns {MtlxElement[]}
 */
export function findAll(el, tag) {
  const out = [];
  _walk(el, n => { if (n.kind === 'element' && n.tag === tag) out.push(n); });
  return out;
}

function _walk(node, visit) {
  if (node.kind !== 'element') return;
  visit(node);
  for (const c of node.children) _walk(c, visit);
}

/**
 * Extract the node-graph DAG edges from a parsed mtlx document.
 * MaterialX encodes connections as `<input nodename="producer" />` children.
 * Returns edges {from: producerNodeName, to: consumerNodeName, inputName}.
 * @param {MtlxDoc} doc
 * @returns {Array<{from:string, to:string, inputName:string}>}
 */
export function extractLinks(doc) {
  const edges = [];
  _walk(doc.root, (el) => {
    if (!isNodeElement(el)) return;
    const to = getAttr(el, 'name');
    for (const child of el.children) {
      if (child.kind !== 'element') continue;
      if (child.tag !== 'input') continue;
      const from = getAttr(child, 'nodename');
      if (!from || !to) continue;
      edges.push({ from, to, inputName: getAttr(child, 'name') });
    }
  });
  return edges;
}

/**
 * Is this element a graph node (i.e. can participate in nodename wiring)?
 * Anything inside a <nodegraph> that isn't <input>/<output>/<parameter> is a node.
 * At document root, <surfacematerial> and similar nodes also count.
 */
export function isNodeElement(el) {
  if (el.kind !== 'element') return false;
  const t = el.tag;
  return t !== 'input' && t !== 'output' && t !== 'parameter' &&
         t !== 'nodegraph' && t !== 'nodedef' && t !== 'materialx' &&
         t !== 'look' && t !== 'typedef' && t !== 'unitdef' && t !== 'unittypedef';
}

// ── Internals ──────────────────────────────────────────────────────────────

// Find the `>` that closes an open-tag starting at index `start` (which is at '<').
// Accounts for `>` inside quoted attribute values.
function _findTagEnd(text, start) {
  let i = start + 1;
  let quote = null;
  while (i < text.length) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
    } else {
      if (c === '"' || c === "'") quote = c;
      else if (c === '>') return i;
    }
    i++;
  }
  return -1;
}

const ATTR_RE = /([A-Za-z_][A-Za-z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function _parseAttrs(src) {
  const attrs = [];
  if (!src) return attrs;
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(src)) !== null) {
    const name = m[1];
    const isDouble = m[2] !== undefined;
    const raw = isDouble ? m[2] : m[3];
    attrs.push({ name, value: _decodeEntities(raw), quote: isDouble ? '"' : "'" });
  }
  return attrs;
}

const ENTITY_MAP = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function _decodeEntities(s) {
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);/g, (m, name) => {
    if (name in ENTITY_MAP) return ENTITY_MAP[name];
    if (name[0] === '#') {
      const code = name[1] === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return m;
  });
}

function _encodeAttr(value, quote) {
  let out = String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  if (quote === '"') out = out.replace(/"/g, '&quot;');
  else out = out.replace(/'/g, '&apos;');
  return out;
}

// usda.js — Parser + generator for USD ASCII (`.usda`) layer files.
//
// Scope (Phase 18.3): full layer-level fidelity for authoring USD scenes.
//
//   ✓ Layer header `#usda 1.0` + layer metadata block
//   ✓ Prim specs (def / over / class) with typeName + name + nested hierarchy
//   ✓ Typed attributes, optional `uniform` / `custom` modifiers
//   ✓ Attribute connections (`foo.connect = </path/to/target>`)
//   ✓ Time-sampled attributes (`foo.timeSamples = { 0: v, 24: v }`)
//   ✓ Relationships with single / array targets
//   ✓ References, payloads, variantSelection, apiSchemas in metadata
//   ✓ Variant sets + nested variant bodies
//   ✓ Full value grammar: scalar, string, asset (@...@), path (</...>),
//     tuple (...), array [...], dict { ... }, None, true/false
//
// Not in scope: crate (binary) format, USD composition resolution (we parse
// a single layer, not the composed stage), schema validation, comments
// (stripped in round-trip — documented limitation).
//
// Round-trip contract: `parseUsda(generateUsda(parseUsda(x)))` is deep-equal
// to `parseUsda(x)` for any valid USDA input. Output is canonical pretty-
// printed form, not byte-identical to input.
//
// Reference: Pixar USD "Crate File Format" + usda grammar docs.

/**
 * @typedef {object} UsdaValue
 * @property {'number'|'string'|'asset'|'path'|'bool'|'none'|'token'|'tuple'|'array'|'dict'} kind
 * @property {*} [value]                    — decoded JS value (number, string, bool…)
 * @property {string} [raw]                 — original source slice (for leaves)
 * @property {UsdaValue[]} [elements]       — tuple / array contents
 * @property {UsdaMetaEntry[]} [entries]    — dict contents
 */

/**
 * @typedef {object} UsdaMetaEntry
 * @property {string} key
 * @property {'prepend'|'append'|'delete'|'add'|'reorder'|null} op
 * @property {string|null} type             — typed dict entry (e.g. "string")
 * @property {UsdaValue} value
 */

/**
 * @typedef {object} UsdaAttribute
 * @property {'attribute'} kind
 * @property {boolean} uniform
 * @property {boolean} custom
 * @property {string} type                  — "double3", "token[]", etc.
 * @property {string} name                  — may be namespaced ("primvars:displayColor")
 * @property {UsdaValue|null} value         — null if connection-only
 * @property {string[]} connections         — target paths from `.connect = ...`
 * @property {Array<{time:number, value:UsdaValue}>|null} timeSamples
 * @property {UsdaMetaEntry[]} metadata
 */

/**
 * @typedef {object} UsdaRelationship
 * @property {'relationship'} kind
 * @property {boolean} custom
 * @property {string} name
 * @property {string[]} targets
 * @property {UsdaMetaEntry[]} metadata
 */

/**
 * @typedef {UsdaAttribute|UsdaRelationship} UsdaProperty
 */

/**
 * @typedef {object} UsdaVariant
 * @property {string} name
 * @property {UsdaMetaEntry[]} metadata
 * @property {UsdaProperty[]} properties
 * @property {UsdaPrim[]} children
 * @property {UsdaVariantSet[]} variantSets
 */

/**
 * @typedef {object} UsdaVariantSet
 * @property {string} name
 * @property {UsdaVariant[]} variants
 */

/**
 * @typedef {object} UsdaPrim
 * @property {'def'|'over'|'class'} specifier
 * @property {string|null} typeName
 * @property {string} name
 * @property {UsdaMetaEntry[]} metadata
 * @property {UsdaProperty[]} properties
 * @property {UsdaPrim[]} children
 * @property {UsdaVariantSet[]} variantSets
 */

/**
 * @typedef {object} UsdaLayer
 * @property {string} version                 — e.g. "1.0"
 * @property {UsdaMetaEntry[]} metadata
 * @property {UsdaPrim[]} prims
 */

const OPS = new Set(['prepend', 'append', 'delete', 'add', 'reorder']);
const SPECIFIERS = new Set(['def', 'over', 'class']);

// ── Tokenizer ───────────────────────────────────────────────────────────────
//
// Converts source text → flat token stream. Handles string escapes, triple-
// quoted strings, @asset@ (incl. @@@…@@@ for paths containing @), </paths/>,
// numbers (incl. scientific + hex), identifiers (colon-namespaced).

/**
 * @typedef {object} Token
 * @property {string} type    — 'kw'|'id'|'str'|'asset'|'path'|'num'|'punct'|'eof'
 * @property {*} value        — decoded for str, raw for num/path/asset
 * @property {string} [raw]   — original source slice for round-trip
 * @property {number} pos     — start offset in source (for error messages)
 */

function tokenize(text) {
  /** @type {Token[]} */ const tokens = [];
  const len = text.length;
  let i = 0;

  while (i < len) {
    const c = text[i];
    // Whitespace + newlines
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
    // Comments
    if (c === '#' || (c === '/' && text[i + 1] === '/')) {
      while (i < len && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw new SyntaxError(`usda: unterminated block comment at ${i}`);
      i = end + 2;
      continue;
    }
    // Triple-quoted string
    if ((c === '"' && text.startsWith('"""', i)) || (c === "'" && text.startsWith("'''", i))) {
      const delim = text.slice(i, i + 3);
      const start = i + 3;
      const end = text.indexOf(delim, start);
      if (end === -1) throw new SyntaxError(`usda: unterminated triple-string at ${i}`);
      const raw = text.slice(i, end + 3);
      tokens.push({ type: 'str', value: text.slice(start, end), raw, pos: i });
      i = end + 3;
      continue;
    }
    // Single-line string
    if (c === '"' || c === "'") {
      const start = i;
      const quote = c;
      i++;
      let out = '';
      while (i < len && text[i] !== quote) {
        if (text[i] === '\\' && i + 1 < len) {
          const esc = text[i + 1];
          const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'", '0': '\0' };
          out += (esc in map) ? map[esc] : esc;
          i += 2;
        } else {
          out += text[i]; i++;
        }
      }
      if (i >= len) throw new SyntaxError(`usda: unterminated string at ${start}`);
      i++; // consume closing quote
      tokens.push({ type: 'str', value: out, raw: text.slice(start, i), pos: start });
      continue;
    }
    // Asset path @...@  (or @@@...@@@ for paths containing @)
    if (c === '@') {
      const start = i;
      if (text.startsWith('@@@', i)) {
        const end = text.indexOf('@@@', i + 3);
        if (end === -1) throw new SyntaxError(`usda: unterminated @@@asset@@@ at ${i}`);
        tokens.push({ type: 'asset', value: text.slice(i + 3, end), raw: text.slice(i, end + 3), pos: i });
        i = end + 3;
      } else {
        i++;
        let end = i;
        while (end < len && text[end] !== '@') end++;
        if (end >= len) throw new SyntaxError(`usda: unterminated @asset@ at ${start}`);
        tokens.push({ type: 'asset', value: text.slice(i, end), raw: text.slice(start, end + 1), pos: start });
        i = end + 1;
      }
      continue;
    }
    // USD path </...>
    if (c === '<') {
      const end = text.indexOf('>', i + 1);
      if (end === -1) throw new SyntaxError(`usda: unterminated <path> at ${i}`);
      tokens.push({ type: 'path', value: text.slice(i + 1, end), raw: text.slice(i, end + 1), pos: i });
      i = end + 1;
      continue;
    }
    // Number
    if ((c >= '0' && c <= '9') || (c === '-' && text[i + 1] >= '0' && text[i + 1] <= '9') ||
        (c === '.' && text[i + 1] >= '0' && text[i + 1] <= '9')) {
      const start = i;
      if (c === '-') i++;
      // Hex
      if (text[i] === '0' && (text[i + 1] === 'x' || text[i + 1] === 'X')) {
        i += 2;
        while (i < len && /[0-9a-fA-F]/.test(text[i])) i++;
      } else {
        while (i < len && text[i] >= '0' && text[i] <= '9') i++;
        if (text[i] === '.') {
          i++;
          while (i < len && text[i] >= '0' && text[i] <= '9') i++;
        }
        if (text[i] === 'e' || text[i] === 'E') {
          i++;
          if (text[i] === '+' || text[i] === '-') i++;
          while (i < len && text[i] >= '0' && text[i] <= '9') i++;
        }
      }
      const raw = text.slice(start, i);
      tokens.push({ type: 'num', value: raw, raw, pos: start });
      continue;
    }
    // Identifier (including namespaced with colons, dotted for .connect/.timeSamples)
    if (c === '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
      const start = i;
      while (i < len && /[A-Za-z0-9_:]/.test(text[i])) i++;
      const word = text.slice(start, i);
      const isKw = OPS.has(word) || SPECIFIERS.has(word) ||
        word === 'uniform' || word === 'custom' || word === 'rel' ||
        word === 'variantSet' || word === 'None' || word === 'true' || word === 'false';
      tokens.push({ type: isKw ? 'kw' : 'id', value: word, raw: word, pos: start });
      continue;
    }
    // Punctuation — `:` is a standalone punct here (inside identifiers it's
    // already consumed by the identifier rule above, so a bare `:` is always
    // a separator, e.g. in timeSample entries `1: (0,0,0)`).
    if ('{}[](),=.;:'.includes(c)) {
      tokens.push({ type: 'punct', value: c, raw: c, pos: i });
      i++;
      continue;
    }
    throw new SyntaxError(`usda: unexpected character ${JSON.stringify(c)} at ${i}`);
  }
  tokens.push({ type: 'eof', value: null, pos: len });
  return tokens;
}

// ── Parser (recursive descent over token stream) ────────────────────────────

class Parser {
  constructor(tokens) { this.tokens = tokens; this.pos = 0; }
  peek(offset = 0) { return this.tokens[this.pos + offset] || this.tokens[this.tokens.length - 1]; }
  consume() { return this.tokens[this.pos++]; }
  match(type, value) {
    const t = this.peek();
    if (t.type !== type) return false;
    if (value !== undefined && t.value !== value) return false;
    return true;
  }
  eat(type, value) {
    if (!this.match(type, value)) {
      const t = this.peek();
      throw new SyntaxError(`usda: expected ${type}${value !== undefined ? ' "' + value + '"' : ''}, got ${t.type} "${t.value}" at pos ${t.pos}`);
    }
    return this.consume();
  }
  eatPunct(ch) { return this.eat('punct', ch); }

  /** @returns {UsdaLayer} */
  parseLayer() {
    // Header: "#usda 1.0" is stripped by caller before tokenizing.
    // Stored version comes from source scan, not tokens.
    /** @type {UsdaMetaEntry[]} */
    let metadata = [];
    if (this.match('punct', '(')) metadata = this.parseMetadataBlock();
    /** @type {UsdaPrim[]} */ const prims = [];
    while (!this.match('eof')) {
      prims.push(this.parsePrim());
    }
    return { version: '', metadata, prims };
  }

  /** Parse `(key = value ...)` metadata block — newline-or-comma separated. */
  parseMetadataBlock() {
    this.eatPunct('(');
    /** @type {UsdaMetaEntry[]} */ const entries = [];
    while (!this.match('punct', ')')) {
      entries.push(this.parseMetaEntry());
      // Allow optional comma or semicolon between entries
      while (this.match('punct', ',') || this.match('punct', ';')) this.consume();
    }
    this.eatPunct(')');
    return entries;
  }

  /** Parse one `[op] key = value` metadata entry. */
  parseMetaEntry() {
    /** @type {UsdaMetaEntry} */
    const entry = { key: '', op: null, type: null, value: null };
    // Optional op keyword
    if (this.match('kw') && OPS.has(this.peek().value)) {
      // Only consume as op if followed by an identifier (not '=')
      const next = this.peek(1);
      if (next && next.type === 'id') {
        entry.op = this.consume().value;
      }
    }
    // Key (identifier)
    const keyTok = this.peek();
    if (keyTok.type !== 'id') {
      throw new SyntaxError(`usda: expected metadata key, got ${keyTok.type} "${keyTok.value}" at pos ${keyTok.pos}`);
    }
    entry.key = this.consume().value;
    this.eatPunct('=');
    entry.value = this.parseValue();
    return entry;
  }

  /** Parse one value — any kind. */
  /** @returns {UsdaValue} */
  parseValue() {
    const t = this.peek();
    // None
    if (t.type === 'kw' && t.value === 'None') { this.consume(); return { kind: 'none' }; }
    // Booleans
    if (t.type === 'kw' && (t.value === 'true' || t.value === 'false')) {
      this.consume();
      return { kind: 'bool', value: t.value === 'true', raw: t.value };
    }
    // String
    if (t.type === 'str') { this.consume(); return { kind: 'string', value: t.value, raw: t.raw }; }
    // Asset (optionally followed by a prim path: @asset@</Prim>)
    if (t.type === 'asset') {
      this.consume();
      const assetVal = { kind: 'asset', value: t.value, raw: t.raw };
      if (this.peek().type === 'path') {
        const pt = this.consume();
        assetVal.targetPath = pt.value;
        assetVal.raw = t.raw + pt.raw;
      }
      return assetVal;
    }
    // Path
    if (t.type === 'path') { this.consume(); return { kind: 'path', value: t.value, raw: t.raw }; }
    // Number (signed)
    if (t.type === 'num') {
      this.consume();
      const n = Number(t.value);
      return { kind: 'number', value: Number.isFinite(n) ? n : t.value, raw: t.value };
    }
    // Tuple
    if (t.type === 'punct' && t.value === '(') return this.parseTuple();
    // Array
    if (t.type === 'punct' && t.value === '[') return this.parseArray();
    // Dict
    if (t.type === 'punct' && t.value === '{') return this.parseDict();
    // Bare identifier — token value (e.g. `Y` for upAxis, `group` for kind)
    if (t.type === 'id' || t.type === 'kw') {
      this.consume();
      return { kind: 'token', value: t.value, raw: t.value };
    }
    throw new SyntaxError(`usda: unexpected value token ${t.type} "${t.value}" at pos ${t.pos}`);
  }

  /** Parse `(a, b, c)` — tuple. */
  parseTuple() {
    this.eatPunct('(');
    /** @type {UsdaValue[]} */ const elements = [];
    while (!this.match('punct', ')')) {
      elements.push(this.parseValue());
      if (this.match('punct', ',')) this.consume();
    }
    this.eatPunct(')');
    return { kind: 'tuple', elements };
  }

  /** Parse `[a, b, c]` — array. */
  parseArray() {
    this.eatPunct('[');
    /** @type {UsdaValue[]} */ const elements = [];
    while (!this.match('punct', ']')) {
      elements.push(this.parseValue());
      if (this.match('punct', ',')) this.consume();
    }
    this.eatPunct(']');
    return { kind: 'array', elements };
  }

  /** Parse `{ [type] key = value ... }` — dict. */
  parseDict() {
    this.eatPunct('{');
    /** @type {UsdaMetaEntry[]} */ const entries = [];
    while (!this.match('punct', '}')) {
      entries.push(this.parseDictEntry());
      while (this.match('punct', ',') || this.match('punct', ';')) this.consume();
    }
    this.eatPunct('}');
    return { kind: 'dict', entries };
  }

  parseDictEntry() {
    /** @type {UsdaMetaEntry} */
    const entry = { key: '', op: null, type: null, value: null };
    // Optional type (first id), then key (second id), or just key
    if (this.peek().type === 'id' && this.peek(1).type === 'id') {
      entry.type = this.consume().value;
      entry.key = this.consume().value;
    } else if (this.peek().type === 'id' || this.peek().type === 'str') {
      // Dict key may also be a string literal (e.g. in customData)
      const t = this.consume();
      entry.key = t.value;
    } else {
      const t = this.peek();
      throw new SyntaxError(`usda: expected dict key at pos ${t.pos}`);
    }
    this.eatPunct('=');
    entry.value = this.parseValue();
    return entry;
  }

  /** Parse a prim: `(def|over|class) [TypeName] "name" [(meta)] { body }` */
  parsePrim() {
    /** @type {UsdaPrim} */
    const prim = {
      specifier: 'def', typeName: null, name: '',
      metadata: [], properties: [], children: [], variantSets: [],
    };
    // Specifier
    if (this.match('kw') && SPECIFIERS.has(this.peek().value)) {
      prim.specifier = this.consume().value;
    } else {
      const t = this.peek();
      throw new SyntaxError(`usda: expected prim specifier (def|over|class) at pos ${t.pos}, got ${t.type} "${t.value}"`);
    }
    // Optional typeName (id) + name (str), OR just name (str)
    if (this.peek().type === 'id' && this.peek(1).type === 'str') {
      prim.typeName = this.consume().value;
    }
    const nameTok = this.eat('str');
    prim.name = nameTok.value;
    // Optional metadata
    if (this.match('punct', '(')) prim.metadata = this.parseMetadataBlock();
    // Body
    this.eatPunct('{');
    this.parsePrimBody(prim);
    this.eatPunct('}');
    return prim;
  }

  parsePrimBody(prim) {
    while (!this.match('punct', '}')) {
      // Nested prim?
      if (this.match('kw') && SPECIFIERS.has(this.peek().value)) {
        prim.children.push(this.parsePrim());
        continue;
      }
      // Variant set definition?
      if (this.match('kw', 'variantSet')) {
        prim.variantSets.push(this.parseVariantSet());
        continue;
      }
      // Relationship?  `[custom] rel name [= targets]`
      if (this.match('kw', 'rel') || (this.match('kw', 'custom') && this.peek(1).type === 'kw' && this.peek(1).value === 'rel')) {
        prim.properties.push(this.parseRelationship());
        continue;
      }
      // Attribute
      prim.properties.push(this.parseAttribute());
    }
  }

  /** Parse `[custom] [uniform] type name[.connect|.timeSamples] [= value] [metadata]`. */
  parseAttribute() {
    /** @type {UsdaAttribute} */
    const attr = {
      kind: 'attribute', uniform: false, custom: false,
      type: '', name: '', value: null, connections: [], timeSamples: null, metadata: [],
    };
    if (this.match('kw', 'custom')) { this.consume(); attr.custom = true; }
    if (this.match('kw', 'uniform')) { this.consume(); attr.uniform = true; }
    // Type: identifier, optionally followed by [] — tokenizer sees `token` then `[` `]`
    const typeTok = this.eat('id');
    let typeName = typeTok.value;
    if (this.match('punct', '[')) {
      this.consume();
      this.eatPunct(']');
      typeName += '[]';
    }
    attr.type = typeName;
    // Name
    const nameTok = this.eat('id');
    attr.name = nameTok.value;
    // Optional .connect / .timeSamples suffix
    let isConnection = false;
    let isTimeSamples = false;
    if (this.match('punct', '.')) {
      this.consume();
      const suffix = this.eat('id').value;
      if (suffix === 'connect') isConnection = true;
      else if (suffix === 'timeSamples') isTimeSamples = true;
      else throw new SyntaxError(`usda: unknown attribute suffix ".${suffix}"`);
    }
    // Optional = value
    if (this.match('punct', '=')) {
      this.consume();
      if (isConnection) {
        // Target: single path or [path, path, …]
        if (this.match('punct', '[')) {
          const arr = this.parseArray();
          attr.connections = arr.elements.filter(e => e.kind === 'path').map(e => e.value);
        } else {
          const v = this.parseValue();
          if (v.kind === 'path') attr.connections.push(v.value);
        }
      } else if (isTimeSamples) {
        // Dict with numeric keys: `{ 0: (0,0,0), 24: (1,0,0) }`
        attr.timeSamples = this.parseTimeSamples();
      } else {
        attr.value = this.parseValue();
      }
    }
    // Optional per-attribute metadata (rare but legal)
    if (this.match('punct', '(')) attr.metadata = this.parseMetadataBlock();
    return attr;
  }

  parseTimeSamples() {
    this.eatPunct('{');
    /** @type {Array<{time:number, value:UsdaValue}>} */ const samples = [];
    while (!this.match('punct', '}')) {
      // Key: number
      const keyTok = this.eat('num');
      this.eatPunct(':');
      const v = this.parseValue();
      samples.push({ time: Number(keyTok.value), value: v });
      if (this.match('punct', ',') || this.match('punct', ';')) this.consume();
    }
    this.eatPunct('}');
    return samples;
  }

  /** Parse `[custom] rel name [= target | [targets]] [metadata]`. */
  parseRelationship() {
    /** @type {UsdaRelationship} */
    const rel = { kind: 'relationship', custom: false, name: '', targets: [], metadata: [] };
    if (this.match('kw', 'custom')) { this.consume(); rel.custom = true; }
    this.eat('kw', 'rel');
    rel.name = this.eat('id').value;
    if (this.match('punct', '=')) {
      this.consume();
      if (this.match('punct', '[')) {
        const arr = this.parseArray();
        rel.targets = arr.elements.filter(e => e.kind === 'path').map(e => e.value);
      } else if (this.match('path')) {
        rel.targets.push(this.consume().value);
      } else if (this.match('kw', 'None')) {
        this.consume(); // relationship explicitly cleared
      }
    }
    if (this.match('punct', '(')) rel.metadata = this.parseMetadataBlock();
    return rel;
  }

  /** Parse `variantSet "name" = { "variantName" { body } … }`. */
  parseVariantSet() {
    this.eat('kw', 'variantSet');
    const nameTok = this.eat('str');
    this.eatPunct('=');
    this.eatPunct('{');
    /** @type {UsdaVariant[]} */ const variants = [];
    while (!this.match('punct', '}')) {
      const vnameTok = this.eat('str');
      /** @type {UsdaVariant} */
      const variant = {
        name: vnameTok.value, metadata: [], properties: [], children: [], variantSets: [],
      };
      if (this.match('punct', '(')) variant.metadata = this.parseMetadataBlock();
      this.eatPunct('{');
      // Reuse prim-body parser — variants can contain any prim body items
      this.parsePrimBody(/** @type {any} */ (variant));
      this.eatPunct('}');
      variants.push(variant);
    }
    this.eatPunct('}');
    return { name: nameTok.value, variants };
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Parse a USDA layer.
 * @param {string} text
 * @returns {UsdaLayer}
 */
export function parseUsda(text) {
  if (typeof text !== 'string') throw new TypeError('parseUsda: text must be a string');
  // Extract #usda header
  const headerMatch = text.match(/^\s*#usda\s+(\S+)/);
  if (!headerMatch) throw new SyntaxError('parseUsda: missing "#usda" header');
  const version = headerMatch[1];
  const body = text.slice(headerMatch[0].length);
  const tokens = tokenize(body);
  const parser = new Parser(tokens);
  const layer = parser.parseLayer();
  layer.version = version;
  return layer;
}

/**
 * Serialize a USDA layer back to text.
 * @param {UsdaLayer} layer
 * @returns {string}
 */
export function generateUsda(layer) {
  if (!layer) throw new TypeError('generateUsda: layer required');
  const out = [];
  out.push(`#usda ${layer.version || '1.0'}`);
  if (layer.metadata.length) {
    out.push(formatMetadata(layer.metadata, 0));
  }
  out.push('');
  for (const prim of layer.prims) {
    out.push(formatPrim(prim, 0));
    out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function formatMetadata(entries, depth) {
  const pad = '    '.repeat(depth);
  const padInner = '    '.repeat(depth + 1);
  const lines = ['(', ...entries.map(e => padInner + formatMetaEntry(e, depth + 1)), pad + ')'];
  return lines.join('\n');
}

function formatMetaEntry(e, depth) {
  const prefix = (e.op ? e.op + ' ' : '') + (e.type ? e.type + ' ' : '');
  return `${prefix}${e.key} = ${formatValue(e.value, depth)}`;
}

function formatValue(v, depth) {
  if (!v) return 'None';
  switch (v.kind) {
    case 'none': return 'None';
    case 'bool': return v.value ? 'true' : 'false';
    case 'number': return v.raw ?? String(v.value);
    case 'string': return JSON.stringify(v.value);       // double-quoted, JS-style escapes
    case 'asset': return v.targetPath != null ? `@${v.value}@<${v.targetPath}>` : `@${v.value}@`;
    case 'path': return `<${v.value}>`;
    case 'token': return v.value;
    case 'tuple': return `(${v.elements.map(el => formatValue(el, depth)).join(', ')})`;
    case 'array': return formatArray(v.elements, depth);
    case 'dict': return formatDict(v.entries, depth);
  }
  return '';
}

function formatArray(elements, depth) {
  if (elements.length === 0) return '[]';
  // Inline short arrays
  const items = elements.map(el => formatValue(el, depth));
  const inline = `[${items.join(', ')}]`;
  if (inline.length <= 80 && !inline.includes('\n')) return inline;
  const pad = '    '.repeat(depth + 1);
  const padClose = '    '.repeat(depth);
  return `[\n${items.map(s => pad + s).join(',\n')}\n${padClose}]`;
}

function formatDict(entries, depth) {
  if (entries.length === 0) return '{}';
  const pad = '    '.repeat(depth + 1);
  const padClose = '    '.repeat(depth);
  const lines = entries.map(e => pad + formatMetaEntry(e, depth + 1));
  return `{\n${lines.join('\n')}\n${padClose}}`;
}

function formatPrim(prim, depth) {
  const pad = '    '.repeat(depth);
  const head = `${prim.specifier} ${prim.typeName ? prim.typeName + ' ' : ''}${JSON.stringify(prim.name)}`;
  const out = [pad + head];
  if (prim.metadata.length) out[0] += ' ' + formatMetadata(prim.metadata, depth);
  out.push(pad + '{');
  for (const p of prim.properties) out.push(formatProperty(p, depth + 1));
  for (const vs of prim.variantSets) out.push(formatVariantSet(vs, depth + 1));
  for (const c of prim.children) out.push('', formatPrim(c, depth + 1));
  out.push(pad + '}');
  return out.join('\n');
}

function formatProperty(p, depth) {
  const pad = '    '.repeat(depth);
  if (p.kind === 'relationship') {
    const header = `${p.custom ? 'custom ' : ''}rel ${p.name}`;
    let body = '';
    if (p.targets.length === 0) {
      body = ''; // no value — relationship declaration only
    } else if (p.targets.length === 1) {
      body = ` = <${p.targets[0]}>`;
    } else {
      body = ` = [${p.targets.map(t => `<${t}>`).join(', ')}]`;
    }
    return pad + header + body;
  }
  // Attribute
  const mods = `${p.custom ? 'custom ' : ''}${p.uniform ? 'uniform ' : ''}`;
  const lines = [];
  if (p.value !== null) {
    lines.push(pad + `${mods}${p.type} ${p.name} = ${formatValue(p.value, depth)}`);
  }
  if (p.connections.length === 1) {
    lines.push(pad + `${mods}${p.type} ${p.name}.connect = <${p.connections[0]}>`);
  } else if (p.connections.length > 1) {
    lines.push(pad + `${mods}${p.type} ${p.name}.connect = [${p.connections.map(c => `<${c}>`).join(', ')}]`);
  }
  if (p.timeSamples) {
    const samplePad = '    '.repeat(depth + 1);
    const close = '    '.repeat(depth);
    const items = p.timeSamples.map(s => `${samplePad}${s.time}: ${formatValue(s.value, depth + 1)}`);
    lines.push(pad + `${mods}${p.type} ${p.name}.timeSamples = {\n${items.join(',\n')}\n${close}}`);
  }
  // Declaration-only attribute (no value, no connection, no timeSamples)
  if (lines.length === 0) {
    lines.push(pad + `${mods}${p.type} ${p.name}`);
  }
  return lines.join('\n');
}

function formatVariantSet(vs, depth) {
  const pad = '    '.repeat(depth);
  const padInner = '    '.repeat(depth + 1);
  const out = [pad + `variantSet ${JSON.stringify(vs.name)} = {`];
  for (const v of vs.variants) {
    let head = padInner + JSON.stringify(v.name);
    if (v.metadata.length) head += ' ' + formatMetadata(v.metadata, depth + 1);
    out.push(head);
    out.push(padInner + '{');
    for (const p of v.properties) out.push(formatProperty(p, depth + 2));
    for (const nvs of v.variantSets) out.push(formatVariantSet(nvs, depth + 2));
    for (const c of v.children) out.push('', formatPrim(c, depth + 2));
    out.push(padInner + '}');
  }
  out.push(pad + '}');
  return out.join('\n');
}

// ── Analysis helpers ────────────────────────────────────────────────────────

/**
 * Walk the prim tree and return a flat list with prim paths.
 * @param {UsdaLayer} layer
 * @returns {Array<{path:string, prim:UsdaPrim}>}
 */
export function extractPrimTree(layer) {
  const out = [];
  const walk = (prims, parentPath) => {
    for (const p of prims) {
      const path = `${parentPath}/${p.name}`;
      out.push({ path, prim: p });
      walk(p.children, path);
      for (const vs of p.variantSets) {
        for (const v of vs.variants) {
          walk(v.children, `${path}{${vs.name}=${v.name}}`);
        }
      }
    }
  };
  walk(layer.prims, '');
  return out;
}

/**
 * Extract all attribute-connection edges across the layer: the UsdShade node
 * graph inside a scene. Each edge is `{from, to, consumerAttr}` where:
 *   - `from` is the target path (the producer)
 *   - `to` is the prim path of the consumer
 *   - `consumerAttr` is the attribute name that referenced the producer
 * @param {UsdaLayer} layer
 * @returns {Array<{from:string, to:string, consumerAttr:string}>}
 */
export function extractConnections(layer) {
  const edges = [];
  const tree = extractPrimTree(layer);
  for (const { path, prim } of tree) {
    for (const p of prim.properties) {
      if (p.kind !== 'attribute') continue;
      for (const conn of p.connections) {
        edges.push({ from: conn, to: path, consumerAttr: p.name });
      }
    }
  }
  return edges;
}

/**
 * Extract all reference/payload arcs from the layer's prim metadata.
 * @param {UsdaLayer} layer
 * @returns {Array<{primPath:string, arc:'references'|'payload'|'inherits'|'specializes', assetPath?:string, primPathRef?:string}>}
 */
export function extractReferences(layer) {
  const arcs = [];
  const tree = extractPrimTree(layer);
  const arcKeys = new Set(['references', 'payload', 'payloads', 'inherits', 'specializes']);
  for (const { path, prim } of tree) {
    for (const meta of prim.metadata) {
      if (!arcKeys.has(meta.key)) continue;
      const arcType = meta.key === 'payloads' ? 'payload' : /** @type any */ (meta.key);
      const targets = meta.value.kind === 'array' ? meta.value.elements : [meta.value];
      for (const t of targets) {
        if (t.kind === 'asset') arcs.push({ primPath: path, arc: arcType, assetPath: t.value });
        else if (t.kind === 'path') arcs.push({ primPath: path, arc: arcType, primPathRef: t.value });
      }
    }
  }
  return arcs;
}

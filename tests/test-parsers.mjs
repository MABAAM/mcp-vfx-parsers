import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseNk, generateNk, createNkScene, appendNkNode, extractLinks as extractNkLinks } from "../src/parsers/nuke.js";
import { parseMtlx, generateMtlx, extractLinks as extractMtlxLinks } from "../src/parsers/mtlx.js";
import { parseUsda, generateUsda, extractPrimTree, extractConnections, extractReferences } from "../src/parsers/usda.js";

// ── Nuke .nk ────────────────────────────────────────────────────────────────

const SAMPLE_NK = `#! C:/Program Files/Nuke14.0v3/nuke-14.0.3.dll -nx
version 14.0 v3
Root {
 inputs 0
 name "C:/projects/comp.nk"
}
Read {
 inputs 0
 file_type exr
 file "plate_v001.####.exr"
 name Read1
 xpos 100
 ypos -200
}
Grade {
 inputs 1
 white 1.5
 name Grade1
 xpos 100
 ypos -100
}
Write {
 inputs 1
 file "output.####.exr"
 name Write1
 xpos 100
 ypos 0
}
`;

describe("Nuke parser", () => {
  it("parses nodes", () => {
    const scene = parseNk(SAMPLE_NK);
    assert.ok(scene.nodes.length >= 3);
    const names = scene.nodes.map((n) => n.name);
    assert.ok(names.includes("Read1"));
    assert.ok(names.includes("Grade1"));
    assert.ok(names.includes("Write1"));
  });

  it("round-trips", () => {
    const a = parseNk(SAMPLE_NK);
    const text = generateNk(a);
    const b = parseNk(text);
    assert.deepStrictEqual(a, b);
  });

  it("extracts links", () => {
    const scene = parseNk(SAMPLE_NK);
    const links = extractNkLinks(scene);
    assert.ok(links.length >= 1);
  });

  it("creates and appends nodes", () => {
    const scene = createNkScene();
    appendNkNode(scene, "Read", { file: "test.exr", file_type: "exr" });
    appendNkNode(scene, "Grade", { white: "1.2" }, ["Read1"]);
    assert.equal(scene.nodes.length, 2);
    const text = generateNk(scene);
    assert.ok(text.includes("Read"));
    assert.ok(text.includes("Grade"));
  });
});

// ── MaterialX .mtlx ────────────────────────────────────────────────────────

const SAMPLE_MTLX = `<?xml version="1.0"?>
<materialx version="1.38">
  <nodegraph name="NG_marble">
    <noise3d name="noise1" type="float">
      <input name="amplitude" type="float" value="1.0"/>
      <input name="pivot" type="float" value="0.0"/>
    </noise3d>
    <mix name="mix1" type="color3">
      <input name="fg" type="color3" value="0.8, 0.2, 0.1"/>
      <input name="bg" type="color3" value="1.0, 1.0, 1.0"/>
      <input name="mix" type="float" nodename="noise1"/>
    </mix>
    <output name="out" type="color3" nodename="mix1"/>
  </nodegraph>
</materialx>
`;

describe("MaterialX parser", () => {
  it("parses elements", () => {
    const doc = parseMtlx(SAMPLE_MTLX);
    assert.ok(doc.root);
    assert.equal(doc.root.tag, "materialx");
    assert.ok(doc.root.children.length > 0);
  });

  it("round-trips", () => {
    const a = parseMtlx(SAMPLE_MTLX);
    const text = generateMtlx(a);
    const b = parseMtlx(text);
    assert.deepStrictEqual(a, b);
  });

  it("extracts links", () => {
    const doc = parseMtlx(SAMPLE_MTLX);
    const links = extractMtlxLinks(doc);
    assert.ok(links.length >= 1);
    const noiseLink = links.find((l) => l.from === "noise1");
    assert.ok(noiseLink);
  });
});

// ── USD ASCII .usda ─────────────────────────────────────────────────────────

const SAMPLE_USDA = `#usda 1.0
(
    defaultPrim = "World"
    upAxis = "Y"
)

def Xform "World"
{
    def Mesh "Cube" (
        prepend references = @./cube.usda@</Cube>
    )
    {
        float3[] extent = [(-1, -1, -1), (1, 1, 1)]
        uniform bool doubleSided = true
    }

    def Scope "Materials"
    {
        def Material "SimpleMat"
        {
            token outputs:surface.connect = </World/Materials/SimpleMat/Shader.outputs:surface>

            def Shader "Shader"
            {
                uniform token info:id = "UsdPreviewSurface"
                color3f inputs:diffuseColor = (0.8, 0.2, 0.1)
                float inputs:roughness = 0.4
                token outputs:surface
            }
        }
    }
}
`;

describe("USDA parser", () => {
  it("parses prims", () => {
    const layer = parseUsda(SAMPLE_USDA);
    assert.ok(layer.prims.length > 0);
    assert.equal(layer.prims[0].name, "World");
  });

  it("round-trips semantically", () => {
    const a = parseUsda(SAMPLE_USDA);
    const text = generateUsda(a);
    const b = parseUsda(text);
    assert.deepStrictEqual(a, b);
  });

  it("extracts prim tree", () => {
    const layer = parseUsda(SAMPLE_USDA);
    const tree = extractPrimTree(layer);
    assert.ok(tree.length >= 3);
    const paths = tree.map((t) => t.path);
    assert.ok(paths.includes("/World"));
    assert.ok(paths.includes("/World/Cube"));
  });

  it("extracts connections", () => {
    const layer = parseUsda(SAMPLE_USDA);
    const conns = extractConnections(layer);
    assert.ok(conns.length >= 1);
  });

  it("extracts references", () => {
    const layer = parseUsda(SAMPLE_USDA);
    const refs = extractReferences(layer);
    assert.ok(refs.length >= 1);
    assert.equal(refs[0].arc, "references");
  });

  it("parses layer metadata", () => {
    const layer = parseUsda(SAMPLE_USDA);
    assert.ok(layer.metadata.length >= 1);
  });
});

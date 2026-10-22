/** Exercise the pinned renderer's emitted quads: pixel-rounded cells must not resample text. */
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

// Import the dependency's source so both backends can be checked without a physical GPU.
const runtimeSource = resolve(import.meta.dir, "../src/runtime/create-runtime");
const { emitWebGPUQueuedGlyphs } = await import(
  `${runtimeSource}/render-tick-webgpu-emit-glyphs.ts`
);
const { renderWebGLGlyphPipeline } = await import(
  `${runtimeSource}/render-tick-webgl-glyph-pipeline.ts`
);

function emittedQuad(
  backend: "webgpu" | "webgl2",
  advance: number,
  cellWidth: number,
  glyphWidth: number,
): number[] {
  const glyphId = 1;
  const atlas = {
    bitmap: { width: 64, rows: 64 },
    glyphs: new Map([
      [glyphId, { width: glyphWidth, height: 10, bearingX: 0, bearingY: 10, atlasX: 1, atlasY: 1 }],
    ]),
  };
  const deps = {
    fontState: { fonts: [{ atlas }] },
    defaultBg: [0, 0, 0, 1],
    fontEntryHasItalicStyle: () => false,
    fontEntryHasBoldStyle: () => false,
    GLYPH_RENDER_MODE_MONO: 0,
    GLYPH_RENDER_MODE_COLOR: 1,
  };
  const state = { glyphAtlases: new Map([[0, { nearest: true }]]) };
  const queue = new Map([
    [
      0,
      [
        {
          shaped: { advance, glyphs: [{ glyphId, xOffset: 0, yOffset: 0, xAdvance: advance }] },
          x: 0,
          xPad: 0,
          baseY: 12,
          fg: [1, 1, 1, 1],
        },
      ],
    ],
  ]);
  const nearest = new Map<number, number[]>();
  const linear = new Map<number, number[]>();
  const metrics = { cellW: cellWidth, cellH: 20, primaryScale: 1, baselineOffset: 12, yPad: 0 };
  if (backend === "webgpu") {
    emitWebGPUQueuedGlyphs({
      deps,
      state,
      frame: { baselineAdjustByFont: [0] },
      queueByFont: queue,
      targetMaps: { nearest, linear },
      ...metrics,
    });
  } else {
    // Stop after the real WebGL emitter, before it attempts to draw using a GPU context.
    const emitted = new Error("quads emitted");
    expect(() =>
      renderWebGLGlyphPipeline({
        deps: {
          ...deps,
          collectKittyDrawPlan: () => {
            throw emitted;
          },
        },
        state,
        ...metrics,
        neededGlyphIdsByFont: new Map(),
        glyphQueueByFont: queue,
        overlayGlyphQueueByFont: new Map(),
        glyphDataByFont: nearest,
        overlayGlyphDataByFont: new Map(),
        baselineAdjustByFont: [0],
        getGlyphData(map: Map<number, number[]>, index: number) {
          if (!map.has(index)) map.set(index, []);
          return map.get(index)!;
        },
      }),
    ).toThrow(emitted);
  }
  return (nearest.get(0)?.length ? nearest.get(0) : linear.get(0)) ?? [];
}

for (const backend of ["webgpu", "webgl2"] as const) {
  describe(`${backend} primary font pixel rounding`, () => {
    for (const [advance, cellWidth, glyphWidth] of [
      [8.4, 8, 8],
      [7.2, 7, 7],
      [16.8, 17, 16],
      [8, 8, 8],
    ] as const) {
      test(`preserves the raster at advance ${advance} in a ${cellWidth}px cell`, () => {
        const quad = emittedQuad(backend, advance, cellWidth, glyphWidth);
        expect(quad).toHaveLength(18);
        expect(quad[2]).toBe(glyphWidth);
        expect(quad[3]).toBe(10);
      });
    }
    test("still fits a genuinely oversized glyph", () => {
      const quad = emittedQuad(backend, 12, 8, 12);
      expect(quad[2]).toBe(8);
      expect(quad[3]).toBeCloseTo((10 * 8) / 12);
    });
  });
}

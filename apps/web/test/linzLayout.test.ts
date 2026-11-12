import { describe, expect, test } from "bun:test";
import { paintLinz } from "../src/art/linz.ts";
import { C } from "../src/art/palette.ts";
import { PixelCanvas, packColor } from "../src/art/pixel.ts";
import { artSeason, setArtSeason } from "../src/art/seasons.ts";
import {
  LINZ_SURROUND,
  type LinzRect,
  linzLayout,
  linzTreeAllowed,
  overlapsLinzRect,
} from "../src/world/linzLayout.ts";
import { buildOfficeMap, TILE } from "../src/world/map.ts";

const contains = (outer: LinzRect, inner: LinzRect) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.w <= outer.x + outer.w &&
  inner.y + inner.h <= outer.y + outer.h;

describe("linzLayout", () => {
  for (const rows of [4, 5, 6]) {
    test(`four non-overlapping strips preserve office and road (${rows} pod rows)`, () => {
      const map = buildOfficeMap(rows);
      const width = map.width * TILE;
      const height = map.height * TILE;
      const l = linzLayout(width, height);
      expect(width).toBe(1280);
      expect(height).toBe(480 + (rows - 4) * 96);
      expect(l).toEqual(linzLayout(width, height));
      expect(l.strips.length).toBe(4);
      for (const [i, strip] of l.strips.entries()) {
        expect(overlapsLinzRect(strip, { x: 0, y: 0, w: width, h: height })).toBe(false);
        for (const other of l.strips.slice(i + 1))
          expect(overlapsLinzRect(strip, other)).toBe(false);
      }
      expect(l.strips.reduce((area, s) => area + s.w * s.h, 0)).toBe(
        (width + 2 * LINZ_SURROUND) * (height + 2 * LINZ_SURROUND) - width * height,
      );
      expect(l.sidewalk).toEqual({ x: -192, y: height, w: width + 384, h: 10 });
      expect(l.road).toEqual({ x: -192, y: height + 10, w: width + 384, h: 44 });
      // Existing car lanes (+30/+50) and lunch truck (+32) remain inside the street.
      for (const lane of [30, 50, 32]) {
        expect(height + lane).toBeGreaterThan(l.road.y);
        expect(height + lane).toBeLessThan(l.road.y + l.road.h);
      }
      expect(contains(l.strips[2]!, l.forest)).toBe(true);
      expect(overlapsLinzRect(l.forest, l.north)).toBe(false);
      expect(overlapsLinzRect(l.forest, l.road)).toBe(false);
      expect(l.north).toEqual(linzLayout(1280, 480).north);
    });
  }

  test("landmarks occupy the right banks, basilica stays distant and river is continuous", () => {
    const l = linzLayout(1280, 480);
    for (const rect of [l.hill, l.basilica, l.aec, l.river, l.lentos, l.facades]) {
      expect(contains(l.north, rect)).toBe(true);
      expect(rect.y + rect.h).toBeLessThanOrEqual(-8);
    }
    expect(contains(l.hill, l.basilica)).toBe(true);
    expect(l.aec.y + l.aec.h).toBeLessThanOrEqual(l.river.y);
    expect(contains(l.nearBank, l.lentos)).toBe(true);
    expect(contains(l.nearBank, l.facades)).toBe(true);
    expect(contains(l.lentos, l.lentosOpening)).toBe(true);
    expect(l.river.x).toBe(l.north.x);
    expect(l.river.w).toBe(l.north.w);
  });

  test("complete tree crowns/shadows cannot intrude into the riverfront", () => {
    const l = linzLayout(1280, 480);
    for (let y = -192; y < 20; y += 4)
      for (let x = -192; x < 1472; x += 20)
        for (const radius of [9, 15])
          if (linzTreeAllowed(l, x, y, radius)) expect(y - radius - 7).toBeGreaterThanOrEqual(0);
    expect(linzTreeAllowed(l, -100, 100, 15)).toBe(true);
  });
});

describe("paintLinz", () => {
  test("seasonal hill foliage changes without recolouring the river or architecture", () => {
    const previous = artSeason();
    const l = linzLayout(1280, 480);
    const sheets: PixelCanvas[] = [];
    try {
      for (const season of ["summer", "autumn", "spring", "winter"] as const) {
        setArtSeason(season);
        const pc = new PixelCanvas(1664, 192).at(192, 192);
        paintLinz(pc, l);
        sheets.push(pc);
      }
      const summer = sheets[0]!;
      for (const sheet of sheets.slice(1)) {
        expect(sheet.data.subarray(60 * sheet.width)).toEqual(
          summer.data.subarray(60 * summer.width),
        );
      }
      for (const sheet of sheets.slice(1, 3)) expect(sheet.data).not.toEqual(summer.data);
    } finally {
      setArtSeason(previous);
    }
  });

  test("deterministic clipped north painting never touches office, paths or southern traffic", () => {
    for (const height of [480, 576, 672]) {
      const l = linzLayout(1280, height);
      const full = new PixelCanvas(1664, height + 384).at(192, 192);
      paintLinz(full, l);
      // All landmarks and the clean setback stop before the original map origin.
      expect(full.data.subarray(192 * full.width).every((p) => p === 0)).toBe(true);
      const strip = new PixelCanvas(1664, 192).at(192, 192);
      paintLinz(strip, l);
      expect(full.data.subarray(0, 192 * full.width)).toEqual(strip.data);
      const repeat = new PixelCanvas(1664, 192).at(192, 192);
      paintLinz(repeat, l);
      expect(strip.data).toEqual(repeat.data);
      // The picture-frame void is open right through to the base, unlike a glass window.
      const o = l.lentosOpening;
      expect(strip.get(o.x, o.y + o.h - 1)).toBe(packColor(C.ink));
      expect(strip.get(o.x - 1, o.y + o.h - 1)).not.toBe(packColor(C.ink));
      // A ribbon of water reaches both strip edges, with no gaps or tree-coloured pixels.
      for (const x of [-192, 0, 400, 900, 1471])
        expect([C.slate, C.dusk, C.grey].map((c) => packColor(c))).toContain(strip.get(x, -80));
    }
  });
});

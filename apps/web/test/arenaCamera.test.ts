import { expect, test } from "bun:test";
import type { Container } from "pixi.js";
import { Camera } from "../src/camera.ts";
import { buildOfficeMap, TILE } from "../src/world/map.ts";

for (const width of [390, 1440])
  test(`arena camera fits all combat cells at viewport ${width}`, () => {
    const map = buildOfficeMap(4, true);
    const area = map.areas.find((a) => a.name === "arena")!;
    const world = { scale: { set: () => {} }, position: { set: () => {} } } as unknown as Container;
    const camera = new Camera(
      world,
      () => ({ width, height: 844 }),
      () => ({ width: map.width * TILE, height: map.height * TILE }),
      () => map.areas,
      { kiosk: false, topInset: 36 },
    );
    camera.focusArea("arena", true);
    const v = camera.viewRect();
    expect(v.x).toBeLessThanOrEqual(area.x * TILE);
    expect(v.x + v.w).toBeGreaterThanOrEqual((area.x + area.w) * TILE);
    expect(v.y).toBeLessThanOrEqual(area.y * TILE);
    expect(v.y + v.h).toBeGreaterThanOrEqual((area.y + area.h) * TILE);
  });

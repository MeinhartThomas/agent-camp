# Linz surroundings

## Composition and invariants

An original, geographically compressed riverfront, not a literal city map or playable expansion.
Behind the office: wooded Pöstlingberg with its twin-tower basilica, angular LED-grid Ars Electronica
Center on the far quay, the Danube, then the near-bank glass Lentos with its through-building opening
and a Hauptplatz-inspired facade row. Muted colours keep the office the focus. All art is static;
there are no new POIs, animations, shader effects, copied assets or per-frame painting.

`world/linzLayout.ts` owns pure geometry, four non-overlapping strip bounds and tree exclusions.
`art/linz.ts` paints the north strip using the existing PixelCanvas offsets/clipping. Terrain still
uploads exactly four surround textures, owned and destroyed by the existing floor rebuild lifecycle.
The southern sidewalk, road, vehicle lanes, office, garden, businesses, paths and map dimensions
are unchanged. Forest eyes/wolf use the wooded west side rather than the riverfront. Seasonal
lawn/trees remain; distant hill foliage uses the existing seasonal palette.

Camera and minimap are unchanged. **Office fit is not scenery fit**: the hill/AEC can be clipped
on laptops, portrait phones and grown maps. Office legibility takes priority over showing every
landmark. The full-scene screenshots use zoom 1 at 1920×1080; normal laptop fit is 1440×900.

## Visual references

Official photographs were viewed to understand silhouettes; none are bundled or traced:

- [Ars Electronica Center](https://ars.electronica.art/center/en/): angular gridded volume and
  lower sloping wing, with regular luminous facade panels.
- [Lentos](https://www.lentos.at/en/): long glass screen, oversized picture-frame opening and
  red entrance accent.
- [Pöstlingberg](https://www.linztourismus.at/en/leisure/discover-linz/worth-seeing/top10/adventure-world-poestlingberg):
  pale twin towers and dark caps above a wooded hillside.
- [Hauptplatz](https://www.linztourismus.at/en/leisure/discover-linz/activities/sights/main-square/):
  narrow historic fronts, cornices, uneven roofs and arched ground-floor rhythm.
- [Danube](https://www.linztourismus.at/en/leisure/discover-linz/activities/danube).

## Preview and validation

- `screenshots/linz-full-day.png`: complete riverfront by day.
- `screenshots/linz-full-night.png`: existing night overlay, no new animated lighting.
- `screenshots/linz-fit-day-laptop.png`: normal office framing and scale preserved.

Run `bun test apps/web/test/linzLayout.test.ts apps/web/test/map.test.ts apps/web/test/camera.test.ts`
for layout, bank/tree exclusions, deterministic pixels, seasonal isolation and growing-map coverage.
Use the existing real-server/simulator screenshot harness for visual checks.

Implementation-time tests, lint, typecheck, web build and explicit E2E passed on Bun 1.4.1;
CI uses pinned Bun 1.4.4. Day/night, desktop/tablet/phone and reduced-motion captures were reviewed.
Static wall/road comparison crops showed unchanged initial framing and southern terrain.

A pre-existing browser exception during the live 12→13-person map-growth transition was reproduced
both with and without this feature: the rebuild destroys the graveyard sign before retained
`Graveyard.relayout()` accesses it. This change does not repair that separate ownership defect;
growth screenshots are not evidence of a clean runtime lifecycle. Hardware iPad/GPU, minimap
clicking and occupied east-business scenarios were not independently validated.

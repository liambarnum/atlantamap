# Source exports

Raw data pulled from elsewhere. The app does not read these; it reads
`data/beltline.geojson` and `data/access-points.geojson`, which
`tools/build-data.js` generates from what is here.

## `osm-beltline-trails.geojson`

Overpass export of the BeltLine trails from OpenStreetMap, taken 2026-08-08 with:

```
[out:json][timeout:90];
(
  way["name"~"BeltLine",i]["highway"](33.68,-84.50,33.85,-84.32);
  relation["name"~"BeltLine",i]["route"~"bicycle|foot|hiking"](33.68,-84.50,33.85,-84.32);
);
out geom;
```

310 features: the trail as several hundred short ways, split wherever a tag
changes, plus the `route=bicycle` relation that ties them together.

`tools/osm.js` turns that into the corridor:

- **Ways are matched to a named segment** by a regex over the name. OSM spells
  the brand three ways (`Beltline`, `BeltLine`, `beltline`) and varies the word
  order (`Atlanta Northwest Beltline Trail`), so a literal name list would miss
  things.
- **The route relation is skipped.** It duplicates the ways it is built from,
  and keeping it would draw the whole trail twice.
- **132 access spurs are skipped** — the stairs, ramps and short paths named
  "Beltline Access Line" that join the street network to the trail. They are
  real, but they are not the corridor.
- **Ways are chained back into continuous lines**, first at 12 m to rebuild the
  trail from the pieces OSM split it into, then at 250 m to bridge the gaps it
  leaves at street crossings. Anything wider than that stays a gap, because on
  this trail a wider gap is a real one.
- **Chaining happens within a status, not across it.** Merging a proposed
  stretch into the open trail either side of it would average the two away, and
  which stretch is open is the thing the map is for.

Status comes from the tags: `highway=proposed` is planned, `highway=construction`
is building, an `Interim` name or an unpaved footway is interim, and a paved
cycleway is open.

## Refreshing it

Re-run the query above at [overpass-turbo.eu](https://overpass-turbo.eu), use
**Export → GeoJSON**, save over this file, then:

```sh
node tools/build-data.js
```

The build prints what it produced and flags any access point it had to move a
long way to reach the trail.

## Hand-traced additions (2026-08-10)

Nine ways with `@id` starting `way/hand-traced-` were added by hand rather than
pulled from Overpass: the Northwest/Northeast connection through Bobby Jones
Golf Course, Collier Hills North, Colonial Homes and Brookwood Hills up to
Lindbergh, none of which OSM has mapped yet. Overpass and beltline.org were
both unreachable from the environment that added them, so their geometry is
approximated from a beltline.org/map screenshot and anchored to the real
corridor only at the points where they touch existing OSM ways. Treat their
shape as indicative, not surveyed — replace them the next time this file is
refreshed from Overpass and that stretch has proposed/construction ways of
its own.

## What was here before

An export of relation 13048389 was tried first and discarded. It was
`route=railway, historic=yes` — the historic Belt Line *railway* rather than the
trail — its own `description` tag read `Incomplete!`, and it arrived as 23
disconnected fragments covering 10.7 of 22 miles with nothing north of Ponce.
Query the named trail ways, as above, rather than the railway relation.

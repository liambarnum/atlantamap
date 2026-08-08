#!/usr/bin/env node
/**
 * Tests for js/geo.js — the routing math, which is the part of this app that
 * can be wrong in ways you cannot see by looking at the map.
 *
 * Run: node tests/geo.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// js/geo.js is a browser script that hangs its exports off `window`.
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'geo.js'), 'utf8'), sandbox);
const Geo = sandbox.window.Geo;

let failures = 0;
let checks = 0;

function check(name, condition, detail) {
  checks++;
  if (condition) return;
  failures++;
  console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
}

function near(actual, expected, tolerance, name) {
  check(
    name,
    Math.abs(actual - expected) <= tolerance,
    `expected ${expected} ±${tolerance}, got ${actual}`
  );
}

// --- haversine --------------------------------------------------------------
// Ponce City Market to Krog Street Market is a little over a mile of trail;
// straight line is about 1.92 km.
near(
  Geo.haversine([33.7726, -84.3657], [33.7554, -84.3646]),
  1915,
  60,
  'haversine: PCM to Krog'
);
near(Geo.haversine([33.75, -84.4], [33.75, -84.4]), 0, 0.001, 'haversine: zero distance');
// One degree of latitude is ~111 km anywhere.
near(Geo.haversine([33, -84], [34, -84]), 111000, 500, 'haversine: one degree of latitude');

// --- cumulative -------------------------------------------------------------
{
  const line = [
    [33.75, -84.4],
    [33.76, -84.4],
    [33.77, -84.4],
  ];
  const cum = Geo.cumulative(line);
  check('cumulative: starts at zero', cum[0] === 0);
  check('cumulative: one entry per vertex', cum.length === line.length);
  check('cumulative: increases', cum[1] > 0 && cum[2] > cum[1]);
  near(cum[2], Geo.pathLength(line), 0.001, 'cumulative: total matches pathLength');
}

// --- nearestOnPath ----------------------------------------------------------
{
  // A due-north line at lng -84.4, from lat 33.75 to 33.77.
  const line = [
    [33.75, -84.4],
    [33.77, -84.4],
  ];
  const cum = Geo.cumulative(line);

  const mid = Geo.nearestOnPath([33.76, -84.39], line, cum);
  near(mid.point[0], 33.76, 1e-6, 'nearestOnPath: projects to the same latitude');
  near(mid.point[1], -84.4, 1e-6, 'nearestOnPath: projects onto the line');
  near(mid.offset, Geo.haversine([33.76, -84.39], [33.76, -84.4]), 2, 'nearestOnPath: offset');
  near(mid.along, cum[1] / 2, 5, 'nearestOnPath: halfway along');

  // A point beyond the end clamps to the endpoint rather than extrapolating.
  const past = Geo.nearestOnPath([33.79, -84.4], line, cum);
  near(past.point[0], 33.77, 1e-6, 'nearestOnPath: clamps past the end');
  near(past.along, cum[1], 1, 'nearestOnPath: along clamps to total length');
}

// --- pointAtAlong -----------------------------------------------------------
{
  const line = [
    [33.75, -84.4],
    [33.77, -84.4],
  ];
  const cum = Geo.cumulative(line);
  near(Geo.pointAtAlong(line, cum, 0)[0], 33.75, 1e-9, 'pointAtAlong: start');
  near(Geo.pointAtAlong(line, cum, cum[1])[0], 33.77, 1e-9, 'pointAtAlong: end');
  near(Geo.pointAtAlong(line, cum, cum[1] / 2)[0], 33.76, 1e-4, 'pointAtAlong: midpoint');
  near(Geo.pointAtAlong(line, cum, -500)[0], 33.75, 1e-9, 'pointAtAlong: clamps below zero');
  near(Geo.pointAtAlong(line, cum, cum[1] + 500)[0], 33.77, 1e-9, 'pointAtAlong: clamps past end');
}

// --- slicePath on a closed square ------------------------------------------
{
  // A closed ring: four corners, last vertex repeating the first.
  const ring = [
    [33.75, -84.4],
    [33.77, -84.4],
    [33.77, -84.38],
    [33.75, -84.38],
    [33.75, -84.4],
  ];
  const cum = Geo.cumulative(ring);
  const total = cum[cum.length - 1];

  // A quarter of the way round, forward, is the short way.
  const quarter = Geo.slicePath(ring, cum, 0, cum[1], true);
  near(quarter.distance, cum[1], 1, 'slicePath loop: quarter turn distance');
  check('slicePath loop: quarter turn has no interior vertices', quarter.points.length === 2);
  near(quarter.points[1][0], 33.77, 1e-6, 'slicePath loop: quarter turn endpoint');

  // Three quarters forward is one quarter backward — it must go backward.
  const threeQuarter = Geo.slicePath(ring, cum, 0, cum[3], true);
  near(threeQuarter.distance, total - cum[3], 1, 'slicePath loop: takes the shorter direction');
  near(
    threeQuarter.points[threeQuarter.points.length - 1][1],
    -84.38,
    1e-6,
    'slicePath loop: backward slice ends at the target'
  );

  // Whichever way it goes, the drawn line must be as long as the reported
  // distance — that is what catches a dropped or out-of-order vertex.
  for (const [name, slice] of [
    ['quarter', quarter],
    ['three quarter', threeQuarter],
    ['seam crossing', Geo.slicePath(ring, cum, cum[3] + 50, cum[1] - 50, true)],
    ['near half', Geo.slicePath(ring, cum, 0, total / 2 - 10, true)],
  ]) {
    near(
      Geo.pathLength(slice.points),
      slice.distance,
      2,
      `slicePath loop: drawn length matches reported distance (${name})`
    );
  }

  // Crossing the seam (the point where the ring's coordinate list wraps) is
  // where an off-by-one shows up as a line shooting across the city.
  const seam = Geo.slicePath(ring, cum, total - 100, 100, true);
  near(seam.distance, 200, 1, 'slicePath loop: seam crossing distance');
  check(
    'slicePath loop: seam crossing includes the wrap vertex',
    seam.points.length === 3 && Math.abs(seam.points[1][0] - 33.75) < 1e-9
  );

  // Non-loop mode never wraps, even when wrapping would be shorter.
  const openPath = Geo.slicePath(ring, cum, total - 100, 100, false);
  near(openPath.distance, total - 200, 1, 'slicePath open: does not wrap');
  near(
    Geo.pathLength(openPath.points),
    openPath.distance,
    2,
    'slicePath open: drawn length matches reported distance'
  );

  // Backward on an open path is allowed and reports positive distance.
  const backwards = Geo.slicePath(ring, cum, cum[2], cum[1], false);
  near(backwards.distance, cum[2] - cum[1], 1, 'slicePath open: backward distance is positive');
  near(
    Geo.pathLength(backwards.points),
    backwards.distance,
    2,
    'slicePath open: backward drawn length matches'
  );
}

// --- chainFragments ---------------------------------------------------------
{
  // Three pieces of one north-south line, shuffled and with two reversed.
  const a = [[33.75, -84.4], [33.76, -84.4]];
  const b = [[33.77, -84.4], [33.76, -84.4]]; // reversed
  const c = [[33.78, -84.4], [33.77, -84.4]]; // reversed
  const chained = Geo.chainFragments([b, c, a]);
  check('chainFragments: uses every fragment', chained.dropped.length === 0);
  near(Geo.pathLength(chained.coords), Geo.haversine([33.75, -84.4], [33.78, -84.4]), 2,
    'chainFragments: reassembles the original length');
  const lats = chained.coords.map((p) => p[0]);
  check('chainFragments: comes out monotonic',
    lats.every((v, i) => i === 0 || v >= lats[i - 1]) ||
    lats.every((v, i) => i === 0 || v <= lats[i - 1]),
    lats.join(', '));
  check('chainFragments: touching fragments record no bridge',
    chained.bridges.every((d) => d < 1), chained.bridges.join(', '));
}
{
  // Growing from both ends: the starting fragment sits in the middle, so one
  // piece has to be prepended rather than appended.
  const middle = [[33.76, -84.4], [33.77, -84.4]];
  const before = [[33.75, -84.4], [33.76, -84.4]];
  const after = [[33.77, -84.4], [33.78, -84.4]];
  const chained = Geo.chainFragments([middle, after, before]);
  near(Geo.pathLength(chained.coords), Geo.haversine([33.75, -84.4], [33.78, -84.4]), 2,
    'chainFragments: grows from both ends rather than doubling back');
  check('chainFragments: no long bridges when everything touches',
    Math.max(...chained.bridges) < 1, chained.bridges.join(', '));
}
{
  // A fragment beyond maxBridge is left out rather than reached for.
  const near_ = [[33.75, -84.4], [33.76, -84.4]];
  const far = [[34.20, -84.4], [34.21, -84.4]];
  const chained = Geo.chainFragments([near_, far], { maxBridge: 2500 });
  check('chainFragments: drops an unreachable fragment', chained.dropped.length === 1);
  near(Geo.pathLength(chained.coords), Geo.haversine(near_[0], near_[1]), 1,
    'chainFragments: keeps only what it could reach');
  const greedy = Geo.chainFragments([near_, far]);
  check('chainFragments: without a limit it takes everything', greedy.dropped.length === 0);
}
check('chainFragments: copes with nothing', Geo.chainFragments([]).coords.length === 0);
check('chainFragments: ignores degenerate one-point fragments',
  Geo.chainFragments([[[33.75, -84.4]]]).coords.length === 0);

// --- the real corridor ------------------------------------------------------
{
  const corridor = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'data', 'beltline.geojson'), 'utf8')
  );
  const access = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'data', 'access-points.geojson'), 'utf8')
  );

  const trail = corridor.features.filter((f) => !f.properties.spur);
  const built = trail.reduce((sum, f) => sum + f.properties.lengthMeters, 0);
  near(built / 1609.344, 19.2, 2.5, 'corridor: the built trail is around 19 miles');
  check('corridor: every segment has a known status',
    corridor.features.every((f) =>
      ['open', 'interim', 'construction', 'planned', 'closed'].includes(f.properties.status)),
    corridor.features.map((f) => f.properties.status).join(', '));
  check('corridor: statuses are not all the same',
    new Set(corridor.features.map((f) => f.properties.status)).size > 1);
  check('corridor: every segment came from OSM',
    corridor.features.every((f) => f.properties.source === 'OpenStreetMap'));
  check('corridor: lengths are recorded and positive',
    corridor.features.every((f) => f.properties.lengthMeters > 100));

  const lines = trail.map((f) => f.geometry.coordinates.map(([lng, lat]) => [lat, lng]));
  const chained = Geo.chainFragments(lines, { maxBridge: 2500 });
  const spine = chained.coords;
  const cum = Geo.cumulative(spine);

  check('corridor: the spine picks up nearly every segment',
    chained.dropped.length <= 1, `${chained.dropped.length} dropped`);
  // The spine bridges real gaps, but never by more than the limit.
  check('corridor: no bridge exceeds the limit',
    Math.max(...chained.bridges) <= 2500, `${Math.round(Math.max(...chained.bridges))} m`);

  // Access points are snapped onto the corridor at build time, so any drift
  // here means the geometry and the markers were generated out of step.
  let worst = { offset: -1, name: null };
  for (const feature of access.features) {
    const [lng, lat] = feature.geometry.coordinates;
    const snap = Geo.nearestOnPath([lat, lng], spine, cum);
    if (snap.offset > worst.offset) worst = { offset: snap.offset, name: feature.properties.name };
  }
  check('corridor: every access point sits on the corridor', worst.offset < 60,
    `furthest is "${worst.name}" at ${worst.offset.toFixed(0)} m`);
  check('corridor: every access point records how far it was snapped',
    access.features.every((f) => Number.isFinite(f.properties.snappedMeters)));

  const byName = (name) => {
    const f = access.features.find((x) => x.properties.name === name);
    const [lng, lat] = f.geometry.coordinates;
    return Geo.nearestOnPath([lat, lng], spine, cum);
  };

  // Ponce City Market to Krog Street Market is a bit over a mile of Eastside
  // Trail. Both sit on continuous, built trail, so this is a real check on the
  // geometry rather than on gap-bridging.
  const walk = Geo.slicePath(spine, cum, byName('Ponce City Market').along,
    byName('Krog Street Market').along, false);
  near(walk.distance / 1609.344, 1.25, 0.35,
    'corridor: PCM to Krog matches the published Eastside distance');
  near(Geo.pathLength(walk.points), walk.distance, 5,
    'corridor: PCM to Krog drawn length matches reported');

  // Memorial Drive is south of both, and further from PCM than Krog is.
  const memorial = byName('Memorial Drive').along;
  const pcm = byName('Ponce City Market').along;
  const krog = byName('Krog Street Market').along;
  check('corridor: the Eastside stops fall in geographic order along the spine',
    (pcm < krog && krog < memorial) || (pcm > krog && krog > memorial),
    `PCM ${Math.round(pcm)}, Krog ${Math.round(krog)}, Memorial ${Math.round(memorial)}`);
}

// --- formatting -------------------------------------------------------------
check('formatDistance: short imperial in feet', Geo.formatDistance(100, 'mi').endsWith(' ft'));
check('formatDistance: long imperial in miles', Geo.formatDistance(5000, 'mi') === '3.11 mi');
check('formatDistance: short metric in meters', Geo.formatDistance(400, 'km') === '400 m');
check('formatDistance: long metric in km', Geo.formatDistance(5000, 'km') === '5.00 km');
check('formatDuration: under an hour', Geo.formatDuration(42) === '42 min');
check('formatDuration: over an hour', Geo.formatDuration(125) === '2h 05m', Geo.formatDuration(125));

// --- report -----------------------------------------------------------------
if (failures) {
  console.error(`\n${failures} of ${checks} checks failed.`);
  process.exit(1);
}
console.log(`All ${checks} checks passed.`);

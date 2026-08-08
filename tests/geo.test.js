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

// --- slicePath against the real corridor ------------------------------------
{
  const corridor = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'data', 'beltline.geojson'), 'utf8')
  );
  const spine = [];
  for (const feature of corridor.features) {
    const pts = feature.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    spine.push(...(spine.length ? pts.slice(1) : pts));
  }
  const cum = Geo.cumulative(spine);
  const total = cum[cum.length - 1];

  near(total / 1609.344, 20.4, 1.5, 'corridor: loop is roughly 22 miles');
  check(
    'corridor: ring is closed',
    Geo.haversine(spine[0], spine[spine.length - 1]) < 1,
    `endpoints are ${Geo.haversine(spine[0], spine[spine.length - 1])} m apart`
  );

  const pcm = Geo.nearestOnPath([33.7726, -84.3657], spine, cum);
  const krog = Geo.nearestOnPath([33.7554, -84.3646], spine, cum);
  const lindbergh = Geo.nearestOnPath([33.8215, -84.3672], spine, cum);

  check('corridor: PCM snaps to the trail', pcm.offset < 50, `offset ${pcm.offset} m`);
  check('corridor: Krog snaps to the trail', krog.offset < 50, `offset ${krog.offset} m`);

  const walk = Geo.slicePath(spine, cum, pcm.along, krog.along, true);
  near(walk.distance / 1609.344, 1.2, 0.4, 'corridor: PCM to Krog is about a mile of trail');
  near(
    Geo.pathLength(walk.points),
    walk.distance,
    5,
    'corridor: PCM to Krog drawn length matches reported'
  );

  // Piedmont Park sits between Lindbergh and PCM on the Northeast Trail, so
  // Lindbergh to PCM must run down the northeast side, not round via West End.
  const north = Geo.slicePath(spine, cum, lindbergh.along, pcm.along, true);
  check(
    'corridor: Lindbergh to PCM takes the short way',
    north.distance < total / 2,
    `${(north.distance / 1609.344).toFixed(2)} mi of a ${(total / 1609.344).toFixed(2)} mi loop`
  );
  near(
    Geo.pathLength(north.points),
    north.distance,
    5,
    'corridor: Lindbergh to PCM drawn length matches reported'
  );
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

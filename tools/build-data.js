#!/usr/bin/env node
/**
 * Builds the data the app reads.
 *
 * The corridor comes from an OpenStreetMap export in data/sources/, converted
 * by tools/osm.js into named segments with a status each. The access points are
 * hand-curated here for their names, amenities and descriptions, and then
 * snapped onto the OSM geometry so the markers sit on the trail rather than
 * near it.
 *
 * Run: node tools/build-data.js
 * Emits: data/beltline.geojson, data/access-points.geojson and .js copies of
 * each (the .js copies exist so index.html works when opened straight off
 * disk, where fetch() of a local file is blocked by the browser).
 *
 * Coordinates are written [lat, lng] below because that is how you read them
 * off a map. GeoJSON wants [lng, lat], so the emitter flips them exactly once.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { buildSegments, haversine, lengthMeters } = require('./osm.js');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const SOURCE = path.join(DATA_DIR, 'sources', 'osm-beltline-trails.geojson');

/**
 * Status vocabulary. tools/osm.js derives these from the OSM tags; anything
 * outside this list fails the build.
 */
const STATUSES = ['open', 'interim', 'construction', 'planned', 'closed'];

/** An access point further than this from the trail gets called out for review. */
const SNAP_REVIEW_M = 400;

/**
 * Trailheads and street crossings. `type` drives the marker icon and the
 * filter chips; `amenities` is free-form and only shown in the popup.
 *
 * The coordinates here are approximate by hand; the build snaps each one onto
 * the nearest point of the real corridor and records how far it moved.
 */
const ACCESS_POINTS = [
  // --- Eastside Trail ---
  ['Piedmont Park — Park Tavern', 33.7822, -84.3691, 'eastside', 'park', ['restrooms', 'water', 'bus'], '10th St NE at Monroe Dr. Busiest entrance on the trail.'],
  ['Piedmont Park — North Woods', 33.7845, -84.3699, 'eastside', 'park', ['restrooms', 'water'], 'North end of the park, near the Northeast Trail junction.'],
  ['Monroe Drive at Virginia Ave', 33.7782, -84.3667, 'eastside', 'street', ['bus'], 'Street-level crossing.'],
  ['Amsterdam Walk', 33.7770, -84.3661, 'eastside', 'street', ['food'], 'Access from Amsterdam Ave NE.'],
  ['Ponce City Market', 33.7726, -84.3643, 'eastside', 'trailhead', ['restrooms', 'food', 'water', 'parking', 'bike-share'], 'Ramp and stairs to the Central Food Hall. Paid parking deck.'],
  ['Ponce de Leon Ave', 33.7714, -84.3640, 'eastside', 'street', ['bus'], 'Trail passes under Ponce; access via PCM ramp.'],
  ['North Avenue', 33.7700, -84.3637, 'eastside', 'street', [], 'Stair and ramp access.'],
  ['Historic Fourth Ward Park', 33.7670, -84.3632, 'eastside', 'park', ['restrooms', 'water', 'playground', 'parking'], 'Skate park, splash pad and the retention pond.'],
  ['Freedom Parkway / PATH', 33.7642, -84.3629, 'eastside', 'trailhead', ['bike-share'], 'Connects to the PATH Freedom Park Trail.'],
  ['Irwin Street', 33.7552, -84.3641, 'eastside', 'street', ['food'], 'Inman Park edge, by Krog Street Market.'],
  ['Krog Street Market', 33.7546, -84.3643, 'eastside', 'trailhead', ['restrooms', 'food', 'bike-share'], 'Stairs down to Krog St NE and the tunnel.'],
  ['Wylie Street', 33.7518, -84.3632, 'eastside', 'street', [], 'Reynoldstown.'],
  ['Kirkwood Avenue', 33.7490, -84.3607, 'eastside', 'street', ['food'], 'Reynoldstown.'],
  ['Bill Kennedy Way', 33.7458, -84.3578, 'eastside', 'street', ['parking'], 'Street crossing with on-street parking.'],
  ['Memorial Drive', 33.7434, -84.3556, 'eastside', 'trailhead', ['bus'], 'Eastside/Southside junction.'],

  // --- Southside Trail ---
  ['Glenwood Avenue', 33.7405, -84.3560, 'southside', 'street', ['bus'], 'Street crossing.'],
  ['Glenwood Park', 33.7370, -84.3572, 'southside', 'park', ['food', 'water'], 'Neighborhood green and shops.'],
  ['Ormewood Avenue', 33.7330, -84.3600, 'southside', 'street', [], 'Ormewood Park.'],
  ['Boulevard Crossing Park', 33.7262, -84.3706, 'southside', 'park', ['restrooms', 'parking', 'playground'], 'Parking off Boulevard SE.'],
  ['Boulevard SE', 33.7252, -84.3722, 'southside', 'street', ['bus'], 'Street crossing.'],
  ['Hill Street', 33.7228, -84.3792, 'southside', 'street', [], 'Chosewood edge.'],
  ['Chosewood Park', 33.7212, -84.3845, 'southside', 'park', ['restrooms', 'playground', 'parking'], 'Pool and ball fields.'],
  ['Englewood Avenue', 33.7192, -84.3898, 'southside', 'street', [], 'Street crossing.'],
  ['Pryor Road', 33.7180, -84.3925, 'southside', 'street', ['bus'], 'Street crossing.'],
  ['McDaniel Street', 33.7130, -84.4022, 'southside', 'street', [], 'Pittsburgh.'],
  ['University Ave / Pittsburgh Yards', 33.7115, -84.4060, 'southside', 'trailhead', ['parking', 'food'], 'Southside/Westside junction.'],

  // --- Westside Trail ---
  ['Allene Avenue', 33.7180, -84.4098, 'westside', 'street', [], 'Adair Park.'],
  ['Murphy Avenue / Adair Park', 33.7215, -84.4105, 'westside', 'park', ['playground'], 'Adair Park entrance.'],
  ['White Street', 33.7250, -84.4110, 'westside', 'street', [], 'Street crossing.'],
  ['Lee Street / West End MARTA', 33.7290, -84.4128, 'westside', 'transit', ['rail', 'bus', 'parking', 'bike-share'], 'West End station — Red and Gold lines.'],
  ['Ralph David Abernathy Blvd', 33.7360, -84.4165, 'westside', 'street', ['food', 'bus'], 'West End business district.'],
  ['Lawton Street', 33.7400, -84.4195, 'westside', 'street', [], 'Westview edge.'],
  ['Langhorn Street / Ashview Heights', 33.7440, -84.4225, 'westside', 'street', [], 'Street crossing.'],
  ['Lena Street', 33.7480, -84.4250, 'westside', 'trailhead', [], 'Ashview Heights trailhead.'],
  ['Washington Park', 33.7555, -84.4272, 'westside', 'park', ['restrooms', 'pool', 'parking'], 'Natatorium and tennis center.'],
  ['Rockdale Park / Hollowell Pkwy', 33.7700, -84.4310, 'westside-segment-4', 'street', ['bus'], 'Donald Lee Hollowell Pkwy crossing.'],
  ['Grove Park / Johnson Road', 33.7800, -84.4320, 'westside-segment-4', 'street', [], 'Grove Park.'],
  ['Westside Park at Bellwood Quarry', 33.7875, -84.4300, 'westside-segment-4', 'park', ['restrooms', 'water', 'parking', 'playground'], "Atlanta's largest park; the quarry reservoir overlook."],

  // --- Northwest Trail ---
  ['Marietta Blvd / Chattahoochee Ave', 33.7935, -84.4355, 'northwest', 'street', ['bus'], 'Planned alignment — not yet a built trailhead.'],
  ['Howell Mill Road', 33.8005, -84.4220, 'northwest', 'street', ['food'], 'Planned alignment.'],
  ['Bobby Jones Golf Course', 33.8065, -84.4100, 'northwest', 'park', ['parking'], 'Planned alignment.'],
  ['Tanyard Creek Park', 33.8085, -84.4050, 'northwest', 'park', ['water', 'playground'], 'Connects to the Tanyard Creek PATH trail.'],
  ['Northside Drive', 33.8095, -84.3995, 'northwest', 'street', ['bus'], 'Planned crossing.'],
  ['Ardmore Park', 33.8080, -84.3950, 'northwest', 'park', ['playground'], 'Planned alignment.'],
  ['Peachtree Road / Brookwood', 33.8095, -84.3900, 'northwest', 'street', ['bus', 'food'], 'Planned crossing.'],

  // --- Northeast Trail ---
  ['Armour Yards', 33.8150, -84.3740, 'northeast', 'trailhead', ['food', 'parking'], 'Armour Drive industrial district.'],
  ['Lindbergh Center MARTA', 33.8215, -84.3672, 'northeast', 'transit', ['rail', 'bus', 'parking'], 'Lindbergh Center station — northern top of the loop.'],
  ['Piedmont Road', 33.8170, -84.3625, 'northeast', 'street', ['bus', 'food'], 'Piedmont Heights.'],
  ['Montgomery Ferry Drive', 33.8050, -84.3655, 'northeast', 'street', [], 'Piedmont Heights.'],
  ['Ansley Mall', 33.7940, -84.3695, 'northeast', 'trailhead', ['food', 'parking', 'restrooms'], 'Shopping center parking and food.'],
  ['Monroe Drive / Ansley', 33.7905, -84.3700, 'northeast', 'street', ['bus'], 'Street crossing.'],
];


// --- geometry helpers -------------------------------------------------------

/** Nearest point on a polyline to `pt`, in metres. Flat-earth is fine at city scale. */
function nearestOnPath(pt, coords) {
  const mPerDegLat = 110574;
  const mPerDegLng = 111320 * Math.cos((pt[0] * Math.PI) / 180);
  const to = ([lat, lng]) => [lng * mPerDegLng, lat * mPerDegLat];
  const from = ([x, y]) => [y / mPerDegLat, x / mPerDegLng];
  const p = to(pt);
  let best = null;

  for (let i = 1; i < coords.length; i++) {
    const a = to(coords[i - 1]);
    const b = to(coords[i]);
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const lenSq = abx * abx + aby * aby;
    let t = lenSq === 0 ? 0 : ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const cx = a[0] + t * abx;
    const cy = a[1] + t * aby;
    const dSq = (p[0] - cx) ** 2 + (p[1] - cy) ** 2;
    if (!best || dSq < best.dSq) best = { dSq, point: from([cx, cy]) };
  }

  return best ? { point: best.point, offset: Math.sqrt(best.dSq) } : null;
}

/** Snap a point onto whichever segment passes closest to it. */
function snapToCorridor(pt, segments) {
  let best = null;
  for (const segment of segments) {
    const hit = nearestOnPath(pt, segment.coords);
    if (hit && (!best || hit.offset < best.offset)) {
      best = { ...hit, segment: segment.id, segmentName: segment.name };
    }
  }
  return best;
}

// --- emitters ---------------------------------------------------------------

function corridorGeoJSON(segments) {
  return {
    type: 'FeatureCollection',
    name: 'Atlanta BeltLine corridor',
    metadata: {
      description:
        'The Atlanta BeltLine trails, split by named segment and build status.',
      source:
        'OpenStreetMap, via an Overpass export in data/sources/osm-beltline-trails.geojson. ' +
        'Map data (c) OpenStreetMap contributors, ODbL.',
      note:
        'Gaps between segments are real: the loop is not continuous yet. Segments are not ' +
        'bridged across anything wider than a street crossing.',
      generatedBy: 'tools/build-data.js',
    },
    features: segments.map((seg) => ({
      type: 'Feature',
      id: seg.id,
      properties: {
        id: seg.id,
        name: seg.name,
        status: seg.status,
        note: seg.note || '',
        source: seg.source,
        spur: Boolean(seg.spur),
        lengthMeters: seg.lengthMeters,
      },
      geometry: {
        type: 'LineString',
        coordinates: seg.coords.map(([lat, lng]) => [Number(lng.toFixed(6)), Number(lat.toFixed(6))]),
      },
    })),
  };
}

function accessGeoJSON(points, segments) {
  const review = [];

  const features = points.map(([name, lat, lng, segment, type, amenities, description], i) => {
    const snap = snapToCorridor([lat, lng], segments);
    const moved = snap ? snap.offset : 0;
    if (moved > SNAP_REVIEW_M) review.push({ name, moved, landedOn: snap.segmentName });

    const position = snap ? snap.point : [lat, lng];
    return {
      type: 'Feature',
      id: `ap-${String(i + 1).padStart(3, '0')}`,
      properties: {
        id: `ap-${String(i + 1).padStart(3, '0')}`,
        name,
        // The segment the point actually landed on, which is not always the
        // one the hand-written table guessed.
        segment: snap ? snap.segment : segment,
        type,
        amenities,
        description,
        snappedMeters: Math.round(moved),
      },
      geometry: {
        type: 'Point',
        coordinates: [Number(position[1].toFixed(6)), Number(position[0].toFixed(6))],
      },
    };
  });

  return {
    collection: {
      type: 'FeatureCollection',
      name: 'Atlanta BeltLine access points',
      metadata: {
        description: 'Trailheads, park entrances, transit connections and street crossings.',
        note:
          'Names and amenities are hand-curated. Positions are snapped onto the OpenStreetMap ' +
          'corridor; snappedMeters records how far each moved, and a large value means the ' +
          'hand-written starting guess was poor and the result is worth checking.',
        generatedBy: 'tools/build-data.js',
      },
      features,
    },
    review,
  };
}

function writeJSONPair(basename, globalName, obj) {
  const json = JSON.stringify(obj, null, 2);
  fs.writeFileSync(path.join(DATA_DIR, `${basename}.geojson`), `${json}\n`);
  // The .js twin lets index.html work from file:// where fetch() is blocked.
  fs.writeFileSync(
    path.join(DATA_DIR, `${basename}.js`),
    `/* Generated by tools/build-data.js - do not edit. */\n` +
      `window.${globalName} = ${json};\n`
  );
}

function main() {
  if (!fs.existsSync(SOURCE)) {
    throw new Error(`missing ${path.relative(ROOT, SOURCE)}; see data/sources/README.md`);
  }

  const { segments, skipped } = buildSegments(JSON.parse(fs.readFileSync(SOURCE, 'utf8')), {
    minLength: 150,
  });
  if (!segments.length) throw new Error('the OSM export produced no segments');

  for (const seg of segments) {
    if (!STATUSES.includes(seg.status)) {
      throw new Error(
        `segment "${seg.id}" has status "${seg.status}"; expected one of ${STATUSES.join(', ')}`
      );
    }
  }

  const corridor = corridorGeoJSON(segments);
  const { collection: access, review } = accessGeoJSON(ACCESS_POINTS, segments);

  writeJSONPair('beltline', 'BELTLINE_CORRIDOR', corridor);
  writeJSONPair('access-points', 'BELTLINE_ACCESS_POINTS', access);

  const miles = (m) => (m / 1609.344).toFixed(2);
  const total = segments.reduce((sum, seg) => sum + seg.lengthMeters, 0);

  console.log('Wrote data/beltline.{geojson,js} and data/access-points.{geojson,js}\n');
  for (const seg of segments) {
    console.log(
      `  ${seg.name.padEnd(26)} ${miles(seg.lengthMeters).padStart(6)} mi  ${seg.status}`
    );
  }
  console.log(`  ${'TOTAL'.padEnd(26)} ${miles(total).padStart(6)} mi across ${segments.length} segments`);
  console.log(`  ${'access points'.padEnd(26)} ${String(ACCESS_POINTS.length).padStart(6)}`);
  console.log(`  ${'access spurs skipped'.padEnd(26)} ${String(skipped.spurs).padStart(6)}`);

  if (review.length) {
    console.log(`\n  ${review.length} access points moved more than ${SNAP_REVIEW_M} m onto the trail.`);
    console.log('  Their names are right; the hand-written coordinates were not. Worth checking:');
    for (const item of review.sort((a, b) => b.moved - a.moved)) {
      console.log(`    ${String(Math.round(item.moved)).padStart(5)} m  ${item.name.padEnd(36)} -> ${item.landedOn}`);
    }
  }
}

main();

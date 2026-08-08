#!/usr/bin/env node
/**
 * Source of truth for the map's bundled data.
 *
 * Coordinates below are written [lat, lng] because that is how you read them
 * off a map. GeoJSON wants [lng, lat], so the emitter flips them exactly once,
 * here, instead of scattering the chance of a transposed pair across the app.
 *
 * Run: node tools/build-data.js
 * Emits: data/beltline.geojson, data/access-points.geojson and .js copies of
 * each (the .js copies exist so index.html works when opened straight off
 * disk, where fetch() of a local file is blocked by the browser).
 *
 * ---------------------------------------------------------------------------
 * ACCURACY: the corridor geometry is hand-traced from known Atlanta geography,
 * not surveyed data. It is good enough to see the loop and plan along it, and
 * it is wrong by up to a block or so in places. See README for how to replace
 * it with the official alignment.
 * ---------------------------------------------------------------------------
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

/**
 * Status vocabulary. Segments are all drawn the same way on the map — status
 * is information, not styling — so these strings are what the legend badge and
 * the status filter read from. Anything not in this list fails the build.
 */
const STATUSES = ['open', 'interim', 'construction', 'planned', 'closed'];

/**
 * The loop, split into the segments the BeltLine is actually named and built
 * in. Each segment starts on the previous segment's last coordinate so the
 * whole thing concatenates into one closed ring; buildSpine() asserts this.
 */
const SEGMENTS = [
  {
    id: 'eastside',
    name: 'Eastside Trail',
    status: 'open',
    note: 'Piedmont Park to Memorial Drive, through Ponce City Market and Krog Street Market.',
    // Re-anchored on landmarks: the trail runs along the EAST side of Ponce
    // City Market and forms the east edge of Historic Fourth Ward Park, and
    // Krog Street Market sits at Irwin Street rather than well north of it.
    coords: [
      [33.7845, -84.3699],
      [33.7832, -84.3695],
      [33.7822, -84.3691],
      [33.7808, -84.3683],
      [33.7795, -84.3675],
      [33.7782, -84.3667],
      [33.7770, -84.3661],
      [33.7757, -84.3655],
      [33.7742, -84.3648],
      [33.7734, -84.3645],
      [33.7726, -84.3643],
      [33.7719, -84.3641],
      [33.7714, -84.3640],
      [33.7707, -84.3638],
      [33.7700, -84.3637],
      [33.7692, -84.3635],
      [33.7683, -84.3633],
      [33.7670, -84.3632],
      [33.7663, -84.3631],
      [33.7656, -84.3630],
      [33.7649, -84.3629],
      [33.7642, -84.3629],
      [33.7633, -84.3628],
      [33.7625, -84.3628],
      [33.7616, -84.3629],
      [33.7608, -84.3629],
      [33.7600, -84.3631],
      [33.7592, -84.3632],
      [33.7584, -84.3634],
      [33.7576, -84.3635],
      [33.7568, -84.3637],
      [33.7560, -84.3639],
      [33.7552, -84.3641],
      [33.7546, -84.3643],
      [33.7539, -84.3642],
      [33.7532, -84.3641],
      [33.7525, -84.3637],
      [33.7518, -84.3632],
      [33.7511, -84.3626],
      [33.7504, -84.3620],
      [33.7497, -84.3613],
      [33.7490, -84.3607],
      [33.7482, -84.3599],
      [33.7474, -84.3592],
      [33.7466, -84.3585],
      [33.7458, -84.3578],
      [33.7451, -84.3572],
      [33.7445, -84.3566],
      [33.7434, -84.3556],
    ],
  },
  {
    id: 'southside',
    name: 'Southside Trail',
    status: 'construction',
    note: 'Memorial Drive to University Avenue. Paved conversion is phased; interim surface in places.',
    coords: [
      [33.7434, -84.3556],
      [33.7422, -84.3557],
      [33.7405, -84.3560],
      [33.7388, -84.3566],
      [33.7370, -84.3572],
      [33.7352, -84.3582],
      [33.7330, -84.3600],
      [33.7315, -84.3620],
      [33.7300, -84.3642],
      [33.7285, -84.3668],
      [33.7272, -84.3690],
      [33.7262, -84.3706],
      [33.7252, -84.3722],
      [33.7244, -84.3745],
      [33.7236, -84.3768],
      [33.7228, -84.3792],
      [33.7220, -84.3818],
      [33.7212, -84.3845],
      [33.7202, -84.3872],
      [33.7192, -84.3898],
      [33.7180, -84.3925],
      [33.7168, -84.3950],
      [33.7155, -84.3975],
      [33.7142, -84.4000],
      [33.7130, -84.4022],
      [33.7122, -84.4042],
      [33.7115, -84.4060],
    ],
  },
  {
    id: 'westside',
    name: 'Westside Trail',
    status: 'open',
    note: 'University Avenue to Washington Park, through Adair Park, Pittsburgh and West End.',
    coords: [
      [33.7115, -84.4060],
      [33.7128, -84.4070],
      [33.7145, -84.4080],
      [33.7162, -84.4090],
      [33.7180, -84.4098],
      [33.7198, -84.4102],
      [33.7215, -84.4105],
      [33.7232, -84.4108],
      [33.7250, -84.4110],
      [33.7268, -84.4118],
      [33.7290, -84.4128],
      [33.7308, -84.4138],
      [33.7325, -84.4148],
      [33.7342, -84.4157],
      [33.7360, -84.4165],
      [33.7378, -84.4178],
      [33.7400, -84.4195],
      [33.7420, -84.4210],
      [33.7440, -84.4225],
      [33.7460, -84.4238],
      [33.7480, -84.4250],
      [33.7500, -84.4258],
      [33.7520, -84.4265],
      [33.7538, -84.4269],
      [33.7555, -84.4272],
    ],
  },
  {
    id: 'westside-segment-4',
    name: 'Westside Trail — Segment 4',
    status: 'open',
    note: 'Washington Park north to Westside Park at Bellwood Quarry.',
    coords: [
      [33.7555, -84.4272],
      [33.7575, -84.4278],
      [33.7600, -84.4285],
      [33.7625, -84.4292],
      [33.7650, -84.4300],
      [33.7675, -84.4305],
      [33.7700, -84.4310],
      [33.7725, -84.4313],
      [33.7750, -84.4315],
      [33.7775, -84.4318],
      [33.7800, -84.4320],
      [33.7822, -84.4320],
      [33.7845, -84.4318],
      [33.7862, -84.4310],
      [33.7875, -84.4300],
    ],
  },
  {
    id: 'northwest',
    name: 'Northwest Trail',
    status: 'planned',
    note: 'Westside Park to Peachtree Creek, via Chattahoochee Avenue, Bobby Jones and Tanyard Creek.',
    coords: [
      [33.7875, -84.4300],
      [33.7890, -84.4320],
      [33.7905, -84.4340],
      [33.7922, -84.4352],
      [33.7935, -84.4355],
      [33.7950, -84.4345],
      [33.7962, -84.4328],
      [33.7975, -84.4305],
      [33.7986, -84.4280],
      [33.7996, -84.4252],
      [33.8005, -84.4220],
      [33.8016, -84.4195],
      [33.8028, -84.4172],
      [33.8040, -84.4150],
      [33.8052, -84.4126],
      [33.8065, -84.4100],
      [33.8076, -84.4076],
      [33.8085, -84.4050],
      [33.8092, -84.4024],
      [33.8095, -84.3995],
      [33.8090, -84.3972],
      [33.8080, -84.3950],
      [33.8085, -84.3925],
      [33.8095, -84.3900],
      [33.8105, -84.3872],
      [33.8118, -84.3845],
      [33.8130, -84.3818],
      [33.8140, -84.3790],
    ],
  },
  {
    id: 'northeast',
    name: 'Northeast Trail',
    status: 'construction',
    note: 'Armour Yards and Lindbergh south through Piedmont Heights and Ansley back to Piedmont Park.',
    coords: [
      [33.8140, -84.3790],
      [33.8146, -84.3765],
      [33.8150, -84.3740],
      [33.8158, -84.3718],
      [33.8168, -84.3700],
      [33.8180, -84.3686],
      [33.8195, -84.3678],
      [33.8215, -84.3672],
      [33.8212, -84.3655],
      [33.8202, -84.3640],
      [33.8188, -84.3630],
      [33.8170, -84.3625],
      [33.8152, -84.3626],
      [33.8135, -84.3632],
      [33.8118, -84.3640],
      [33.8100, -84.3646],
      [33.8082, -84.3650],
      [33.8065, -84.3652],
      [33.8050, -84.3655],
      [33.8032, -84.3660],
      [33.8012, -84.3665],
      [33.7995, -84.3672],
      [33.7975, -84.3680],
      [33.7958, -84.3688],
      [33.7940, -84.3695],
      [33.7922, -84.3698],
      [33.7905, -84.3700],
      [33.7888, -84.3701],
      [33.7870, -84.3701],
      [33.7857, -84.3700],
      [33.7845, -84.3699],
    ],
  },
];

/**
 * Trailheads and street crossings. `type` drives the marker icon and the
 * filter chips; `amenities` is free-form and only shown in the popup.
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

const R_EARTH_M = 6371008.8;

function haversine([lat1, lon1], [lat2, lon2]) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.sqrt(a));
}

function lengthMeters(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += haversine(coords[i - 1], coords[i]);
  return total;
}

const same = (a, b) => a[0] === b[0] && a[1] === b[1];

/**
 * Concatenate the segments into one closed ring, dropping the duplicated
 * shared endpoint between each pair. Throws if the segments don't actually
 * meet — a silent gap here would quietly break follow-the-corridor routing.
 */
function buildSpine(segments) {
  const spine = [...segments[0].coords];
  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1];
    const cur = segments[i];
    if (!same(prev.coords[prev.coords.length - 1], cur.coords[0])) {
      throw new Error(`segment "${cur.id}" does not start where "${prev.id}" ends`);
    }
    spine.push(...cur.coords.slice(1));
  }
  const last = segments[segments.length - 1].coords.slice(-1)[0];
  if (!same(last, segments[0].coords[0])) {
    throw new Error('the loop does not close: last segment must end at the first segment start');
  }
  return spine;
}

// --- emitters ---------------------------------------------------------------

function assertStatuses(segments) {
  for (const seg of segments) {
    if (!STATUSES.includes(seg.status)) {
      throw new Error(
        `segment "${seg.id}" has status "${seg.status}"; expected one of ${STATUSES.join(', ')}`
      );
    }
  }
}

function corridorGeoJSON(segments) {
  return {
    type: 'FeatureCollection',
    name: 'Atlanta BeltLine corridor',
    metadata: {
      description:
        'Approximate centerline of the 22-mile Atlanta BeltLine loop, split by named trail segment.',
      accuracy:
        'Hand-traced from known geography, not survey data. Replace with the official alignment for anything that matters.',
      generatedBy: 'tools/build-data.js',
    },
    features: segments.map((seg) => ({
      type: 'Feature',
      id: seg.id,
      properties: {
        id: seg.id,
        name: seg.name,
        status: seg.status,
        note: seg.note,
        lengthMeters: Math.round(lengthMeters(seg.coords)),
      },
      geometry: {
        type: 'LineString',
        coordinates: seg.coords.map(([lat, lng]) => [lng, lat]),
      },
    })),
  };
}

function accessGeoJSON(points) {
  return {
    type: 'FeatureCollection',
    name: 'Atlanta BeltLine access points',
    metadata: {
      description: 'Trailheads, park entrances, transit connections and street crossings.',
      accuracy: 'Approximate positions, snapped by eye to the corridor.',
      generatedBy: 'tools/build-data.js',
    },
    features: points.map(([name, lat, lng, segment, type, amenities, description], i) => ({
      type: 'Feature',
      id: `ap-${String(i + 1).padStart(3, '0')}`,
      properties: {
        id: `ap-${String(i + 1).padStart(3, '0')}`,
        name,
        segment,
        type,
        amenities,
        description,
      },
      geometry: { type: 'Point', coordinates: [lng, lat] },
    })),
  };
}

function writeJSONPair(basename, globalName, obj) {
  const json = JSON.stringify(obj, null, 2);
  fs.writeFileSync(path.join(DATA_DIR, `${basename}.geojson`), `${json}\n`);
  // The .js twin lets index.html work from file:// where fetch() is blocked.
  fs.writeFileSync(
    path.join(DATA_DIR, `${basename}.js`),
    `/* Generated by tools/build-data.js — do not edit. */\n` +
      `window.${globalName} = ${json};\n`
  );
}

function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  assertStatuses(SEGMENTS);
  const spine = buildSpine(SEGMENTS);
  const corridor = corridorGeoJSON(SEGMENTS);
  const access = accessGeoJSON(ACCESS_POINTS);

  writeJSONPair('beltline', 'BELTLINE_CORRIDOR', corridor);
  writeJSONPair('access-points', 'BELTLINE_ACCESS_POINTS', access);

  const miles = (m) => (m / 1609.344).toFixed(2);
  console.log('Wrote data/beltline.{geojson,js} and data/access-points.{geojson,js}\n');
  for (const seg of SEGMENTS) {
    console.log(`  ${seg.name.padEnd(28)} ${miles(lengthMeters(seg.coords)).padStart(6)} mi  (${seg.status})`);
  }
  console.log(`  ${'TOTAL LOOP'.padEnd(28)} ${miles(lengthMeters(spine)).padStart(6)} mi`);
  console.log(`  ${'access points'.padEnd(28)} ${String(ACCESS_POINTS.length).padStart(6)}`);
}

main();

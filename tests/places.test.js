#!/usr/bin/env node
/**
 * Tests for js/places.js — the grouping, the half-mile filter and the
 * favourite ordering. No browser and no network: the resolver is left alone
 * and everything above it takes its inputs as arguments.
 *
 * Run: node tests/places.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = { window: {}, localStorage: undefined, console };
vm.createContext(sandbox);
for (const file of ['geo.js', 'places.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8'), sandbox);
}
const { Geo, Places } = sandbox.window;

let failures = 0;
let checks = 0;

function check(name, condition, detail) {
  checks++;
  if (condition) return;
  failures++;
  console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
}

// A straight north-south "trail" at lng -84.40, plus a second one well east.
const withCum = (name, coords) => ({ name, coords, cum: Geo.cumulative(coords) });
const segments = [
  withCum('Westside Trail (part 1)', [[33.74, -84.40], [33.78, -84.40]]),
  withCum('Eastside Trail', [[33.74, -84.36], [33.78, -84.36]]),
];

// A degree of longitude here is about 92.5 km, so 0.005 deg is roughly 460 m
// and 0.02 deg is roughly 1.85 km.
const near = (lng) => -84.40 + lng;

// --- regionName -------------------------------------------------------------
check('regionName: strips a part number',
  Places.regionName('Northeast Trail (part 2)') === 'Northeast Trail');
check('regionName: leaves a plain name alone',
  Places.regionName('Eastside Trail') === 'Eastside Trail');
check('regionName: copes with nothing', Places.regionName(undefined) === '');

// --- nearestRegion ----------------------------------------------------------
{
  const hit = Places.nearestRegion([33.76, near(0.001)], segments);
  check('nearestRegion: picks the closer trail', hit.region === 'Westside Trail', hit.region);
  check('nearestRegion: drops the part number', !/part/.test(hit.region), hit.region);
  check('nearestRegion: reports a sane distance', hit.distance > 50 && hit.distance < 150,
    `${hit.distance.toFixed(0)} m`);

  const east = Places.nearestRegion([33.76, -84.3605], segments);
  check('nearestRegion: picks the other trail when nearer', east.region === 'Eastside Trail',
    east.region);
}

// --- locate: the half-mile filter -------------------------------------------
{
  const places = [
    { id: 'a', name: 'On the trail', vibe: 'bar', lat: 33.76, lng: -84.40 },
    { id: 'b', name: 'A block away', vibe: 'bar', lat: 33.76, lng: near(0.005) },
    { id: 'c', name: 'Over a mile away', vibe: 'bar', lat: 33.76, lng: near(0.02) },
    { id: 'd', name: 'No coordinates yet', vibe: 'bar' },
  ];
  const { near: kept, far } = Places.locate(places, segments);

  check('locate: keeps what is on the trail', kept.some((p) => p.id === 'a'));
  check('locate: keeps what is within half a mile', kept.some((p) => p.id === 'b'));
  check('locate: drops what is beyond half a mile', far.some((p) => p.id === 'c'));
  check('locate: skips unresolved places entirely',
    !kept.some((p) => p.id === 'd') && !far.some((p) => p.id === 'd'));
  check('locate: attaches a region', kept.every((p) => p.region === 'Westside Trail'));
  check('locate: attaches a distance', kept.every((p) => Number.isFinite(p.distance)));

  // The cutoff really is half a mile.
  check('locate: half a mile is 804.672 m', Math.abs(Places.MAX_DISTANCE_M - 804.672) < 0.001);
  const justInside = Places.locate(
    [{ id: 'x', name: 'x', vibe: 'bar', lat: 33.76, lng: -84.40 }], segments, 1);
  check('locate: honours a custom limit', justInside.near.length === 1);
  const justOutside = Places.locate(
    [{ id: 'x', name: 'x', vibe: 'bar', lat: 33.76, lng: near(0.005) }], segments, 100);
  check('locate: a tighter limit excludes more', justOutside.near.length === 0);
}

// --- group ------------------------------------------------------------------
const sample = [
  { id: 'r1', name: 'Bravo Diner', vibe: 'restaurant', lat: 33.76, lng: near(0.004) },
  { id: 'r2', name: 'Alpha Diner', vibe: 'restaurant', lat: 33.76, lng: near(0.005) },
  { id: 'b1', name: 'Some Bar', vibe: 'bar', lat: 33.762, lng: near(0.001) },
  { id: 'b2', name: 'Другой Bar', vibe: 'bar', lat: 33.763, lng: near(0.002) },
  { id: 'e1', name: 'East Cafe', vibe: 'coffee', lat: 33.77, lng: -84.3601 },
];

{
  const located = Places.locate(sample, segments).near;
  const grouped = Places.group(located, {});

  check('group: splits by region', grouped.length === 2, `${grouped.length} regions`);
  const west = grouped.find((g) => g.region === 'Westside Trail');
  const east = grouped.find((g) => g.region === 'Eastside Trail');
  check('group: the busier region comes first', grouped[0].region === 'Westside Trail',
    grouped[0].region);
  check('group: counts per region', west.count === 4 && east.count === 1,
    `west ${west.count}, east ${east.count}`);

  check('group: splits by vibe within a region', west.vibes.length === 2,
    west.vibes.map((v) => v.vibe).join(', '));
  check('group: vibes come out in the declared order',
    west.vibes[0].vibe === 'restaurant' && west.vibes[1].vibe === 'bar',
    west.vibes.map((v) => v.vibe).join(', '));
  check('group: vibes are labelled', west.vibes[0].label === 'Restaurants', west.vibes[0].label);

  // Within a vibe, nearest the trail wins when nothing is favourited.
  const bars = west.vibes.find((v) => v.vibe === 'bar').places;
  check('group: nearest the trail sorts first', bars[0].id === 'b1', bars.map((p) => p.id).join(', '));
}

// --- favourites -------------------------------------------------------------
{
  const located = Places.locate(sample, segments).near;

  const plain = Places.group(located, {});
  const plainRestaurants = plain
    .find((g) => g.region === 'Westside Trail')
    .vibes.find((v) => v.vibe === 'restaurant').places;
  check('favourites: without one, distance decides',
    plainRestaurants[0].id === 'r1', plainRestaurants.map((p) => p.id).join(', '));

  const favoured = Places.group(located, { favorites: ['r2'] });
  const west = favoured.find((g) => g.region === 'Westside Trail');
  const restaurants = west.vibes.find((v) => v.vibe === 'restaurant').places;
  check('favourites: a favourite goes to the top of its category',
    restaurants[0].id === 'r2', restaurants.map((p) => p.id).join(', '));
  check('favourites: it is marked as one', restaurants[0].favorite === true);
  check('favourites: the others are not', restaurants[1].favorite === false);
  check('favourites: nothing is lost', restaurants.length === 2);

  // The point of per-category: favouriting a restaurant must not disturb bars,
  // nor promote the restaurant above them.
  check('favourites: other categories keep their order',
    west.vibes.find((v) => v.vibe === 'bar').places[0].id === 'b1');
  check('favourites: a favourite does not jump category',
    west.vibes[0].vibe === 'restaurant' && west.vibes[1].vibe === 'bar',
    west.vibes.map((v) => v.vibe).join(', '));

  // A favourite in another region stays in that region.
  const crossRegion = Places.group(located, { favorites: ['e1'] });
  check('favourites: a favourite stays in its own region',
    crossRegion.find((g) => g.region === 'Eastside Trail').vibes[0].places[0].id === 'e1');
  check('favourites: favouriting does not reorder regions',
    crossRegion[0].region === 'Westside Trail', crossRegion[0].region);
}

// --- vibe filter ------------------------------------------------------------
{
  const located = Places.locate(sample, segments).near;
  const barsOnly = Places.group(located, { vibeFilter: ['bar'] });
  check('vibe filter: keeps only the chosen vibes',
    barsOnly.every((g) => g.vibes.every((v) => v.vibe === 'bar')));
  check('vibe filter: drops regions that empty out', barsOnly.length === 1, `${barsOnly.length}`);
  check('vibe filter: an empty filter set hides everything',
    Places.group(located, { vibeFilter: [] }).length === 0);
}

// --- the vibe vocabulary ----------------------------------------------------
check('vibes: food vibes are all declared vibes',
  [...Places.FOOD_VIBES].every((v) => Places.VIBES.some((x) => x.id === v)),
  [...Places.FOOD_VIBES].join(', '));
check('vibes: every vibe has a label and a marker colour',
  Places.VIBES.every((v) => v.label && /^#[0-9a-f]{6}$/i.test(v.marker)));
check('vibes: an unknown vibe still gets something to show',
  Places.vibeMeta('nonsense').label === 'Other');

// --- the shipped dataset ----------------------------------------------------
{
  const data = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'data', 'places.json'), 'utf8')
  );
  const ids = data.places.map((p) => p.id);
  check('dataset: has places', data.places.length > 0);
  check('dataset: ids are unique', new Set(ids).size === ids.length);
  check('dataset: every place has a name', data.places.every((p) => p.name && p.name.trim()));
  check('dataset: every vibe is a known one',
    data.places.every((p) => Places.VIBES.some((v) => v.id === p.vibe)),
    data.places.filter((p) => !Places.VIBES.some((v) => v.id === p.vibe))
      .map((p) => `${p.name}=${p.vibe}`).join(', '));
  check('dataset: ids look like slugs', data.places.every((p) => /^[a-z0-9-]+$/.test(p.id)),
    data.places.filter((p) => !/^[a-z0-9-]+$/.test(p.id)).map((p) => p.id).join(', '));
}

if (failures) {
  console.error(`\n${failures} of ${checks} checks failed.`);
  process.exit(1);
}
console.log(`All ${checks} checks passed.`);

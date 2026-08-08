#!/usr/bin/env node
/**
 * Tests for the Atlanta restriction in js/geocode.js.
 *
 * A bounding box around Atlanta also contains Decatur, East Point and a slice
 * of Marietta, so the ZIP check is what actually keeps results in the city.
 * These tests pin that behaviour down without touching the network.
 *
 * Run: node tests/geocode.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = { window: {}, fetch: () => Promise.reject(new Error('no network in tests')) };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'geocode.js'), 'utf8'), sandbox);
const Geocode = sandbox.window.Geocode;

let failures = 0;
let checks = 0;

function check(name, condition, detail) {
  checks++;
  if (condition) return;
  failures++;
  console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
}

// --- extractZip -------------------------------------------------------------
check('extractZip: finds a plain ZIP', Geocode.extractZip('Atlanta, Georgia, 30312') === '30312');
check('extractZip: finds a ZIP+4 base', Geocode.extractZip('Atlanta, GA 30312-1234') === '30312');
check('extractZip: ignores a house number', Geocode.extractZip('675 Ponce De Leon Ave') === null);
check('extractZip: ignores nothing at all', Geocode.extractZip('') === null);
check('extractZip: ignores a six digit run', Geocode.extractZip('building 303120') === null);

// --- withinAtlanta ----------------------------------------------------------
const at = (postcode, lat, lng, address) => ({
  postcode,
  lat: lat === undefined ? 33.77 : lat,
  lng: lng === undefined ? -84.36 : lng,
  address: address || '',
  name: '',
});

check('withinAtlanta: keeps an in-town ZIP', Geocode.withinAtlanta(at('30312')));
check('withinAtlanta: keeps a Buckhead ZIP', Geocode.withinAtlanta(at('30305')));
check('withinAtlanta: keeps a westside ZIP', Geocode.withinAtlanta(at('30318')));

// The point of the exercise: these all sit inside any sane Atlanta bounding
// box, and none of them is an Atlanta address. A box alone would let them in.
check('withinAtlanta: rejects Decatur (30030)', !Geocode.withinAtlanta(at('30030', 33.7748, -84.2963)));
check('withinAtlanta: rejects Marietta (30060)', !Geocode.withinAtlanta(at('30060', 33.9526, -84.5499)));
check('withinAtlanta: rejects Smyrna (30080)', !Geocode.withinAtlanta(at('30080', 33.8709, -84.5144)));
check('withinAtlanta: rejects Tucker (30084)', !Geocode.withinAtlanta(at('30084', 33.8545, -84.2171)));
check('withinAtlanta: rejects College Park proper (30337)',
  !Geocode.withinAtlanta(at('30337', 33.6534, -84.4494)));
check('withinAtlanta: rejects a far-away ZIP', !Geocode.withinAtlanta(at('90210', 34.09, -118.4)));

// Deliberately kept: ZIPs outside the city limits whose USPS city name is
// still "Atlanta", which is what a resident typing an address will expect.
check('withinAtlanta: keeps Sandy Springs, an Atlanta mailing address (30328)',
  Geocode.withinAtlanta(at('30328', 33.9304, -84.3733)));
check('withinAtlanta: keeps Vinings (30339)', Geocode.withinAtlanta(at('30339', 33.8712, -84.4652)));

// A ZIP in the free-text address counts, even when the field is missing.
check(
  'withinAtlanta: reads a ZIP out of the address text',
  Geocode.withinAtlanta(at(null, 33.77, -84.36, 'Ponce De Leon Ave NE, Atlanta, GA 30308'))
);
check(
  'withinAtlanta: rejects on a ZIP found in the address text',
  !Geocode.withinAtlanta(at(null, 33.7748, -84.2963, 'Church St, Decatur, GA 30030'))
);

// No ZIP anywhere falls back to the box — parks and intersections often have none.
check('withinAtlanta: no ZIP but inside the box is kept', Geocode.withinAtlanta(at(null, 33.77, -84.36)));
check('withinAtlanta: no ZIP and outside the box is dropped', !Geocode.withinAtlanta(at(null, 40.7, -74.0)));
check(
  'withinAtlanta: no ZIP, just outside the box, is dropped',
  !Geocode.withinAtlanta(at(null, 34.2, -84.36))
);

// --- rankForAtlanta ---------------------------------------------------------
{
  const hits = [
    { name: 'Somewhere in Buckhead', postcode: '30328', address: '' },
    { name: 'Ponce City Market', postcode: '30308', address: '' },
    { name: 'Elsewhere', postcode: '30345', address: '' },
    { name: 'Krog Street Market', postcode: '30307', address: '' },
  ];
  const ranked = Geocode.rankForAtlanta(hits).map((h) => h.name);
  check(
    'rankForAtlanta: BeltLine ZIPs come first',
    ranked[0] === 'Ponce City Market' && ranked[1] === 'Krog Street Market',
    ranked.join(' | ')
  );
  check(
    'rankForAtlanta: everything else keeps its original order',
    ranked[2] === 'Somewhere in Buckhead' && ranked[3] === 'Elsewhere',
    ranked.join(' | ')
  );
  check('rankForAtlanta: keeps every result', ranked.length === 4);
}

// --- the ZIP tables ---------------------------------------------------------
check('the BeltLine ZIPs are all Atlanta ZIPs',
  [...Geocode.BELTLINE_ZIPS].every((zip) => Geocode.ATLANTA_ZIPS.has(zip)),
  [...Geocode.BELTLINE_ZIPS].filter((z) => !Geocode.ATLANTA_ZIPS.has(z)).join(', '));
check('the ZIP table is not accidentally empty', Geocode.ATLANTA_ZIPS.size > 30,
  `${Geocode.ATLANTA_ZIPS.size} entries`);
check('withinAtlanta: keeps the airport (30320)', Geocode.withinAtlanta(at('30320', 33.6407, -84.4277)));

// --- the viewbox ------------------------------------------------------------
{
  const [w, s, e, n] = Geocode.ATLANTA_VIEWBOX;
  check('viewbox: ordered west, south, east, north', w < e && s < n, `${w},${s},${e},${n}`);
  check('viewbox: contains downtown', w < -84.39 && e > -84.39 && s < 33.75 && n > 33.75);
  check('viewbox: contains the whole BeltLine loop', w < -84.44 && e > -84.35 && s < 33.71 && n > 33.83);
}

if (failures) {
  console.error(`\n${failures} of ${checks} checks failed.`);
  process.exit(1);
}
console.log(`All ${checks} checks passed.`);

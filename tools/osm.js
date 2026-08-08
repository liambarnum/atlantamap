/**
 * Turning an Overpass export of the BeltLine into ordered, named, status-tagged
 * segments.
 *
 * OSM gives you the trail as a few hundred short ways in no particular order,
 * split wherever a tag changes — a bridge, a surface, a street crossing. Three
 * jobs here: work out which named segment each way belongs to, chain the ways
 * of a segment back into a continuous line, and read a status off the tags.
 *
 * Coordinates are [lng, lat] on the way in (GeoJSON) and [lat, lng] on the way
 * out, matching the rest of the tooling.
 */

'use strict';

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

/**
 * The segments we keep, in loop order, and the names OSM uses for each.
 *
 * OSM spells the brand three ways ("Beltline", "BeltLine", "beltline") and
 * word order varies ("Atlanta Northwest Beltline Trail"), so each segment is
 * matched by a regex over the lower-cased name rather than a literal list.
 */
const SEGMENTS = [
  { id: 'eastside', name: 'Eastside Trail', match: /eastside/ },
  { id: 'southeast', name: 'Southeast Trail', match: /southeast/ },
  { id: 'southside', name: 'Southside Trail', match: /southside/ },
  { id: 'southwest', name: 'Southwest Trail', match: /southwest/ },
  { id: 'westside', name: 'Westside Trail', match: /westside(?!.*connector)/ },
  { id: 'northwest', name: 'Northwest Trail', match: /northwest/ },
  { id: 'northside', name: 'Northside Trail', match: /northside/ },
  { id: 'northeast', name: 'Northeast Trail', match: /northeast/ },
  // A spur off the loop rather than part of it: drawn, but kept out of the
  // routing spine, where a dead end would send routes down it and back.
  { id: 'westside-connector', name: 'Westside Connector', match: /westside.*connector/, spur: true },
];

/**
 * Short spurs, stairs and ramps that join the street network to the trail.
 * They are real, but they are not the corridor, and there are 130-odd of them.
 */
const ACCESS_SPUR = /access|connection|promenade|right of way/;

function canonicalSegment(name) {
  const lower = String(name || '').toLowerCase();
  if (!/beltline/.test(lower)) return null;
  if (ACCESS_SPUR.test(lower)) return null;
  return SEGMENTS.find((seg) => seg.match.test(lower)) || null;
}

const UNPAVED = new Set(['unpaved', 'gravel', 'fine_gravel', 'dirt', 'ground', 'earth', 'grass']);

/**
 * Status from the tags, most decisive first.
 *
 * `construction=*` on a way that is already `highway=cycleway` is a leftover
 * from when it was being built, so highway wins; the tag only means "under
 * construction" when highway says so too.
 */
function statusFromTags(props) {
  const highway = props.highway || '';
  const name = String(props.name || '').toLowerCase();

  if (highway === 'proposed' || props['proposed:highway']) return 'planned';
  if (highway === 'construction') return 'construction';
  if (/interim/.test(name)) return 'interim';
  if ((highway === 'footway' || highway === 'path') && props.construction) return 'construction';
  if ((highway === 'footway' || highway === 'path') && UNPAVED.has(props.surface)) return 'interim';
  if (UNPAVED.has(props.surface)) return 'interim';
  return 'open';
}

/** The most significant status across a segment's ways, by distance covered. */
function dominantStatus(pieces) {
  const byStatus = new Map();
  for (const piece of pieces) {
    byStatus.set(piece.status, (byStatus.get(piece.status) || 0) + piece.length);
  }
  return [...byStatus.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Chain ways into continuous runs.
 *
 * Greedy: take a way, then repeatedly attach whichever unused way starts or
 * ends nearest the current run's head or tail, flipping it if needed, until
 * nothing is within `tolerance`. Ways arrive in arbitrary order and arbitrary
 * direction, so both ends of both pieces have to be considered every time.
 */
function chain(ways, tolerance) {
  const pool = ways.map((w) => ({ ...w, coords: w.coords.slice() }));
  const runs = [];

  while (pool.length) {
    const run = pool.shift();
    let extended = true;

    while (extended) {
      extended = false;
      const head = run.coords[0];
      const tail = run.coords[run.coords.length - 1];
      let best = null;

      for (let i = 0; i < pool.length; i++) {
        const candidate = pool[i];
        const cStart = candidate.coords[0];
        const cEnd = candidate.coords[candidate.coords.length - 1];
        const options = [
          { d: haversine(tail, cStart), at: 'tail', flip: false },
          { d: haversine(tail, cEnd), at: 'tail', flip: true },
          { d: haversine(head, cEnd), at: 'head', flip: false },
          { d: haversine(head, cStart), at: 'head', flip: true },
        ];
        for (const option of options) {
          if (option.d <= tolerance && (!best || option.d < best.d)) {
            best = { ...option, index: i };
          }
        }
      }

      if (!best) break;
      const [piece] = pool.splice(best.index, 1);
      const coords = best.flip ? piece.coords.slice().reverse() : piece.coords;
      if (best.at === 'tail') {
        // Drop the duplicated joining vertex.
        run.coords.push(...coords.slice(haversine(tail, coords[0]) < 0.5 ? 1 : 0));
      } else {
        const prefix = haversine(head, coords[coords.length - 1]) < 0.5
          ? coords.slice(0, -1)
          : coords;
        run.coords.unshift(...prefix);
      }
      run.pieces = (run.pieces || [run]).concat(piece);
      extended = true;
    }

    runs.push(run);
  }

  return runs;
}

/**
 * Build corridor segments from an Overpass GeoJSON export.
 *
 * @param {object} geojson         the export
 * @param {object} [options]
 * @param {number} [options.joinTolerance]   metres; ways closer than this are
 *        treated as touching. OSM splits at crossings, so a few metres of gap
 *        is normal.
 * @param {number} [options.bridgeTolerance] metres; separate runs of the same
 *        segment closer than this are joined into one line. A street crossing
 *        leaves a gap of tens of metres; a genuinely unbuilt stretch leaves
 *        hundreds, and those stay separate.
 * @param {number} [options.minLength]       metres; runs shorter than this are
 *        dropped as stubs.
 */
function buildSegments(geojson, options) {
  const opts = { joinTolerance: 12, bridgeTolerance: 250, minLength: 60, ...options };
  const grouped = new Map();
  const skipped = { spurs: 0, unmatched: new Map() };

  for (const feature of geojson.features || []) {
    const props = feature.properties || {};
    const geometry = feature.geometry;
    if (!geometry) continue;

    const lines =
      geometry.type === 'LineString'
        ? [geometry.coordinates]
        : geometry.type === 'MultiLineString'
          ? geometry.coordinates
          : [];
    if (!lines.length) continue;

    // The route relation duplicates the ways it is built from; keeping it
    // would draw everything twice.
    if (props.type === 'route') continue;

    const segment = canonicalSegment(props.name);
    if (!segment) {
      const lower = String(props.name || '').toLowerCase();
      if (/beltline/.test(lower)) {
        if (ACCESS_SPUR.test(lower)) skipped.spurs++;
        else skipped.unmatched.set(props.name, (skipped.unmatched.get(props.name) || 0) + 1);
      }
      continue;
    }

    if (!grouped.has(segment.id)) grouped.set(segment.id, []);
    for (const line of lines) {
      const coords = line.map(([lng, lat]) => [lat, lng]);
      if (coords.length < 2) continue;
      grouped.get(segment.id).push({
        coords,
        status: statusFromTags(props),
        length: lengthMeters(coords),
        id: props['@id'],
      });
    }
  }

  const out = [];

  for (const segment of SEGMENTS) {
    const ways = grouped.get(segment.id);
    if (!ways || !ways.length) continue;

    // Chain within a status rather than across it. Merging a proposed stretch
    // into the open trail either side of it would average the two away, and
    // the status of a given stretch is exactly what the map is for.
    const byStatus = new Map();
    for (const way of ways) {
      if (!byStatus.has(way.status)) byStatus.set(way.status, []);
      byStatus.get(way.status).push(way);
    }

    const runsForSegment = [];
    for (const [status, statusWays] of byStatus) {
      // Twice: tightly to rebuild the trail from the ways OSM split it into,
      // then loosely to bridge the gaps it leaves at street crossings.
      let runs = chain(statusWays, opts.joinTolerance);
      runs = chain(runs.map((run) => ({ coords: run.coords })), opts.bridgeTolerance);
      for (const run of runs) {
        const length = lengthMeters(run.coords);
        if (length >= opts.minLength) runsForSegment.push({ status, coords: run.coords, length });
      }
    }

    runsForSegment.sort((a, b) => b.length - a.length);
    const countPerStatus = new Map();
    for (const run of runsForSegment) {
      countPerStatus.set(run.status, (countPerStatus.get(run.status) || 0) + 1);
    }

    const usedPerStatus = new Map();
    for (const run of runsForSegment) {
      const n = (usedPerStatus.get(run.status) || 0) + 1;
      usedPerStatus.set(run.status, n);

      const manyStatuses = runsForSegment.length > 1;
      const manyOfThisStatus = countPerStatus.get(run.status) > 1;
      const id =
        [segment.id, manyStatuses ? run.status : null, manyOfThisStatus ? n : null]
          .filter(Boolean)
          .join('-');

      out.push({
        id,
        spur: Boolean(segment.spur),
        // The status badge distinguishes rows in the legend, so it is left out
        // of the name; only a repeated status needs a part number.
        name: manyOfThisStatus ? `${segment.name} (part ${n})` : segment.name,
        status: run.status,
        coords: run.coords,
        lengthMeters: Math.round(run.length),
        source: 'OpenStreetMap',
      });
    }
  }

  return { segments: out, skipped };
}

module.exports = { buildSegments, statusFromTags, canonicalSegment, chain, haversine, lengthMeters, SEGMENTS };

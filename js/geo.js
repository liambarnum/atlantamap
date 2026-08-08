/* Geometry helpers. All coordinates are [lat, lng]; all distances are meters. */
(function (global) {
  'use strict';

  const R_EARTH_M = 6371008.8;
  const toRad = (d) => (d * Math.PI) / 180;

  function haversine(a, b) {
    const dLat = toRad(b[0] - a[0]);
    const dLon = toRad(b[1] - a[1]);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
    return 2 * R_EARTH_M * Math.asin(Math.sqrt(h));
  }

  function pathLength(coords) {
    let total = 0;
    for (let i = 1; i < coords.length; i++) total += haversine(coords[i - 1], coords[i]);
    return total;
  }

  /** Distance from the path start to each vertex. cum[i] is for coords[i]. */
  function cumulative(coords) {
    const cum = [0];
    for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]));
    return cum;
  }

  /**
   * Flat-earth projection anchored at a reference latitude. Over a city the
   * error is negligible and it makes point-on-segment math ordinary algebra.
   */
  function planar(refLat) {
    const mPerDegLat = 110574;
    const mPerDegLng = 111320 * Math.cos(toRad(refLat));
    return {
      to: ([lat, lng]) => [lng * mPerDegLng, lat * mPerDegLat],
      from: ([x, y]) => [y / mPerDegLat, x / mPerDegLng],
    };
  }

  /**
   * Nearest point on a polyline to `pt`.
   * Returns { point, index, t, offset, along } where `offset` is the distance
   * from pt to the path and `along` is the distance from the path start to the
   * projected point.
   */
  function nearestOnPath(pt, coords, cum) {
    const proj = planar(pt[0]);
    const p = proj.to(pt);
    let best = null;

    for (let i = 1; i < coords.length; i++) {
      const a = proj.to(coords[i - 1]);
      const b = proj.to(coords[i]);
      const abx = b[0] - a[0];
      const aby = b[1] - a[1];
      const lenSq = abx * abx + aby * aby;
      let t = lenSq === 0 ? 0 : ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / lenSq;
      t = Math.max(0, Math.min(1, t));
      const cx = a[0] + t * abx;
      const cy = a[1] + t * aby;
      const dSq = (p[0] - cx) ** 2 + (p[1] - cy) ** 2;
      if (!best || dSq < best.dSq) {
        best = { dSq, index: i - 1, t, point: proj.from([cx, cy]) };
      }
    }

    if (!best) return null;
    const segLen = cum[best.index + 1] - cum[best.index];
    return {
      point: best.point,
      index: best.index,
      t: best.t,
      offset: Math.sqrt(best.dSq),
      along: cum[best.index] + best.t * segLen,
    };
  }

  /** The point sitting `along` meters from the start of the path. */
  function pointAtAlong(coords, cum, along) {
    const total = cum[cum.length - 1];
    const d = Math.max(0, Math.min(total, along));
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const segLen = cum[i] - cum[i - 1];
    const t = segLen === 0 ? 0 : (d - cum[i - 1]) / segLen;
    return [
      coords[i - 1][0] + t * (coords[i][0] - coords[i - 1][0]),
      coords[i - 1][1] + t * (coords[i][1] - coords[i - 1][1]),
    ];
  }

  /**
   * Walk the path from `fromAlong` to `toAlong`, returning the vertices in
   * between plus exact endpoints.
   *
   * On a closed loop there are two ways round; `loop: true` takes the shorter
   * one, which is what you want when routing between two points on the
   * BeltLine — otherwise a pin at Lindbergh and a pin at Piedmont Park would
   * route the long way through West End.
   */
  function slicePath(coords, cum, fromAlong, toAlong, loop) {
    const total = cum[cum.length - 1];
    const forward = (toAlong - fromAlong + total) % total;
    const backward = total - forward;

    if (!loop) {
      const out = [pointAtAlong(coords, cum, fromAlong)];
      if (toAlong >= fromAlong) {
        for (let i = 0; i < coords.length; i++) {
          if (cum[i] > fromAlong && cum[i] < toAlong) out.push(coords[i]);
        }
      } else {
        for (let i = coords.length - 1; i >= 0; i--) {
          if (cum[i] < fromAlong && cum[i] > toAlong) out.push(coords[i]);
        }
      }
      out.push(pointAtAlong(coords, cum, toAlong));
      return { points: out, distance: Math.abs(toAlong - fromAlong) };
    }

    const goForward = forward <= backward;
    const span = goForward ? forward : backward;

    // Rank every unique vertex by how far it sits from `fromAlong` in the
    // chosen direction, then keep the ones we actually pass. coords[last]
    // duplicates coords[0] on a closed ring, so it is excluded from the scan.
    const passed = [];
    for (let i = 0; i < coords.length - 1; i++) {
      const rel = goForward
        ? (cum[i] - fromAlong + total) % total
        : (fromAlong - cum[i] + total) % total;
      if (rel > 0 && rel < span) passed.push({ rel, coord: coords[i] });
    }
    passed.sort((a, b) => a.rel - b.rel);

    return {
      points: [
        pointAtAlong(coords, cum, fromAlong),
        ...passed.map((v) => v.coord),
        pointAtAlong(coords, cum, toAlong),
      ],
      distance: span,
    };
  }

  /**
   * Order a set of disjoint polylines into one continuous path.
   *
   * Real trail data arrives as separate fragments in whatever order the
   * exporter emitted, pointing in whatever direction they were drawn, with
   * genuine gaps where the trail has not been built. This chains them
   * greedily: repeatedly attach whichever remaining fragment starts or ends
   * nearest either end of the path so far, reversing it when that is the end
   * that matches.
   *
   * Growing from both ends matters — growing only from the tail walks one way
   * around a loop and then has to jump back across everything to collect
   * whatever belonged before the starting fragment.
   *
   * Fragments further than `maxBridge` from both ends are left out rather than
   * reached for, since joining them would invent a straight line across the
   * gap. They come back in `dropped`.
   *
   * @param {Array<Array<[number,number]>>} lines
   * @param {object} [options] { maxBridge } in metres
   * @returns {{coords, bridges, dropped}}
   */
  function chainFragments(lines, options) {
    const maxBridge = (options && options.maxBridge) || Infinity;
    const usable = lines.filter((line) => line && line.length > 1);
    if (!usable.length) return { coords: [], bridges: [], dropped: [] };

    const pool = usable.slice(1);
    const coords = usable[0].slice();
    const bridges = [];

    while (pool.length) {
      const head = coords[0];
      const tail = coords[coords.length - 1];
      let best = null;

      pool.forEach((line, index) => {
        const start = line[0];
        const end = line[line.length - 1];
        const options_ = [
          { distance: haversine(tail, start), at: 'tail', flip: false },
          { distance: haversine(tail, end), at: 'tail', flip: true },
          { distance: haversine(head, end), at: 'head', flip: false },
          { distance: haversine(head, start), at: 'head', flip: true },
        ];
        for (const option of options_) {
          if (!best || option.distance < best.distance) best = { ...option, index };
        }
      });

      if (!best || best.distance > maxBridge) break;

      const [line] = pool.splice(best.index, 1);
      const piece = best.flip ? line.slice().reverse() : line;
      bridges.push(best.distance);
      // Drop the shared vertex when the fragments actually touch.
      if (best.at === 'tail') {
        coords.push(...(best.distance < 1 ? piece.slice(1) : piece));
      } else {
        coords.unshift(...(best.distance < 1 ? piece.slice(0, -1) : piece));
      }
    }

    return { coords, bridges, dropped: pool };
  }

  function bounds(coordsList) {
    let s = Infinity;
    let w = Infinity;
    let n = -Infinity;
    let e = -Infinity;
    for (const [lat, lng] of coordsList) {
      if (lat < s) s = lat;
      if (lat > n) n = lat;
      if (lng < w) w = lng;
      if (lng > e) e = lng;
    }
    return { south: s, west: w, north: n, east: e };
  }

  function formatDistance(meters, units) {
    if (units === 'km') {
      return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(2)} km`;
    }
    const miles = meters / 1609.344;
    if (miles < 0.19) return `${Math.round(meters * 3.28084)} ft`;
    return `${miles.toFixed(2)} mi`;
  }

  function formatDuration(minutes) {
    const m = Math.round(minutes);
    if (m < 60) return `${m} min`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  }

  global.Geo = {
    haversine,
    pathLength,
    cumulative,
    nearestOnPath,
    pointAtAlong,
    slicePath,
    chainFragments,
    bounds,
    formatDistance,
    formatDuration,
  };
})(window);

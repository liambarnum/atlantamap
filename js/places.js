/*
 * Places on and around the BeltLine.
 *
 * The dataset carries names and a vibe, not coordinates. Coordinates are
 * resolved by geocoding in the browser and then cached, because whoever edits
 * the list cannot necessarily reach a geocoder. Once a place is resolved its
 * region is worked out from the corridor segment it sits nearest, and anything
 * further than half a mile from the trail is dropped.
 *
 * Everything above the resolver is pure and takes its inputs as arguments, so
 * the grouping, filtering and favourite ordering can be tested without a
 * browser or a network.
 */
(function (global) {
  'use strict';

  /** Half a mile, the cutoff for counting as "on the BeltLine". */
  const MAX_DISTANCE_M = 804.672;

  /** Display order and labels. Anything unrecognised falls to the end. */
  const VIBES = [
    { id: 'restaurant', label: 'Restaurants', marker: '#c2371f' },
    { id: 'bar', label: 'Bars', marker: '#7a3e9d' },
    { id: 'brewery', label: 'Breweries', marker: '#b06f00' },
    { id: 'coffee', label: 'Coffee', marker: '#6b4423' },
    { id: 'dessert', label: 'Dessert', marker: '#d4568a' },
    { id: 'market', label: 'Markets & food halls', marker: '#1b7f4d' },
    { id: 'shop', label: 'Shops', marker: '#2b7a9e' },
    { id: 'activity', label: 'Activities', marker: '#1c6fbf' },
    { id: 'park', label: 'Parks', marker: '#2f9e44' },
  ];

  const FOOD_VIBES = new Set(['restaurant', 'bar', 'brewery', 'coffee', 'dessert', 'market']);

  const vibeMeta = (id) =>
    VIBES.find((v) => v.id === id) || { id: id || 'other', label: 'Other', marker: '#6b7570' };

  /** "Northeast Trail (part 2)" and "Northeast Trail" are one region. */
  function regionName(segmentName) {
    return String(segmentName || '').replace(/\s*\(part \d+\)\s*$/, '').trim();
  }

  /**
   * Nearest corridor segment to a point.
   *
   * @param {[number,number]} position
   * @param {Array} segments  [{ name, coords, cum }]
   * @returns {{region, distance, segmentName}|null}
   */
  function nearestRegion(position, segments) {
    let best = null;
    for (const segment of segments) {
      const snap = global.Geo.nearestOnPath(position, segment.coords, segment.cum);
      if (snap && (!best || snap.offset < best.distance)) {
        best = { distance: snap.offset, segmentName: segment.name };
      }
    }
    return best ? { ...best, region: regionName(best.segmentName) } : null;
  }

  /**
   * Attach region and distance to each resolved place and drop the ones too
   * far from the trail.
   */
  function locate(places, segments, maxDistance) {
    const limit = maxDistance === undefined ? MAX_DISTANCE_M : maxDistance;
    const near = [];
    const far = [];

    for (const place of places) {
      if (!Number.isFinite(place.lat) || !Number.isFinite(place.lng)) continue;
      const hit = nearestRegion([place.lat, place.lng], segments);
      if (!hit) continue;
      const located = { ...place, region: hit.region, distance: hit.distance };
      (hit.distance <= limit ? near : far).push(located);
    }

    return { near, far };
  }

  /**
   * Group located places by region, then by vibe.
   *
   * Favourites sort to the top of their own vibe group — the category they are
   * in — rather than to the top of everything, so favouriting a bar does not
   * bury the restaurants.
   *
   * @param {Array} places   output of locate().near
   * @param {object} options { favorites: Set|Array, vibeFilter: Set|Array }
   */
  function group(places, options) {
    const opts = options || {};
    const favorites = new Set(opts.favorites || []);
    const vibeFilter = opts.vibeFilter ? new Set(opts.vibeFilter) : null;

    const byRegion = new Map();
    for (const place of places) {
      if (vibeFilter && !vibeFilter.has(place.vibe)) continue;
      if (!byRegion.has(place.region)) byRegion.set(place.region, new Map());
      const byVibe = byRegion.get(place.region);
      if (!byVibe.has(place.vibe)) byVibe.set(place.vibe, []);
      byVibe.get(place.vibe).push({ ...place, favorite: favorites.has(place.id) });
    }

    const regions = [...byRegion.entries()].map(([region, byVibe]) => {
      const vibes = [...byVibe.entries()]
        .map(([vibe, list]) => ({
          vibe,
          label: vibeMeta(vibe).label,
          places: list.slice().sort(
            (a, b) =>
              // Favourites first, then nearest the trail, then alphabetical so
              // the order never depends on how the file happened to be written.
              (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) ||
              a.distance - b.distance ||
              a.name.localeCompare(b.name)
          ),
        }))
        .sort((a, b) => vibeOrder(a.vibe) - vibeOrder(b.vibe));

      return {
        region,
        count: vibes.reduce((sum, v) => sum + v.places.length, 0),
        vibes,
      };
    });

    // Busiest region first; it is the one most worth scrolling to.
    return regions.sort((a, b) => b.count - a.count || a.region.localeCompare(b.region));
  }

  function vibeOrder(vibe) {
    const index = VIBES.findIndex((v) => v.id === vibe);
    return index === -1 ? VIBES.length : index;
  }

  // ------------------------------------------------------------- resolution

  const CACHE_KEY = 'atl-beltline-planner:places:v1';

  function loadCache() {
    try {
      return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    } catch (err) {
      console.warn('Ignoring unreadable place cache:', err);
      return {};
    }
  }

  function saveCache(cache) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch (err) {
      console.warn('Could not cache resolved places:', err);
    }
  }

  /**
   * Merge in whatever this browser has already looked up. Synchronous and
   * offline: without it a reload would show an empty list until you asked it
   * to resolve again, even though every answer was already cached.
   */
  function hydrate(places) {
    const cache = loadCache();
    return places
      .map((place) => {
        if (Number.isFinite(place.lat) && Number.isFinite(place.lng)) return place;
        const cached = cache[place.id];
        if (!cached || cached.notFound) return place;
        return { ...place, lat: cached.lat, lng: cached.lng, fromCache: true };
      })
      .filter((place) => !(cache[place.id] && cache[place.id].notFound));
  }

  /**
   * Fill in coordinates for places that lack them.
   *
   * One at a time with a gap between requests: this is a list of dozens of
   * names, and firing them all at a public geocoder at once is exactly the
   * abuse its usage policy is about. Results are cached permanently, so this
   * runs once per browser and never again — and once the resolved file is
   * committed, not even that.
   *
   * @param {Array} places
   * @param {object} options { onProgress, signal, gapMs, preferGoogle }
   */
  async function resolve(places, options) {
    const opts = { gapMs: 1200, ...options };
    const cache = loadCache();
    const out = [];
    const pending = [];

    for (const place of places) {
      if (Number.isFinite(place.lat) && Number.isFinite(place.lng)) {
        out.push(place);
      } else if (cache[place.id]) {
        out.push({ ...place, ...cache[place.id], fromCache: true });
      } else {
        pending.push(place);
        out.push(place);
      }
    }

    let done = 0;
    for (const place of pending) {
      if (opts.signal && opts.signal.aborted) break;
      if (opts.onProgress) opts.onProgress({ done, total: pending.length, name: place.name });

      try {
        const query = place.hint ? `${place.name}, ${place.hint}` : `${place.name}, Atlanta, GA`;
        const hits = await global.Geocode.search(query, {
          preferGoogle: opts.preferGoogle,
          signal: opts.signal,
        });
        if (hits.length) {
          const { lat, lng } = hits[0];
          cache[place.id] = { lat, lng };
          const at = out.findIndex((p) => p.id === place.id);
          if (at >= 0) out[at] = { ...out[at], lat, lng };
        } else {
          cache[place.id] = { notFound: true };
        }
      } catch (err) {
        if (err && err.name === 'AbortError') break;
        console.warn(`Could not place "${place.name}":`, err);
      }

      done++;
      saveCache(cache);
      if (done < pending.length) await new Promise((r) => setTimeout(r, opts.gapMs));
    }

    if (opts.onProgress) opts.onProgress({ done, total: pending.length, finished: true });
    return out.filter((p) => !(cache[p.id] && cache[p.id].notFound));
  }

  function clearCache() {
    try {
      localStorage.removeItem(CACHE_KEY);
    } catch (err) {
      console.warn('Could not clear the place cache:', err);
    }
  }

  global.Places = {
    MAX_DISTANCE_M,
    VIBES,
    FOOD_VIBES,
    vibeMeta,
    regionName,
    nearestRegion,
    locate,
    group,
    hydrate,
    resolve,
    clearCache,
  };
})(window);

/*
 * Looking up places by name.
 *
 * Two providers, tried in order of what is already available:
 *
 *   Google   — only when the Google basemap is running, since it reuses that
 *              already-loaded SDK. Needs the Geocoding API enabled on the key,
 *              which is a separate switch from the Maps JavaScript API, so a
 *              failure here is expected and falls through rather than erroring.
 *   Nominatim — OpenStreetMap's geocoder. No key, works on either basemap.
 *
 * Results are restricted to Atlanta. A bounding box alone is too blunt — it
 * lets in anything within the rectangle, including neighbouring cities — so
 * the postcode is the real test, with the box as a fallback for results that
 * come back without one.
 */
(function (global) {
  'use strict';

  // The city and its immediate surrounds: west, south, east, north.
  const ATLANTA_VIEWBOX = [-84.65, 33.60, -84.20, 33.94];
  const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
  const RESULT_LIMIT = 12;

  /**
   * ZIP codes whose USPS city name is Atlanta.
   *
   * This is deliberately the mailing definition rather than the city limits:
   * a resident typing an address in Sandy Springs or Vinings expects it to
   * resolve, and those carry Atlanta addresses. What it excludes is the
   * neighbouring cities with names of their own — Decatur, Marietta, Smyrna,
   * College Park, Tucker — all of which sit inside any bounding box drawn
   * around Atlanta and would otherwise come back as results.
   *
   * PO-box-only codes are left out; nothing on a map carries one.
   */
  const ATLANTA_ZIPS = new Set([
    // City proper
    '30303', '30305', '30306', '30307', '30308', '30309', '30310', '30311',
    '30312', '30313', '30314', '30315', '30316', '30317', '30318', '30319',
    '30322', '30324', '30326', '30327', '30331', '30332', '30334', '30336',
    '30342', '30354', '30363',
    // Airport and south Fulton, both Atlanta mailing addresses
    '30320', '30349',
    // Outside the city limits, still an Atlanta mailing address
    '30328', '30329', '30338', '30339', '30340', '30341', '30345', '30346',
    '30350', '30360',
  ]);

  /** ZIPs the BeltLine itself passes through, used only to rank results. */
  const BELTLINE_ZIPS = new Set([
    '30306', '30307', '30308', '30309', '30310', '30312', '30313', '30314',
    '30315', '30316', '30318', '30324', '30326', '30363',
  ]);

  class GeocodeError extends Error {
    constructor(message, cause) {
      super(message);
      this.name = 'GeocodeError';
      this.cause = cause;
    }
  }

  /**
   * Split a display name into a title and the rest of the address, which is
   * how both providers hand back a single long comma-separated string.
   */
  function splitLabel(displayName) {
    const parts = String(displayName).split(',').map((s) => s.trim());
    return { name: parts[0] || displayName, address: parts.slice(1).join(', ') };
  }

  const inViewbox = (lat, lng) =>
    lng >= ATLANTA_VIEWBOX[0] &&
    lng <= ATLANTA_VIEWBOX[2] &&
    lat >= ATLANTA_VIEWBOX[1] &&
    lat <= ATLANTA_VIEWBOX[3];

  /** First five-digit run in a string, which is how a ZIP appears in an address. */
  function extractZip(text) {
    const match = /\b(\d{5})(?:-\d{4})?\b/.exec(String(text || ''));
    return match ? match[1] : null;
  }

  /**
   * Is this result in Atlanta?
   *
   * A known ZIP decides it either way — that is the accurate test, and it
   * correctly rejects Decatur, Marietta and East Point, which a bounding box
   * would happily include. Results with no ZIP at all (parks, intersections,
   * neighbourhoods) fall back to the box.
   */
  function withinAtlanta(hit) {
    const zip = hit.postcode || extractZip(hit.address) || extractZip(hit.name);
    if (zip) return ATLANTA_ZIPS.has(zip);
    return inViewbox(hit.lat, hit.lng);
  }

  /** Results on the BeltLine's own ZIPs come first; everything keeps its order. */
  function rankForAtlanta(hits) {
    return hits
      .map((hit, index) => {
        const zip = hit.postcode || extractZip(hit.address);
        return { hit, index, onBeltLine: zip ? BELTLINE_ZIPS.has(zip) : false };
      })
      .sort((a, b) => (b.onBeltLine ? 1 : 0) - (a.onBeltLine ? 1 : 0) || a.index - b.index)
      .map((entry) => entry.hit);
  }

  async function viaNominatim(query, signal) {
    const url = new URL(NOMINATIM);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', String(RESULT_LIMIT));
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('countrycodes', 'us');
    url.searchParams.set('viewbox', ATLANTA_VIEWBOX.join(','));
    // bounded=1 makes the viewbox a hard limit rather than a preference; the
    // ZIP check then trims the neighbouring cities it still lets through.
    url.searchParams.set('bounded', '1');

    let res;
    try {
      res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new GeocodeError('Could not reach the place search. Check your connection.', err);
    }
    if (!res.ok) throw new GeocodeError(`The place search returned HTTP ${res.status}.`);

    const body = await res.json();
    const hits = body
      .map((hit) => {
        const { name, address } = splitLabel(hit.display_name);
        return {
          name: hit.name || name,
          address,
          postcode: (hit.address && hit.address.postcode) || extractZip(hit.display_name),
          lat: parseFloat(hit.lat),
          lng: parseFloat(hit.lon),
          source: 'OpenStreetMap',
        };
      })
      .filter((hit) => Number.isFinite(hit.lat) && Number.isFinite(hit.lng));

    return rankForAtlanta(hits.filter(withinAtlanta)).slice(0, 8);
  }

  function viaGoogle(query) {
    const gm = global.google && global.google.maps;
    if (!gm || !gm.Geocoder) return Promise.reject(new GeocodeError('Google geocoder unavailable.'));

    const geocoder = new gm.Geocoder();
    const bounds = new gm.LatLngBounds(
      { lat: ATLANTA_VIEWBOX[1], lng: ATLANTA_VIEWBOX[0] },
      { lat: ATLANTA_VIEWBOX[3], lng: ATLANTA_VIEWBOX[2] }
    );

    return geocoder
      .geocode({
        address: query,
        bounds,
        componentRestrictions: { country: 'US', administrativeArea: 'GA', locality: 'Atlanta' },
      })
      .then((response) => {
        const hits = (response.results || []).map((hit) => {
          const { name, address } = splitLabel(hit.formatted_address);
          const postal = (hit.address_components || []).find((c) =>
            c.types.includes('postal_code')
          );
          return {
            name,
            address,
            postcode: postal ? postal.short_name : null,
            lat: hit.geometry.location.lat(),
            lng: hit.geometry.location.lng(),
            source: 'Google',
          };
        });
        return rankForAtlanta(hits.filter(withinAtlanta)).slice(0, 8);
      });
  }

  /**
   * @param {string} query
   * @param {object} options  { preferGoogle, signal }
   * @returns {Promise<Array>} possibly empty; throws GeocodeError if no
   *          provider could be reached at all.
   */
  async function search(query, options) {
    const opts = options || {};
    const trimmed = query.trim();
    if (!trimmed) return [];

    if (opts.preferGoogle) {
      try {
        const hits = await viaGoogle(trimmed);
        if (hits.length) return hits;
      } catch (err) {
        // ZERO_RESULTS is a legitimate answer; anything else means the key is
        // not set up for geocoding and Nominatim should get a turn.
        if (err && err.code === 'ZERO_RESULTS') return [];
      }
    }

    return viaNominatim(trimmed, opts.signal);
  }

  global.Geocode = {
    search,
    GeocodeError,
    ATLANTA_VIEWBOX,
    // Exposed for the tests.
    withinAtlanta,
    rankForAtlanta,
    extractZip,
    ATLANTA_ZIPS,
    BELTLINE_ZIPS,
  };
})(window);

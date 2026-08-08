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
 * Results are biased towards Atlanta but not restricted to it, so searching for
 * somewhere outside the city still finds it.
 */
(function (global) {
  'use strict';

  // Roughly the metro area: west, south, east, north.
  const ATLANTA_VIEWBOX = [-84.85, 33.45, -84.05, 34.05];
  const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
  const RESULT_LIMIT = 8;

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

  async function viaNominatim(query, signal) {
    const url = new URL(NOMINATIM);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', String(RESULT_LIMIT));
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('viewbox', ATLANTA_VIEWBOX.join(','));

    let res;
    try {
      res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new GeocodeError('Could not reach the place search. Check your connection.', err);
    }
    if (!res.ok) throw new GeocodeError(`The place search returned HTTP ${res.status}.`);

    const body = await res.json();
    return body.map((hit) => {
      const { name, address } = splitLabel(hit.display_name);
      return {
        name: hit.name || name,
        address: hit.name ? splitLabel(hit.display_name).address : address,
        lat: parseFloat(hit.lat),
        lng: parseFloat(hit.lon),
        source: 'OpenStreetMap',
      };
    }).filter((hit) => Number.isFinite(hit.lat) && Number.isFinite(hit.lng));
  }

  function viaGoogle(query) {
    const gm = global.google && global.google.maps;
    if (!gm || !gm.Geocoder) return Promise.reject(new GeocodeError('Google geocoder unavailable.'));

    const geocoder = new gm.Geocoder();
    const bounds = new gm.LatLngBounds(
      { lat: ATLANTA_VIEWBOX[1], lng: ATLANTA_VIEWBOX[0] },
      { lat: ATLANTA_VIEWBOX[3], lng: ATLANTA_VIEWBOX[2] }
    );

    return geocoder.geocode({ address: query, bounds }).then((response) =>
      (response.results || []).slice(0, RESULT_LIMIT).map((hit) => {
        const { name, address } = splitLabel(hit.formatted_address);
        return {
          name,
          address,
          lat: hit.geometry.location.lat(),
          lng: hit.geometry.location.lng(),
          source: 'Google',
        };
      })
    );
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

  global.Geocode = { search, GeocodeError, ATLANTA_VIEWBOX };
})(window);

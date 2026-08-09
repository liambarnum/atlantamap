/* Atlanta BeltLine Trail Planner — application logic. */
(function () {
  'use strict';

  const STORAGE_KEY = 'atl-beltline-planner:v1';
  const ATLANTA = [33.7684, -84.3963];
  const DEFAULT_ZOOM = 12;

  /** How far off the corridor a pin can sit and still route along it. */
  const SNAP_TOLERANCE_M = 400;

  /** Metres per minute. */
  const SPEEDS = { walk: 80, run: 161, bike: 267 };
  const TRAVEL_LABELS = { walk: 'Walking', run: 'Running', bike: 'Biking' };
  const GOOGLE_TRAVEL = { walk: 'walking', run: 'walking', bike: 'bicycling' };

  /**
   * One colour per status, used for the line on the map, the legend swatch,
   * the badge and the filter chip — so the colour you see on the map is the
   * same one the legend explains. Weight is uniform; nothing is dashed.
   */
  const CORRIDOR_WEIGHT = 5;

  const STATUS_META = {
    open: { label: 'Open', color: '#1b7f4d', detail: 'Finished and open to the public.' },
    interim: { label: 'Interim', color: '#3aa9c4', detail: 'Walkable, but not yet the finished surface.' },
    construction: { label: 'Building', color: '#e8820c', detail: 'Under construction.' },
    planned: { label: 'Planned', color: '#8a8f99', detail: 'Planned or in design; not yet built.' },
    closed: { label: 'Closed', color: '#c2371f', detail: 'Currently closed.' },
  };
  const STATUS_ORDER = ['open', 'interim', 'construction', 'planned', 'closed'];
  const statusMeta = (status) =>
    STATUS_META[status] || { label: status || 'Unknown', color: '#8a8f99', detail: '' };

  // The route usually sits directly on top of the corridor, so it is drawn
  // wide and translucent — a highlighter over the trail rather than a line
  // that paints over it.
  const ROUTE_STYLE = { color: '#1c6fbf', weight: 9, opacity: 0.45 };
  const ROUTE_CORE = { color: '#0d4f8f', weight: 2.5, opacity: 0.95 };

  // ------------------------------------------------------------------ state

  const state = {
    pins: [],
    settings: {
      basemap: 'osm',
      googleKey: '',
      units: 'mi',
      routeMode: 'beltline',
      travelMode: 'walk',
      closeLoop: false,
      showCorridor: true,
      showAccess: true,
      hiddenSegments: [],
      hiddenStatuses: [],
      hiddenAccessTypes: [],
      hiddenVibes: [],
      showPlaces: true,
      favoritePlaces: [],
      includeCorridor: true,
      includeAccess: false,
    },
    ui: {
      dropMode: false,
      selectedPinId: null,
      accessSearch: '',
      placeQuery: '',
      placeResults: [],
      placeStatus: null, // { kind: 'searching' | 'error' | 'empty', message }
    },
  };

  let corridor = null; // GeoJSON FeatureCollection
  let accessPoints = null; // GeoJSON FeatureCollection
  let spine = null; // [lat,lng][] — the whole loop as one closed ring
  let spineCum = null;
  let spineIsLoop = false;
  let map = null;
  let route = { legs: [], coords: [], distance: 0 };
  let pinCounter = 0;
  let renderedPinIds = new Set();
  let renderedAccessIds = new Set();
  let renderedSegmentIds = new Set();
  let renderedPlaceIds = new Set();
  let renderedVenueIds = new Set();
  let places = [];          // the raw list, with coordinates once resolved
  let locatedPlaces = [];   // within half a mile, with region and distance
  let farPlaces = [];       // resolved but too far from the trail
  let placesStatus = null;  // { kind, message }
  let resolving = false;

  const $ = (id) => document.getElementById(id);

  const escapeHTML = (s) =>
    String(s === null || s === undefined ? '' : s).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );

  const fmtDist = (m) => Geo.formatDistance(m, state.settings.units);

  let toastTimer = null;
  function toast(message, ms) {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, ms || 3200);
  }

  // ------------------------------------------------------------- persistence

  function save() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ pins: state.pins, settings: state.settings })
      );
    } catch (err) {
      // Private browsing, quota, or a blocked origin — the app still works,
      // it just will not remember anything.
      console.warn('Could not save to localStorage:', err);
    }
  }

  function restore() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    } catch (err) {
      console.warn('Ignoring unreadable saved state:', err);
    }
    if (saved && typeof saved === 'object') {
      if (Array.isArray(saved.pins)) state.pins = saved.pins.filter(isValidPin);
      if (saved.settings) Object.assign(state.settings, saved.settings);
    }
    // A share link in the URL wins over whatever this browser had saved.
    const shared = readShareLink();
    if (shared) {
      state.pins = shared.pins;
      Object.assign(state.settings, shared.settings);
      toast('Loaded a shared route.');
    }
    pinCounter = state.pins.length;
    state.pins.forEach((p, i) => {
      if (!p.id) p.id = `p${i + 1}`;
    });
  }

  const isValidPin = (p) =>
    p &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lng) <= 180;

  // ------------------------------------------------------------- share links

  const b64encode = (text) =>
    btoa(String.fromCharCode(...new TextEncoder().encode(text)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

  const b64decode = (encoded) => {
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  };

  function buildShareLink() {
    const payload = {
      v: 1,
      m: state.settings.routeMode,
      t: state.settings.travelMode,
      c: state.settings.closeLoop ? 1 : 0,
      p: state.pins.map((p) => [
        Number(p.lat.toFixed(6)),
        Number(p.lng.toFixed(6)),
        p.name || '',
        p.inRoute === false ? 0 : 1,
      ]),
    };
    const url = new URL(location.href);
    url.hash = `r=${b64encode(JSON.stringify(payload))}`;
    return url.toString();
  }

  function readShareLink() {
    const match = /(?:^|[#&])r=([^&]+)/.exec(location.hash || '');
    if (!match) return null;
    try {
      const payload = JSON.parse(b64decode(match[1]));
      if (!payload || !Array.isArray(payload.p)) return null;
      return {
        pins: payload.p
          .map(([lat, lng, name, inRoute], i) => ({
            id: `p${i + 1}`,
            lat,
            lng,
            name: name || '',
            notes: '',
            inRoute: inRoute !== 0,
          }))
          .filter(isValidPin),
        settings: {
          routeMode: payload.m === 'straight' ? 'straight' : 'beltline',
          travelMode: SPEEDS[payload.t] ? payload.t : 'walk',
          closeLoop: payload.c === 1,
        },
      };
    } catch (err) {
      console.warn('Ignoring malformed share link:', err);
      return null;
    }
  }

  // ---------------------------------------------------------------- the data

  async function loadData() {
    // The bundled data is delivered as plain scripts so the page also works
    // when opened straight off disk, where fetch() of a sibling file is
    // blocked. Fall back to fetch if those scripts are missing.
    corridor = window.BELTLINE_CORRIDOR || (await fetchJSON('data/beltline.geojson'));
    accessPoints = window.BELTLINE_ACCESS_POINTS || (await fetchJSON('data/access-points.geojson'));
    const placeData = window.BELTLINE_PLACES || (await fetchJSON('data/places.json'));
    // Coordinates already looked up in this browser come back without asking.
    places = Places.hydrate((placeData && placeData.places) || []);
    rebuildSpine();
  }

  async function fetchJSON(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  }

  /** Two fragments closer than this are treated as the same continuous trail. */
  const SPINE_LOOP_TOLERANCE_M = 1500;

  /**
   * A fragment further than this from either end of the chain is left out of
   * the routing spine. It is still drawn; it just cannot be routed along,
   * because reaching it would mean a straight line across miles of city.
   */
  const SPINE_MAX_BRIDGE_M = 2500;

  /**
   * Flatten the corridor's segments into one path for routing.
   *
   * The corridor is not one line and not in order: it arrives as separate
   * segments, and the real trail has genuine gaps where it has not been built.
   * So the fragments are chained greedily — repeatedly attach whichever
   * remaining fragment begins or ends nearest the current end, flipping it if
   * that is the end that matches. Routing then treats a gap as a straight line
   * across it, which is what walking it would involve anyway.
   *
   * This also runs on imported corridors, where the ordering is whatever the
   * exporter happened to emit.
   */
  function rebuildSpine() {
    const lines = corridor.features
      .filter(
        (f) =>
          f.geometry &&
          f.geometry.type === 'LineString' &&
          f.geometry.coordinates.length > 1 &&
          // Spurs are dead ends. Chaining one in sends every route down it and
          // straight back out again.
          !(f.properties || {}).spur
      )
      .map((f) => f.geometry.coordinates.map(([lng, lat]) => [lat, lng]));

    if (!lines.length) {
      spine = null;
      spineCum = null;
      spineIsLoop = false;
      return;
    }

    const chained = Geo.chainFragments(lines, { maxBridge: SPINE_MAX_BRIDGE_M });
    const ordered = chained.coords;
    if (chained.dropped.length) {
      console.info(
        `${chained.dropped.length} corridor fragment(s) are too far from the rest to route ` +
          'along; they are drawn but left out of the routing spine.'
      );
    }

    spine = ordered;
    spineCum = Geo.cumulative(ordered);
    spineIsLoop =
      Geo.haversine(ordered[0], ordered[ordered.length - 1]) < SPINE_LOOP_TOLERANCE_M;
  }

  // ------------------------------------------------------------------- pins

  function addPin(lat, lng, options) {
    const opts = options || {};
    pinCounter++;
    const pin = {
      id: `p${pinCounter}`,
      lat,
      lng,
      name: opts.name || `Stop ${state.pins.filter((p) => p.inRoute !== false).length + 1}`,
      notes: opts.notes || '',
      inRoute: opts.inRoute !== false,
      sourceId: opts.sourceId || null,
    };
    state.pins.push(pin);
    commit();
    return pin;
  }

  function dropPinAt(position) {
    const pin = addPin(position[0], position[1]);
    state.ui.selectedPinId = pin.id;
    drawPins();
    renderSidebar();
    return pin;
  }

  function removePin(id) {
    const index = state.pins.findIndex((p) => p.id === id);
    if (index < 0) return;
    state.pins.splice(index, 1);
    if (state.ui.selectedPinId === id) state.ui.selectedPinId = null;
    if (map) map.removeMarker(`pin-${id}`);
    renderedPinIds.delete(`pin-${id}`);
    if (map) map.closePopup();
    commit();
  }

  function movePin(id, delta) {
    const from = state.pins.findIndex((p) => p.id === id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= state.pins.length) return;
    const [pin] = state.pins.splice(from, 1);
    state.pins.splice(to, 0, pin);
    commit();
  }

  function reorderPin(fromIndex, toIndex) {
    if (fromIndex === toIndex || fromIndex < 0 || fromIndex >= state.pins.length) return;
    const [pin] = state.pins.splice(fromIndex, 1);
    state.pins.splice(Math.max(0, Math.min(state.pins.length, toIndex)), 0, pin);
    commit();
  }

  /** Reorder stops to follow the loop, which is usually what you meant. */
  function sortAlongLoop() {
    if (!spine) return;
    const withPosition = state.pins.map((pin, index) => {
      const snap = Geo.nearestOnPath([pin.lat, pin.lng], spine, spineCum);
      return { pin, index, snapped: snap.offset <= SNAP_TOLERANCE_M, along: snap.along };
    });
    const on = withPosition.filter((e) => e.snapped).sort((a, b) => a.along - b.along);
    const off = withPosition.filter((e) => !e.snapped);
    state.pins = [...on, ...off].map((e) => e.pin);
    commit();
    toast(
      off.length
        ? `Ordered along the loop. ${off.length} pin${off.length === 1 ? '' : 's'} too far from the trail to place, left at the end.`
        : 'Ordered along the loop.'
    );
  }

  // ------------------------------------------------------------------ route

  function buildLeg(a, b) {
    const A = [a.lat, a.lng];
    const B = [b.lat, b.lng];

    if (state.settings.routeMode === 'beltline' && spine) {
      const sa = Geo.nearestOnPath(A, spine, spineCum);
      const sb = Geo.nearestOnPath(B, spine, spineCum);

      if (sa.offset <= SNAP_TOLERANCE_M && sb.offset <= SNAP_TOLERANCE_M) {
        const slice = Geo.slicePath(spine, spineCum, sa.along, sb.along, spineIsLoop);
        const points = dedupe([A, ...slice.points, B]);
        return {
          from: a,
          to: b,
          points,
          distance: sa.offset + slice.distance + sb.offset,
          mode: 'beltline',
        };
      }
    }

    return { from: a, to: b, points: [A, B], distance: Geo.haversine(A, B), mode: 'straight' };
  }

  /** Drop consecutive points that are effectively the same spot. */
  function dedupe(points) {
    const out = [points[0]];
    for (let i = 1; i < points.length; i++) {
      if (Geo.haversine(out[out.length - 1], points[i]) > 0.5) out.push(points[i]);
    }
    return out;
  }

  function computeRoute() {
    const stops = state.pins.filter((p) => p.inRoute !== false);
    const legs = [];

    for (let i = 0; i < stops.length - 1; i++) legs.push(buildLeg(stops[i], stops[i + 1]));
    if (state.settings.closeLoop && stops.length > 2) {
      legs.push(buildLeg(stops[stops.length - 1], stops[0]));
    }

    const coords = [];
    for (const leg of legs) {
      coords.push(...(coords.length ? leg.points.slice(1) : leg.points));
    }

    route = { legs, coords, distance: legs.reduce((sum, leg) => sum + leg.distance, 0), stops };
  }

  // ---------------------------------------------------------------- drawing

  /** A segment shows unless it, or its status, has been filtered out. */
  function isSegmentVisible(props) {
    return (
      state.settings.showCorridor &&
      !state.settings.hiddenSegments.includes(props.id) &&
      !state.settings.hiddenStatuses.includes(props.status)
    );
  }

  function drawCorridor() {
    const wanted = new Set();

    for (const feature of corridor.features) {
      if (!feature.geometry || feature.geometry.type !== 'LineString') continue;
      const props = feature.properties || {};
      const id = `seg-${props.id || feature.id || props.name}`;
      const visible = isSegmentVisible(props);

      wanted.add(id);
      map.setPolyline(id, feature.geometry.coordinates.map(([lng, lat]) => [lat, lng]), {
        color: statusMeta(props.status).color,
        weight: CORRIDOR_WEIGHT,
        interactive: true,
        visible,
        tooltip: `${props.name} — ${statusMeta(props.status).label}`,
        zIndex: 2,
        // While dropping pins, a click on the trail means "put one here",
        // which is the easiest way to pin an exact spot on the corridor.
        onClick: (_id, position) =>
          state.ui.dropMode ? dropPinAt(position) : showSegmentPopup(feature),
      });
      map.setPolylineVisible(id, visible);
    }

    for (const id of renderedSegmentIds) if (!wanted.has(id)) map.removePolyline(id);
    renderedSegmentIds = wanted;
  }

  function visibleAccessPoints() {
    const query = state.ui.accessSearch.trim().toLowerCase();
    const hidden = state.settings.hiddenAccessTypes;
    return accessPoints.features.filter((f) => {
      const p = f.properties;
      if (hidden.includes(p.type)) return false;
      if (!query) return true;
      return `${p.name} ${p.description || ''} ${p.segment} ${(p.amenities || []).join(' ')}`
        .toLowerCase()
        .includes(query);
    });
  }

  function drawAccessPoints() {
    const wanted = new Set();
    const show = state.settings.showAccess;
    const visible = show ? visibleAccessPoints() : [];
    const visibleIds = new Set(visible.map((f) => f.properties.id));

    for (const feature of accessPoints.features) {
      const p = feature.properties;
      const id = `ap-marker-${p.id}`;
      const [lng, lat] = feature.geometry.coordinates;
      const isVisible = visibleIds.has(p.id);

      if (!isVisible && !renderedAccessIds.has(id)) continue;

      wanted.add(id);
      map.setMarker(id, {
        position: [lat, lng],
        icon: Icons.accessIcon(p.type, p.type === 'trailhead' || p.type === 'transit'),
        title: p.name,
        visible: isVisible,
        zIndex: 10,
      });
      map.setMarkerVisible(id, isVisible);
    }

    for (const id of renderedAccessIds) if (!wanted.has(id)) map.removeMarker(id);
    renderedAccessIds = wanted;
  }

  function drawPins() {
    const wanted = new Set();
    const order = new Map();
    state.pins.filter((p) => p.inRoute !== false).forEach((p, i) => order.set(p.id, i + 1));

    for (const pin of state.pins) {
      const id = `pin-${pin.id}`;
      wanted.add(id);
      const label = order.get(pin.id);
      map.setMarker(id, {
        position: [pin.lat, pin.lng],
        icon: Icons.pinIcon(
          label === undefined ? '' : label,
          state.ui.selectedPinId === pin.id ? '#1c6fbf' : undefined,
          label === undefined
        ),
        title: pin.name,
        draggable: true,
        visible: true,
        zIndex: 100 + (label || 0),
      });
    }

    for (const id of renderedPinIds) if (!wanted.has(id)) map.removeMarker(id);
    renderedPinIds = wanted;
  }

  function drawRoute() {
    if (route.coords.length > 1) {
      map.setPolyline('route-halo', route.coords, { ...ROUTE_STYLE, zIndex: 40 });
      map.setPolyline('route', route.coords, { ...ROUTE_CORE, zIndex: 41 });
      map.setPolylineVisible('route-halo', true);
      map.setPolylineVisible('route', true);
    } else {
      map.removePolyline('route-halo');
      map.removePolyline('route');
    }
  }

  // ----------------------------------------------------------------- popups

  function showSegmentPopup(feature) {
    const p = feature.properties;
    const meta = statusMeta(p.status);
    const coords = feature.geometry.coordinates;
    const mid = coords[Math.floor(coords.length / 2)];
    map.showPopup(
      [mid[1], mid[0]],
      `<div class="popup">
         <h3>${escapeHTML(p.name)}</h3>
         <div class="meta">
           <span class="status-badge" style="background:${meta.color}">${escapeHTML(meta.label)}</span>
           <span>${fmtDist(p.lengthMeters || 0)}</span>
         </div>
         ${meta.detail ? `<p class="status-detail">${escapeHTML(meta.detail)}</p>` : ''}
         <p>${escapeHTML(p.note || '')}</p>
       </div>`
    );
  }

  function showAccessPopup(feature) {
    const p = feature.properties;
    const [lng, lat] = feature.geometry.coordinates;
    const amenities = (p.amenities || [])
      .map((a) => `<span class="amenity">${escapeHTML(a)}</span>`)
      .join('');
    map.showPopup(
      [lat, lng],
      `<div class="popup">
         <h3>${escapeHTML(p.name)}</h3>
         <div class="meta">${escapeHTML(p.type)} · ${escapeHTML(segmentName(p.segment))}</div>
         ${p.description ? `<p>${escapeHTML(p.description)}</p>` : ''}
         ${amenities ? `<div class="amenities">${amenities}</div>` : ''}
         <div class="popup-actions">
           <button class="primary" data-action="add-access" data-id="${escapeHTML(p.id)}">Add to route</button>
           <button data-action="copy-coords" data-lat="${lat}" data-lng="${lng}">Copy coords</button>
         </div>
         <div class="coords">${lat.toFixed(5)}, ${lng.toFixed(5)}</div>
       </div>`
    );
  }

  function showPinPopup(pin) {
    const stops = state.pins.filter((p) => p.inRoute !== false);
    const position = stops.indexOf(pin) + 1;
    const snap = spine ? Geo.nearestOnPath([pin.lat, pin.lng], spine, spineCum) : null;
    const nearTrail =
      snap && snap.offset <= SNAP_TOLERANCE_M
        ? `${fmtDist(snap.offset)} from the corridor`
        : 'Not near the corridor';

    map.showPopup(
      [pin.lat, pin.lng],
      `<div class="popup">
         <div class="meta">${position ? `Stop ${position}` : 'Not in the route'} · ${escapeHTML(nearTrail)}</div>
         <input type="text" data-action="pin-name" data-id="${escapeHTML(pin.id)}"
                value="${escapeHTML(pin.name)}" aria-label="Pin name" placeholder="Name this stop">
         <textarea data-action="pin-notes" data-id="${escapeHTML(pin.id)}"
                   aria-label="Notes" placeholder="Notes…">${escapeHTML(pin.notes)}</textarea>
         <div class="popup-actions">
           <button data-action="pin-toggle" data-id="${escapeHTML(pin.id)}">
             ${pin.inRoute === false ? 'Add to route' : 'Skip in route'}
           </button>
           <button class="danger" data-action="pin-delete" data-id="${escapeHTML(pin.id)}">Delete</button>
         </div>
         <div class="coords">${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}</div>
       </div>`
    );
  }

  const segmentName = (id) => {
    const f = corridor.features.find((x) => (x.properties || {}).id === id);
    return f ? f.properties.name : id;
  };

  // Popup content lives outside the sidebar's own listeners (and inside
  // Google's InfoWindow), so its controls are handled by delegation.
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const { action, id } = target.dataset;

    if (action === 'add-access') {
      const feature = accessPoints.features.find((f) => f.properties.id === id);
      if (!feature) return;
      const [lng, lat] = feature.geometry.coordinates;
      addPin(lat, lng, { name: feature.properties.name, sourceId: id });
      map.closePopup();
      toast(`Added “${feature.properties.name}” to the route.`);
    } else if (action === 'add-place') {
      addPlaceToRoute(id);
    } else if (action === 'fav-place') {
      toggleFavorite(id);
      const place = locatedPlaces.find((p) => p.id === id);
      if (place) showVenuePopup(place);
    } else if (action === 'add-result') {
      addResultToRoute(Number(target.dataset.index));
    } else if (action === 'copy-coords') {
      copyText(`${Number(target.dataset.lat).toFixed(6)}, ${Number(target.dataset.lng).toFixed(6)}`);
    } else if (action === 'pin-toggle') {
      const pin = state.pins.find((p) => p.id === id);
      if (!pin) return;
      pin.inRoute = pin.inRoute === false;
      commit();
      showPinPopup(pin);
    } else if (action === 'pin-delete') {
      removePin(id);
    }
  });

  document.addEventListener('input', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const pin = state.pins.find((p) => p.id === target.dataset.id);
    if (!pin) return;
    if (target.dataset.action === 'pin-name') {
      pin.name = target.value;
      renderSidebar();
      drawPins();
      save();
    } else if (target.dataset.action === 'pin-notes') {
      pin.notes = target.value;
      save();
    }
  });

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied to the clipboard.');
    } catch (err) {
      // Clipboard access needs a secure context; fall back to selection.
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand && document.execCommand('copy');
      area.remove();
      toast(ok ? 'Copied to the clipboard.' : text, ok ? 3200 : 8000);
    }
  }

  // -------------------------------------------------------------- sidebar UI

  function renderSidebar() {
    renderRoutePanel();
    renderPinList();
    renderLegend();
    renderAccessControls();
    renderPlaces();
    renderPlaceResults();
  }

  function renderRoutePanel() {
    const stops = route.stops || [];
    const hasRoute = route.coords.length > 1;
    $('routeEmptyHint').hidden = state.pins.length > 0;
    $('routeStats').hidden = !hasRoute;

    if (hasRoute) {
      const minutes = route.distance / SPEEDS[state.settings.travelMode];
      $('statDistance').textContent = fmtDist(route.distance);
      $('statTimeLabel').textContent = TRAVEL_LABELS[state.settings.travelMode];
      $('statTime').textContent = Geo.formatDuration(minutes);
      $('statStops').textContent = String(stops.length);
    }

    $('googleDirBtn').disabled = stops.length < 2;
    $('shareBtn').disabled = state.pins.length === 0;
    $('clearPinsBtn').disabled = state.pins.length === 0;
    $('reverseBtn').disabled = state.pins.length < 2;
    $('sortByLoopBtn').disabled = state.pins.length < 2;
  }

  function renderPinList() {
    const list = $('pinList');
    list.innerHTML = '';

    const orderOf = new Map();
    state.pins.filter((p) => p.inRoute !== false).forEach((p, i) => orderOf.set(p.id, i + 1));

    state.pins.forEach((pin, index) => {
      const li = document.createElement('li');
      li.className = 'pin-item';
      li.draggable = true;
      li.dataset.id = pin.id;
      li.dataset.index = String(index);
      if (state.ui.selectedPinId === pin.id) li.classList.add('selected');
      if (pin.inRoute === false) li.classList.add('excluded');

      const order = orderOf.get(pin.id);
      li.innerHTML = `
        <span class="pin-grip" aria-hidden="true">⠿</span>
        <span class="pin-index">${order === undefined ? '–' : order}</span>
        <input class="pin-name" value="${escapeHTML(pin.name)}" aria-label="Name of stop ${order || index + 1}">
        <span class="pin-actions">
          <button data-act="toggle" title="${pin.inRoute === false ? 'Include in the route' : 'Skip in the route'}"
                  aria-label="${pin.inRoute === false ? 'Include in the route' : 'Skip in the route'}">${pin.inRoute === false ? '○' : '●'}</button>
          <button data-act="locate" title="Centre the map here" aria-label="Centre the map on this stop">◎</button>
          <button data-act="up" title="Move up" aria-label="Move up" ${index === 0 ? 'disabled' : ''}>↑</button>
          <button data-act="down" title="Move down" aria-label="Move down" ${index === state.pins.length - 1 ? 'disabled' : ''}>↓</button>
          <button data-act="remove" class="danger" title="Delete" aria-label="Delete this stop">✕</button>
        </span>`;
      list.appendChild(li);

      // The leg that follows this stop, so distances read between the rows.
      const legIndex = order === undefined ? -1 : order - 1;
      const leg = legIndex >= 0 ? route.legs[legIndex] : null;
      if (leg && legIndex < route.legs.length) {
        const isClosing = state.settings.closeLoop && legIndex === route.legs.length - 1;
        const legRow = document.createElement('li');
        legRow.className = `leg-row${leg.mode === 'straight' ? ' leg-straight' : ''}`;
        const minutes = leg.distance / SPEEDS[state.settings.travelMode];
        legRow.textContent =
          `${fmtDist(leg.distance)} · ${Geo.formatDuration(minutes)}` +
          (leg.mode === 'straight' ? ' · straight line' : '') +
          (isClosing ? ' · back to the start' : '');
        list.appendChild(legRow);
      }
    });
  }

  function renderLegend() {
    $('corridorControls').style.display = state.settings.showCorridor ? '' : 'none';

    // Status filter chips, in a fixed order, covering only the statuses the
    // loaded data actually uses.
    const present = [...new Set(corridor.features.map((f) => (f.properties || {}).status))];
    present.sort((a, b) => STATUS_ORDER.indexOf(a) - STATUS_ORDER.indexOf(b));

    const chips = $('statusChips');
    chips.innerHTML = '';
    for (const status of present) {
      const meta = statusMeta(status);
      const on = !state.settings.hiddenStatuses.includes(status);
      const count = corridor.features.filter((f) => (f.properties || {}).status === status).length;
      const button = document.createElement('button');
      button.className = 'chip chip-status';
      button.dataset.status = status;
      button.setAttribute('aria-pressed', String(on));
      button.title = meta.detail;
      button.innerHTML =
        `<span class="chip-dot" style="background:${meta.color}"></span>` +
        `${escapeHTML(meta.label)} <em>${count}</em>`;
      chips.appendChild(button);
    }

    const legend = $('segmentLegend');
    legend.innerHTML = '';
    let shown = 0;

    for (const feature of corridor.features) {
      const p = feature.properties || {};
      const meta = statusMeta(p.status);
      const byStatus = state.settings.hiddenStatuses.includes(p.status);
      const hidden = state.settings.hiddenSegments.includes(p.id) || byStatus;
      if (!hidden) shown++;

      const li = document.createElement('li');
      li.className = hidden ? 'segment-hidden' : '';
      li.innerHTML = `
        <button data-seg="${escapeHTML(p.id)}" aria-pressed="${!hidden}"
                title="${byStatus
                  ? `${escapeHTML(meta.label)} segments are filtered out`
                  : `${hidden ? 'Show' : 'Hide'} ${escapeHTML(p.name)}`}"
                ${byStatus ? 'disabled' : ''}>
          <span class="seg-swatch" aria-hidden="true"
                style="background:${hidden ? 'transparent' : meta.color};
                       border-color:${meta.color}"></span>
          <span class="seg-body">
            <span class="seg-name">${escapeHTML(p.name)}</span>
            <span class="seg-meta">
              <span class="status-badge" style="background:${meta.color}">${escapeHTML(meta.label)}</span>
              <span class="seg-len">${fmtDist(p.lengthMeters || 0)}</span>
            </span>
          </span>
        </button>`;
      legend.appendChild(li);
    }

    $('segmentCount').textContent = `(${shown} of ${corridor.features.length})`;
  }

  // ------------------------------------------------------------ place search

  let searchAbort = null;
  let searchDebounce = null;

  /**
   * Access points and BeltLine segments matching the query, so typing a place
   * you already know is on the trail answers instantly and without a network
   * round trip.
   */
  function localMatches(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const hits = [];

    for (const feature of accessPoints.features) {
      const p = feature.properties;
      const haystack = `${p.name} ${p.description || ''} ${(p.amenities || []).join(' ')}`.toLowerCase();
      if (!haystack.includes(q)) continue;
      const [lng, lat] = feature.geometry.coordinates;
      hits.push({
        kind: 'access',
        id: p.id,
        name: p.name,
        address: `${p.type} · ${segmentName(p.segment)}`,
        lat,
        lng,
        // Prefer a name match over a description match.
        rank: p.name.toLowerCase().startsWith(q) ? 0 : p.name.toLowerCase().includes(q) ? 1 : 2,
      });
    }

    for (const feature of corridor.features) {
      const p = feature.properties || {};
      if (!String(p.name).toLowerCase().includes(q)) continue;
      const coords = feature.geometry.coordinates;
      const mid = coords[Math.floor(coords.length / 2)];
      hits.push({
        kind: 'segment',
        id: p.id,
        name: p.name,
        address: `BeltLine segment · ${statusMeta(p.status).label} · ${fmtDist(p.lengthMeters || 0)}`,
        lat: mid[1],
        lng: mid[0],
        rank: 0,
      });
    }

    return hits.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name)).slice(0, 8);
  }

  /** Local results appear immediately; geocoding waits for an explicit search. */
  function updateLocalResults() {
    const local = localMatches(state.ui.placeQuery);
    const remote = state.ui.placeResults.filter((r) => r.kind === 'place');
    state.ui.placeResults = [...local, ...remote];
    renderPlaceResults();
    drawPlaceMarkers();
  }

  async function runPlaceSearch() {
    const query = state.ui.placeQuery.trim();
    if (!query) {
      clearPlaceResults();
      return;
    }

    if (searchAbort) searchAbort.abort();
    searchAbort = new AbortController();

    state.ui.placeStatus = { kind: 'searching', message: `Searching for “${query}”…` };
    renderPlaceResults();

    try {
      const found = await Geocode.search(query, {
        preferGoogle: state.settings.basemap === 'google',
        signal: searchAbort.signal,
      });
      const places = found.map((hit, i) => ({ ...hit, kind: 'place', id: `place-${i}` }));
      const local = localMatches(query);
      state.ui.placeResults = [...local, ...places];
      state.ui.placeStatus =
        state.ui.placeResults.length === 0
          ? { kind: 'empty', message: `Nothing in Atlanta matched “${query}”.` }
          : null;
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.warn('Place search failed:', err);
      state.ui.placeStatus = {
        kind: 'error',
        message: err.message || 'The place search could not be reached.',
      };
    }

    renderPlaceResults();
    drawPlaceMarkers();
    const firstPlace = state.ui.placeResults.find((r) => r.kind === 'place');
    if (firstPlace) map.panTo([firstPlace.lat, firstPlace.lng], 15);
  }

  function clearPlaceResults() {
    if (searchAbort) searchAbort.abort();
    state.ui.placeResults = [];
    state.ui.placeStatus = null;
    renderPlaceResults();
    drawPlaceMarkers();
  }

  function renderPlaceResults() {
    const list = $('placeResults');
    const status = $('placeSearchStatus');
    const results = state.ui.placeResults;

    if (state.ui.placeStatus) {
      status.textContent = state.ui.placeStatus.message;
      status.className = `search-status search-${state.ui.placeStatus.kind}`;
      status.hidden = false;
    } else {
      status.hidden = true;
    }

    list.innerHTML = '';
    list.hidden = results.length === 0;
    $('placeResultsActions').hidden = results.length === 0;
    if (!results.length) return;

    results.forEach((hit, index) => {
      const li = document.createElement('li');
      li.className = `result result-${hit.kind}`;
      li.innerHTML = `
        <button class="result-open" data-result="${index}" title="Show on the map">
          <span class="result-kind" aria-hidden="true">${
            hit.kind === 'place' ? '🔍' : hit.kind === 'segment' ? '〰' : '◉'
          }</span>
          <span class="result-text">
            <span class="result-name">${escapeHTML(hit.name)}</span>
            <span class="result-address">${escapeHTML(hit.address || '')}</span>
          </span>
        </button>
        <button class="result-add" data-add-result="${index}"
                title="Add to the route" aria-label="Add ${escapeHTML(hit.name)} to the route">+</button>`;
      list.appendChild(li);
    });
  }

  function drawPlaceMarkers() {
    const wanted = new Set();
    state.ui.placeResults.forEach((hit, index) => {
      if (hit.kind !== 'place') return;
      const id = `place-marker-${index}`;
      wanted.add(id);
      map.setMarker(id, {
        position: [hit.lat, hit.lng],
        icon: Icons.placeIcon(false),
        title: hit.name,
        visible: true,
        zIndex: 80,
      });
    });

    for (const id of renderedPlaceIds) if (!wanted.has(id)) map.removeMarker(id);
    renderedPlaceIds = wanted;
  }

  function showPlacePopup(hit, index) {
    map.showPopup(
      [hit.lat, hit.lng],
      `<div class="popup">
         <h3>${escapeHTML(hit.name)}</h3>
         ${hit.address ? `<div class="meta">${escapeHTML(hit.address)}</div>` : ''}
         <div class="popup-actions">
           <button class="primary" data-action="add-result" data-index="${index}">Add to route</button>
           <button data-action="copy-coords" data-lat="${hit.lat}" data-lng="${hit.lng}">Copy coords</button>
         </div>
         <div class="coords">${hit.lat.toFixed(5)}, ${hit.lng.toFixed(5)}${
           hit.source ? ` · via ${escapeHTML(hit.source)}` : ''
         }</div>
       </div>`
    );
  }

  function openResult(index) {
    const hit = state.ui.placeResults[index];
    if (!hit) return;
    map.panTo([hit.lat, hit.lng], hit.kind === 'segment' ? 14 : 16);
    if (hit.kind === 'access') {
      const feature = accessPoints.features.find((f) => f.properties.id === hit.id);
      if (feature) showAccessPopup(feature);
    } else if (hit.kind === 'segment') {
      const feature = corridor.features.find((f) => (f.properties || {}).id === hit.id);
      if (feature) showSegmentPopup(feature);
    } else {
      showPlacePopup(hit, index);
    }
  }

  function addResultToRoute(index) {
    const hit = state.ui.placeResults[index];
    if (!hit) return;
    addPin(hit.lat, hit.lng, {
      name: hit.name,
      notes: hit.kind === 'place' ? hit.address || '' : '',
      sourceId: hit.kind === 'access' ? hit.id : null,
    });

    // Drop it from the results: it is a route stop now, and leaving the search
    // marker behind would stack a second pin on the same spot.
    state.ui.placeResults.splice(index, 1);
    if (!state.ui.placeResults.length) state.ui.placeStatus = null;
    renderPlaceResults();
    drawPlaceMarkers();

    map.closePopup();
    toast(`Added “${hit.name}” to the route.`);
  }

  // ----------------------------------------------------------------- places

  /** Corridor segments in the shape Places wants: name plus a measured path. */
  function corridorPaths() {
    return corridor.features
      .filter((f) => f.geometry && f.geometry.type === 'LineString')
      .map((f) => {
        const coords = f.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
        return { name: (f.properties || {}).name || '', coords, cum: Geo.cumulative(coords) };
      });
  }

  /** Recompute regions and the half-mile filter from whatever is resolved. */
  function relocatePlaces() {
    const result = Places.locate(places, corridorPaths());
    locatedPlaces = result.near;
    farPlaces = result.far;
  }

  const isFavorite = (id) => state.settings.favoritePlaces.includes(id);

  function toggleFavorite(id) {
    const favorites = state.settings.favoritePlaces;
    const at = favorites.indexOf(id);
    if (at >= 0) favorites.splice(at, 1);
    else favorites.push(id);
    renderPlaces();
    drawPlaces();
    save();
  }

  function visiblePlaces() {
    const hidden = state.settings.hiddenVibes;
    return locatedPlaces.filter((p) => !hidden.includes(p.vibe));
  }

  function drawPlaces() {
    const wanted = new Set();
    const show = state.settings.showPlaces;

    for (const place of show ? visiblePlaces() : []) {
      const id = `venue-${place.id}`;
      wanted.add(id);
      map.setMarker(id, {
        position: [place.lat, place.lng],
        icon: Icons.venueIcon(Places.vibeMeta(place.vibe).marker, isFavorite(place.id)),
        title: place.name,
        visible: true,
        zIndex: 60,
      });
      map.setMarkerVisible(id, true);
    }

    for (const id of renderedVenueIds) if (!wanted.has(id)) map.removeMarker(id);
    renderedVenueIds = wanted;
  }

  function showVenuePopup(place) {
    const meta = Places.vibeMeta(place.vibe);
    map.showPopup(
      [place.lat, place.lng],
      `<div class="popup">
         <h3>${escapeHTML(place.name)}</h3>
         <div class="meta">
           <span class="status-badge" style="background:${meta.marker}">${escapeHTML(meta.label)}</span>
           <span>${escapeHTML(place.region)}</span>
         </div>
         <div class="popup-actions">
           <button class="primary" data-action="add-place" data-id="${escapeHTML(place.id)}">Add to route</button>
           <button data-action="fav-place" data-id="${escapeHTML(place.id)}">
             ${isFavorite(place.id) ? 'Unfavourite' : 'Favourite'}
           </button>
         </div>
       </div>`
    );
  }

  function renderPlaces() {
    $('placesControls').style.display = state.settings.showPlaces ? '' : 'none';

    // Vibe chips, only for the vibes the dataset actually uses.
    const present = [...new Set(places.map((p) => p.vibe))].sort(
      (a, b) =>
        Places.VIBES.findIndex((v) => v.id === a) - Places.VIBES.findIndex((v) => v.id === b)
    );
    const chips = $('placeVibeChips');
    chips.innerHTML = '';
    for (const vibe of present) {
      const meta = Places.vibeMeta(vibe);
      const on = !state.settings.hiddenVibes.includes(vibe);
      const count = locatedPlaces.filter((p) => p.vibe === vibe).length;
      const button = document.createElement('button');
      button.className = 'chip chip-status';
      button.dataset.vibe = vibe;
      button.setAttribute('aria-pressed', String(on));
      button.innerHTML =
        `<span class="chip-dot" style="background:${meta.marker}"></span>` +
        `${escapeHTML(meta.label)} <em>${count}</em>`;
      chips.appendChild(button);
    }

    const unresolved = places.filter((p) => !Number.isFinite(p.lat) && !p.notFound).length;
    const notFound = places.filter((p) => p.notFound).length;
    $('placesCount').textContent = locatedPlaces.length
      ? `(${visiblePlaces().length} within ½ mile)`
      : '';
    $('resolvePlacesBtn').hidden = unresolved === 0;
    $('resolvePlacesBtn').disabled = resolving;
    $('exportPlacesBtn').hidden = unresolved > 0 || !locatedPlaces.length;
    $('exportPlacesBtn').textContent = `Export the ½-mile list (${locatedPlaces.length})`;

    const status = $('placesStatus');
    if (placesStatus) {
      status.textContent = placesStatus.message;
      status.className = `search-status search-${placesStatus.kind}`;
      status.hidden = false;
    } else if (unresolved) {
      status.textContent =
        `${unresolved} place${unresolved === 1 ? '' : 's'} still need locating. ` +
        'This looks each one up once and remembers it.';
      status.className = 'search-status search-empty';
      status.hidden = false;
    } else if (farPlaces.length || notFound) {
      const parts = [];
      if (farPlaces.length) parts.push(`${farPlaces.length} further than half a mile from the trail`);
      if (notFound) parts.push(`${notFound} not found in Atlanta`);
      status.textContent = `Left out: ${parts.join(', ')}.`;
      status.className = 'search-status search-empty';
      status.hidden = false;
    } else {
      status.hidden = true;
    }

    const container = $('placeGroups');
    container.innerHTML = '';
    const groups = Places.group(locatedPlaces, {
      favorites: state.settings.favoritePlaces,
      vibeFilter: present.filter((v) => !state.settings.hiddenVibes.includes(v)),
    });

    for (const group of groups) {
      const section = document.createElement('section');
      section.className = 'place-region';
      section.innerHTML =
        `<h3>${escapeHTML(group.region)} <span class="region-count">${group.count}</span></h3>`;

      for (const vibe of group.vibes) {
        const meta = Places.vibeMeta(vibe.vibe);
        const block = document.createElement('div');
        block.className = 'place-vibe';
        block.innerHTML =
          `<h4><span class="vibe-dot" style="background:${meta.marker}"></span>` +
          `${escapeHTML(vibe.label)}</h4>`;

        const list = document.createElement('ul');
        list.className = 'place-list';
        for (const place of vibe.places) {
          const li = document.createElement('li');
          if (place.favorite) li.className = 'is-favorite';
          li.innerHTML = `
            <button class="place-fav" data-fav="${escapeHTML(place.id)}"
                    aria-pressed="${place.favorite}"
                    title="${place.favorite ? 'Remove from favourites' : 'Favourite, to send it to the top'}"
                    aria-label="${place.favorite ? 'Unfavourite' : 'Favourite'} ${escapeHTML(place.name)}"
              >${place.favorite ? '★' : '☆'}</button>
            <button class="place-open" data-place="${escapeHTML(place.id)}"
                    title="${escapeHTML(place.name)}">${escapeHTML(place.name)}</button>
            <button class="place-add" data-add-place="${escapeHTML(place.id)}"
                    title="Add to the route"
                    aria-label="Add ${escapeHTML(place.name)} to the route">+</button>`;
          list.appendChild(li);
        }
        block.appendChild(list);
        section.appendChild(block);
      }

      container.appendChild(section);
    }
  }

  async function resolvePlaces() {
    if (resolving) return;
    resolving = true;
    placesStatus = { kind: 'searching', message: 'Looking places up…' };
    renderPlaces();

    try {
      places = await Places.resolve(places, {
        preferGoogle: state.settings.basemap === 'google',
        onProgress: ({ done, total, name, finished }) => {
          placesStatus = finished
            ? null
            : { kind: 'searching', message: `Looking up ${name}… (${done + 1} of ${total})` };
          renderPlaces();
        },
      });
      relocatePlaces();
      placesStatus = null;
      renderPlaces();
      drawPlaces();
      toast(`${locatedPlaces.length} places are within half a mile of the trail.`);
    } catch (err) {
      console.warn('Could not resolve places:', err);
      placesStatus = { kind: 'error', message: err.message || 'Could not look those places up.' };
      renderPlaces();
    } finally {
      resolving = false;
      renderPlaces();
    }
  }

  /**
   * Write the list back out, keeping only what is actually within half a mile.
   *
   * The rule is that the file holds nearby places, not the whole guide, so the
   * export applies the filter rather than leaving it to whoever commits the
   * result. Anything out of range or unfindable is reported, not silently
   * dropped.
   */
  function exportPlaces() {
    if (!locatedPlaces.length) {
      toast('Nothing to export yet — resolve the places first.');
      return;
    }

    const resolved = locatedPlaces
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => {
        const out = { id: p.id, name: p.name, vibe: p.vibe };
        out.lat = Number(p.lat.toFixed(6));
        out.lng = Number(p.lng.toFixed(6));
        return out;
      });

    const dropped = farPlaces.length + places.filter((p) => p.notFound).length;
    Exporters.download(
      'places.json',
      'application/json',
      `${JSON.stringify(
        {
          name: 'Places within half a mile of the BeltLine',
          source: 'Filtered from data/sources/apple-maps-guide.json.',
          note:
            `Measured against the corridor in the app: ${resolved.length} within half a mile, ` +
            `${dropped} left out for being further away or not findable in Atlanta.`,
          places: resolved,
        },
        null,
        2
      )}\n`
    );
    toast(`Exported ${resolved.length} places within half a mile; ${dropped} left out.`);
  }

  function addPlaceToRoute(id) {
    const place = locatedPlaces.find((p) => p.id === id);
    if (!place) return;
    addPin(place.lat, place.lng, { name: place.name });
    map.closePopup();
    toast(`Added “${place.name}” to the route.`);
  }

  function renderAccessControls() {
    $('accessControls').style.display = state.settings.showAccess ? '' : 'none';

    const types = [...new Set(accessPoints.features.map((f) => f.properties.type))].sort();
    const chips = $('accessTypeChips');
    chips.innerHTML = '';
    for (const type of types) {
      const on = !state.settings.hiddenAccessTypes.includes(type);
      const button = document.createElement('button');
      button.className = 'chip';
      button.dataset.type = type;
      button.setAttribute('aria-pressed', String(on));
      button.textContent = type;
      chips.appendChild(button);
    }

    const visible = visibleAccessPoints();
    $('accessCount').textContent = `(${visible.length} of ${accessPoints.features.length})`;

    const list = $('accessList');
    list.innerHTML = '';
    if (!visible.length) {
      const empty = document.createElement('li');
      empty.className = 'access-empty';
      empty.textContent = 'Nothing matches those filters.';
      list.appendChild(empty);
      return;
    }
    for (const feature of visible) {
      const p = feature.properties;
      const color = (Icons.TYPE_STYLES[p.type] || Icons.TYPE_STYLES.street).color;
      const li = document.createElement('li');
      li.innerHTML = `
        <button data-ap="${escapeHTML(p.id)}" title="${escapeHTML(p.name)}">
          <span class="dot" style="background:${color}"></span>
          <span class="name">${escapeHTML(p.name)}</span>
          <span class="add" aria-hidden="true">›</span>
        </button>`;
      list.appendChild(li);
    }
  }

  // ------------------------------------------------------------ the redraw

  /** Single place that recomputes, redraws, re-renders and saves. */
  function commit() {
    computeRoute();
    if (map) {
      drawPins();
      drawRoute();
    }
    renderSidebar();
    save();
  }

  function redrawEverything() {
    drawCorridor();
    drawAccessPoints();
    drawPlaces();
    drawPlaceMarkers();
    drawPins();
    drawRoute();
  }

  // --------------------------------------------------------------- the map

  async function initMap(kind) {
    const container = $('map');
    $('mapError').hidden = true;

    if (map) {
      map.destroy();
      map = null;
      container.innerHTML = '';
      renderedPinIds = new Set();
      renderedAccessIds = new Set();
      renderedSegmentIds = new Set();
    }

    try {
      map = await MapKit.createMap(kind, container, {
        center: ATLANTA,
        zoom: DEFAULT_ZOOM,
        apiKey: state.settings.googleKey,
      });
    } catch (err) {
      console.error(err);
      showMapError(err.message || String(err), kind);
      return;
    }

    map.on('mapClick', (position) => {
      if (state.ui.dropMode) dropPinAt(position);
      else map.closePopup();
    });

    map.on('markerClick', (id) => {
      if (id.startsWith('ap-marker-')) {
        const apId = id.slice('ap-marker-'.length);
        const feature = accessPoints.features.find((f) => f.properties.id === apId);
        if (!feature) return;
        // Clicking an access point while dropping pins means "add this one",
        // rather than making you open the popup to press the button in it.
        if (state.ui.dropMode) {
          const [lng, lat] = feature.geometry.coordinates;
          addPin(lat, lng, { name: feature.properties.name, sourceId: apId });
          toast(`Added “${feature.properties.name}” to the route.`);
        } else {
          showAccessPopup(feature);
        }
      } else if (id.startsWith('venue-')) {
        const place = locatedPlaces.find((p) => p.id === id.slice('venue-'.length));
        if (!place) return;
        if (state.ui.dropMode) addPlaceToRoute(place.id);
        else showVenuePopup(place);
      } else if (id.startsWith('place-marker-')) {
        const index = Number(id.slice('place-marker-'.length));
        const hit = state.ui.placeResults[index];
        if (!hit) return;
        if (state.ui.dropMode) {
          addResultToRoute(index);
        } else {
          showPlacePopup(hit, index);
        }
      } else if (id.startsWith('pin-')) {
        const pin = state.pins.find((p) => p.id === id.slice('pin-'.length));
        if (!pin) return;
        state.ui.selectedPinId = pin.id;
        renderSidebar();
        drawPins();
        showPinPopup(pin);
      }
    });

    map.on('markerDragEnd', (id, position) => {
      if (!id.startsWith('pin-')) return;
      const pin = state.pins.find((p) => p.id === id.slice('pin-'.length));
      if (!pin) return;
      pin.lat = position[0];
      pin.lng = position[1];
      commit();
    });

    redrawEverything();
    fitLoop();
    if (state.settings.basemap !== kind) {
      state.settings.basemap = kind;
      save();
    }
  }

  function showMapError(message, kind) {
    $('mapErrorText').textContent = message;
    $('mapError').hidden = false;
    $('mapErrorFallback').hidden = kind === 'osm';
  }

  function fitLoop() {
    if (!map) return;
    const all = [...(spine || [])];
    for (const pin of state.pins) all.push([pin.lat, pin.lng]);
    if (all.length) map.fitBounds(Geo.bounds(all), 40);
  }

  function setDropMode(on) {
    state.ui.dropMode = on;
    $('dropModeBtn').setAttribute('aria-pressed', String(on));
    $('dropHint').hidden = !on;
    $('map').classList.toggle('drop-mode', on);
    if (map) map.setCursor(on ? 'crosshair' : '');
  }

  // ------------------------------------------------------------ export bits

  function exportBundle() {
    return {
      pins: state.pins,
      routeCoords: route.coords,
      routeLength: route.distance,
      routeMode: state.settings.routeMode,
      routeName: 'Atlanta BeltLine route',
      corridor: state.settings.includeCorridor ? corridor : null,
      access: state.settings.includeAccess ? accessPoints : null,
    };
  }

  function doDownload(formatKey) {
    const format = Exporters.FORMATS[formatKey];
    const bundle = exportBundle();
    if (!bundle.pins.length && !bundle.corridor && !bundle.access) {
      toast('Nothing to download yet — drop a pin or include the corridor.');
      return;
    }
    const date = new Date().toISOString().slice(0, 10);
    Exporters.download(
      `atlanta-beltline-${date}.${format.extension}`,
      format.mime,
      format.build(bundle)
    );
    toast(`Downloaded ${format.label}.`);
  }

  function openInGoogleMaps() {
    const stops = state.pins.filter((p) => p.inRoute !== false);
    if (stops.length < 2) return;

    // The Google Maps URL API takes an origin, a destination and at most nine
    // waypoints between them.
    const MAX_WAYPOINTS = 9;
    const middle = stops.slice(1, -1);
    const trimmed = middle.length > MAX_WAYPOINTS;
    const waypoints = trimmed ? middle.slice(0, MAX_WAYPOINTS) : middle;
    const at = (p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;

    const url = new URL('https://www.google.com/maps/dir/');
    url.searchParams.set('api', '1');
    url.searchParams.set('origin', at(stops[0]));
    url.searchParams.set('destination', at(stops[stops.length - 1]));
    url.searchParams.set('travelmode', GOOGLE_TRAVEL[state.settings.travelMode]);
    if (waypoints.length) url.searchParams.set('waypoints', waypoints.map(at).join('|'));

    if (trimmed) {
      toast(`Google Maps allows ${MAX_WAYPOINTS} stops between the ends — the rest were left out.`, 6000);
    }
    window.open(url.toString(), '_blank', 'noopener');
  }

  async function handleImport(file) {
    let parsed;
    try {
      parsed = Exporters.parseImport(await file.text(), file.name);
    } catch (err) {
      toast(`Could not read ${file.name}: ${err.message}`, 6000);
      return;
    }

    if (parsed.pins.length) {
      for (const p of parsed.pins) {
        addPin(p.lat, p.lng, { name: p.name, notes: p.notes, inRoute: p.inRoute });
      }
    }

    let replacedCorridor = false;
    if (parsed.corridor && parsed.corridor.features.length) {
      const count = parsed.corridor.features.length;
      replacedCorridor = window.confirm(
        `${file.name} contains ${count} line${count === 1 ? '' : 's'}.\n\n` +
          'Replace the built-in BeltLine corridor with them? This is how you load the official ' +
          'alignment. Cancel to import only the points.'
      );
      if (replacedCorridor) {
        corridor = {
          type: 'FeatureCollection',
          name: file.name,
          features: parsed.corridor.features.map((f, i) => ({
            ...f,
            properties: {
              status: 'open',
              ...f.properties,
              id: (f.properties && f.properties.id) || `imported-${i + 1}`,
              name: (f.properties && f.properties.name) || `Imported line ${i + 1}`,
              lengthMeters: Math.round(
                Geo.pathLength(f.geometry.coordinates.map(([lng, lat]) => [lat, lng]))
              ),
            },
          })),
        };
        rebuildSpine();
        state.settings.hiddenSegments = [];
        drawCorridor();
        fitLoop();
      }
    }

    commit();
    const bits = [];
    if (parsed.pins.length) bits.push(`${parsed.pins.length} pin${parsed.pins.length === 1 ? '' : 's'}`);
    if (replacedCorridor) bits.push('a new corridor');
    toast(bits.length ? `Imported ${bits.join(' and ')}.` : `Nothing usable found in ${file.name}.`);
  }

  // ----------------------------------------------------------------- wiring

  function wireControls() {
    $('sidebarToggle').addEventListener('click', () => {
      const collapsed = $('app').classList.toggle('sidebar-collapsed');
      $('sidebarToggle').setAttribute('aria-expanded', String(!collapsed));
      // Leaflet and Google both need telling that their viewport changed.
      setTimeout(() => map && map.invalidateSize(), 200);
    });

    $('dropModeBtn').addEventListener('click', () => setDropMode(!state.ui.dropMode));
    $('fitLoopBtn').addEventListener('click', fitLoop);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.ui.dropMode) setDropMode(false);
    });

    // --- route controls
    $('routeMode').addEventListener('change', (e) => {
      state.settings.routeMode = e.target.value;
      commit();
    });
    $('travelMode').addEventListener('change', (e) => {
      state.settings.travelMode = e.target.value;
      commit();
    });
    $('closeLoop').addEventListener('change', (e) => {
      state.settings.closeLoop = e.target.checked;
      commit();
    });
    $('reverseBtn').addEventListener('click', () => {
      state.pins.reverse();
      commit();
    });
    $('sortByLoopBtn').addEventListener('click', sortAlongLoop);
    $('clearPinsBtn').addEventListener('click', () => {
      if (!state.pins.length) return;
      if (!window.confirm(`Delete all ${state.pins.length} pins?`)) return;
      state.pins = [];
      state.ui.selectedPinId = null;
      commit();
    });

    // --- pin list: buttons, renaming, drag to reorder
    const list = $('pinList');

    list.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-act]');
      if (!button) return;
      const id = button.closest('.pin-item').dataset.id;
      const pin = state.pins.find((p) => p.id === id);
      if (!pin) return;

      switch (button.dataset.act) {
        case 'toggle':
          pin.inRoute = pin.inRoute === false;
          commit();
          break;
        case 'locate':
          state.ui.selectedPinId = id;
          map.panTo([pin.lat, pin.lng], 16);
          showPinPopup(pin);
          renderSidebar();
          drawPins();
          break;
        case 'up':
          movePin(id, -1);
          break;
        case 'down':
          movePin(id, 1);
          break;
        case 'remove':
          removePin(id);
          break;
      }
    });

    list.addEventListener('input', (event) => {
      if (!event.target.classList.contains('pin-name')) return;
      const pin = state.pins.find((p) => p.id === event.target.closest('.pin-item').dataset.id);
      if (!pin) return;
      pin.name = event.target.value;
      drawPins();
      save();
    });

    list.addEventListener('keydown', (event) => {
      if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
      const item = event.target.closest('.pin-item');
      if (!item) return;
      event.preventDefault();
      movePin(item.dataset.id, event.key === 'ArrowUp' ? -1 : 1);
      // Keep the keyboard on the row that just moved.
      const moved = list.querySelector(`.pin-item[data-id="${item.dataset.id}"] .pin-name`);
      if (moved) moved.focus();
    });

    let dragFrom = null;
    list.addEventListener('dragstart', (event) => {
      const item = event.target.closest('.pin-item');
      if (!item) return;
      dragFrom = Number(item.dataset.index);
      item.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', item.dataset.id);
    });
    list.addEventListener('dragend', () => {
      dragFrom = null;
      for (const el of list.querySelectorAll('.dragging, .drop-target')) {
        el.classList.remove('dragging', 'drop-target');
      }
    });
    list.addEventListener('dragover', (event) => {
      const item = event.target.closest('.pin-item');
      if (!item || dragFrom === null) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      for (const el of list.querySelectorAll('.drop-target')) el.classList.remove('drop-target');
      item.classList.add('drop-target');
    });
    list.addEventListener('drop', (event) => {
      const item = event.target.closest('.pin-item');
      if (!item || dragFrom === null) return;
      event.preventDefault();
      reorderPin(dragFrom, Number(item.dataset.index));
      dragFrom = null;
    });

    // --- place search
    const searchInput = $('placeSearch');
    searchInput.addEventListener('input', (e) => {
      state.ui.placeQuery = e.target.value;
      clearTimeout(searchDebounce);
      // Local hits update as you type; the geocoder only runs on demand, so
      // typing never fires a burst of requests at it.
      searchDebounce = setTimeout(updateLocalResults, 120);
    });
    searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        runPlaceSearch();
      } else if (event.key === 'Escape') {
        searchInput.value = '';
        state.ui.placeQuery = '';
        clearPlaceResults();
      }
    });
    $('placeSearchBtn').addEventListener('click', runPlaceSearch);
    $('clearResultsBtn').addEventListener('click', () => {
      searchInput.value = '';
      state.ui.placeQuery = '';
      clearPlaceResults();
    });
    $('placeResults').addEventListener('click', (event) => {
      const add = event.target.closest('button[data-add-result]');
      if (add) {
        addResultToRoute(Number(add.dataset.addResult));
        return;
      }
      const open = event.target.closest('button[data-result]');
      if (open) openResult(Number(open.dataset.result));
    });

    // --- places
    $('showPlaces').addEventListener('change', (e) => {
      state.settings.showPlaces = e.target.checked;
      renderPlaces();
      drawPlaces();
      save();
    });
    $('placeVibeChips').addEventListener('click', (event) => {
      const chip = event.target.closest('.chip-status');
      if (!chip) return;
      const hidden = state.settings.hiddenVibes;
      const at = hidden.indexOf(chip.dataset.vibe);
      if (at >= 0) hidden.splice(at, 1);
      else hidden.push(chip.dataset.vibe);
      renderPlaces();
      drawPlaces();
      save();
    });
    $('resolvePlacesBtn').addEventListener('click', resolvePlaces);
    $('exportPlacesBtn').addEventListener('click', exportPlaces);
    $('placeGroups').addEventListener('click', (event) => {
      const fav = event.target.closest('button[data-fav]');
      if (fav) {
        toggleFavorite(fav.dataset.fav);
        return;
      }
      const add = event.target.closest('button[data-add-place]');
      if (add) {
        addPlaceToRoute(add.dataset.addPlace);
        return;
      }
      const open = event.target.closest('button[data-place]');
      if (!open) return;
      const place = locatedPlaces.find((p) => p.id === open.dataset.place);
      if (!place) return;
      map.panTo([place.lat, place.lng], 17);
      showVenuePopup(place);
    });

    // --- layers
    $('showCorridor').addEventListener('change', (e) => {
      state.settings.showCorridor = e.target.checked;
      drawCorridor();
      renderLegend();
      save();
    });
    $('statusChips').addEventListener('click', (event) => {
      const chip = event.target.closest('.chip-status');
      if (!chip) return;
      const hidden = state.settings.hiddenStatuses;
      const at = hidden.indexOf(chip.dataset.status);
      if (at >= 0) hidden.splice(at, 1);
      else hidden.push(chip.dataset.status);
      drawCorridor();
      renderLegend();
      save();
    });
    $('segmentLegend').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-seg]');
      if (!button || button.disabled) return;
      const id = button.dataset.seg;
      const hidden = state.settings.hiddenSegments;
      const at = hidden.indexOf(id);
      if (at >= 0) hidden.splice(at, 1);
      else hidden.push(id);
      drawCorridor();
      renderLegend();
      save();
    });
    $('showAccess').addEventListener('change', (e) => {
      state.settings.showAccess = e.target.checked;
      drawAccessPoints();
      renderAccessControls();
      save();
    });
    $('accessSearch').addEventListener('input', (e) => {
      state.ui.accessSearch = e.target.value;
      drawAccessPoints();
      renderAccessControls();
    });
    $('accessTypeChips').addEventListener('click', (event) => {
      const chip = event.target.closest('.chip');
      if (!chip) return;
      const hidden = state.settings.hiddenAccessTypes;
      const at = hidden.indexOf(chip.dataset.type);
      if (at >= 0) hidden.splice(at, 1);
      else hidden.push(chip.dataset.type);
      drawAccessPoints();
      renderAccessControls();
      save();
    });
    $('accessList').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-ap]');
      if (!button) return;
      const feature = accessPoints.features.find((f) => f.properties.id === button.dataset.ap);
      if (!feature) return;
      const [lng, lat] = feature.geometry.coordinates;
      map.panTo([lat, lng], 16);
      showAccessPopup(feature);
    });

    // --- download and share
    const grid = $('downloadGrid');
    for (const [key, format] of Object.entries(Exporters.FORMATS)) {
      const button = document.createElement('button');
      button.dataset.format = key;
      button.innerHTML = `<strong>${format.label}</strong><small>${escapeHTML(format.hint)}</small>`;
      grid.appendChild(button);
    }
    grid.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-format]');
      if (button) doDownload(button.dataset.format);
    });

    $('includeCorridor').addEventListener('change', (e) => {
      state.settings.includeCorridor = e.target.checked;
      save();
    });
    $('includeAccess').addEventListener('change', (e) => {
      state.settings.includeAccess = e.target.checked;
      save();
    });
    $('shareBtn').addEventListener('click', () => {
      const link = buildShareLink();
      history.replaceState(null, '', link);
      copyText(link);
    });
    $('googleDirBtn').addEventListener('click', openInGoogleMaps);

    $('importBtn').addEventListener('click', () => $('importInput').click());
    $('importInput').addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0];
      if (file) handleImport(file);
      event.target.value = '';
    });

    // --- basemap
    for (const radio of document.querySelectorAll('input[name="basemap"]')) {
      radio.addEventListener('change', (e) => {
        if (!e.target.checked) return;
        const kind = e.target.value;
        $('googleKeyBlock').hidden = kind !== 'google';
        if (kind === 'google' && !state.settings.googleKey) {
          // Revealing the field is not enough: the sidebar is long and the
          // field can appear off-screen. Put it in front of the cursor.
          revealGoogleKeyField();
          toast('Paste your Google Maps API key, then choose “Use this key”.', 6000);
          return;
        }
        initMap(kind);
      });
    }
    $('applyKeyBtn').addEventListener('click', () => {
      const key = $('googleKey').value.trim();
      if (!key) {
        toast('Enter a Google Maps API key first.');
        return;
      }
      state.settings.googleKey = key;
      save();
      initMap('google');
    });
    $('forgetKeyBtn').addEventListener('click', () => {
      state.settings.googleKey = '';
      $('googleKey').value = '';
      save();
      document.querySelector('input[name="basemap"][value="osm"]').checked = true;
      initMap('osm');
      toast('Key forgotten. Back on OpenStreetMap.');
    });
    $('mapErrorFallback').addEventListener('click', () => {
      document.querySelector('input[name="basemap"][value="osm"]').checked = true;
      $('googleKeyBlock').hidden = true;
      initMap('osm');
    });

    $('units').addEventListener('change', (e) => {
      state.settings.units = e.target.value;
      renderSidebar();
      save();
    });
  }

  /** Bring the API key field into view and focus it, ready to paste into. */
  function revealGoogleKeyField() {
    const block = $('googleKeyBlock');
    const input = $('googleKey');
    block.hidden = false;
    block.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // Focus after the scroll starts, or Safari fights the smooth scroll.
    setTimeout(() => input.focus({ preventScroll: true }), 120);
  }

  /** Push restored settings into the form controls. */
  function syncControls() {
    const s = state.settings;
    $('routeMode').value = s.routeMode;
    $('travelMode').value = s.travelMode;
    $('closeLoop').checked = s.closeLoop;
    $('showCorridor').checked = s.showCorridor;
    $('showAccess').checked = s.showAccess;
    $('showPlaces').checked = s.showPlaces;
    $('includeCorridor').checked = s.includeCorridor;
    $('includeAccess').checked = s.includeAccess;
    $('units').value = s.units;
    $('googleKey').value = s.googleKey || '';
    const radio = document.querySelector(`input[name="basemap"][value="${s.basemap}"]`);
    if (radio) radio.checked = true;
    $('googleKeyBlock').hidden = s.basemap !== 'google';
  }

  // -------------------------------------------------------------------- boot

  async function boot() {
    try {
      await loadData();
    } catch (err) {
      console.error(err);
      showMapError(
        `The BeltLine data could not be loaded (${err.message}). If you opened this file ` +
          'directly, make sure the data folder sits next to index.html.',
        'osm'
      );
      return;
    }

    restore();
    relocatePlaces();
    syncControls();
    wireControls();
    computeRoute();
    renderSidebar();

    const kind = state.settings.basemap === 'google' && state.settings.googleKey ? 'google' : 'osm';
    if (state.settings.basemap === 'google' && !state.settings.googleKey) {
      state.settings.basemap = 'osm';
      syncControls();
    }
    await initMap(kind);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

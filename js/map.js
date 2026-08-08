/*
 * One map interface, two backends.
 *
 * The app never talks to Leaflet or the Google Maps SDK directly — it calls
 * the methods on this adapter, so swapping the basemap does not touch any
 * application logic.
 *
 * Coordinates crossing this boundary are always [lat, lng] arrays.
 */
(function (global) {
  'use strict';

  // Leaflet is vendored under vendor/leaflet rather than pulled from a CDN, so
  // the OpenStreetMap basemap has no third-party script dependency and the page
  // works from a plain folder. Only the map tiles need the network.
  const LEAFLET_CSS = 'vendor/leaflet/leaflet.css';
  const LEAFLET_JS = 'vendor/leaflet/leaflet.js';

  function loadScript(src, attrs) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.async = true;
      Object.assign(el, attrs || {});
      el.onload = () => resolve();
      el.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.appendChild(el);
    });
  }

  function loadStylesheet(href) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('link');
      el.rel = 'stylesheet';
      el.href = href;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error(`Could not load ${href}`));
      document.head.appendChild(el);
    });
  }

  /** Shared bookkeeping and the interface both backends implement. */
  class MapAdapter {
    constructor(container, options) {
      this.container = container;
      this.options = options || {};
      this.polylines = new Map();
      this.markers = new Map();
      this.handlers = { mapClick: [], markerClick: [], markerDragEnd: [], mapMove: [] };
    }

    on(event, handler) {
      if (!this.handlers[event]) throw new Error(`unknown map event "${event}"`);
      this.handlers[event].push(handler);
      return this;
    }

    emit(event, ...args) {
      for (const handler of this.handlers[event] || []) handler(...args);
    }
  }

  // --- Leaflet / OpenStreetMap ----------------------------------------------

  class LeafletAdapter extends MapAdapter {
    static get id() {
      return 'osm';
    }

    async init() {
      if (!global.L) {
        await Promise.all([loadStylesheet(LEAFLET_CSS), loadScript(LEAFLET_JS)]);
      }
      const L = global.L;
      this.L = L;

      this.map = L.map(this.container, {
        center: this.options.center,
        zoom: this.options.zoom,
        zoomControl: true,
        preferCanvas: false,
      });

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(this.map);

      this.popup = L.popup({ maxWidth: 280, autoPanPadding: [24, 24] });
      this.map.on('click', (e) => this.emit('mapClick', [e.latlng.lat, e.latlng.lng]));
      this.map.on('moveend', () => this.emit('mapMove'));
      return this;
    }

    setPolyline(id, coords, style) {
      const s = style || {};
      const existing = this.polylines.get(id);
      const opts = {
        color: s.color || '#333',
        weight: s.weight || 4,
        opacity: s.opacity === undefined ? 1 : s.opacity,
        dashArray: s.dash || null,
        interactive: Boolean(s.interactive),
        lineJoin: 'round',
        lineCap: 'round',
      };
      if (existing) {
        existing.setLatLngs(coords);
        existing.setStyle(opts);
        return;
      }
      const line = this.L.polyline(coords, opts);
      if (s.visible !== false) line.addTo(this.map);
      if (s.interactive && s.tooltip) line.bindTooltip(s.tooltip, { sticky: true });
      if (s.onClick) {
        line.on('click', (e) => {
          this.L.DomEvent.stop(e);
          s.onClick(id, [e.latlng.lat, e.latlng.lng]);
        });
      }
      this.polylines.set(id, line);
    }

    setPolylineVisible(id, visible) {
      const line = this.polylines.get(id);
      if (!line) return;
      if (visible && !this.map.hasLayer(line)) line.addTo(this.map);
      if (!visible && this.map.hasLayer(line)) this.map.removeLayer(line);
    }

    removePolyline(id) {
      const line = this.polylines.get(id);
      if (!line) return;
      this.map.removeLayer(line);
      this.polylines.delete(id);
    }

    setMarker(id, spec) {
      const icon = this.L.icon({
        iconUrl: spec.icon.url,
        iconSize: spec.icon.size,
        iconAnchor: spec.icon.anchor,
        popupAnchor: [0, -spec.icon.anchor[1] + 4],
      });
      const existing = this.markers.get(id);
      if (existing) {
        existing.setLatLng(spec.position);
        existing.setIcon(icon);
        existing.setZIndexOffset(spec.zIndex || 0);
        if (existing.dragging) {
          if (spec.draggable) existing.dragging.enable();
          else existing.dragging.disable();
        }
        return;
      }
      const marker = this.L.marker(spec.position, {
        icon,
        draggable: Boolean(spec.draggable),
        title: spec.title || '',
        zIndexOffset: spec.zIndex || 0,
        keyboard: true,
        alt: spec.title || 'map marker',
      });
      marker.on('click', (e) => {
        this.L.DomEvent.stopPropagation(e);
        this.emit('markerClick', id, [marker.getLatLng().lat, marker.getLatLng().lng]);
      });
      marker.on('dragend', () => {
        const p = marker.getLatLng();
        this.emit('markerDragEnd', id, [p.lat, p.lng]);
      });
      if (spec.visible !== false) marker.addTo(this.map);
      this.markers.set(id, marker);
    }

    setMarkerVisible(id, visible) {
      const marker = this.markers.get(id);
      if (!marker) return;
      if (visible && !this.map.hasLayer(marker)) marker.addTo(this.map);
      if (!visible && this.map.hasLayer(marker)) this.map.removeLayer(marker);
    }

    removeMarker(id) {
      const marker = this.markers.get(id);
      if (!marker) return;
      this.map.removeLayer(marker);
      this.markers.delete(id);
    }

    showPopup(position, html) {
      this.popup.setLatLng(position).setContent(html).openOn(this.map);
    }

    closePopup() {
      this.map.closePopup(this.popup);
    }

    fitBounds(b, padding) {
      this.map.fitBounds(
        [
          [b.south, b.west],
          [b.north, b.east],
        ],
        { padding: [padding || 32, padding || 32] }
      );
    }

    panTo(position, zoom) {
      if (zoom) this.map.setView(position, zoom);
      else this.map.panTo(position);
    }

    setCursor(cursor) {
      this.map.getContainer().style.cursor = cursor || '';
    }

    invalidateSize() {
      this.map.invalidateSize();
    }

    destroy() {
      this.map.remove();
    }
  }

  // --- Google Maps ----------------------------------------------------------

  class GoogleAdapter extends MapAdapter {
    static get id() {
      return 'google';
    }

    async init() {
      const key = this.options.apiKey;
      if (!key) throw new Error('A Google Maps API key is required for the Google basemap.');

      if (!(global.google && global.google.maps)) {
        // gm_authFailure is how the SDK reports a rejected key: it fires after
        // the script itself loads fine, so it needs its own listener.
        const authFailure = new Promise((_, reject) => {
          global.gm_authFailure = () =>
            reject(
              new Error(
                'Google rejected this API key. Check that the Maps JavaScript API is enabled, ' +
                  'billing is on, and any HTTP referrer restriction allows this page.'
              )
            );
        });
        await Promise.race([
          loadScript(
            `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async`
          ),
          authFailure,
        ]);
        // The script tag resolves before the SDK finishes booting.
        await global.google.maps.importLibrary('maps');
      }

      const gm = global.google.maps;
      this.gm = gm;
      this.map = new gm.Map(this.container, {
        center: { lat: this.options.center[0], lng: this.options.center[1] },
        zoom: this.options.zoom,
        mapTypeId: this.options.mapTypeId || 'roadmap',
        mapTypeControl: true,
        streetViewControl: true,
        fullscreenControl: false,
        clickableIcons: false,
      });

      this.infoWindow = new gm.InfoWindow({ maxWidth: 280 });
      this.map.addListener('click', (e) => this.emit('mapClick', [e.latLng.lat(), e.latLng.lng()]));
      this.map.addListener('idle', () => this.emit('mapMove'));
      return this;
    }

    setPolyline(id, coords, style) {
      const s = style || {};
      const gm = this.gm;
      const path = coords.map(([lat, lng]) => ({ lat, lng }));
      const strokeOpacity = s.opacity === undefined ? 1 : s.opacity;

      // Google has no dash property; a dashed line is a repeating symbol on an
      // otherwise invisible stroke.
      const dashed = Boolean(s.dash);
      const opts = {
        path,
        strokeColor: s.color || '#333',
        strokeWeight: s.weight || 4,
        strokeOpacity: dashed ? 0 : strokeOpacity,
        clickable: Boolean(s.interactive),
        zIndex: s.zIndex || 1,
        icons: dashed
          ? [
              {
                icon: {
                  path: 'M 0,-1 0,1',
                  strokeOpacity,
                  strokeColor: s.color || '#333',
                  strokeWeight: s.weight || 4,
                  scale: 1,
                },
                offset: '0',
                repeat: `${(s.weight || 4) * 3}px`,
              },
            ]
          : null,
      };

      const existing = this.polylines.get(id);
      if (existing) {
        existing.setOptions(opts);
        return;
      }
      const line = new gm.Polyline(opts);
      if (s.visible !== false) line.setMap(this.map);
      if (s.onClick) {
        line.addListener('click', (e) => s.onClick(id, [e.latLng.lat(), e.latLng.lng()]));
      }
      this.polylines.set(id, line);
    }

    setPolylineVisible(id, visible) {
      const line = this.polylines.get(id);
      if (line) line.setMap(visible ? this.map : null);
    }

    removePolyline(id) {
      const line = this.polylines.get(id);
      if (!line) return;
      line.setMap(null);
      this.polylines.delete(id);
    }

    setMarker(id, spec) {
      const gm = this.gm;
      const icon = {
        url: spec.icon.url,
        scaledSize: new gm.Size(spec.icon.size[0], spec.icon.size[1]),
        anchor: new gm.Point(spec.icon.anchor[0], spec.icon.anchor[1]),
      };
      const position = { lat: spec.position[0], lng: spec.position[1] };

      const existing = this.markers.get(id);
      if (existing) {
        existing.setPosition(position);
        existing.setIcon(icon);
        existing.setDraggable(Boolean(spec.draggable));
        existing.setZIndex(spec.zIndex || 0);
        return;
      }
      const marker = new gm.Marker({
        position,
        icon,
        draggable: Boolean(spec.draggable),
        title: spec.title || '',
        zIndex: spec.zIndex || 0,
        optimized: false,
        map: spec.visible === false ? null : this.map,
      });
      marker.addListener('click', () =>
        this.emit('markerClick', id, [marker.getPosition().lat(), marker.getPosition().lng()])
      );
      marker.addListener('dragend', () =>
        this.emit('markerDragEnd', id, [marker.getPosition().lat(), marker.getPosition().lng()])
      );
      this.markers.set(id, marker);
    }

    setMarkerVisible(id, visible) {
      const marker = this.markers.get(id);
      if (marker) marker.setMap(visible ? this.map : null);
    }

    removeMarker(id) {
      const marker = this.markers.get(id);
      if (!marker) return;
      marker.setMap(null);
      this.markers.delete(id);
    }

    showPopup(position, html) {
      this.infoWindow.setContent(html);
      this.infoWindow.setPosition({ lat: position[0], lng: position[1] });
      this.infoWindow.open({ map: this.map });
    }

    closePopup() {
      this.infoWindow.close();
    }

    fitBounds(b, padding) {
      const bounds = new this.gm.LatLngBounds(
        { lat: b.south, lng: b.west },
        { lat: b.north, lng: b.east }
      );
      this.map.fitBounds(bounds, padding || 32);
    }

    panTo(position, zoom) {
      this.map.panTo({ lat: position[0], lng: position[1] });
      if (zoom) this.map.setZoom(zoom);
    }

    setCursor(cursor) {
      this.map.setOptions({ draggableCursor: cursor || null });
    }

    invalidateSize() {
      this.gm.event.trigger(this.map, 'resize');
    }

    destroy() {
      for (const id of [...this.markers.keys()]) this.removeMarker(id);
      for (const id of [...this.polylines.keys()]) this.removePolyline(id);
      this.container.innerHTML = '';
    }
  }

  const BACKENDS = { osm: LeafletAdapter, google: GoogleAdapter };

  async function createMap(kind, container, options) {
    const Backend = BACKENDS[kind];
    if (!Backend) throw new Error(`unknown basemap "${kind}"`);
    const adapter = new Backend(container, options);
    await adapter.init();
    return adapter;
  }

  global.MapKit = { createMap, backends: Object.keys(BACKENDS) };
})(window);

/* Turning what is on the map into files, and files back into what is on the map. */
(function (global) {
  'use strict';

  const xml = (s) =>
    String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');

  const csvCell = (s) => {
    const v = String(s === null || s === undefined ? '' : s);
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };

  const stamp = () => new Date().toISOString();

  /**
   * @param {object} bundle
   * @param {Array}  bundle.pins       dropped pins, already in route order
   * @param {Array}  bundle.routeCoords the drawn route, [lat,lng][]
   * @param {object} bundle.corridor   BeltLine GeoJSON, or null to leave it out
   * @param {object} bundle.access     access point GeoJSON, or null
   */
  function toGeoJSON(bundle) {
    const features = [];

    bundle.pins.forEach((pin, i) => {
      features.push({
        type: 'Feature',
        properties: {
          kind: 'pin',
          name: pin.name || `Pin ${i + 1}`,
          notes: pin.notes || '',
          order: i + 1,
          inRoute: pin.inRoute !== false,
          sourceAccessPointId: pin.sourceId || null,
          'marker-color': pin.inRoute === false ? '#8b8b8b' : '#c2371f',
        },
        geometry: { type: 'Point', coordinates: [pin.lng, pin.lat] },
      });
    });

    if (bundle.routeCoords && bundle.routeCoords.length > 1) {
      features.push({
        type: 'Feature',
        properties: {
          kind: 'route',
          name: bundle.routeName || 'Planned route',
          mode: bundle.routeMode || 'straight',
          lengthMeters: Math.round(bundle.routeLength || 0),
          stroke: '#1c6fbf',
          'stroke-width': 4,
        },
        geometry: {
          type: 'LineString',
          coordinates: bundle.routeCoords.map(([lat, lng]) => [lng, lat]),
        },
      });
    }

    if (bundle.corridor) {
      for (const f of bundle.corridor.features) {
        features.push({
          ...f,
          properties: { ...f.properties, kind: 'beltline-segment', stroke: '#1b7f4d' },
        });
      }
    }

    if (bundle.access) {
      for (const f of bundle.access.features) {
        features.push({
          ...f,
          properties: { ...f.properties, kind: 'access-point', 'marker-color': '#1b7f4d' },
        });
      }
    }

    return {
      type: 'FeatureCollection',
      name: bundle.routeName || 'Atlanta BeltLine map',
      metadata: { exportedAt: stamp(), generator: 'Atlanta BeltLine Trail Planner' },
      features,
    };
  }

  function toGPX(bundle) {
    const parts = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="Atlanta BeltLine Trail Planner"',
      '     xmlns="http://www.topografix.com/GPX/1/1"',
      '     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
      '     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">',
      '  <metadata>',
      `    <name>${xml(bundle.routeName || 'Atlanta BeltLine route')}</name>`,
      `    <time>${stamp()}</time>`,
      '  </metadata>',
    ];

    bundle.pins.forEach((pin, i) => {
      parts.push(
        `  <wpt lat="${pin.lat}" lon="${pin.lng}">`,
        `    <name>${xml(pin.name || `Pin ${i + 1}`)}</name>`,
        pin.notes ? `    <desc>${xml(pin.notes)}</desc>` : '',
        '    <sym>Flag, Blue</sym>',
        '  </wpt>'
      );
    });

    if (bundle.routeCoords && bundle.routeCoords.length > 1) {
      parts.push('  <trk>', `    <name>${xml(bundle.routeName || 'Planned route')}</name>`, '    <trkseg>');
      for (const [lat, lng] of bundle.routeCoords) {
        parts.push(`      <trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}"/>`);
      }
      parts.push('    </trkseg>', '  </trk>');
    }

    if (bundle.corridor) {
      for (const f of bundle.corridor.features) {
        parts.push('  <trk>', `    <name>BeltLine — ${xml(f.properties.name)}</name>`, '    <trkseg>');
        for (const [lng, lat] of f.geometry.coordinates) {
          parts.push(`      <trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}"/>`);
        }
        parts.push('    </trkseg>', '  </trk>');
      }
    }

    parts.push('</gpx>');
    return parts.filter(Boolean).join('\n');
  }

  function toKML(bundle) {
    const parts = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<kml xmlns="http://www.opengis.net/kml/2.2">',
      '  <Document>',
      `    <name>${xml(bundle.routeName || 'Atlanta BeltLine map')}</name>`,
      '    <Style id="route"><LineStyle><color>ffbf6f1c</color><width>5</width></LineStyle></Style>',
      '    <Style id="beltline"><LineStyle><color>ff4d7f1b</color><width>4</width></LineStyle></Style>',
      '    <Style id="pin"><IconStyle><color>ff1f37c2</color>' +
        '<Icon><href>http://maps.google.com/mapfiles/kml/paddle/red-circle.png</href></Icon></IconStyle></Style>',
      '    <Style id="access"><IconStyle><color>ff4d7f1b</color>' +
        '<Icon><href>http://maps.google.com/mapfiles/kml/shapes/parks.png</href></Icon></IconStyle></Style>',
    ];

    if (bundle.pins.length) {
      parts.push('    <Folder><name>Pins</name>');
      bundle.pins.forEach((pin, i) => {
        parts.push(
          '      <Placemark>',
          `        <name>${xml(`${i + 1}. ${pin.name || `Pin ${i + 1}`}`)}</name>`,
          pin.notes ? `        <description>${xml(pin.notes)}</description>` : '',
          '        <styleUrl>#pin</styleUrl>',
          `        <Point><coordinates>${pin.lng},${pin.lat},0</coordinates></Point>`,
          '      </Placemark>'
        );
      });
      parts.push('    </Folder>');
    }

    if (bundle.routeCoords && bundle.routeCoords.length > 1) {
      parts.push(
        '    <Placemark>',
        `      <name>${xml(bundle.routeName || 'Planned route')}</name>`,
        '      <styleUrl>#route</styleUrl>',
        '      <LineString><tessellate>1</tessellate><coordinates>',
        `        ${bundle.routeCoords.map(([lat, lng]) => `${lng},${lat},0`).join(' ')}`,
        '      </coordinates></LineString>',
        '    </Placemark>'
      );
    }

    if (bundle.corridor) {
      parts.push('    <Folder><name>Atlanta BeltLine</name>');
      for (const f of bundle.corridor.features) {
        parts.push(
          '      <Placemark>',
          `        <name>${xml(f.properties.name)}</name>`,
          `        <description>${xml(f.properties.note || '')}</description>`,
          '        <styleUrl>#beltline</styleUrl>',
          '        <LineString><tessellate>1</tessellate><coordinates>',
          `          ${f.geometry.coordinates.map(([lng, lat]) => `${lng},${lat},0`).join(' ')}`,
          '        </coordinates></LineString>',
          '      </Placemark>'
        );
      }
      parts.push('    </Folder>');
    }

    if (bundle.access) {
      parts.push('    <Folder><name>Access points</name>');
      for (const f of bundle.access.features) {
        const [lng, lat] = f.geometry.coordinates;
        parts.push(
          '      <Placemark>',
          `        <name>${xml(f.properties.name)}</name>`,
          `        <description>${xml(f.properties.description || '')}</description>`,
          '        <styleUrl>#access</styleUrl>',
          `        <Point><coordinates>${lng},${lat},0</coordinates></Point>`,
          '      </Placemark>'
        );
      }
      parts.push('    </Folder>');
    }

    parts.push('  </Document>', '</kml>');
    return parts.filter(Boolean).join('\n');
  }

  function toCSV(bundle) {
    const rows = [['order', 'name', 'latitude', 'longitude', 'in_route', 'notes']];
    bundle.pins.forEach((pin, i) => {
      rows.push([
        i + 1,
        pin.name || `Pin ${i + 1}`,
        pin.lat.toFixed(6),
        pin.lng.toFixed(6),
        pin.inRoute !== false ? 'yes' : 'no',
        pin.notes || '',
      ]);
    });
    return rows.map((r) => r.map(csvCell).join(',')).join('\n');
  }

  // --- import ---------------------------------------------------------------

  const isFiniteCoord = (lat, lng) =>
    Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

  /**
   * Pull pins out of a GeoJSON or GPX document.
   * Returns { pins, corridor } — corridor is a FeatureCollection of any
   * LineStrings found, so an official BeltLine file can be imported as the
   * corridor rather than as a route.
   */
  function parseImport(text, filename) {
    const name = (filename || '').toLowerCase();
    const looksXML = /^\s*</.test(text);
    if (name.endsWith('.gpx') || (looksXML && /<gpx[\s>]/i.test(text))) return parseGPX(text);
    if (name.endsWith('.kml') || (looksXML && /<kml[\s>]/i.test(text))) return parseKML(text);
    return parseGeoJSON(JSON.parse(text));
  }

  function parseGeoJSON(doc) {
    const pins = [];
    const lines = [];
    const features =
      doc.type === 'FeatureCollection' ? doc.features || [] : doc.type === 'Feature' ? [doc] : [];

    const takePoint = (coords, props) => {
      const [lng, lat] = coords;
      if (!isFiniteCoord(lat, lng)) return;
      pins.push({
        lat,
        lng,
        name: props.name || props.Name || props.title || '',
        notes: props.notes || props.description || '',
        inRoute: props.inRoute !== false && props.kind !== 'access-point',
        order: Number.isFinite(props.order) ? props.order : null,
      });
    };

    for (const f of features) {
      const g = f.geometry;
      if (!g) continue;
      const props = f.properties || {};
      if (props.kind === 'access-point' || props.kind === 'beltline-segment') {
        if (props.kind === 'beltline-segment') lines.push(f);
        continue;
      }
      if (g.type === 'Point') takePoint(g.coordinates, props);
      else if (g.type === 'MultiPoint') for (const c of g.coordinates) takePoint(c, props);
      else if (g.type === 'LineString' || g.type === 'MultiLineString') lines.push(f);
    }

    // Honour an explicit order property when every pin carries one.
    if (pins.length && pins.every((p) => p.order !== null)) pins.sort((a, b) => a.order - b.order);
    pins.forEach((p) => delete p.order);

    return { pins, corridor: lines.length ? { type: 'FeatureCollection', features: lines } : null };
  }

  function parseXMLDoc(text, rootTag) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error(`This does not look like valid ${rootTag}.`);
    return doc;
  }

  function parseGPX(text) {
    const doc = parseXMLDoc(text, 'GPX');
    const pins = [];
    const lines = [];

    for (const wpt of doc.getElementsByTagName('wpt')) {
      const lat = parseFloat(wpt.getAttribute('lat'));
      const lng = parseFloat(wpt.getAttribute('lon'));
      if (!isFiniteCoord(lat, lng)) continue;
      const text_ = (tag) => {
        const el = wpt.getElementsByTagName(tag)[0];
        return el ? el.textContent.trim() : '';
      };
      pins.push({ lat, lng, name: text_('name'), notes: text_('desc'), inRoute: true });
    }

    for (const seg of doc.getElementsByTagName('trkseg')) {
      const coords = [];
      for (const pt of seg.getElementsByTagName('trkpt')) {
        const lat = parseFloat(pt.getAttribute('lat'));
        const lng = parseFloat(pt.getAttribute('lon'));
        if (isFiniteCoord(lat, lng)) coords.push([lng, lat]);
      }
      const trk = seg.closest ? seg.closest('trk') : null;
      const nameEl = trk ? trk.getElementsByTagName('name')[0] : null;
      if (coords.length > 1) {
        lines.push({
          type: 'Feature',
          properties: { name: nameEl ? nameEl.textContent.trim() : 'Imported track', status: 'open' },
          geometry: { type: 'LineString', coordinates: coords },
        });
      }
    }

    return { pins, corridor: lines.length ? { type: 'FeatureCollection', features: lines } : null };
  }

  function parseKML(text) {
    const doc = parseXMLDoc(text, 'KML');
    const pins = [];
    const lines = [];

    const parseCoordBlock = (el) =>
      el.textContent
        .trim()
        .split(/\s+/)
        .map((tuple) => tuple.split(',').map(Number))
        .filter(([lng, lat]) => isFiniteCoord(lat, lng))
        .map(([lng, lat]) => [lng, lat]);

    for (const placemark of doc.getElementsByTagName('Placemark')) {
      const nameEl = placemark.getElementsByTagName('name')[0];
      const descEl = placemark.getElementsByTagName('description')[0];
      const label = nameEl ? nameEl.textContent.trim() : '';
      const notes = descEl ? descEl.textContent.trim() : '';

      for (const point of placemark.getElementsByTagName('Point')) {
        const block = point.getElementsByTagName('coordinates')[0];
        if (!block) continue;
        const coords = parseCoordBlock(block);
        if (coords.length) {
          pins.push({ lat: coords[0][1], lng: coords[0][0], name: label, notes, inRoute: true });
        }
      }

      for (const line of placemark.getElementsByTagName('LineString')) {
        const block = line.getElementsByTagName('coordinates')[0];
        if (!block) continue;
        const coords = parseCoordBlock(block);
        if (coords.length > 1) {
          lines.push({
            type: 'Feature',
            properties: { name: label || 'Imported line', status: 'open', note: notes },
            geometry: { type: 'LineString', coordinates: coords },
          });
        }
      }
    }

    return { pins, corridor: lines.length ? { type: 'FeatureCollection', features: lines } : null };
  }

  // --- delivery -------------------------------------------------------------

  function download(filename, mimeType, text) {
    const blob = new Blob([text], { type: `${mimeType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  const FORMATS = {
    geojson: {
      label: 'GeoJSON',
      extension: 'geojson',
      mime: 'application/geo+json',
      build: (b) => JSON.stringify(toGeoJSON(b), null, 2),
      hint: 'Universal. Re-imports here, opens in QGIS, Felt, geojson.io.',
    },
    gpx: {
      label: 'GPX',
      extension: 'gpx',
      mime: 'application/gpx+xml',
      build: toGPX,
      hint: 'For Garmin, Wahoo, Strava, Komoot, Gaia.',
    },
    kml: {
      label: 'KML',
      extension: 'kml',
      mime: 'application/vnd.google-earth.kml+xml',
      build: toKML,
      hint: 'For Google My Maps and Google Earth.',
    },
    csv: {
      label: 'CSV',
      extension: 'csv',
      mime: 'text/csv',
      build: toCSV,
      hint: 'Just the pins, in order, as a spreadsheet.',
    },
  };

  global.Exporters = { FORMATS, toGeoJSON, toGPX, toKML, toCSV, parseImport, download };
})(window);

/* Marker artwork, as SVG data URIs so both map backends draw the same thing. */
(function (global) {
  'use strict';

  const TYPE_STYLES = {
    trailhead: { color: '#1b7f4d', glyph: 'M4 11h10M9 6l5 5-5 5' },
    park: { color: '#2f9e44', glyph: 'M9 14V8M5.5 11L9 5l3.5 6z' },
    transit: { color: '#1c6fbf', glyph: 'M6 5h6v6H6zM6 13h1M11 13h1' },
    street: { color: '#8a6d3b', glyph: 'M9 4v10M6 7h6' },
    pin: { color: '#c2371f' },
  };

  const svgToDataUri = (svg) =>
    `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg.replace(/\s+/g, ' ').trim())}`;

  /** Small circular dot for an access point. */
  function accessIcon(type, highlighted) {
    const style = TYPE_STYLES[type] || TYPE_STYLES.street;
    const r = highlighted ? 9 : 7;
    const size = 24;
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <circle cx="12" cy="12" r="${r + 2}" fill="#ffffff" opacity="0.95"/>
        <circle cx="12" cy="12" r="${r}" fill="${style.color}" stroke="#ffffff" stroke-width="1.5"/>
        ${highlighted ? '<circle cx="12" cy="12" r="3" fill="#ffffff"/>' : ''}
      </svg>`;
    return { url: svgToDataUri(svg), size: [size, size], anchor: [size / 2, size / 2] };
  }

  /** Numbered teardrop for a dropped pin. */
  function pinIcon(label, color, dimmed) {
    const w = 30;
    const h = 42;
    const fill = color || TYPE_STYLES.pin.color;
    const text =
      label === null || label === undefined || label === ''
        ? ''
        : `<text x="15" y="19.5" text-anchor="middle" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif"
             font-size="${String(label).length > 2 ? 11 : 13}" font-weight="700" fill="#ffffff">${label}</text>`;
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
        <path d="M15 41C15 41 27 25.4 27 15A12 12 0 1 0 3 15c0 10.4 12 26 12 26z"
              fill="${fill}" stroke="#ffffff" stroke-width="2.5" opacity="${dimmed ? 0.55 : 1}"/>
        ${text}
      </svg>`;
    return { url: svgToDataUri(svg), size: [w, h], anchor: [w / 2, h] };
  }

  /**
   * Search hit. Deliberately unlike both the access dots and the numbered
   * route pins, because a search result is neither yet — it is a suggestion
   * sitting on the map until you add it or clear it.
   */
  function placeIcon(highlighted) {
    const w = 26;
    const h = 34;
    const fill = highlighted ? '#4c2a86' : '#6b3fa0';
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
        <path d="M13 33S24 20.5 24 13A11 11 0 1 0 2 13c0 7.5 11 20 11 20z"
              fill="${fill}" stroke="#ffffff" stroke-width="2.5"/>
        <circle cx="13" cy="12.5" r="6" fill="none" stroke="#ffffff" stroke-width="2"/>
        <path d="M17.4 17.2 21 21" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>
      </svg>`;
    return { url: svgToDataUri(svg), size: [w, h], anchor: [w / 2, h] };
  }

  global.Icons = { accessIcon, pinIcon, placeIcon, TYPE_STYLES };
})(window);

// Utility SVG leggere per grafici inline
// Nessuna libreria esterna. SVG puro, < 5 KB.

// Palette — importata come costanti per consistenza
const C = {
  t1: '#ECEFF1',
  t2: '#93A1A8',
  t3: '#5C6970',
  bg2: '#1C2226',
  border: '#2A3237',
  band: 'rgba(110,147,168,0.15)',
  bandStroke: 'rgba(110,147,168,0.3)',
  ok: '#6FA88A',
  warn: '#D39A3C',
  alert: '#C0553F',
};

// Genera un grafico a linea con fascia target — corridoio peso, proteine, ecc.
export function svgLineChart({
  width = 390,
  height = 140,
  padding = { top: 10, right: 12, bottom: 24, left: 36 },
  points = [],         // [{x: Date|number, y: number}] — dati grezzi
  line = [],           // [{x, y}] — linea principale (media mobile)
  projection = [],     // [{x, y}] — linea tratteggiata di proiezione
  bandMin = null,      // numero — fascia target bassa (y)
  bandMax = null,      // numero — fascia target alta (y)
  xDomain = null,      // [Date, Date] — asse x fisso
  yDomain = null,      // [number, number] — asse y fisso
  xLabels = [],        // [{x, label}] — etichette asse x
  yLabels = [],        // [{y, label}] — etichette asse y
  thresholds = [],     // [{y, color, dashed}] — linee orizzontali di soglia
} = {}) {
  const w = width - padding.left - padding.right;
  const h = height - padding.top - padding.bottom;

  // Calcola domini
  const allY = [...points.map(p => p.y), ...line.map(p => p.y), ...projection.map(p => p.y)];
  if (bandMin != null) allY.push(bandMin);
  if (bandMax != null) allY.push(bandMax);
  const [yMin, yMax] = yDomain || [Math.min(...allY) - 0.5, Math.max(...allY) + 0.5];

  const allX = [...points.map(p => +p.x), ...line.map(p => +p.x), ...projection.map(p => +p.x)];
  const [xMin, xMax] = xDomain ? [+xDomain[0], +xDomain[1]] : [Math.min(...allX), Math.max(...allX)];

  const sx = v => padding.left + ((+v - xMin) / (xMax - xMin)) * w;
  const sy = v => padding.top + (1 - (v - yMin) / (yMax - yMin)) * h;

  let svg = `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" style="display:block;overflow:visible">`;

  // Fascia target
  if (bandMin != null && bandMax != null) {
    const by1 = sy(bandMax);
    const by2 = sy(bandMin);
    svg += `<rect x="${padding.left}" y="${by1}" width="${w}" height="${by2 - by1}" fill="${C.band}" rx="2"/>`;
    svg += `<line x1="${padding.left}" y1="${by1}" x2="${padding.left + w}" y2="${by1}" stroke="${C.bandStroke}" stroke-width="0.5"/>`;
    svg += `<line x1="${padding.left}" y1="${by2}" x2="${padding.left + w}" y2="${by2}" stroke="${C.bandStroke}" stroke-width="0.5"/>`;
  }

  // Soglie
  for (const t of thresholds) {
    const ty = sy(t.y);
    svg += `<line x1="${padding.left}" y1="${ty}" x2="${padding.left + w}" y2="${ty}" stroke="${t.color || C.alert}" stroke-width="0.5" ${t.dashed ? 'stroke-dasharray="4,3"' : ''}/>`;
  }

  // Punti grezzi
  for (const p of points) {
    const px = sx(p.x);
    const py = sy(p.y);
    if (px >= padding.left && px <= padding.left + w) {
      svg += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="2.5" fill="${C.t3}" opacity="0.5"/>`;
    }
  }

  // Linea principale (segmenti — buchi = interruzione)
  if (line.length >= 2) {
    let d = '';
    for (let i = 0; i < line.length; i++) {
      const px = sx(line[i].x);
      const py = sy(line[i].y);
      if (i === 0 || line[i].gap) {
        d += `M${px.toFixed(1)},${py.toFixed(1)}`;
      } else {
        d += `L${px.toFixed(1)},${py.toFixed(1)}`;
      }
    }
    svg += `<path d="${d}" fill="none" stroke="${C.t1}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
  }

  // Proiezione tratteggiata
  if (projection.length >= 2) {
    let d = '';
    for (let i = 0; i < projection.length; i++) {
      const px = sx(projection[i].x);
      const py = sy(projection[i].y);
      d += i === 0 ? `M${px.toFixed(1)},${py.toFixed(1)}` : `L${px.toFixed(1)},${py.toFixed(1)}`;
    }
    svg += `<path d="${d}" fill="none" stroke="${C.t2}" stroke-width="1.5" stroke-dasharray="6,4" stroke-linecap="round"/>`;
    // Etichetta al punto finale
    const last = projection[projection.length - 1];
    if (last.label) {
      const lx = sx(last.x);
      const ly = sy(last.y);
      svg += `<text x="${lx - 4}" y="${ly - 8}" fill="${C.t2}" font-size="10" font-weight="600" text-anchor="end">${last.label}</text>`;
    }
  }

  // Etichette asse X
  for (const l of xLabels) {
    const lx = sx(l.x);
    svg += `<text x="${lx.toFixed(1)}" y="${height - 2}" fill="${C.t3}" font-size="9" text-anchor="middle">${l.label}</text>`;
  }

  // Etichette asse Y
  for (const l of yLabels) {
    const ly = sy(l.y);
    svg += `<text x="${padding.left - 4}" y="${(ly + 3).toFixed(1)}" fill="${C.t3}" font-size="9" text-anchor="end">${l.label}</text>`;
  }

  svg += '</svg>';
  return svg;
}

// Barra orizzontale con valore e target — macro, volume, ecc.
export function svgHorizontalBar({
  width = 300,
  height = 20,
  value = 0,
  target = 100,
  bandMin = null,
  bandMax = null,
  color = C.t1,
  showValue = true,
} = {}) {
  const pct = target > 0 ? Math.min(1, value / target) : 0;
  const barW = Math.round(pct * width);

  let svg = `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" style="display:block">`;

  // Background
  svg += `<rect x="0" y="4" width="${width}" height="${height - 8}" fill="${C.border}" rx="3"/>`;

  // Banda target
  if (bandMin != null && bandMax != null && target > 0) {
    const bx1 = Math.round((bandMin / target) * width);
    const bx2 = Math.round((bandMax / target) * width);
    svg += `<rect x="${bx1}" y="2" width="${bx2 - bx1}" height="${height - 4}" fill="${C.band}" rx="2"/>`;
  }

  // Barra valore
  if (barW > 0) {
    svg += `<rect x="0" y="4" width="${barW}" height="${height - 8}" fill="${color}" rx="3" opacity="0.85"/>`;
  }

  svg += '</svg>';
  return svg;
}

// Barre divergenti da zero — forza vs baseline
export function svgDivergentBars({
  width = 340,
  rowHeight = 32,
  items = [],        // [{label, shortLabel, value, thresholds: [{pct, color}]}]
  maxPct = 15,       // scala massima % (simmetrica)
} = {}) {
  const height = items.length * rowHeight + 4;
  const centerX = width / 2;
  const barArea = (width - 120) / 2;

  let svg = `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" style="display:block">`;

  // Linea zero
  svg += `<line x1="${centerX}" y1="0" x2="${centerX}" y2="${height}" stroke="${C.border}" stroke-width="1"/>`;

  // Soglie
  const thresh5 = centerX + (-5 / maxPct) * barArea;
  const thresh10 = centerX + (-10 / maxPct) * barArea;
  svg += `<line x1="${thresh5}" y1="0" x2="${thresh5}" y2="${height}" stroke="${C.warn}" stroke-width="0.5" stroke-dasharray="4,3"/>`;
  svg += `<line x1="${thresh10}" y1="0" x2="${thresh10}" y2="${height}" stroke="${C.alert}" stroke-width="0.5" stroke-dasharray="4,3"/>`;

  items.forEach((item, i) => {
    const y = i * rowHeight + 2;
    const barY = y + 8;
    const barH = rowHeight - 16;

    // Barra
    const pct = Math.max(-maxPct, Math.min(maxPct, item.value));
    const barW = Math.abs(pct / maxPct) * barArea;
    const barX = pct >= 0 ? centerX : centerX - barW;
    const color = pct >= 0 ? C.ok : (pct >= -5 ? C.warn : C.alert);
    svg += `<rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" fill="${color}" rx="2" opacity="0.8"/>`;

    // Label sinistra
    svg += `<text x="4" y="${y + rowHeight / 2 + 4}" fill="${C.t2}" font-size="10" font-weight="500">${item.shortLabel || item.label}</text>`;

    // Valore % a destra
    const sign = pct >= 0 ? '+' : '';
    svg += `<text x="${width - 4}" y="${y + rowHeight / 2 + 4}" fill="${color}" font-size="10" font-weight="600" text-anchor="end">${sign}${pct.toFixed(1)}%</text>`;
  });

  svg += '</svg>';
  return svg;
}

// Sparkline — 4-8 punti, per le cinque leve
export function svgSparkline({
  width = 60,
  height = 20,
  values = [],
  threshold = null,
  color = C.t2,
} = {}) {
  if (values.length < 2) return '';

  const min = Math.min(...values, threshold != null ? threshold : Infinity);
  const max = Math.max(...values, threshold != null ? threshold : -Infinity);
  const range = max - min || 1;

  const sx = (i) => (i / (values.length - 1)) * width;
  const sy = (v) => height - ((v - min) / range) * (height - 4) - 2;

  let svg = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" style="display:inline-block;vertical-align:middle">`;

  // Soglia
  if (threshold != null) {
    const ty = sy(threshold);
    svg += `<line x1="0" y1="${ty.toFixed(1)}" x2="${width}" y2="${ty.toFixed(1)}" stroke="${C.alert}" stroke-width="0.5" stroke-dasharray="2,2"/>`;
  }

  // Linea
  let d = '';
  values.forEach((v, i) => {
    const px = sx(i);
    const py = sy(v);
    d += i === 0 ? `M${px.toFixed(1)},${py.toFixed(1)}` : `L${px.toFixed(1)},${py.toFixed(1)}`;
  });
  svg += `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>`;

  // Punto finale
  const lastX = sx(values.length - 1);
  const lastY = sy(values[values.length - 1]);
  svg += `<circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="2" fill="${color}"/>`;

  svg += '</svg>';
  return svg;
}

// Pallino stato — ok/warn/alert/off
export function statusDot(state, size = 6) {
  const colors = { ok: C.ok, warn: C.warn, alert: C.alert, off: C.t3 };
  const c = colors[state] || C.t3;
  return `<span style="display:inline-block;width:${size}px;height:${size}px;border-radius:50%;background:${c};flex-shrink:0"></span>`;
}

// Stato da valore e soglia — ritorna 'ok', 'warn', 'alert'
export function getStatus(value, target, { tolerance = 0, inverse = false } = {}) {
  if (value == null) return 'off';
  if (inverse) {
    if (value <= target) return 'ok';
    if (value <= target * 1.2) return 'warn';
    return 'alert';
  }
  if (tolerance > 0) {
    if (Math.abs(value - target) <= tolerance) return 'ok';
    if (Math.abs(value - target) <= tolerance * 2) return 'warn';
    return 'alert';
  }
  if (value >= target) return 'ok';
  if (value >= target * 0.8) return 'warn';
  return 'alert';
}

// Media mobile semplice con minimo punti richiesti
export function movingAverage(values, window = 7, minPoints = 4) {
  const result = [];
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - window + 1);
    const slice = values.slice(start, i + 1).filter(v => v != null && !isNaN(v));
    if (slice.length >= minPoints) {
      result.push({ index: i, value: slice.reduce((a, b) => a + b, 0) / slice.length });
    } else {
      result.push({ index: i, value: null });
    }
  }
  return result;
}

// Regressione lineare semplice — ritorna {slope, intercept}
export function linearRegression(points) {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: points[0]?.y || 0 };
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
    sumXY += p.x * p.y;
    sumXX += p.x * p.x;
  }
  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX) || 0;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

export { C as COLORS };

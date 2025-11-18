const config = {
  forecastDays: [0, 1, 2, 3, 4, 5, 6, 7],
  interpolationBase: './models/interpolation',
  interpolationTemplate: 'forecast_interpolation_{day}d.png',
  predictionsCsv: './models/predictions.csv',
  mapBounds: [11.4, 57.15, 12.5, 58.25],
  mapCenter: [11.9746, 57.7089],
  mapZoom: 11,
};

const ui = {
  daySlider: document.getElementById('forecast-slider'),
  sliderValue: document.getElementById('slider-value'),
  sensorToggle: document.getElementById('toggle-sensors'),
  overlayToggle: document.getElementById('toggle-overlay'),
  focusPanel: document.getElementById('focus-panel'),
  focusName: document.getElementById('focus-name'),
  focusMeta: document.getElementById('focus-meta'),
  focusDetailsBtn: document.getElementById('focus-details-btn'),
  imageModal: document.getElementById('image-modal'),
  imageModalImg: document.getElementById('image-modal-img'),
  imageModalClose: document.getElementById('image-modal-close'),
  imageModalBackdrop: document.getElementById('image-modal-backdrop'),
  detailsModal: document.getElementById('details-modal'),
  detailsModalTitle: document.getElementById('details-modal-title'),
  detailsModalClose: document.getElementById('details-modal-close'),
  detailsModalBackdrop: document.getElementById('details-modal-backdrop'),
  detailsTableHead: document.getElementById('details-table-head'),
  detailsTableBody: document.getElementById('details-table-body'),
};

const state = {
  currentDay: Number(ui.daySlider?.value ?? config.forecastDays[0]),
  sensorData: {},
  csvHeaders: [],
  markers: [],
  activeMarkerEl: null,
  modals: { image: false, details: false },
};

const hiddenColumns = new Set(['longitude', 'latitude', 'sensor_id', 'city_y', 'city_x', 'street', 'country', 'feed_url']);

const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        attribution: '© OpenStreetMap',
      },
    },
    layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
  },
  center: config.mapCenter,
  zoom: config.mapZoom,
  maxZoom: 14,
  maxBounds: [
    [config.mapBounds[0], config.mapBounds[1] + 0.3],
    [config.mapBounds[2], config.mapBounds[3] - 0.3],
  ],
});

map.addControl(new maplibregl.NavigationControl(), 'top-right');

const sourceId = 'pm25-interpolation';
const layerId = 'pm25-interpolation-layer';

init();

function init() {
  updateSliderLabel(state.currentDay);
  if (ui.daySlider && !ui.daySlider.value) {
    ui.daySlider.value = String(state.currentDay);
  }

  attachControlEvents();
  attachModalEvents();

  map.on('load', async () => {
    await loadRaster(state.currentDay);
    await loadCsvMarkers();
  });

  map.on('click', clearFocus);
}

function attachControlEvents() {
  ui.daySlider?.addEventListener('input', (event) => {
    const day = Number(event.target.value);
    updateSliderLabel(day);
    loadRaster(day);
  });

  ui.overlayToggle?.addEventListener('change', () => {
    if (ui.overlayToggle.checked) loadRaster(state.currentDay);
    else removeRasterLayer();
  });

  ui.sensorToggle?.addEventListener('change', () => {
    state.markers.forEach((marker) => {
      if (ui.sensorToggle.checked) marker.addTo(map);
      else marker.remove();
    });
    if (!ui.sensorToggle.checked) clearFocus();
  });

  ui.focusDetailsBtn?.addEventListener('click', () => {
    if (!ui.focusDetailsBtn.dataset.sensorId) return;
    openDetailsModal(ui.focusDetailsBtn.dataset.sensorId);
  });
}

function attachModalEvents() {
  ui.imageModalClose?.addEventListener('click', closeImageModal);
  ui.imageModalBackdrop?.addEventListener('click', closeImageModal);
  ui.detailsModalClose?.addEventListener('click', closeDetailsModal);
  ui.detailsModalBackdrop?.addEventListener('click', closeDetailsModal);

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (state.modals.image) closeImageModal();
    if (state.modals.details) closeDetailsModal();
  });
}

function updateSliderLabel(day) {
  state.currentDay = day;
  if (!ui.sliderValue) return;
  ui.sliderValue.textContent = day === 0 ? 'Today' : day === 1 ? 'Tomorrow' : `Day ${day}`;
}

function buildRasterUrl(day) {
  return `${config.interpolationBase}/${config.interpolationTemplate.replace('{day}', day)}`;
}

function waitForStyle() {
  return new Promise((resolve) => {
    if (map.isStyleLoaded()) resolve();
    else map.once('styledata', resolve);
  });
}

function removeRasterLayer() {
  if (map.getLayer(layerId)) map.removeLayer(layerId);
  if (map.getSource(sourceId)) map.removeSource(sourceId);
}

async function loadRaster(day) {
  state.currentDay = day;
  if (ui.daySlider && ui.daySlider.value !== String(day)) {
    ui.daySlider.value = String(day);
  }
  if (ui.overlayToggle && !ui.overlayToggle.checked) {
    removeRasterLayer();
    return;
  }

  await waitForStyle();
  removeRasterLayer();

  map.addSource(sourceId, {
    type: 'image',
    url: buildRasterUrl(day),
    coordinates: [
      [config.mapBounds[0], config.mapBounds[3]],
      [config.mapBounds[2], config.mapBounds[3]],
      [config.mapBounds[2], config.mapBounds[1]],
      [config.mapBounds[0], config.mapBounds[1]],
    ],
  });

  map.addLayer({
    id: layerId,
    type: 'raster',
    source: sourceId,
    paint: {
      'raster-opacity': 0.75,
      'raster-resampling': 'linear',
    },
  });
}

async function loadCsvMarkers() {
  if (!config.predictionsCsv) return;

  try {
    const response = await fetch(config.predictionsCsv);
    if (!response.ok) throw new Error(`Failed to fetch CSV (${response.status})`);

    const rows = parseCsv(await response.text());
    state.csvHeaders = rows.length ? Object.keys(rows[0]) : [];

    state.markers.forEach((marker) => marker.remove());
    state.markers = [];
    state.sensorData = {};
    clearFocus();

    rows.forEach((row) => ingestRow(row));
    state.markers = Object.values(state.sensorData).map(createMarker);
  } catch (error) {
    console.error('Failed to load predictions CSV', error);
  }
}

function ingestRow(row) {
  const sensorId = row.sensor_id || row.sensorId;
  const lat = parseFloat(row.latitude ?? row.lat);
  const lon = parseFloat(row.longitude ?? row.lon ?? row.lng);
  if (!sensorId || Number.isNaN(lat) || Number.isNaN(lon)) return;

  if (!state.sensorData[sensorId]) {
    state.sensorData[sensorId] = {
      sensorId,
      lat,
      lon,
      city: row.city_y || '',
      street: row.street || '',
      latestValue: null,
      rows: [],
    };
  }

  const entry = state.sensorData[sensorId];
  entry.rows.push(row);

  const predicted = parseFloat(row.predicted_pm25 ?? row.predicted ?? 'NaN');
  const actual = parseFloat(row.pm25 ?? 'NaN');
  if (Number.isFinite(predicted)) entry.latestValue = predicted;
  else if (Number.isFinite(actual)) entry.latestValue = actual;
}

function createMarker(entry) {
  const element = document.createElement('div');
  element.className = 'sensor-marker';
  element.style.background = getAQIColor(entry.latestValue ?? 0);
  element.addEventListener('click', (event) => {
    event.stopPropagation();
    focusOnSensor(entry.sensorId, element);
  });

  const popup = new maplibregl.Popup({ closeButton: false, offset: 12 }).setHTML(buildPopupHtml(entry));

  const marker = new maplibregl.Marker({ element })
    .setLngLat([entry.lon, entry.lat])
    .setPopup(popup);

  if (ui.sensorToggle?.checked ?? true) marker.addTo(map);
  return marker;
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) return [];
  const headers = splitCsvLine(lines[0]);

  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    return headers.reduce((acc, key, idx) => {
      acc[key] = cells[idx] ?? '';
      return acc;
    }, {});
  });
}

function splitCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  result.push(current);
  return result.map((cell) => cell.replace(/^"|"$/g, '').trim());
}

function getAQIColor(aqi) {
  if (aqi <= 50) return '#00e400';
  if (aqi <= 100) return '#ffff00';
  if (aqi <= 150) return '#ff7e00';
  if (aqi <= 200) return '#ff0000';
  return '#8f3f97';
}

function buildPopupHtml(entry) {
  const name = entry.street || entry.sensorId;
  const location = entry.city ? `${entry.city}<br/>` : '';
  const reading = Number.isFinite(entry.latestValue) ? `PM2.5: ${entry.latestValue.toFixed(1)}` : 'No recent value';
  return `<strong>${name}</strong><br/>${location}${reading}`;
}

function focusOnSensor(sensorId, markerEl) {
  const data = state.sensorData[sensorId];
  if (!data) return;

  if (state.activeMarkerEl && state.activeMarkerEl !== markerEl) {
    state.activeMarkerEl.classList.remove('is-active');
  }
  state.activeMarkerEl = markerEl;
  markerEl.classList.add('is-active');

  if (ui.focusPanel) ui.focusPanel.style.display = 'flex';
  if (ui.focusName) {
    const name = data.street || '';
    const location = data.city ? `${data.city}` : '';
    ui.focusName.textContent = [name, location].filter(Boolean).join(', ') || data.sensorId;
  }
  if (ui.focusMeta) {
    const latLabel = Number.isFinite(data.lat) ? data.lat.toFixed(4) : '—';
    const lonLabel = Number.isFinite(data.lon) ? data.lon.toFixed(4) : '—';
    ui.focusMeta.textContent = `Lat ${latLabel}, Lon ${lonLabel}, ID ${data.sensorId ?? '—'}`;
  }
  if (ui.focusDetailsBtn) {
    ui.focusDetailsBtn.disabled = !(data.rows && data.rows.length);
    ui.focusDetailsBtn.dataset.sensorId = data.sensorId;
  }

  updateFocusImage('forecast-card', 'focus-forecast-thumb', `./models/${sensorId}/images/forecast.png`);
  updateFocusImage('hindcast-card', 'focus-hindcast-thumb', `./models/${sensorId}/images/hindcast_prediction.png`);

  map.flyTo({
    center: [data.lon, data.lat],
    zoom: Math.max(map.getZoom(), 11),
    speed: 0.3,
  });
}

function clearFocus() {
  if (state.activeMarkerEl) {
    state.activeMarkerEl.classList.remove('is-active');
    state.activeMarkerEl = null;
  }
  if (ui.focusPanel) ui.focusPanel.style.display = 'none';
  if (ui.focusName) ui.focusName.textContent = '';
  if (ui.focusMeta) ui.focusMeta.textContent = '';
  if (ui.focusDetailsBtn) {
    ui.focusDetailsBtn.disabled = true;
    ui.focusDetailsBtn.dataset.sensorId = '';
  }
  hideFocusImage('forecast-card', 'focus-forecast-thumb');
  hideFocusImage('hindcast-card', 'focus-hindcast-thumb');
}

function updateFocusImage(cardId, thumbId, url) {
  const cardEl = document.getElementById(cardId);
  const thumbEl = document.getElementById(thumbId);
  if (!cardEl || !thumbEl) return;

  fetch(url, { method: 'HEAD' })
    .then((response) => {
      if (response.ok) {
        thumbEl.src = url;
        thumbEl.classList.remove('hidden');
        cardEl.classList.remove('hidden');
        thumbEl.onclick = () => openImageModal(url);
      } else {
        hideFocusImage(cardId, thumbId);
      }
    })
    .catch(() => hideFocusImage(cardId, thumbId));
}

function hideFocusImage(cardId, thumbId) {
  const cardEl = document.getElementById(cardId);
  const thumbEl = document.getElementById(thumbId);
  if (!cardEl || !thumbEl) return;
  thumbEl.src = '';
  thumbEl.classList.add('hidden');
  cardEl.classList.add('hidden');
  thumbEl.onclick = null;
}

function openDetailsModal(sensorId) {
  if (!ui.detailsModal) return;
  const entry = state.sensorData[sensorId];
  if (!entry || !entry.rows.length) return;

  if (ui.detailsModalTitle) {
    const titleParts = [entry.street, entry.city].filter(Boolean);
    ui.detailsModalTitle.textContent = titleParts.length ? titleParts.join(', ') : entry.sensorId;
  }

  renderDetailsTable(entry);
  ui.detailsModal.classList.remove('hidden');
  state.modals.details = true;
}

function closeDetailsModal() {
  if (!ui.detailsModal) return;
  ui.detailsModal.classList.add('hidden');
  state.modals.details = false;
}

function renderDetailsTable(entry) {
  if (!ui.detailsTableHead || !ui.detailsTableBody) return;
  const headers = (state.csvHeaders.length ? state.csvHeaders : Object.keys(entry.rows[0] || {})).filter(
    (header) => !hiddenColumns.has(header),
  );

  ui.detailsTableHead.innerHTML = '';
  ui.detailsTableBody.innerHTML = '';
  if (!headers.length) return;

  const headRow = document.createElement('tr');
  headers.forEach((header) => {
    const th = document.createElement('th');
    th.textContent = header;
    headRow.appendChild(th);
  });
  ui.detailsTableHead.appendChild(headRow);

  entry.rows.forEach((row) => {
    const tr = document.createElement('tr');
    headers.forEach((header) => {
      const td = document.createElement('td');
      td.textContent = row[header] ?? '';
      tr.appendChild(td);
    });
    ui.detailsTableBody.appendChild(tr);
  });
}

function openImageModal(src) {
  if (!ui.imageModal || !ui.imageModalImg) return;
  ui.imageModalImg.src = src;
  ui.imageModal.classList.remove('hidden');
  state.modals.image = true;
}

function closeImageModal() {
  if (!ui.imageModal || !ui.imageModalImg) return;
  ui.imageModal.classList.add('hidden');
  ui.imageModalImg.src = '';
  state.modals.image = false;
}


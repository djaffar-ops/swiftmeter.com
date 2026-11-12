const SPEEDTEST_ORIGIN = 'https://speed.cloudflare.com';
const DOWNLOAD_DURATION_MS = 3600;
const UPLOAD_DURATION_MS = 2800;
const DOWNLOAD_BYTES_PER_REQUEST = 1_000_000;
const UPLOAD_BYTES_PER_REQUEST = 750_000;

const elements = {
  speed: document.querySelector('#speed-value'),
  ring: document.querySelector('#ring-progress'),
  phase: document.querySelector('#phase-label'),
  note: document.querySelector('#status-note'),
  button: document.querySelector('#test-button'),
  buttonLabel: document.querySelector('#button-label'),
  ping: document.querySelector('#ping-value'),
  pingCaption: document.querySelector('#ping-caption'),
  download: document.querySelector('#download-value'),
  upload: document.querySelector('#upload-value'),
  error: document.querySelector('#error-message'),
};

const appState = { running: false, controller: null, phase: 'idle', history: [] };
const circleLength = 2 * Math.PI * 148;
elements.ring.style.strokeDasharray = String(circleLength);

function updateRing(speed) {
  const fill = Math.max(0.025, Math.min(0.93, Math.log10(1 + Math.max(0, speed)) / 3.25));
  elements.ring.style.strokeDashoffset = String(circleLength * (1 - fill));
}

function showLiveSpeed(speed) {
  elements.speed.textContent = formatNumber(speed);
  updateRing(speed);
  appState.history.push(speed);
  if (appState.history.length > 16) appState.history.shift();
}

function formatNumber(value, places = 1) {
  if (!Number.isFinite(value) || value < 0) return '—';
  const rounded = value < 10 ? Number(value.toFixed(places)) : Math.round(value);
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: places }).format(rounded);
}

function setPhase(phase, label, note) {
  appState.phase = phase;
  document.body.classList.toggle('is-running', phase === 'latency' || phase === 'download' || phase === 'upload');
  document.body.classList.toggle('is-finished', phase === 'done');
  document.body.classList.toggle('is-error', phase === 'error');
  elements.phase.textContent = label;
  if (note) elements.note.textContent = note;
  elements.buttonLabel.textContent = phase === 'latency' || phase === 'download' || phase === 'upload' ? 'Arrêter la mesure' : 'Relancer le test';
  elements.button.setAttribute('aria-label', phase === 'latency' || phase === 'download' || phase === 'upload' ? 'Arrêter la mesure' : 'Relancer le test de connexion');
}

function makeTestUrl(path) {
  return `${SPEEDTEST_ORIGIN}/${path}${path.includes('?') ? '&' : '?'}r=${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function measureLatency(signal) {
  const readings = [];
  for (let sample = 0; sample < 5; sample += 1) {
    if (signal.aborted) throw new DOMException('Mesure interrompue', 'AbortError');
    const start = performance.now();
    const response = await fetch(makeTestUrl('__down?bytes=1000'), { cache: 'no-store', signal });
    if (!response.ok) throw new Error('Le serveur de mesure a refusé la requête.');
    await response.arrayBuffer();
    readings.push(performance.now() - start);
    elements.ping.textContent = String(Math.round(median(readings)));
    elements.pingCaption.textContent = `latence · mesure ${sample + 1}/5`;
  }
  return { median: median(readings), jitter: Math.max(...readings) - Math.min(...readings) };
}

async function readDownload(url, signal, onBytes) {
  const response = await fetch(url, { cache: 'no-store', signal });
  if (!response.ok) throw new Error(`Erreur de téléchargement (${response.status}).`);
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    onBytes(buffer.byteLength);
    return buffer.byteLength;
  }
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      onBytes(value.byteLength);
    }
  } finally {
    if (signal.aborted) reader.cancel().catch(() => {});
  }
  return bytes;
}

async function measureDownload(signal) {
  let bytes = 0;
  let failures = 0;
  const start = performance.now();
  const workers = 3;
  const update = () => {
    const elapsed = (performance.now() - start) / 1000;
    if (elapsed > 0) showLiveSpeed((bytes * 8) / elapsed / 1_000_000);
  };
  const meter = window.setInterval(update, 120);
  const timer = window.setTimeout(() => appState.controller?.abort('download-complete'), DOWNLOAD_DURATION_MS);
  const worker = async () => {
    while (!signal.aborted) {
      try {
        await readDownload(makeTestUrl(`__down?bytes=${DOWNLOAD_BYTES_PER_REQUEST}`), signal, (chunk) => { bytes += chunk; });
      } catch (error) {
        if (signal.aborted || error?.name === 'AbortError') break;
        failures += 1;
        if (failures >= workers) throw error;
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: workers }, () => worker()));
  } finally {
    window.clearInterval(meter);
    window.clearTimeout(timer);
  }
  update();
  if (signal.aborted && signal.reason !== 'download-complete') {
    throw new DOMException('Mesure interrompue', 'AbortError');
  }
  if (bytes === 0) throw new Error('Aucune donnée reçue du serveur de mesure. Vérifiez votre réseau, puis réessayez.');
  return (bytes * 8) / Math.max(0.1, (performance.now() - start) / 1000) / 1_000_000;
}

function createPayload(size) {
  const bytes = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += 65_536) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(size, offset + 65_536)));
  }
  return new Blob([bytes], { type: 'application/octet-stream' });
}

async function measureUpload(signal) {
  const payload = createPayload(UPLOAD_BYTES_PER_REQUEST);
  let completedBytes = 0;
  let attempts = 0;
  const start = performance.now();
  const workers = 2;
  const update = () => {
    const elapsed = (performance.now() - start) / 1000;
    const estimated = completedBytes + Math.max(0, attempts - completedBytes / payload.size) * payload.size * .35;
    if (elapsed > 0 && estimated > 0) showLiveSpeed((estimated * 8) / elapsed / 1_000_000);
  };
  const meter = window.setInterval(update, 140);
  const timer = window.setTimeout(() => appState.controller?.abort('upload-complete'), UPLOAD_DURATION_MS);
  const worker = async () => {
    while (!signal.aborted) {
      attempts += 1;
      try {
        const response = await fetch(makeTestUrl('__up'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: payload,
          cache: 'no-store',
          signal,
        });
        if (!response.ok) throw new Error(`Erreur d’envoi (${response.status}).`);
        await response.arrayBuffer();
        completedBytes += payload.size;
      } catch (error) {
        if (signal.aborted || error?.name === 'AbortError') break;
        if (attempts >= workers) throw error;
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: workers }, () => worker()));
  } finally {
    window.clearInterval(meter);
    window.clearTimeout(timer);
  }
  if (signal.aborted && signal.reason !== 'upload-complete') {
    throw new DOMException('Mesure interrompue', 'AbortError');
  }
  if (completedBytes === 0) throw new Error('Le débit montant n’a pas pu être mesuré.');
  return (completedBytes * 8) / Math.max(0.1, (performance.now() - start) / 1000) / 1_000_000;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function runTest() {
  if (appState.running) {
    appState.controller?.abort('user-stopped');
    elements.button.disabled = true;
    setPhase('idle', 'Arrêt de la mesure…', 'Le test en cours se termine.');
    return;
  }

  appState.running = true;
  appState.history = [];
  elements.error.hidden = true;
  elements.ping.textContent = '—';
  elements.pingCaption.textContent = 'temps de réponse';
  elements.download.textContent = '—';
  elements.upload.textContent = '—';
  elements.speed.textContent = '0';
  updateRing(0);
  document.body.classList.remove('is-error', 'is-finished');

  try {
    appState.controller = new AbortController();
    const signal = appState.controller.signal;

    setPhase('latency', 'Recherche du serveur…', 'Connexion au serveur de mesure');
    const latency = await measureLatency(signal);
    elements.ping.textContent = String(Math.round(latency.median));
    elements.pingCaption.textContent = `latence · variation ${Math.round(latency.jitter)} ms`;

    appState.controller = new AbortController();
    setPhase('download', 'Mesure du téléchargement…', 'Lecture du débit descendant en direct');
    const download = await measureDownload(appState.controller.signal);
    elements.download.textContent = formatNumber(download);

    appState.controller = new AbortController();
    setPhase('upload', 'Mesure de l’envoi…', 'Lecture du débit montant en direct');
    const upload = await measureUpload(appState.controller.signal);
    elements.upload.textContent = formatNumber(upload);

    showLiveSpeed(download);
    setPhase('done', 'Test terminé', 'Résultats mesurés à l’instant · relancez pour comparer');
  } catch (error) {
    if (error?.name === 'AbortError') {
      if (appState.running) setPhase('idle', 'Mesure interrompue', 'Relancez le test quand vous le souhaitez.');
    } else {
      appState.controller?.abort('test-failed');
      setPhase('error', 'Test indisponible', 'La mesure n’a pas abouti.');
      elements.error.textContent = error?.message || 'Impossible de contacter le serveur de mesure. Vérifiez la connexion et réessayez.';
      elements.error.hidden = false;
    }
  } finally {
    appState.running = false;
    appState.controller = null;
    elements.button.disabled = false;
  }
}

elements.button.addEventListener('click', runTest);
window.addEventListener('DOMContentLoaded', () => runTest(), { once: true });

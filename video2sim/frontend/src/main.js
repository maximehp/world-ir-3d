import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SimulationEngine } from './sceneBuilder.js';

// DOM Elements
const canvas = document.getElementById('sim-canvas');
const viewport3d = document.getElementById('viewport-3d');
const btnSample = document.getElementById('btn-sample');
const fileInput = document.getElementById('file-input');
const modeSelect = document.getElementById('mode-select');
const apiKeyInput = document.getElementById('api-key-input');
const btnAnalyze = document.getElementById('btn-analyze');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');
const loadingSub = document.getElementById('loading-sub');
const statusBanner = document.getElementById('status-banner');

const videoPanel = document.getElementById('video-panel');
const sourceVideo = document.getElementById('source-video');
const videoMeta = document.getElementById('video-meta');
const btnToggleSplit = document.getElementById('btn-toggle-split');
const btnToggleSync = document.getElementById('btn-toggle-sync');

const sliderTod = document.getElementById('slider-tod');
const valTod = document.getElementById('val-tod');
const sliderWind = document.getElementById('slider-wind');
const valWind = document.getElementById('val-wind');
const sliderSpeed = document.getElementById('slider-speed');
const valSpeed = document.getElementById('val-speed');
const sceneStats = document.getElementById('scene-stats');
const btnJson = document.getElementById('btn-json');
const jsonModal = document.getElementById('json-modal');
const jsonContent = document.getElementById('json-content');
const btnCloseJson = document.getElementById('btn-close-json');
const presetBtns = Array.from(document.querySelectorAll('.preset-btn'));

// Restore saved Gemini API key if present
const savedKey = localStorage.getItem('video2sim_gemini_key');
if (savedKey) apiKeyInput.value = savedKey;
apiKeyInput.addEventListener('input', () => {
  localStorage.setItem('video2sim_gemini_key', apiKeyInput.value.trim());
});

// Initialize Three.js Simulation Engine + OrbitControls
const engine = new SimulationEngine(canvas);
const controls = new OrbitControls(engine.camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 6;
controls.maxDistance = 110;
controls.target.set(0, 4.5, -2);
controls.update();

// App state
let selectedFile = null;
let usingSample = false;
let latestAnalysis = null;
let syncWithVideo = true;
let simSpeed = 1.0;
let activeCamPreset = 'match';
let camTransition = null;

const CAM_PRESETS = {
  match: { pos: new THREE.Vector3(0, 11.2, 33.0), target: new THREE.Vector3(0, 4.5, -3.0) },
  iso: { pos: new THREE.Vector3(26, 22, 26), target: new THREE.Vector3(0, 2.5, 0) },
  top: { pos: new THREE.Vector3(0, 46, 12), target: new THREE.Vector3(0, 0, -2) },
};

function setCameraPreset(name) {
  activeCamPreset = name;
  presetBtns.forEach((b) => b.classList.toggle('active', b.dataset.cam === name));
  if (CAM_PRESETS[name]) {
    camTransition = {
      startPos: engine.camera.position.clone(),
      startTarget: controls.target.clone(),
      endPos: CAM_PRESETS[name].pos.clone(),
      endTarget: CAM_PRESETS[name].target.clone(),
      progress: 0,
    };
  }
}

presetBtns.forEach((btn) => {
  btn.addEventListener('click', () => setCameraPreset(btn.dataset.cam));
});

// Cancel smooth camera transition if user grabs orbit controls
controls.addEventListener('start', () => {
  camTransition = null;
  if (activeCamPreset === 'bird') {
    activeCamPreset = 'free';
    presetBtns.forEach((b) => b.classList.remove('active'));
  }
});

// Interactive click on water -> pebble ripple
let pointerDownPos = { x: 0, y: 0 };
canvas.addEventListener('pointerdown', (e) => {
  pointerDownPos = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointerup', (e) => {
  const moved = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
  if (moved < 6) {
    engine.handlePointerClick(e.clientX, e.clientY);
  }
});

// Resize handler
function handleResize() {
  const rect = viewport3d.getBoundingClientRect();
  engine.resize(rect.width, rect.height);
}
window.addEventListener('resize', handleResize);
handleResize();

// Status & Loading Helpers
function showBanner(msg, isError = false) {
  if (!msg) {
    statusBanner.classList.add('hidden');
    return;
  }
  statusBanner.textContent = msg;
  statusBanner.classList.toggle('error', isError);
  statusBanner.classList.remove('hidden');
}

function setLoading(show, title = '', sub = '') {
  loadingOverlay.classList.toggle('hidden', !show);
  if (title) loadingText.textContent = title;
  if (sub) loadingSub.textContent = sub;
}

// Format hours (e.g. 13.5 -> "13:30")
function formatHours(h) {
  const hrs = Math.floor(h) % 24;
  const mins = Math.floor((h - Math.floor(h)) * 60);
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

sliderTod.addEventListener('input', () => {
  const v = parseFloat(sliderTod.value);
  valTod.textContent = formatHours(v);
  engine.applyTimeOfDay(v);
});

sliderWind.addEventListener('input', () => {
  const v = parseFloat(sliderWind.value);
  valWind.textContent = `${v.toFixed(1)}x`;
  engine.windStrength = v;
});

sliderSpeed.addEventListener('input', () => {
  simSpeed = parseFloat(sliderSpeed.value);
  valSpeed.textContent = `${simSpeed.toFixed(1)}x`;
  if (sourceVideo.src) {
    sourceVideo.playbackRate = Math.max(0.25, simSpeed || 0.25);
  }
});

// Video panel toggles
btnToggleSplit.addEventListener('click', () => {
  videoPanel.classList.toggle('split-mode');
  btnToggleSplit.classList.toggle('active');
});

btnToggleSync.addEventListener('click', () => {
  syncWithVideo = !syncWithVideo;
  btnToggleSync.classList.toggle('active', syncWithVideo);
});

// JSON Modal
btnJson.addEventListener('click', () => {
  if (!latestAnalysis) return;
  jsonContent.textContent = JSON.stringify(latestAnalysis, null, 2);
  jsonModal.classList.remove('hidden');
});
btnCloseJson.addEventListener('click', () => jsonModal.classList.add('hidden'));
jsonModal.addEventListener('click', (e) => {
  if (e.target === jsonModal) jsonModal.classList.add('hidden');
});

// Core Analysis Request
async function runAnalysis({ useSample = false, file = null } = {}) {
  showBanner(null);
  const mode = modeSelect.value;
  const apiKey = apiKeyInput.value.trim();

  setLoading(
    true,
    mode === 'opencv'
      ? 'Analyzing 2D video with OpenCV...'
      : 'Analyzing 2D video with OpenCV & Gemini Vision...',
    'Computing background model, tracking moving trajectories & synthesizing 3D world'
  );

  const form = new FormData();
  form.append('use_sample', useSample ? 'true' : 'false');
  form.append('mode', mode);
  if (apiKey) form.append('api_key', apiKey);
  if (file) form.append('file', file);

  try {
    const res = await fetch('api/analyze', { method: 'POST', body: form });
    if (!res.ok) {
      let detail = `Server error (${res.status})`;
      try {
        const errData = await res.json();
        if (errData.detail) detail = errData.detail;
      } catch (_) {}
      throw new Error(detail);
    }

    const data = await res.json();
    latestAnalysis = data;
    btnJson.disabled = false;

    // Load 3D simulation!
    engine.loadSceneGraph(data.scene, data.trajectories, data.metadata.duration);
    setCameraPreset('match');

    // Sync sliders to scene defaults
    if (data.scene?.environment?.wind_strength != null) {
      engine.windStrength = data.scene.environment.wind_strength;
      sliderWind.value = String(engine.windStrength);
      valWind.textContent = `${engine.windStrength.toFixed(1)}x`;
    }

    // Load 2D source video in PiP / Split panel
    sourceVideo.src = data.metadata.video_url;
    sourceVideo.playbackRate = Math.max(0.25, simSpeed || 1.0);
    videoPanel.classList.remove('hidden');
    videoMeta.innerHTML = `<span>${data.metadata.filename}</span><span>${data.metadata.width}×${data.metadata.height} · ${data.metadata.duration}s</span>`;
    sourceVideo.play().catch(() => {});

    // Render stats
    const sc = data.scene;
    const badgeClass = data.mode_used === 'gemini' ? 'gemini' : 'opencv';
    const badgeLabel =
      data.mode_used === 'gemini' ? `✦ Gemini Vision (${data.model_used || 'AI'})` : '⚙ Local OpenCV CV';

    sceneStats.innerHTML = `
      <div class="stat-badge ${badgeClass}">${badgeLabel}</div>
      <div><strong>${sc.title || '3D Scene'}</strong></div>
      <div style="margin-top:4px;">
        Mountains: <b>${(sc.mountains || []).length}</b> ·
        Water: <b>${(sc.water_bodies || []).length}</b> ·
        Structures: <b>${(sc.structures || []).length}</b><br/>
        Trees: <b>${(sc.vegetation || []).length}</b> ·
        Paths: <b>${(sc.paths || []).length}</b> ·
        Tracked Motion: <b>${(data.trajectories || []).length}</b>
      </div>
    `;

    if (data.warning) {
      showBanner(data.warning, false);
    }
  } catch (err) {
    showBanner(`Analysis failed: ${err.message}`, true);
  } finally {
    setLoading(false);
  }
}

// Button handlers
btnSample.addEventListener('click', () => {
  usingSample = true;
  selectedFile = null;
  btnAnalyze.disabled = false;
  runAnalysis({ useSample: true });
});

fileInput.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  selectedFile = file;
  usingSample = false;
  btnAnalyze.disabled = false;
  runAnalysis({ useSample: false, file });
});

btnAnalyze.addEventListener('click', () => {
  if (selectedFile) {
    runAnalysis({ useSample: false, file: selectedFile });
  } else if (usingSample) {
    runAnalysis({ useSample: true });
  }
});

// Drag & Drop 2D video directly onto the 3D viewport!
viewport3d.addEventListener('dragover', (e) => {
  e.preventDefault();
  viewport3d.style.outline = '2px dashed #38bdf8';
});
viewport3d.addEventListener('dragleave', () => {
  viewport3d.style.outline = 'none';
});
viewport3d.addEventListener('drop', (e) => {
  e.preventDefault();
  viewport3d.style.outline = 'none';
  const file = e.dataTransfer?.files?.[0];
  if (file && file.type.startsWith('video/')) {
    selectedFile = file;
    usingSample = false;
    btnAnalyze.disabled = false;
    runAnalysis({ useSample: false, file });
  }
});

// Check backend health & auto-load sample video on startup!
async function init() {
  try {
    const res = await fetch('api/health');
    if (res.ok) {
      const info = await res.json();
      if (info.gemini_env_configured && !apiKeyInput.value) {
        apiKeyInput.placeholder = 'Using backend .env key';
      }
      if (info.sample_available) {
        usingSample = true;
        btnAnalyze.disabled = false;
        runAnalysis({ useSample: true });
      }
    }
  } catch (_) {
    showBanner('Backend server not reachable on port 8000. Start uvicorn backend first.', true);
  }
}

// Main Render Loop
let lastTime = performance.now();
function animate(now) {
  requestAnimationFrame(animate);
  const rawDt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;
  const dt = rawDt * simSpeed;

  // Smooth camera preset transition
  if (camTransition) {
    camTransition.progress = Math.min(1, camTransition.progress + rawDt * 2.4);
    const ease = 1 - Math.pow(1 - camTransition.progress, 3);
    engine.camera.position.lerpVectors(camTransition.startPos, camTransition.endPos, ease);
    controls.target.lerpVectors(camTransition.startTarget, camTransition.endTarget, ease);
    if (camTransition.progress >= 1) camTransition = null;
  }

  // Follow Bird camera mode
  if (activeCamPreset === 'bird') {
    const birdPos = engine.getFirstBirdPosition();
    if (birdPos) {
      const desiredPos = birdPos.clone().add(new THREE.Vector3(0, 3.2, 10.5));
      engine.camera.position.lerp(desiredPos, 0.05);
      controls.target.lerp(birdPos, 0.09);
    }
  }

  const videoT =
    syncWithVideo && sourceVideo.src && !Number.isNaN(sourceVideo.currentTime) && sourceVideo.readyState >= 2
      ? sourceVideo.currentTime
      : null;

  engine.update(dt, videoT);
  controls.update();
  engine.render();
}

requestAnimationFrame(animate);
init();

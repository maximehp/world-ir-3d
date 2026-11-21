import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { SimulationEngine } from './sceneBuilder.js';

// DOM Elements
const canvas = document.getElementById('sim-canvas');
const viewport3d = document.getElementById('viewport-3d');
const btnSample = document.getElementById('btn-sample');
const btnSampleTaj = document.getElementById('btn-sample-taj');
const btnSamplePyramids = document.getElementById('btn-sample-pyramids');
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
const btnExportGlb = document.getElementById('btn-export-glb');
const btnExportJson = document.getElementById('btn-export-json');
const importJsonInput = document.getElementById('import-json-input');
const jsonModal = document.getElementById('json-modal');
const jsonContent = document.getElementById('json-content');
const btnCloseJson = document.getElementById('btn-close-json');

const objectSelect = document.getElementById('object-select');
const objectInspector = document.getElementById('object-inspector');
const envSkyTop = document.getElementById('env-sky-top');
const envSkyBot = document.getElementById('env-sky-bot');
const envGround = document.getElementById('env-ground');
const envSunCol = document.getElementById('env-sun-col');
const envFog = document.getElementById('env-fog');

const btnFlightPaths = document.getElementById('btn-flight-paths');
const btnWireframe = document.getElementById('btn-wireframe');
const presetBtns = Array.from(document.querySelectorAll('.preset-btn'));
const toolBtns = Array.from(document.querySelectorAll('.tool-btn[data-tool]'));
const tabBtns = Array.from(document.querySelectorAll('.tab-btn'));
const addBtns = Array.from(document.querySelectorAll('.mini-btn[data-add]'));

// Restore saved Gemini API key
const savedKey = localStorage.getItem('video2sim_gemini_key');
if (savedKey) apiKeyInput.value = savedKey;
apiKeyInput.addEventListener('input', () => {
  localStorage.setItem('video2sim_gemini_key', apiKeyInput.value.trim());
});

// Initialize Three.js Simulation Engine + OrbitControls + TransformControls
const engine = new SimulationEngine(canvas);
const controls = new OrbitControls(engine.camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 6;
controls.maxDistance = 120;
controls.target.set(0, 4.5, -2);
controls.update();

const transformControls = new TransformControls(engine.camera, canvas);
transformControls.setSpace('world');
transformControls.addEventListener('dragging-changed', (e) => {
  controls.enabled = !e.value;
});
transformControls.addEventListener('objectChange', () => {
  const entry = engine.syncGizmoToSpec();
  if (entry) renderObjectInspector(entry);
});
engine.scene.add(transformControls.getHelper());

// App state
let selectedFile = null;
let usingSample = false;
let latestAnalysis = null;
let syncWithVideo = true;
let simSpeed = 1.0;
let activeCamPreset = 'match';
let activeTool = 'select';
let camTransition = null;

const CAM_PRESETS = {
  match: { pos: new THREE.Vector3(0, 11.2, 33.0), target: new THREE.Vector3(0, 4.5, -3.0) },
  iso: { pos: new THREE.Vector3(26, 22, 26), target: new THREE.Vector3(0, 2.5, 0) },
  top: { pos: new THREE.Vector3(0, 46, 12), target: new THREE.Vector3(0, 0, -2) },
};

// Tabs
function switchTab(tabName) {
  tabBtns.forEach((b) => b.classList.toggle('active', b.dataset.tab === tabName));
  document.querySelectorAll('.tab-pane').forEach((p) => {
    p.classList.toggle('active', p.id === `tab-${tabName}`);
  });
}
tabBtns.forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

// Gizmo Tool Modes
function setToolMode(tool) {
  activeTool = tool;
  toolBtns.forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  updateGizmoAttachment();
}
toolBtns.forEach((b) => b.addEventListener('click', () => setToolMode(b.dataset.tool)));

function updateGizmoAttachment() {
  const entry = engine.getSelectedEntry();
  if (!entry || activeTool === 'select' || entry.category === 'dynamic_entities' || entry.category === 'paths') {
    transformControls.detach();
    return;
  }
  transformControls.setMode(activeTool);
  transformControls.showY = activeTool !== 'translate';
  transformControls.attach(entry.root);
}

btnFlightPaths.addEventListener('click', () => {
  const next = !engine.showFlightPaths;
  engine.setShowFlightPaths(next);
  btnFlightPaths.classList.toggle('active', next);
});

btnWireframe.addEventListener('click', () => {
  const next = !engine.wireframe;
  engine.setWireframe(next);
  btnWireframe.classList.toggle('active', next);
});

// Keyboard shortcuts: G = Move, R = Rotate, Esc = Select/Deselect
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 'g' || e.key === 'G') setToolMode('translate');
  if (e.key === 'r' || e.key === 'R') setToolMode('rotate');
  if (e.key === 'Escape') {
    setToolMode('select');
    engine.selectObjectByKey(null);
    refreshObjectList();
    renderObjectInspector(null);
  }
});

// Camera Presets
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
presetBtns.forEach((btn) => btn.addEventListener('click', () => setCameraPreset(btn.dataset.cam)));

controls.addEventListener('start', () => {
  camTransition = null;
  if (activeCamPreset === 'bird') {
    activeCamPreset = 'free';
    presetBtns.forEach((b) => b.classList.remove('active'));
  }
});

// Viewport Click -> Water ripple + 3D Object selection
let pointerDownPos = { x: 0, y: 0 };
canvas.addEventListener('pointerdown', (e) => {
  pointerDownPos = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointerup', (e) => {
  const moved = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
  if (moved < 6 && !transformControls.dragging) {
    const key = engine.handlePointerClick(e.clientX, e.clientY);
    objectSelect.value = key || '';
    const entry = engine.getSelectedEntry();
    renderObjectInspector(entry);
    updateGizmoAttachment();
    if (entry) switchTab('customize');
  }
});

// Outliner & Dynamic Object Inspector
const CATEGORY_LABELS = {
  structures: 'House',
  vegetation: 'Tree / Nature',
  mountains: 'Mountain',
  water_bodies: 'Pond / Water',
  paths: 'Path',
  dynamic_entities: 'Animated Entity',
};

function refreshObjectList() {
  const items = engine.getAllObjectsList();
  const current = engine.selectedKey || '';
  objectSelect.innerHTML = `<option value="">— Click any 3D object or pick here (${items.length}) —</option>`;
  for (const item of items) {
    const opt = document.createElement('option');
    opt.value = item.key;
    opt.textContent = `${CATEGORY_LABELS[item.category] || item.category}: ${item.id}`;
    if (item.key === current) opt.selected = true;
    objectSelect.appendChild(opt);
  }
}

objectSelect.addEventListener('change', () => {
  const key = objectSelect.value || null;
  const entry = engine.selectObjectByKey(key);
  renderObjectInspector(entry);
  updateGizmoAttachment();
});

function createSliderRow(label, value, min, max, step, onChange) {
  const row = document.createElement('div');
  row.className = 'prop-row';
  const lbl = document.createElement('span');
  lbl.textContent = label;
  const inp = document.createElement('input');
  inp.type = 'range';
  inp.min = String(min);
  inp.max = String(max);
  inp.step = String(step);
  inp.value = String(value);
  const val = document.createElement('span');
  val.className = 'prop-val';
  val.textContent = Number(value).toFixed(step < 0.1 ? 2 : 1);

  inp.addEventListener('input', () => {
    const num = parseFloat(inp.value);
    val.textContent = num.toFixed(step < 0.1 ? 2 : 1);
    onChange(num);
  });

  row.append(lbl, inp, val);
  return row;
}

function createColorRow(label, hexValue, onChange) {
  const row = document.createElement('div');
  row.className = 'prop-row';
  const lbl = document.createElement('span');
  lbl.textContent = label;
  const inp = document.createElement('input');
  inp.type = 'color';
  inp.value = hexValue && hexValue.startsWith('#') ? hexValue.slice(0, 7) : '#ffffff';
  inp.addEventListener('input', () => onChange(inp.value));
  row.append(lbl, inp);
  return row;
}

function createSelectRow(label, current, options, onChange) {
  const row = document.createElement('div');
  row.className = 'prop-row';
  const lbl = document.createElement('span');
  lbl.textContent = label;
  const sel = document.createElement('select');
  for (const [val, text] of options) {
    const o = document.createElement('option');
    o.value = val;
    o.textContent = text;
    if (val === current) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => onChange(sel.value));
  row.append(lbl, sel);
  return row;
}

function createCheckRow(label, checked, onChange) {
  const row = document.createElement('div');
  row.className = 'prop-row';
  const lbl = document.createElement('span');
  lbl.textContent = label;
  const inp = document.createElement('input');
  inp.type = 'checkbox';
  inp.checked = Boolean(checked);
  inp.addEventListener('change', () => onChange(inp.checked));
  row.append(lbl, inp);
  return row;
}

function rebuildKeepingSelection() {
  const key = engine.selectedKey;
  transformControls.detach();
  engine.rebuildAll(key);
  updateGizmoAttachment();
  updateStatsPanel();
}

function renderObjectInspector(entry) {
  objectInspector.innerHTML = '';
  if (!entry) {
    objectInspector.innerHTML = `
      <div class="empty-hint">
        Click any <b>house</b>, <b>tree</b>, <b>mountain</b>, <b>pond</b>, <b>path</b>, or <b>bird</b> in the 3D scene to edit its position, size, style, and colors live!
      </div>
    `;
    return;
  }

  const { category, spec } = entry;

  // Position controls for static objects
  if (typeof spec.x === 'number') {
    objectInspector.appendChild(
      createSliderRow('Pos X', spec.x, -35, 35, 0.2, (v) => {
        spec.x = v;
        rebuildKeepingSelection();
      })
    );
  }
  if (typeof spec.z === 'number') {
    objectInspector.appendChild(
      createSliderRow('Pos Z', spec.z, -38, 22, 0.2, (v) => {
        spec.z = v;
        rebuildKeepingSelection();
      })
    );
  }

  if (category === 'structures') {
    // ── Complete Internal Architecture Builder Card ──
    const intBox = document.createElement('div');
    intBox.className = 'interior-card';

    const intHeader = document.createElement('div');
    intHeader.className = 'section-label';
    intHeader.textContent = 'Internal Architecture';
    intBox.appendChild(intHeader);

    if (!spec.interior || !spec.interior.enabled) {
      const btnAddInt = document.createElement('button');
      btnAddInt.className = 'btn btn-accent full-width';
      btnAddInt.textContent = '🏛 Add Complete Internal Architecture';
      btnAddInt.addEventListener('click', () => {
        const defaultPreset =
          spec.kind === 'pyramid'
            ? 'pyramid_chambers'
            : spec.kind === 'mosque' || spec.kind === 'pavilion'
            ? 'mosque_hall'
            : spec.kind === 'house' || spec.kind === 'cabin'
            ? 'house_rooms'
            : 'hasht_bihisht';

        spec.interior = {
          enabled: true,
          preset: defaultPreset,
          view_mode: 'cutaway',
          cutaway_ratio: 0.5,
          show_double_dome: true,
          show_rooms: true,
          show_cenotaphs: true,
          show_crypt: true,
          show_lights: true,
          marble_color: '#efe9dc',
          vault_color: '#dfd4be',
          floor_color: '#e5dcc8',
        };
        rebuildKeepingSelection();
        renderObjectInspector(engine.getSelectedEntry());

        // Smoothly frame the cross-section cutaway!
        const cx = spec.x || 0;
        const cy = (spec.elevation_y || 0) + (spec.height || 8) * 0.55;
        const cz = spec.z || 0;
        const dist = Math.max(spec.width || 10, spec.depth || 10) * 1.45;
        camTransition = {
          startPos: engine.camera.position.clone(),
          startTarget: controls.target.clone(),
          endPos: new THREE.Vector3(cx, cy + 2.5, cz + dist),
          endTarget: new THREE.Vector3(cx, cy - 0.5, cz),
          progress: 0,
        };
      });
      intBox.appendChild(btnAddInt);
    } else {
      const intr = spec.interior;

      // View Mode Switcher Grid (Cutaway / Floor Plan / X-Ray / Exterior)
      const modeGrid = document.createElement('div');
      modeGrid.className = 'preset-grid';
      const modes = [
        ['cutaway', '✂ Cutaway'],
        ['floorplan', '⊞ Floor Plan'],
        ['xray', '◎ X-Ray'],
        ['exterior', '▣ Exterior'],
      ];
      for (const [mVal, mLabel] of modes) {
        const mb = document.createElement('button');
        mb.className = `preset-btn${intr.view_mode === mVal ? ' active' : ''}`;
        mb.textContent = mLabel;
        mb.addEventListener('click', () => {
          intr.view_mode = mVal;
          rebuildKeepingSelection();
          renderObjectInspector(engine.getSelectedEntry());

          const cx = spec.x || 0;
          const cy = (spec.elevation_y || 0) + (spec.height || 8) * 0.5;
          const cz = spec.z || 0;
          if (mVal === 'floorplan') {
            camTransition = {
              startPos: engine.camera.position.clone(),
              startTarget: controls.target.clone(),
              endPos: new THREE.Vector3(cx, cy + Math.max(spec.width || 12, spec.depth || 12) * 1.55, cz + 2.5),
              endTarget: new THREE.Vector3(cx, cy, cz),
              progress: 0,
            };
          } else if (mVal === 'cutaway') {
            camTransition = {
              startPos: engine.camera.position.clone(),
              startTarget: controls.target.clone(),
              endPos: new THREE.Vector3(cx, cy + 2.5, cz + Math.max(spec.width || 10, spec.depth || 10) * 1.45),
              endTarget: new THREE.Vector3(cx, cy - 0.5, cz),
              progress: 0,
            };
          }
        });
        modeGrid.appendChild(mb);
      }
      intBox.appendChild(modeGrid);

      // Enter Inside Camera Walkthrough Button
      const btnEnter = document.createElement('button');
      btnEnter.className = 'btn btn-primary full-width';
      btnEnter.textContent = '🚪 Fly Inside Central Chamber';
      btnEnter.addEventListener('click', () => {
        if (intr.view_mode === 'floorplan') {
          intr.view_mode = 'exterior';
          rebuildKeepingSelection();
          renderObjectInspector(engine.getSelectedEntry());
        }
        const cx = spec.x || 0;
        const baseY = spec.elevation_y || 0;
        const cz = spec.z || 0;
        camTransition = {
          startPos: engine.camera.position.clone(),
          startTarget: controls.target.clone(),
          endPos: new THREE.Vector3(cx, baseY + 2.2, cz + (spec.depth || 12) * 0.28),
          endTarget: new THREE.Vector3(cx, baseY + 2.6, cz - 1.0),
          progress: 0,
        };
      });
      intBox.appendChild(btnEnter);

      // Cutaway / Floor Plan Slice Slider
      if (intr.view_mode === 'cutaway' || intr.view_mode === 'floorplan') {
        intBox.appendChild(
          createSliderRow(
            intr.view_mode === 'floorplan' ? 'Plan Level' : 'Slice Depth',
            intr.cutaway_ratio ?? 0.5,
            0.05,
            0.95,
            0.02,
            (v) => {
              intr.cutaway_ratio = v;
              rebuildKeepingSelection();
            }
          )
        );
      }

      intBox.appendChild(
        createSelectRow(
          'Interior Style',
          intr.preset || 'hasht_bihisht',
          [
            ['hasht_bihisht', 'Hasht-Bihisht (9 Rooms + Crypt)'],
            ['pyramid_chambers', 'Pyramid (Grand Gallery + Chambers)'],
            ['mosque_hall', 'Mosque Prayer Hall'],
            ['house_rooms', 'House Rooms'],
          ],
          (v) => {
            intr.preset = v;
            rebuildKeepingSelection();
            renderObjectInspector(engine.getSelectedEntry());
          }
        )
      );

      if ((intr.preset || 'hasht_bihisht') === 'hasht_bihisht' || intr.preset === 'pyramid_chambers') {
        const isPyr = intr.preset === 'pyramid_chambers';
        intBox.appendChild(
          createCheckRow(isPyr ? 'Relieving Chambers & Shafts' : 'Double-Shelled Dome', intr.show_double_dome !== false, (v) => {
            intr.show_double_dome = v;
            rebuildKeepingSelection();
          })
        );
        intBox.appendChild(
          createCheckRow(isPyr ? "Queen's Chamber" : '9-Room Plan & Hallways', intr.show_rooms !== false, (v) => {
            intr.show_rooms = v;
            rebuildKeepingSelection();
          })
        );
        intBox.appendChild(
          createCheckRow(isPyr ? 'Granite Sarcophagus' : 'Jali & Cenotaphs', intr.show_cenotaphs !== false, (v) => {
            intr.show_cenotaphs = v;
            rebuildKeepingSelection();
          })
        );
        intBox.appendChild(
          createCheckRow(isPyr ? 'Subterranean Chamber' : 'Underground Crypt', intr.show_crypt !== false, (v) => {
            intr.show_crypt = v;
            rebuildKeepingSelection();
          })
        );
      }

      intBox.appendChild(
        createCheckRow('Interior Lights', intr.show_lights !== false, (v) => {
          intr.show_lights = v;
          rebuildKeepingSelection();
        })
      );
      intBox.appendChild(
        createColorRow('Interior Marble', intr.marble_color || '#efe9dc', (v) => {
          intr.marble_color = v;
          rebuildKeepingSelection();
        })
      );
      intBox.appendChild(
        createColorRow('Inner Vault', intr.vault_color || '#dfd4be', (v) => {
          intr.vault_color = v;
          rebuildKeepingSelection();
        })
      );

      const btnRemInt = document.createElement('button');
      btnRemInt.className = 'btn btn-ghost full-width';
      btnRemInt.textContent = 'Remove Internal Architecture';
      btnRemInt.addEventListener('click', () => {
        spec.interior.enabled = false;
        rebuildKeepingSelection();
        renderObjectInspector(engine.getSelectedEntry());
      });
      intBox.appendChild(btnRemInt);
    }

    objectInspector.appendChild(intBox);

    objectInspector.appendChild(
      createSelectRow(
        'Architecture',
        spec.kind || 'house',
        [
          ['house', 'House'],
          ['pyramid', 'Stepped Pyramid'],
          ['sphinx', 'Great Sphinx'],
          ['ruins', 'Temple / Mastaba Ruins'],
          ['mausoleum', 'Domed Mausoleum'],
          ['minaret', 'Minaret / Tower'],
          ['mosque', 'Mosque / Pavilion'],
          ['plinth', 'Marble Plinth'],
        ],
        (v) => {
          spec.kind = v;
          rebuildKeepingSelection();
          renderObjectInspector(engine.getSelectedEntry());
        }
      )
    );
    objectInspector.appendChild(
      createSliderRow('Elevation Y', spec.elevation_y ?? 0, 0, 12, 0.2, (v) => {
        spec.elevation_y = v;
        rebuildKeepingSelection();
      })
    );
    objectInspector.appendChild(
      createSliderRow('Width', spec.width ?? 7, 1.5, 36, 0.2, (v) => {
        spec.width = v;
        rebuildKeepingSelection();
      })
    );
    objectInspector.appendChild(
      createSliderRow('Height', spec.height ?? 4.8, 1.0, 22, 0.2, (v) => {
        spec.height = v;
        rebuildKeepingSelection();
      })
    );
    objectInspector.appendChild(
      createSliderRow('Depth', spec.depth ?? 6, 1.5, 32, 0.2, (v) => {
        spec.depth = v;
        rebuildKeepingSelection();
      })
    );
    objectInspector.appendChild(
      createSliderRow('Rotate Y', spec.rotation_y ?? 0, -3.14, 3.14, 0.05, (v) => {
        spec.rotation_y = v;
        rebuildKeepingSelection();
      })
    );
    objectInspector.appendChild(
      createColorRow('Wall / Marble', spec.wall_color, (v) => {
        spec.wall_color = v;
        rebuildKeepingSelection();
      })
    );
    if (spec.kind === 'mausoleum' || spec.kind === 'mosque' || spec.kind === 'minaret' || spec.kind === 'palace') {
      objectInspector.appendChild(
        createColorRow('Dome Color', spec.dome_color || '#faf7f0', (v) => {
          spec.dome_color = v;
          rebuildKeepingSelection();
        })
      );
      objectInspector.appendChild(
        createColorRow('Trim / Accent', spec.accent_color || '#d8cbb5', (v) => {
          spec.accent_color = v;
          rebuildKeepingSelection();
        })
      );
      if (spec.kind === 'mausoleum' || spec.kind === 'palace') {
        objectInspector.appendChild(
          createCheckRow('Corner Chhatris', spec.has_chhatris !== false, (v) => {
            spec.has_chhatris = v;
            rebuildKeepingSelection();
          })
        );
      }
      if (spec.kind === 'minaret' || spec.kind === 'tower') {
        objectInspector.appendChild(
          createSliderRow('Balconies', spec.num_balconies ?? 3, 1, 5, 1, (v) => {
            spec.num_balconies = Math.round(v);
            rebuildKeepingSelection();
          })
        );
      }
    } else if (spec.kind !== 'plinth') {
      objectInspector.appendChild(
        createSelectRow(
          'Roof Style',
          spec.roof_style || 'gable',
          [
            ['gable', 'Gable (Triangle)'],
            ['pyramid', 'Pyramid'],
            ['flat', 'Modern Flat'],
          ],
          (v) => {
            spec.roof_style = v;
            rebuildKeepingSelection();
          }
        )
      );
      objectInspector.appendChild(
        createColorRow('Roof Color', spec.roof_color, (v) => {
          spec.roof_color = v;
          rebuildKeepingSelection();
        })
      );
      objectInspector.appendChild(
        createColorRow('Door Color', spec.door_color, (v) => {
          spec.door_color = v;
          rebuildKeepingSelection();
        })
      );
      objectInspector.appendChild(
        createColorRow('Window Tint', spec.window_color, (v) => {
          spec.window_color = v;
          rebuildKeepingSelection();
        })
      );
      objectInspector.appendChild(
        createCheckRow('Chimney & Smoke', spec.has_chimney, (v) => {
          spec.has_chimney = v;
          rebuildKeepingSelection();
        })
      );
    }
  } else if (category === 'vegetation') {
    objectInspector.appendChild(
      createSelectRow(
        'Style',
        spec.kind || 'round_tree',
        [
          ['round_tree', 'Round Oak Tree'],
          ['cypress', 'Cypress Tree'],
          ['pine_tree', 'Pine Tree'],
          ['bush', 'Shrub / Bush'],
          ['rock', 'Boulder Rock'],
        ],
        (v) => {
          spec.kind = v;
          rebuildKeepingSelection();
        }
      )
    );
    objectInspector.appendChild(
      createSliderRow('Scale', spec.scale ?? 1.0, 0.3, 2.5, 0.05, (v) => {
        spec.scale = v;
        rebuildKeepingSelection();
      })
    );
    objectInspector.appendChild(
      createColorRow('Foliage', spec.foliage_color, (v) => {
        spec.foliage_color = v;
        rebuildKeepingSelection();
      })
    );
    objectInspector.appendChild(
      createColorRow('Accent', spec.foliage_accent_color, (v) => {
        spec.foliage_accent_color = v;
        rebuildKeepingSelection();
      })
    );
    objectInspector.appendChild(
      createColorRow('Trunk', spec.trunk_color, (v) => {
        spec.trunk_color = v;
        rebuildKeepingSelection();
      })
    );
    objectInspector.appendChild(
      createSliderRow('Wind Sway', spec.sway_intensity ?? 0.75, 0, 2, 0.1, (v) => {
        spec.sway_intensity = v;
        rebuildKeepingSelection();
      })
    );
  } else if (category === 'mountains') {
    objectInspector.appendChild(
      createSliderRow('Height', spec.height ?? 12, 3, 30, 0.5, (v) => {
        spec.height = v;
        rebuildKeepingSelection();
      })
    );
    objectInspector.appendChild(
      createSliderRow('Radius', spec.radius ?? 12, 3, 28, 0.5, (v) => {
        spec.radius = v;
        rebuildKeepingSelection();
      })
    );
    objectInspector.appendChild(
      createColorRow('Peak Color', spec.color, (v) => {
        spec.color = v;
        rebuildKeepingSelection();
      })
    );
    objectInspector.appendChild(
      createCheckRow('Snow Cap', spec.snow_cap, (v) => {
        spec.snow_cap = v;
        rebuildKeepingSelection();
      })
    );
  } else if (category === 'water_bodies') {
    objectInspector.appendChild(
      createSelectRow(
        'Pool Shape',
        spec.shape || 'ellipse',
        [
          ['ellipse', 'Organic Pond'],
          ['rectangle', 'Formal Reflecting Pool'],
        ],
        (v) => {
          spec.shape = v;
          rebuildKeepingSelection();
        }
      )
    );
    objectInspector.appendChild(
      createSliderRow('Radius X', spec.radius_x ?? 8, 1.5, 22, 0.2, (v) => {
        spec.radius_x = v;
        rebuildKeepingSelection();
      })
    );
    objectInspector.appendChild(
      createSliderRow('Radius Z', spec.radius_z ?? 5, 2, 24, 0.2, (v) => {
        spec.radius_z = v;
        rebuildKeepingSelection();
      })
    );
    objectInspector.appendChild(
      createSliderRow('Ripples', spec.ripple_intensity ?? 0.65, 0, 2, 0.05, (v) => {
        spec.ripple_intensity = v;
        rebuildKeepingSelection();
      })
    );
    objectInspector.appendChild(
      createCheckRow('Fountains', Boolean(spec.has_fountains), (v) => {
        spec.has_fountains = v;
        if (v && !spec.fountain_count) spec.fountain_count = 7;
        rebuildKeepingSelection();
      })
    );
    objectInspector.appendChild(
      createSliderRow('Fountain Count', spec.fountain_count ?? 7, 1, 13, 1, (v) => {
        spec.fountain_count = Math.round(v);
        rebuildKeepingSelection();
      })
    );
    objectInspector.appendChild(
      createColorRow('Water Color', spec.water_color, (v) => {
        spec.water_color = v;
        rebuildKeepingSelection();
      })
    );
    objectInspector.appendChild(
      createColorRow('Shore / Marble', spec.shore_color, (v) => {
        spec.shore_color = v;
        rebuildKeepingSelection();
      })
    );
  } else if (category === 'paths') {
    objectInspector.appendChild(
      createSliderRow('Path Width', spec.width ?? 3.2, 1, 8, 0.2, (v) => {
        spec.width = v;
        rebuildKeepingSelection();
      })
    );
    objectInspector.appendChild(
      createColorRow('Path Color', spec.color, (v) => {
        spec.color = v;
        rebuildKeepingSelection();
      })
    );
  } else if (category === 'dynamic_entities') {
    objectInspector.appendChild(
      createSelectRow(
        '3D Model',
        spec.kind || 'bird',
        [
          ['bird', '3D Flapping Bird'],
          ['cloud', '3D Cloud'],
          ['car', '3D Car'],
          ['floating_orb', '3D Energy Orb'],
        ],
        (v) => {
          spec.kind = v;
          rebuildKeepingSelection();
        }
      )
    );
    objectInspector.appendChild(
      createSliderRow('Scale', spec.scale ?? 1.0, 0.3, 3.0, 0.1, (v) => {
        spec.scale = v;
        rebuildKeepingSelection();
      })
    );
    objectInspector.appendChild(
      createSliderRow('Depth Z', spec.depth_z ?? -2, -22, 12, 0.5, (v) => {
        spec.depth_z = v;
        rebuildKeepingSelection();
      })
    );
    objectInspector.appendChild(
      createSliderRow('Altitude', spec.altitude_offset ?? 0, -6, 12, 0.5, (v) => {
        spec.altitude_offset = v;
        rebuildKeepingSelection();
      })
    );
    objectInspector.appendChild(
      createSliderRow('Flap Speed', spec.flap_speed ?? 8.5, 1, 18, 0.5, (v) => {
        spec.flap_speed = v;
        rebuildKeepingSelection();
      })
    );
    objectInspector.appendChild(
      createColorRow('Body Color', spec.color, (v) => {
        spec.color = v;
        rebuildKeepingSelection();
      })
    );
  }

  // Duplicate & Delete Actions
  const actions = document.createElement('div');
  actions.className = 'inspector-actions';

  const btnDup = document.createElement('button');
  btnDup.className = 'btn btn-secondary';
  btnDup.textContent = '⧉ Duplicate';
  btnDup.addEventListener('click', () => {
    transformControls.detach();
    const newKey = engine.duplicateSelected();
    refreshObjectList();
    renderObjectInspector(engine.getSelectedEntry());
    updateGizmoAttachment();
    updateStatsPanel();
    if (newKey) objectSelect.value = newKey;
  });

  const btnDel = document.createElement('button');
  btnDel.className = 'btn btn-danger';
  btnDel.textContent = '✕ Delete';
  btnDel.addEventListener('click', () => {
    transformControls.detach();
    engine.deleteSelected();
    refreshObjectList();
    renderObjectInspector(null);
    updateStatsPanel();
  });

  actions.append(btnDup, btnDel);
  objectInspector.appendChild(actions);
}

// Add 3D Object buttons
addBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    transformControls.detach();
    const key = engine.addObject(btn.dataset.add);
    refreshObjectList();
    renderObjectInspector(engine.getSelectedEntry());
    updateGizmoAttachment();
    updateStatsPanel();
    if (key) {
      objectSelect.value = key;
      if (activeTool === 'select') setToolMode('translate');
    }
  });
});

// Environment Color Pickers
function syncEnvInputsFromScene() {
  const env = engine.sceneGraph?.environment;
  if (!env) return;
  if (env.sky_top_color) envSkyTop.value = env.sky_top_color.slice(0, 7);
  if (env.sky_bottom_color) envSkyBot.value = env.sky_bottom_color.slice(0, 7);
  if (env.ground_color) envGround.value = env.ground_color.slice(0, 7);
  if (env.sun?.color) envSunCol.value = env.sun.color.slice(0, 7);
  if (env.fog_density != null) envFog.value = String(env.fog_density);
}

envSkyTop.addEventListener('input', () => {
  if (!engine.sceneGraph?.environment) return;
  engine.sceneGraph.environment.sky_top_color = envSkyTop.value;
  engine.baseSkyTop.set(envSkyTop.value);
  engine.applyTimeOfDay(engine.timeOfDay);
});
envSkyBot.addEventListener('input', () => {
  if (!engine.sceneGraph?.environment) return;
  engine.sceneGraph.environment.sky_bottom_color = envSkyBot.value;
  engine.baseSkyBot.set(envSkyBot.value);
  engine.applyTimeOfDay(engine.timeOfDay);
});
envGround.addEventListener('input', () => {
  if (!engine.sceneGraph?.environment) return;
  engine.sceneGraph.environment.ground_color = envGround.value;
  if (engine.groundMesh) engine.groundMesh.material.color.set(envGround.value);
});
envSunCol.addEventListener('input', () => {
  if (!engine.sceneGraph?.environment?.sun) return;
  engine.sceneGraph.environment.sun.color = envSunCol.value;
  rebuildKeepingSelection();
});
envFog.addEventListener('input', () => {
  if (!engine.sceneGraph?.environment) return;
  const d = parseFloat(envFog.value);
  engine.sceneGraph.environment.fog_density = d;
  if (engine.scene.fog) engine.scene.fog.density = d;
});

// Resize
function handleResize() {
  const rect = viewport3d.getBoundingClientRect();
  engine.resize(rect.width, rect.height);
}
window.addEventListener('resize', handleResize);
handleResize();

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
  if (sourceVideo.src) sourceVideo.playbackRate = Math.max(0.25, simSpeed || 0.25);
});

btnToggleSplit.addEventListener('click', () => {
  videoPanel.classList.toggle('split-mode');
  btnToggleSplit.classList.toggle('active');
});

btnToggleSync.addEventListener('click', () => {
  syncWithVideo = !syncWithVideo;
  btnToggleSync.classList.toggle('active', syncWithVideo);
});

function updateStatsPanel() {
  const sc = engine.sceneGraph;
  if (!sc) return;
  const modeUsed = latestAnalysis?.mode_used || 'opencv';
  const badgeClass = modeUsed === 'gemini' ? 'gemini' : 'opencv';
  const badgeLabel =
    modeUsed === 'gemini'
      ? `✦ Gemini Vision (${latestAnalysis?.model_used || 'AI'})`
      : '⚙ Local OpenCV + Custom 3D';

  sceneStats.innerHTML = `
    <div class="stat-badge ${badgeClass}">${badgeLabel}</div>
    <div><strong>${sc.title || '3D Scene'}</strong></div>
    <div style="margin-top:4px;">
      Mountains: <b>${(sc.mountains || []).length}</b> ·
      Water: <b>${(sc.water_bodies || []).length}</b> ·
      Structures: <b>${(sc.structures || []).length}</b><br/>
      Trees: <b>${(sc.vegetation || []).length}</b> ·
      Paths: <b>${(sc.paths || []).length}</b> ·
      Entities: <b>${(sc.dynamic_entities || []).length}</b>
    </div>
  `;
}

// Export / Import / Inspect JSON + Export .GLB
btnJson.addEventListener('click', () => {
  jsonContent.textContent = JSON.stringify(
    { scene: engine.sceneGraph, trajectories: engine.trajectories },
    null,
    2
  );
  jsonModal.classList.remove('hidden');
});
btnCloseJson.addEventListener('click', () => jsonModal.classList.add('hidden'));
jsonModal.addEventListener('click', (e) => {
  if (e.target === jsonModal) jsonModal.classList.add('hidden');
});

btnExportJson.addEventListener('click', () => {
  const payload = JSON.stringify(
    { scene: engine.sceneGraph, trajectories: engine.trajectories },
    null,
    2
  );
  const blob = new Blob([payload], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'video2sim3d_scene.json';
  a.click();
});

importJsonInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const sg = parsed.scene || parsed;
    const trajs = parsed.trajectories || engine.trajectories || [];
    transformControls.detach();
    engine.loadSceneGraph(sg, trajs, engine.videoDuration);
    refreshObjectList();
    renderObjectInspector(null);
    syncEnvInputsFromScene();
    updateStatsPanel();
    showBanner('Imported custom 3D Scene JSON!', false);
  } catch (err) {
    showBanner(`Invalid JSON file: ${err.message}`, true);
  }
});

btnExportGlb.addEventListener('click', async () => {
  try {
    showBanner('Exporting 3D scene to .GLB model...', false);
    const glbBuffer = await engine.exportGLB();
    const blob = new Blob([glbBuffer], { type: 'model/gltf-binary' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'video2sim3d_world.glb';
    a.click();
    showBanner('Exported video2sim3d_world.glb! Open it in Blender, Unity, or any 3D viewer.', false);
  } catch (err) {
    showBanner(`GLB export failed: ${err.message}`, true);
  }
});

// Core Analysis Request
let activeSampleName = 'sample_landscape_birds.mp4';

async function runAnalysis({ useSample = false, sampleName = null, file = null } = {}) {
  showBanner(null);
  const mode = modeSelect.value;
  const apiKey = apiKeyInput.value.trim();

  setLoading(
    true,
    mode === 'opencv'
      ? 'Analyzing 2D video with OpenCV...'
      : 'Analyzing 2D video with OpenCV & Gemini Vision...',
    'Computing background model, tracking moving trajectories & synthesizing 3D architecture'
  );

  const form = new FormData();
  form.append('use_sample', useSample ? 'true' : 'false');
  if (sampleName) form.append('sample_name', sampleName);
  form.append('mode', mode);
  if (apiKey) form.append('api_key', apiKey);
  if (file) form.append('file', file);

  try {
    const res = await fetch('/api/analyze', { method: 'POST', body: form });
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

    transformControls.detach();
    engine.loadSceneGraph(data.scene, data.trajectories, data.metadata.duration);

    // Frame monumental aerial architecture cleanly when mausoleum/plinth/pyramid is present
    const isPyramid = (data.scene?.structures || []).some((s) => s.kind === 'pyramid');
    const isMonumental = (data.scene?.structures || []).some((s) =>
      ['mausoleum', 'plinth', 'mosque', 'palace'].includes(s.kind)
    );
    if (isPyramid) {
      CAM_PRESETS.match.pos.set(-22.0, 22.0, 36.0);
      CAM_PRESETS.match.target.set(2.0, 4.0, -4.0);
    } else if (isMonumental) {
      CAM_PRESETS.match.pos.set(0, 26.5, 42.0);
      CAM_PRESETS.match.target.set(0, 5.5, -6.0);
    } else {
      CAM_PRESETS.match.pos.set(0, 11.2, 33.0);
      CAM_PRESETS.match.target.set(0, 4.5, -3.0);
    }
    setCameraPreset('match');
    refreshObjectList();
    renderObjectInspector(null);
    syncEnvInputsFromScene();
    updateStatsPanel();

    if (data.scene?.environment?.wind_strength != null) {
      engine.windStrength = data.scene.environment.wind_strength;
      sliderWind.value = String(engine.windStrength);
      valWind.textContent = `${engine.windStrength.toFixed(1)}x`;
    }

    sourceVideo.src = data.metadata.video_url;
    sourceVideo.playbackRate = Math.max(0.25, simSpeed || 1.0);
    videoPanel.classList.remove('hidden');
    videoMeta.innerHTML = `<span>${data.metadata.filename}</span><span>${data.metadata.width}×${data.metadata.height} · ${data.metadata.duration}s</span>`;
    sourceVideo.play().catch(() => {});

    if (data.warning) showBanner(data.warning, false);
  } catch (err) {
    showBanner(`Analysis failed: ${err.message}`, true);
  } finally {
    setLoading(false);
  }
}

btnSample.addEventListener('click', () => {
  usingSample = true;
  activeSampleName = 'sample_landscape_birds.mp4';
  selectedFile = null;
  btnAnalyze.disabled = false;
  runAnalysis({ useSample: true, sampleName: activeSampleName });
});

btnSampleTaj.addEventListener('click', () => {
  usingSample = true;
  activeSampleName = 'taj_mahal.mp4';
  selectedFile = null;
  btnAnalyze.disabled = false;
  runAnalysis({ useSample: true, sampleName: activeSampleName });
});

btnSamplePyramids.addEventListener('click', () => {
  usingSample = true;
  activeSampleName = 'pyramids_giza.mp4';
  selectedFile = null;
  btnAnalyze.disabled = false;
  runAnalysis({ useSample: true, sampleName: activeSampleName });
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
  if (selectedFile) runAnalysis({ useSample: false, file: selectedFile });
  else if (usingSample) runAnalysis({ useSample: true, sampleName: activeSampleName });
});

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

async function init() {
  refreshObjectList();
  syncEnvInputsFromScene();
  updateStatsPanel();

  try {
    const res = await fetch('/api/health');
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

  if (camTransition) {
    camTransition.progress = Math.min(1, camTransition.progress + rawDt * 2.4);
    const ease = 1 - Math.pow(1 - camTransition.progress, 3);
    engine.camera.position.lerpVectors(camTransition.startPos, camTransition.endPos, ease);
    controls.target.lerpVectors(camTransition.startTarget, camTransition.endTarget, ease);
    if (camTransition.progress >= 1) camTransition = null;
  }

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

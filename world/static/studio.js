/* WorldIR 3D Studio — Streamed Parallel 3D World & Deterministic Cinema Runtime:
 *  - Progressive WorldOp SSE consumer: terrain -> geometry -> agents -> 2-stage PBR in-place hot-swap
 *  - Non-blocking interactive Orbit & WASD Walk + live surgical chat editing DURING generation
 *  - Pure Deterministic Timestamp Evaluator evaluateWorldAt(t) (zero dt drift, reproducible scrubbing)
 *  - Independently Editable Camera Trajectories (spline dolly/crane + entity orbit)
 *  - Deterministic G-Buffer exporter (RGB, Linear Depth, World Normals, Object-ID)
 *    + Multi-View Canonical Entity Turnaround capture (Front / 3/4 Side / Back)
 *    + Synchronized gl.finish() GPU profiler + 4-View Gemini 4 Hydrogen Visual Audit
 */

import * as THREE from "./vendor/three.module.min.js";
import {
  buildArticulatedAgent,
  buildImplicitSDFObject,
  buildParametricObject,
  buildProceduralAssembly,
  buildTerrain,
  sampleTerrainHeight,
  upgradeMaterialsWithTexture,
} from "./builders.js";

// ---------------------------------------------------------------------------
// Three.js Renderer, Scene, Balanced Three-Point Lights, Atmospheric Sky & PMREM
// ---------------------------------------------------------------------------
const canvas = document.getElementById("viewport3d");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.04;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.15, 320);
camera.position.set(0, 4.8, 22);

const sunLight = new THREE.DirectionalLight("#fff0d6", 2.8);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
sunLight.shadow.camera.near = 2;
sunLight.shadow.camera.far = 130;
const shadowBound = 36;
sunLight.shadow.camera.left = -shadowBound;
sunLight.shadow.camera.right = shadowBound;
sunLight.shadow.camera.top = shadowBound;
sunLight.shadow.camera.bottom = -shadowBound;
sunLight.shadow.bias = -0.0004;
sunLight.shadow.normalBias = 0.02;
scene.add(sunLight);

const bounceLight = new THREE.DirectionalLight("#ffd4a3", 0.42);
bounceLight.position.set(-28, 12, -26);
scene.add(bounceLight);

const hemiLight = new THREE.HemisphereLight("#8cb6e8", "#5b5142", 0.72);
scene.add(hemiLight);

// Physically-Based Rayleigh + Mie Atmospheric Scattering Sky Dome
const skyUniforms = {
  uZenith: { value: new THREE.Color("#24528a") },
  uHorizon: { value: new THREE.Color("#f2be88") },
  uFogColor: { value: new THREE.Color("#dfc9ae") },
  uSunDir: { value: new THREE.Vector3(0.5, 0.45, 0.5).normalize() },
  uSunColor: { value: new THREE.Color("#ffeed2") },
};
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  uniforms: skyUniforms,
  vertexShader: `
    varying vec3 vWorldDir;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorldDir = normalize(position);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `,
  fragmentShader: `
    uniform vec3 uZenith;
    uniform vec3 uHorizon;
    uniform vec3 uFogColor;
    uniform vec3 uSunDir;
    uniform vec3 uSunColor;
    varying vec3 vWorldDir;
    void main() {
      vec3 d = normalize(vWorldDir);
      float h = clamp(d.y, 0.0, 1.0);
      vec3 sky = mix(uHorizon, uZenith, pow(h, 0.46));
      float hazeBand = exp(-abs(d.y) * 9.0);
      sky = mix(sky, mix(uHorizon, uFogColor, 0.55), hazeBand * 0.65);
      float sunCos = max(dot(d, normalize(uSunDir)), 0.0);
      sky += uSunColor * pow(sunCos, 6.0) * 0.24 * (1.0 - h * 0.45);
      sky += uSunColor * pow(sunCos, 48.0) * 0.48;
      sky += uSunColor * smoothstep(0.9985, 0.9996, sunCos) * 1.9;
      sky = mix(uFogColor * 0.72, sky, smoothstep(-0.06, 0.03, d.y));
      gl_FragColor = vec4(sky, 1.0);
    }
  `,
});
const skyDome = new THREE.Mesh(new THREE.SphereGeometry(210, 28, 18), skyMat);
scene.add(skyDome);

const pmremGen = new THREE.PMREMGenerator(renderer);
let envRenderTarget = null;
function refreshEnvironmentIBL() {
  const envScene = new THREE.Scene();
  const envSky = new THREE.Mesh(new THREE.SphereGeometry(30, 18, 12), skyMat);
  envScene.add(envSky);
  if (envRenderTarget) envRenderTarget.dispose();
  envRenderTarget = pmremGen.fromScene(envScene, 0.04);
  scene.environment = envRenderTarget.texture;
}

const cloudGroup = new THREE.Group();
scene.add(cloudGroup);
function rebuildClouds(count, atm) {
  while (cloudGroup.children.length) cloudGroup.remove(cloudGroup.children[0]);
  const isNight = atm.time_of_day === "night";
  const cColor = new THREE.Color(isNight ? "#2a354d" : "#fff7ee").lerp(
    new THREE.Color(atm.sky_horizon || "#f2be88"),
    isNight ? 0.1 : 0.28
  );
  const cMat = new THREE.MeshStandardMaterial({
    color: cColor,
    roughness: 1.0,
    metalness: 0.0,
    transparent: true,
    opacity: isNight ? 0.35 : 0.68,
    depthWrite: false,
  });
  for (let i = 0; i < count; i++) {
    const cg = new THREE.Group();
    const ang = (i / Math.max(count, 1)) * Math.PI * 2 + 0.45;
    const rad = 38 + (i % 4) * 16;
    const initX = Math.cos(ang) * rad;
    const initY = 30 + (i % 3) * 6.5;
    const initZ = Math.sin(ang) * rad;
    cg.position.set(initX, initY, initZ);
    for (let k = 0; k < 6; k++) {
      const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(2.0 + (k % 3) * 0.85, 2), cMat);
      puff.scale.set(1.65, 0.72, 1.25);
      puff.position.set((k - 2.5) * 1.65, (k % 2) * 0.65, ((k * 5) % 3 - 1) * 1.15);
      cg.add(puff);
    }
    cg.userData.initX = initX;
    cg.userData.driftSpeed = 0.22 + (i % 3) * 0.14;
    cloudGroup.add(cg);
  }
}

const selRingGeo = new THREE.RingGeometry(1.0, 1.25, 32);
selRingGeo.rotateX(-Math.PI / 2);
const selRing = new THREE.Mesh(
  selRingGeo,
  new THREE.MeshBasicMaterial({ color: "#38bdf8", side: THREE.DoubleSide, transparent: true, opacity: 0.85 })
);
selRing.visible = false;
scene.add(selRing);

// ---------------------------------------------------------------------------
// World Runtime Registry & Deterministic Playback State
// ---------------------------------------------------------------------------
const worldRoot = new THREE.Group();
scene.add(worldRoot);

const state = {
  world: null,
  terrainGroup: null,
  runtimes: new Map(),
  selectedId: null,
  camMode: "orbit",
  activeCameraTrackId: "__free__",
  playing: true,
  simTime: 0.0,
  durationS: 12.0,
  isStreamingGen: false,
  genStats: null,
  orbitTarget: new THREE.Vector3(0, 2.5, 0),
  orbitDist: 23,
  orbitTheta: 0.28,
  orbitPhi: 1.24,
  walkYaw: 0,
  walkPitch: -0.06,
  keys: new Set(),
  popAnimations: new Map(), // id -> { startPerfMs, targetScale }
};

function applyAtmosphere(atm) {
  const enc = state.world?.terrain?.enclosure || "open_sky";
  const isSpaceInterior = enc === "space_bridge" || enc === "sci_fi_corridor" || Boolean(state.world?.terrain?.space_stars);
  const isInterior = isSpaceInterior || enc === "interior_room" || enc === "cathedral_hall";
  const isNight = atm.time_of_day === "night" || atm.time_of_day === "dusk" || isSpaceInterior;
  const el = THREE.MathUtils.degToRad(atm.sun_elevation_deg ?? 32);
  const az = THREE.MathUtils.degToRad(atm.sun_azimuth_deg ?? 46);
  const sunDir = new THREE.Vector3(
    Math.cos(el) * Math.sin(az),
    Math.sin(el),
    Math.cos(el) * Math.cos(az)
  ).normalize();

  sunLight.position.copy(sunDir).multiplyScalar(48);
  sunLight.color.set(isSpaceInterior ? "#b8dcff" : (atm.sun_color || "#ffeed2"));
  sunLight.intensity = isSpaceInterior ? 0.85 : (atm.sun_intensity ?? 2.9);

  bounceLight.position.copy(sunDir).multiplyScalar(-34);
  bounceLight.position.y = Math.max(8, bounceLight.position.y);
  bounceLight.color.set(isSpaceInterior ? "#3a5c8a" : (isNight ? "#334c78" : (atm.sky_horizon || "#f2be88")));
  bounceLight.intensity = isInterior ? 0.55 : (isNight ? 0.28 : 0.48);

  hemiLight.color.set(isSpaceInterior ? "#5278a8" : (atm.sky_zenith || "#6fa4e0"));
  hemiLight.groundColor.set(isSpaceInterior ? "#161d29" : (isNight ? "#1a1f2b" : "#705d47"));
  hemiLight.intensity = isInterior ? 0.85 : (atm.ambient_intensity ?? 0.75) * 0.88;

  if (isSpaceInterior) {
    skyUniforms.uZenith.value.set("#03050c");
    skyUniforms.uHorizon.value.set("#080d1c");
    skyUniforms.uFogColor.value.set("#050812");
    skyUniforms.uSunColor.value.set("#6fb6ff");
    scene.fog = new THREE.FogExp2("#080d18", 0.004);
    cloudGroup.visible = false;
  } else {
    skyUniforms.uZenith.value.set(atm.sky_zenith || "#24528a");
    skyUniforms.uHorizon.value.set(atm.sky_horizon || "#f2be88");
    skyUniforms.uFogColor.value.set(atm.fog_color || "#dfc9ae");
    skyUniforms.uSunColor.value.set(atm.sun_color || "#ffeed2");
    scene.fog = new THREE.FogExp2(atm.fog_color || "#dfc9ae", atm.fog_density ?? 0.0075);
    cloudGroup.visible = !isInterior;
  }
  skyUniforms.uSunDir.value.copy(sunDir);
  renderer.toneMappingExposure = isSpaceInterior ? 1.18 : (isNight ? 1.15 : 0.96);

  rebuildClouds(isInterior ? 0 : (atm.cloud_count ?? 8), atm);
  refreshEnvironmentIBL();

  for (const rt of state.runtimes.values()) {
    const g = rt.group;
    if (g.userData.windowGlassMat) {
      g.userData.windowGlassMat.emissiveIntensity = isNight ? 1.95 : 0.14;
      g.userData.windowGlassMat.color.set(isNight ? "#5c4a32" : "#22303f");
    }
    if (g.userData.lampLight) {
      g.userData.lampLight.intensity = isNight ? 20.0 : 2.5;
    }
    if (g.userData.lampGlowMat) {
      g.userData.lampGlowMat.emissiveIntensity = isNight ? 3.2 : 0.75;
    }
  }
}

function positionObjectOnTerrain(obj, group, terrain) {
  const [x, yOff, z] = obj.position || [0, 0, 0];
  const groundY = sampleTerrainHeight(terrain, x, z);
  if (
    obj.carrier === "articulated_agent" &&
    (obj.agent?.rig_kind === "bird_flock" || obj.agent?.rig_kind === "floating_lanterns")
  ) {
    group.position.set(0, 0, 0);
    group.rotation.set(0, 0, 0);
    group.scale.setScalar(1);
    return;
  }
  group.position.set(x, groundY + (yOff || 0), z);
  group.rotation.y = THREE.MathUtils.degToRad(obj.rotation_y_deg || 0);
  group.scale.setScalar(obj.scale || 1.0);
}

function measureBounds(group) {
  group.updateMatrixWorld(true);
  const box = new THREE.Box3();
  group.traverse(n => {
    if (n.isMesh && !n.userData.isContactAO) box.expandByObject(n);
  });
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  return {
    topY: isFinite(box.max.y) ? box.max.y : 4.0,
    center,
    radius: Math.max(0.8, Math.hypot(size.x, size.z) * 0.5),
  };
}

async function mountSingleObject(obj, world, animatePop = false) {
  if (state.runtimes.has(obj.id)) {
    const old = state.runtimes.get(obj.id);
    worldRoot.remove(old.group);
    state.runtimes.delete(obj.id);
  }
  if (!obj.visible) return;

  const isNight = world.atmosphere.time_of_day === "night" || world.atmosphere.time_of_day === "dusk";
  let group;
  if (obj.carrier === "implicit_sdf") {
    group = await buildImplicitSDFObject(obj, world.textures || {});
  } else if (obj.carrier === "procedural_assembly") {
    group = buildProceduralAssembly(obj, world.textures || {});
  } else if (obj.carrier === "articulated_agent") {
    group = buildArticulatedAgent(obj, world.textures || {});
  } else {
    group = buildParametricObject(obj, world.textures || {}, isNight);
  }

  group.userData.objectId = obj.id;
  group.traverse(n => { n.userData.objectId = obj.id; });
  positionObjectOnTerrain(obj, group, world.terrain);
  worldRoot.add(group);

  const b = measureBounds(group);
  state.runtimes.set(obj.id, {
    spec: obj,
    group,
    topY: b.topY,
    center: b.center,
    radius: b.radius,
  });

  if (animatePop && obj.carrier !== "articulated_agent") {
    state.popAnimations.set(obj.id, {
      startMs: performance.now(),
      targetScale: obj.scale || 1.0,
    });
    group.scale.setScalar(0.05);
  }
}

function rebuildTerrainMesh(world) {
  if (state.terrainGroup) worldRoot.remove(state.terrainGroup);
  state.terrainGroup = buildTerrain(world.terrain, world.textures || {});
  worldRoot.add(state.terrainGroup);
}

function syncCameraDropdown() {
  const sel = document.getElementById("camTrackSelect");
  if (!sel || !state.world) return;
  const prev = state.activeCameraTrackId;
  sel.innerHTML = `<option value="__free__">Camera: Free Interactive</option>`;
  for (const cam of state.world.cameras || []) {
    const opt = document.createElement("option");
    opt.value = cam.id;
    opt.textContent = `Shot: ${cam.name} (${cam.duration_s}s)`;
    sel.appendChild(opt);
  }
  const hasPrev = prev === "__free__" || (state.world.cameras || []).some(c => c.id === prev);
  state.activeCameraTrackId = hasPrev ? prev : "__free__";
  sel.value = state.activeCameraTrackId;

  const activeTrack = (state.world.cameras || []).find(c => c.id === state.activeCameraTrackId);
  state.durationS = activeTrack ? activeTrack.duration_s : 12.0;
  const scrub = document.getElementById("timeScrubber");
  if (scrub) scrub.max = String(state.durationS);
}

async function loadFullWorld(world, resetCam = true) {
  state.world = world;
  while (worldRoot.children.length) worldRoot.remove(worldRoot.children[0]);
  state.runtimes.clear();
  state.popAnimations.clear();
  state.selectedId = null;
  state.activeCameraTrackId = "__free__";
  selRing.visible = false;

  rebuildTerrainMesh(world);
  applyAtmosphere(world.atmosphere);

  await Promise.all(world.objects.filter(o => o.visible).map(o => mountSingleObject(o, world, false)));

  syncCameraDropdown();
  if (resetCam) {
    const sp = world.camera_spawn || [0, 5, 22];
    const lk = world.camera_look_at || [0, 2.5, 0];
    setOrbitFromLook(new THREE.Vector3(...sp), new THREE.Vector3(...lk));
  }
  evaluateWorldAt(state.simTime);
  renderSidebars();
}

// ---------------------------------------------------------------------------
// Progressive WorldOp Consumer (Live SSE Streaming & In-Place Refinement!)
// ---------------------------------------------------------------------------
async function applyWorldOp(op) {
  if (!op || !op.domain) return;

  if (op.domain === "init") {
    const p = op.payload;
    state.world = {
      world_id: p.world_id || op.world_id,
      title: p.title || "Streaming 3D World...",
      prompt: p.prompt || "",
      terrain: p.terrain,
      atmosphere: p.atmosphere,
      textures: {},
      appearance_refs: {},
      objects: [],
      cameras: [],
      regions: p.regions || [],
      revision: 1,
      seq: op.seq,
      generation_status: "streaming",
      history: [],
      cumulative_costs: { flash_lite_calls: 1, carbon_calls: 0, hydrogen_calls: 0, nano_banana_texture_calls: 0, provisional_texture_calls: 0, sdf_meshes_compiled: 0 },
      camera_spawn: p.camera_spawn || [0, 4.2, 22],
      camera_look_at: p.camera_look_at || [0, 2.4, -1],
    };
    while (worldRoot.children.length) worldRoot.remove(worldRoot.children[0]);
    state.runtimes.clear();
    state.selectedId = null;
    state.activeCameraTrackId = "__free__";
    selRing.visible = false;

    rebuildTerrainMesh(state.world);
    applyAtmosphere(state.world.atmosphere);
    const sp = state.world.camera_spawn;
    const lk = state.world.camera_look_at;
    setOrbitFromLook(new THREE.Vector3(...sp), new THREE.Vector3(...lk));
    syncCameraDropdown();
    renderSidebars();
    return;
  }

  if (!state.world) return;
  state.world.seq = Math.max(state.world.seq || 0, op.seq || 0);

  if (op.domain === "object") {
    if (op.action === "delete") {
      const rid = op.target_id || op.payload.object_id;
      const idx = state.world.objects.findIndex(o => o.id === rid);
      if (idx >= 0) state.world.objects[idx].visible = false;
      const rt = state.runtimes.get(rid);
      if (rt) {
        worldRoot.remove(rt.group);
        state.runtimes.delete(rid);
      }
      if (state.selectedId === rid) selectObject(null);
      renderSidebars();
      return;
    }

    const obj = op.payload;
    const idx = state.world.objects.findIndex(o => o.id === obj.id);
    const prevObj = idx >= 0 ? state.world.objects[idx] : null;
    if (idx >= 0) state.world.objects[idx] = obj;
    else state.world.objects.push(obj);

    // Check if we can mutate the LIVE Three.js object in-place (zero rebuild for transform/behavior edits!)
    const existingRt = state.runtimes.get(obj.id);
    const sameCarrier = prevObj && prevObj.carrier === obj.carrier;
    const sameMat = prevObj && JSON.stringify(prevObj.material) === JSON.stringify(obj.material);
    const sameGeom =
      prevObj &&
      JSON.stringify(prevObj.parametric) === JSON.stringify(obj.parametric) &&
      JSON.stringify(prevObj.procedural) === JSON.stringify(obj.procedural) &&
      JSON.stringify(prevObj.implicit_sdf) === JSON.stringify(obj.implicit_sdf) &&
      JSON.stringify(prevObj.agent) === JSON.stringify(obj.agent);

    if (existingRt && sameCarrier && sameMat && sameGeom && obj.visible) {
      existingRt.spec = obj;
      positionObjectOnTerrain(obj, existingRt.group, state.world.terrain);
      const b = measureBounds(existingRt.group);
      existingRt.topY = b.topY;
      existingRt.center = b.center;
      existingRt.radius = b.radius;
    } else {
      const isNewStreamObj = !prevObj && (op.phase === "geometry" || op.phase === "region");
      await mountSingleObject(obj, state.world, isNewStreamObj);
    }
    evaluateWorldAt(state.simTime);
    if (state.selectedId === obj.id) selectObject(obj.id);
    renderSidebars();
    return;
  }

  if (op.domain === "texture") {
    const tex = op.payload;
    state.world.textures = state.world.textures || {};
    state.world.textures[tex.id] = tex;
    // In-place PBR upgrade across ALL live meshes referencing this texture!
    await upgradeMaterialsWithTexture(worldRoot, tex);
    // If terrain uses this texture (plaza or hillside splat), refresh terrain smoothly
    if (tex.id === state.world.terrain.texture_id || tex.id === state.world.terrain.hill_texture_id) {
      rebuildTerrainMesh(state.world);
    }
    renderSidebars();
    return;
  }

  if (op.domain === "atmosphere") {
    state.world.atmosphere = op.payload;
    applyAtmosphere(state.world.atmosphere);
    renderSidebars();
    return;
  }

  if (op.domain === "terrain") {
    state.world.terrain = op.payload;
    rebuildTerrainMesh(state.world);
    for (const rt of state.runtimes.values()) {
      positionObjectOnTerrain(rt.spec, rt.group, state.world.terrain);
    }
    renderSidebars();
    return;
  }

  if (op.domain === "camera") {
    const cam = op.payload;
    state.world.cameras = state.world.cameras || [];
    const idx = state.world.cameras.findIndex(c => c.id === cam.id);
    if (idx >= 0) state.world.cameras[idx] = cam;
    else state.world.cameras.push(cam);
    syncCameraDropdown();
    return;
  }

  if (op.domain === "region") {
    const reg = op.payload.region;
    state.world.regions = state.world.regions || [];
    const idx = state.world.regions.findIndex(r => r.region_id === reg.region_id);
    if (idx >= 0) state.world.regions[idx] = reg;
    else state.world.regions.push(reg);
    if (op.payload.terrain) {
      state.world.terrain = op.payload.terrain;
      rebuildTerrainMesh(state.world);
    }
    renderSidebars();
    return;
  }
}

async function consumeWorldOpStream(response, onOp) {
  if (!response.ok) {
    const txt = await response.text();
    throw new Error(txt || `HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const jsonStr = line.slice(5).trim();
        if (!jsonStr) continue;
        try {
          const op = JSON.parse(jsonStr);
          await onOp(op);
        } catch (err) {
          console.warn("Malformed SSE op:", err);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Pure Deterministic Timestamp Evaluator evaluateWorldAt(t) (Zero dt Drift!)
// ---------------------------------------------------------------------------
function smoothstep(e0, e1, x) {
  const u = Math.max(0, Math.min(1, (x - e0) / Math.max(e1 - e0, 1e-6)));
  return u * u * (3 - 2 * u);
}

function resolveTargetBounds(targetId) {
  if (targetId && state.runtimes.has(targetId)) {
    const rt = state.runtimes.get(targetId);
    // Use live group position for dynamic actors (like bride) so groom/guests track accurately!
    if (rt.spec.carrier === "articulated_agent" && rt.group.userData.humanMesh) {
      return { cx: rt.group.position.x, cz: rt.group.position.z, topY: rt.group.position.y + 1.65, radius: 0.5 };
    }
    return { cx: rt.center.x, cz: rt.center.z, topY: rt.topY, radius: rt.radius };
  }
  return { cx: 0, cz: 0, topY: 3.2, radius: 3.0 };
}

function samplePolylineArcLength(waypoints, uFrac) {
  if (!waypoints || waypoints.length === 0) return { x: 0, z: 0, dx: 0, dz: 1, dist: 0 };
  if (waypoints.length === 1) return { x: waypoints[0][0], z: waypoints[0][1], dx: 0, dz: 1, dist: 0 };
  const segLens = [];
  let total = 0;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const L = Math.hypot(waypoints[i + 1][0] - waypoints[i][0], waypoints[i + 1][1] - waypoints[i][1]);
    segLens.push(L);
    total += L;
  }
  if (total < 1e-5) return { x: waypoints[0][0], z: waypoints[0][1], dx: 0, dz: 1, dist: 0 };
  const targetD = THREE.MathUtils.clamp(uFrac, 0, 1) * total;
  let acc = 0;
  for (let i = 0; i < segLens.length; i++) {
    const nextAcc = acc + segLens[i];
    if (targetD <= nextAcc || i === segLens.length - 1) {
      const localU = segLens[i] > 1e-5 ? (targetD - acc) / segLens[i] : 0;
      const x0 = waypoints[i][0], z0 = waypoints[i][1];
      const x1 = waypoints[i + 1][0], z1 = waypoints[i + 1][1];
      return {
        x: x0 + (x1 - x0) * localU,
        z: z0 + (z1 - z0) * localU,
        dx: (x1 - x0) / Math.max(segLens[i], 1e-5),
        dz: (z1 - z0) / Math.max(segLens[i], 1e-5),
        dist: targetD,
      };
    }
    acc = nextAcc;
  }
  return { x: waypoints[0][0], z: waypoints[0][1], dx: 0, dz: 1, dist: 0 };
}

function evaluateCameraTrack(track, t) {
  if (!track) return;
  const dur = Math.max(0.5, track.duration_s || 12.0);
  const tMod = (t >= dur && t <= dur + 1e-3) ? dur : (t % dur);

  if (track.kind === "orbit_entity") {
    const tgt = resolveTargetBounds(track.look_at_id);
    const ang = (tMod / dur) * Math.PI * 2 + 0.4;
    const r = track.orbit_radius || 9.0;
    const h = track.orbit_height || 3.8;
    camera.position.set(tgt.cx + Math.cos(ang) * r, h, tgt.cz + Math.sin(ang) * r);
    camera.lookAt(tgt.cx, Math.max(1.2, tgt.topY * 0.55), tgt.cz);
    return;
  }

  const kfs = track.keyframes || [];
  if (kfs.length === 0) return;
  if (kfs.length === 1) {
    camera.position.set(...kfs[0].pos);
    if (kfs[0].look_at) camera.lookAt(...kfs[0].look_at);
    camera.fov = kfs[0].fov_deg || 46;
    camera.updateProjectionMatrix();
    return;
  }

  const ptsPos = kfs.map(k => new THREE.Vector3(...k.pos));
  const ptsLook = kfs.map(k => new THREE.Vector3(...(k.look_at || [0, 1.8, 0])));
  const curvePos = new THREE.CatmullRomCurve3(ptsPos, false, "centripetal");
  const curveLook = new THREE.CatmullRomCurve3(ptsLook, false, "centripetal");

  const t0 = kfs[0].t ?? 0;
  const t1 = kfs[kfs.length - 1].t ?? dur;
  const frac = THREE.MathUtils.clamp((tMod - t0) / Math.max(t1 - t0, 1e-4), 0, 1);

  const posNow = curvePos.getPoint(frac);
  const lookNow = track.look_at_id
    ? (() => {
        const tb = resolveTargetBounds(track.look_at_id);
        return new THREE.Vector3(tb.cx, Math.max(1.2, tb.topY * 0.8), tb.cz);
      })()
    : curveLook.getPoint(frac);

  camera.position.copy(posNow);
  camera.lookAt(lookNow);

  // Interpolate FOV smoothly
  const f0 = kfs[0].fov_deg || 46;
  const f1 = kfs[kfs.length - 1].fov_deg || 46;
  const fov = f0 + (f1 - f0) * frac;
  if (Math.abs(camera.fov - fov) > 0.05) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
}

export function evaluateWorldAt(t) {
  if (!state.world) return;
  const wind = state.world.atmosphere?.wind_strength ?? 0.5;
  const terrain = state.world.terrain;

  // Deterministic clouds
  for (const cg of cloudGroup.children) {
    const rawX = (cg.userData.initX || 0) + cg.userData.driftSpeed * wind * t;
    cg.position.x = (((rawX + 75) % 150) + 150) % 150 - 75;
  }

  // Deterministic terrain water
  const wm = state.terrainGroup?.userData?.waterMesh;
  const wnt = state.terrainGroup?.userData?.waterNormalTex;
  if (wm) wm.position.y = (terrain.water_level ?? -0.4) + Math.sin(t * 1.4) * 0.03;
  if (wnt) {
    wnt.offset.x = (t * 0.045) % 1.0;
    wnt.offset.y = (t * 0.032) % 1.0;
  }

  // PASS 1: Independent kinematics & locomotion
  const standFaceRuntimes = [];
  for (const rt of state.runtimes.values()) {
    const { spec, group } = rt;

    if (group.userData.waterNormalTex) {
      group.userData.waterNormalTex.offset.x = (t * 0.09) % 1.0;
      group.userData.waterNormalTex.offset.y = (((-t * 0.06) % 1.0) + 1.0) % 1.0;
    }

    if (group.userData.waterDrops) {
      for (const drop of group.userData.waterDrops) {
        const d = drop.userData;
        const u = (d.phase + t * 0.85) % 1.0;
        const r = u * d.radius;
        const arcY = d.topY + 0.95 * u - (0.95 + (d.topY - d.poolY)) * u * u;
        drop.position.set(Math.cos(d.ang) * r, Math.max(d.poolY, arcY), Math.sin(d.ang) * r);
      }
    }

    if (group.userData.swayGroup) {
      const ph = group.userData.swayPhase || 0;
      group.userData.swayGroup.rotation.z = Math.sin(t * 1.3 + ph) * 0.032 * wind;
      group.userData.swayGroup.rotation.x = Math.cos(t * 0.95 + ph) * 0.02 * wind;
    }

    if (group.userData.spinRotorZ) group.userData.spinRotorZ.rotation.z = -t * (0.65 + wind * 0.6);
    if (group.userData.sweepBeamY) group.userData.sweepBeamY.rotation.y = t * 0.75;
    if (group.userData.clockHands) {
      for (const hand of group.userData.clockHands) hand.rotation.z = -t * 0.25;
    }

    // Pure deterministic procedural_assembly part animations (holograms, spinning rings, pulsing cores, swaying fronds)
    if (group.userData.animatedParts) {
      for (const ap of group.userData.animatedParts) {
        if (ap.anim === "spin_y") ap.mesh.rotation.y = ap.baseRotY + t * 0.85;
        else if (ap.anim === "spin_z") ap.mesh.rotation.z = ap.baseRotZ - t * 0.95;
        else if (ap.anim === "bob_y") ap.mesh.position.y = ap.baseY + Math.sin(t * 2.1 + ap.phase) * 0.14;
        else if (ap.anim === "pulse_emissive" && ap.mesh.material) {
          ap.mesh.material.emissiveIntensity = ap.baseEmissive * (0.65 + 0.45 * Math.sin(t * 2.8 + ap.phase));
        } else if (ap.anim === "sway") {
          ap.mesh.rotation.z = ap.baseRotZ + Math.sin(t * 1.4 + ap.phase) * 0.045 * wind;
        }
      }
    }

    // Pure deterministic Bird Flock (closed-form modular phase — reproducible at any t!)
    if (group.userData.flockMembers) {
      const beh = spec.behavior || {};
      const tgt = resolveTargetBounds(beh.target_id);
      const orbitR = Math.max(tgt.radius + 1.8, beh.orbit_radius || 6.0);
      const orbitH = Math.max(tgt.topY + 1.6, beh.orbit_height || 6.0);
      const speed = beh.speed || 0.7;
      const canPerch = beh.kind === "orbit_and_perch";
      const flyDur = beh.fly_duration_sec || 7.5;
      const perchDur = beh.perch_duration_sec || 3.5;
      const cycleDur = flyDur + perchDur;

      for (const bird of group.userData.flockMembers) {
        const st = bird.userData.agentState;
        const idx = st.perchSlot || 0;
        const slotAng = (idx * 2.1) % (Math.PI * 2);
        const perchRad = Math.min(tgt.radius * 0.45, 1.35);
        const perchPos = new THREE.Vector3(
          tgt.cx + Math.cos(slotAng) * perchRad,
          tgt.topY + 0.14,
          tgt.cz + Math.sin(slotAng) * perchRad
        );

        const ang = idx * 1.15 + t * speed * (0.85 + 0.2 * Math.sin(idx));
        const rNow = orbitR + st.radiusOffset;
        const yNow = orbitH + st.heightOffset + Math.sin(ang * 2.0 + idx) * 0.75;
        const flyPos = new THREE.Vector3(tgt.cx + Math.cos(ang) * rNow, yNow, tgt.cz + Math.sin(ang) * rNow);
        const flyVel = new THREE.Vector3(-Math.sin(ang) * rNow, Math.cos(ang * 2.0 + idx) * 0.75, Math.cos(ang) * rNow);

        let perchBlend = 0.0;
        if (canPerch) {
          const tau = (t + idx * 1.85) % cycleDur;
          if (tau > flyDur) {
            const localP = tau - flyDur;
            const landIn = smoothstep(0.0, 1.1, localP);
            const takeOff = 1.0 - smoothstep(perchDur - 0.8, perchDur, localP);
            perchBlend = landIn * takeOff;
          }
        }

        const pos = flyPos.clone().lerp(perchPos, perchBlend);
        bird.position.copy(pos);
        if (perchBlend > 0.85) {
          bird.rotation.set(0, slotAng + Math.sin(t * 1.6 + idx) * 0.25, 0);
          bird.userData.wingL.rotation.z = -1.05;
          bird.userData.wingR.rotation.z = 1.05;
        } else {
          const lookDir = flyVel.clone().lerp(perchPos.clone().sub(pos), perchBlend * 0.5);
          if (lookDir.lengthSq() > 1e-4) bird.lookAt(pos.clone().add(lookDir));
          bird.rotation.z = -0.28 * (1.0 - perchBlend);
          const flap = Math.sin(t * 11.0 + idx * 1.37) * 0.72 * (1.0 - perchBlend * 0.6);
          bird.userData.wingL.rotation.z = flap;
          bird.userData.wingR.rotation.z = -flap;
        }
      }
    }

    // Pure deterministic Floating Lanterns
    if (group.userData.lanternMembers) {
      const beh = spec.behavior || {};
      const tgt = resolveTargetBounds(beh.target_id);
      const rad = beh.orbit_radius || 5.5;
      const baseH = Math.max(tgt.topY + 1.2, beh.orbit_height || 4.8);
      for (let i = 0; i < group.userData.lanternMembers.length; i++) {
        const lg = group.userData.lanternMembers[i];
        const st = lg.userData.agentState;
        const ang = (i / group.userData.lanternMembers.length) * Math.PI * 2 + t * (beh.speed || 0.25);
        lg.position.set(
          tgt.cx + Math.cos(ang) * (rad + st.radiusOffset),
          baseH + st.heightOffset + Math.sin(t * 1.4 + ang) * 0.55,
          tgt.cz + Math.sin(ang) * (rad + st.radiusOffset)
        );
        lg.rotation.y = t * 0.4 + i;
      }
    }

    // Pure deterministic Patrol Vehicles / Fox
    if (group.userData.patrolMesh) {
      const beh = spec.behavior || {};
      const tgt = resolveTargetBounds(beh.target_id);
      const rad = Math.max(tgt.radius + 2.5, beh.orbit_radius || 7.5);
      const spd = beh.speed || 0.45;
      const ang = t * spd;
      const nx = tgt.cx + Math.cos(ang) * rad;
      const nz = tgt.cz + Math.sin(ang) * rad;
      const isBoat = spec.agent?.rig_kind === "boat_cruiser";
      const ny = isBoat ? (terrain.water_level ?? -0.4) + 0.05 : sampleTerrainHeight(terrain, nx, nz);
      group.position.set(nx, ny, nz);
      const vx = -Math.sin(ang), vz = Math.cos(ang);
      group.rotation.y = Math.atan2(-vz, vx);
      const pm = group.userData.patrolMesh;
      if (pm.userData.wheels) {
        for (const w of pm.userData.wheels) w.rotation.z = -t * spd * rad * 1.8;
      }
      if (pm.userData.legs) {
        for (const leg of pm.userData.legs) leg.rotation.z = Math.sin(t * 8.5 + leg.userData.phase) * 0.48;
      }
    }

    // Pure deterministic Human Character Rig (Bride walking, Groom/Guests watching!)
    if (group.userData.humanMesh) {
      const beh = spec.behavior || {};
      const hm = group.userData.humanMesh;
      const rig = hm.userData.humanRig;

      if (beh.kind === "walk_path" && beh.waypoints_xz && beh.waypoints_xz.length >= 2) {
        const t0 = beh.start_time_s ?? 0.0;
        const dur = Math.max(0.5, beh.duration_s ?? 4.5);
        const uRaw = THREE.MathUtils.clamp((t - t0) / dur, 0, 1);
        const uEase = smoothstep(0, 1, uRaw);
        const pt = samplePolylineArcLength(beh.waypoints_xz, uEase);
        const gy = sampleTerrainHeight(terrain, pt.x, pt.z);
        group.position.set(pt.x, gy, pt.z);
        group.rotation.y = Math.atan2(pt.dx, pt.dz);

        const isMoving = uRaw > 0.005 && uRaw < 0.995;
        const stridePhase = pt.dist * 3.8;
        const amp = isMoving ? Math.sin(Math.min(1, uRaw * 6) * Math.PI * 0.5) * Math.sin(Math.min(1, (1 - uRaw) * 6) * Math.PI * 0.5) : 0;

        for (const leg of rig.legs) {
          leg.rotation.x = Math.sin(stridePhase + leg.userData.phase) * 0.34 * amp;
        }
        if (!rig.hasBouquet) {
          for (const arm of rig.arms) {
            arm.rotation.x = Math.sin(stridePhase + arm.userData.phase) * 0.24 * amp;
          }
        }
        // Subtle natural vertical walk bob + graceful bridal veil & gown sway
        rig.torsoGroup.position.y = 0.88 + Math.abs(Math.sin(stridePhase)) * 0.025 * amp;
        if (rig.veilMesh) {
          rig.veilMesh.rotation.x = 0.14 * amp + Math.sin(t * 2.2) * 0.06 * (0.5 + wind);
          rig.veilMesh.rotation.y = Math.cos(t * 1.5) * 0.05;
        }
        if (rig.skirtMesh) {
          rig.skirtMesh.rotation.z = Math.sin(stridePhase) * 0.03 * amp;
        }
      } else {
        const [x, yOff, z] = spec.position || [0, 0, 0];
        const gy = sampleTerrainHeight(terrain, x, z);
        group.position.set(x, gy + (yOff || 0), z);
        if (beh.kind === "stand_and_face" && beh.target_id) {
          standFaceRuntimes.push(rt);
        } else {
          group.rotation.y = THREE.MathUtils.degToRad(spec.rotation_y_deg || 0);
        }
        // Gentle idle breathing
        rig.torsoGroup.position.y = 0.88 + Math.sin(t * 1.8 + x) * 0.008;
      }
    }
  }

  // PASS 2: Relational gaze & facing constraints (Groom, Officiant & Guests smoothly watch the Bride!)
  for (const rt of standFaceRuntimes) {
    const { spec, group } = rt;
    const tgt = resolveTargetBounds(spec.behavior.target_id);
    const dx = tgt.cx - group.position.x;
    const dz = tgt.cz - group.position.z;
    const desiredYaw = Math.atan2(dx, dz);
    group.rotation.y = desiredYaw;
    const rig = group.userData.humanMesh?.userData?.humanRig;
    if (rig?.headPivot) {
      rig.headPivot.rotation.y = Math.sin(t * 0.8 + group.position.x) * 0.06;
    }
  }

  // Active independent Camera Trajectory override
  if (state.activeCameraTrackId !== "__free__" && state.world.cameras) {
    const track = state.world.cameras.find(c => c.id === state.activeCameraTrackId);
    if (track) evaluateCameraTrack(track, t);
  }
}

// ---------------------------------------------------------------------------
// Deterministic G-Buffer Exporter + 3-View Entity Turnaround Capture + Ortho SDF Capture
// ---------------------------------------------------------------------------
const linearDepthMat = new THREE.ShaderMaterial({
  uniforms: { uNear: { value: 0.5 }, uFar: { value: 65.0 } },
  vertexShader: `
    varying float vViewZ;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vViewZ = -mv.z;
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: `
    uniform float uNear;
    uniform float uFar;
    varying float vViewZ;
    void main() {
      float d = clamp((vViewZ - uNear) / (uFar - uNear), 0.0, 1.0);
      float inv = 1.0 - pow(d, 0.65);
      gl_FragColor = vec4(vec3(inv), 1.0);
    }
  `,
});

const normalPassMat = new THREE.MeshNormalMaterial();

function hashIdToColor(idStr) {
  let h = 2166136261;
  for (let i = 0; i < idStr.length; i++) {
    h ^= idStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const r = 45 + ((h >>> 0) % 195);
  const g = 45 + ((h >>> 8) % 195);
  const b = 45 + ((h >>> 16) % 195);
  return new THREE.Color(r / 255, g / 255, b / 255);
}

function captureGBufferPasses(posArr = null, lookArr = null, outW = 768, outH = 480) {
  const prevPos = camera.position.clone();
  const prevQuat = camera.quaternion.clone();
  const prevAspect = camera.aspect;
  const prevSelVis = selRing.visible;
  const prevSkyVis = skyDome.visible;
  const prevCloudVis = cloudGroup.visible;
  const prevFog = scene.fog;
  const prevBg = scene.background;
  const prevTone = renderer.toneMapping;

  selRing.visible = false;
  if (posArr && lookArr) {
    camera.position.set(posArr[0], posArr[1], posArr[2]);
    camera.lookAt(lookArr[0], lookArr[1], lookArr[2]);
  }
  camera.aspect = outW / outH;
  camera.updateProjectionMatrix();

  const tmp = document.createElement("canvas");
  tmp.width = outW;
  tmp.height = outH;
  const ctx = tmp.getContext("2d");

  function snap(quality = 0.92) {
    renderer.render(scene, camera);
    ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, outW, outH);
    return tmp.toDataURL("image/jpeg", quality);
  }

  const rgb = snap(0.92);

  skyDome.visible = false;
  cloudGroup.visible = false;
  scene.fog = null;
  renderer.toneMapping = THREE.NoToneMapping;

  const hiddenAO = [];
  worldRoot.traverse(n => {
    if (n.userData.isContactAO && n.visible) { n.visible = false; hiddenAO.push(n); }
  });

  scene.background = new THREE.Color("#000000");
  scene.overrideMaterial = linearDepthMat;
  const depth = snap(0.90);

  scene.background = new THREE.Color("#8080ff");
  scene.overrideMaterial = normalPassMat;
  const normals = snap(0.90);
  scene.overrideMaterial = null;

  scene.background = new THREE.Color("#10141c");
  const savedMats = [];
  const idMatCache = new Map();
  worldRoot.traverse(n => {
    if (n.isMesh && n.visible) {
      const oid = n.userData.objectId || "__terrain__";
      if (!idMatCache.has(oid)) {
        idMatCache.set(
          oid,
          new THREE.MeshBasicMaterial({
            color: oid === "__terrain__" ? new THREE.Color("#2b323d") : hashIdToColor(oid),
          })
        );
      }
      savedMats.push([n, n.material]);
      n.material = idMatCache.get(oid);
    }
  });
  const obj_id = snap(0.92);

  for (const [n, m] of savedMats) n.material = m;
  for (const m of idMatCache.values()) m.dispose();
  for (const ao of hiddenAO) ao.visible = true;
  scene.background = prevBg;
  scene.fog = prevFog;
  skyDome.visible = prevSkyVis;
  cloudGroup.visible = prevCloudVis;
  renderer.toneMapping = prevTone;
  camera.aspect = prevAspect;
  camera.updateProjectionMatrix();
  camera.position.copy(prevPos);
  camera.quaternion.copy(prevQuat);
  selRing.visible = prevSelVis;
  renderer.render(scene, camera);

  return { rgb, depth, normals, obj_id };
}

function captureEntityTurnaround3View(objectId) {
  // Isolate a single persistent entity in a neutral studio lighting scene and render Front / 3/4 Side / Back
  const rt = state.runtimes.get(objectId);
  if (!rt) throw new Error(`Entity ${objectId} not found`);

  const isoScene = new THREE.Scene();
  isoScene.background = new THREE.Color("#7c8087");
  isoScene.add(new THREE.AmbientLight("#ffffff", 1.15));
  const key = new THREE.DirectionalLight("#fff6eb", 1.35);
  key.position.set(2.5, 4.0, 4.0);
  const fill = new THREE.DirectionalLight("#dce8f8", 0.85);
  fill.position.set(-3.0, 2.5, -2.5);
  isoScene.add(key, fill);

  const clone = rt.group.clone(true);
  clone.position.set(0, 0, 0);
  clone.rotation.set(0, 0, 0);
  clone.traverse(n => { if (n.userData?.isContactAO) n.visible = false; });
  isoScene.add(clone);

  const box = new THREE.Box3().setFromObject(clone);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  const maxDim = Math.max(size.x, size.y, size.z, 1.4);

  const cam = new THREE.PerspectiveCamera(34, 384 / 512, 0.1, 40);
  const dist = maxDim * 2.15;

  const outCanvas = document.createElement("canvas");
  outCanvas.width = 384;
  outCanvas.height = 512;
  const ctx = outCanvas.getContext("2d");

  renderer.setSize(384, 512, false);

  function snapAngle(deg) {
    const rad = THREE.MathUtils.degToRad(deg);
    cam.position.set(center.x + Math.sin(rad) * dist, center.y + size.y * 0.05, center.z + Math.cos(rad) * dist);
    cam.lookAt(center.x, center.y, center.z);
    renderer.render(isoScene, cam);
    ctx.drawImage(canvas, 0, 0, 384, 512);
    return outCanvas.toDataURL("image/jpeg", 0.92);
  }

  const front = snapAngle(0);
  const side = snapAngle(50);
  const back = snapAngle(180);

  resize();
  renderer.render(scene, camera);
  return { front, side, back };
}

function captureShotKeyframes(cameraTrackId, timestamps, outW = 768, outH = 480) {
  const prevTrack = state.activeCameraTrackId;
  const prevPlay = state.playing;
  const prevTime = state.simTime;

  state.playing = false;
  if (cameraTrackId) state.activeCameraTrackId = cameraTrackId;

  const frames = [];
  for (const t of timestamps) {
    state.simTime = t;
    evaluateWorldAt(t);
    const gbuf = captureGBufferPasses(null, null, outW, outH);
    frames.push({ t, ...gbuf });
  }

  state.activeCameraTrackId = prevTrack;
  state.playing = prevPlay;
  state.simTime = prevTime;
  evaluateWorldAt(prevTime);
  renderer.render(scene, camera);
  return frames;
}

function captureDenseGuideFrames(cameraTrackId, tStart, tEnd, totalFrames, outW = 480, outH = 300) {
  const prevTrack = state.activeCameraTrackId;
  const prevPlay = state.playing;
  const prevTime = state.simTime;
  const prevAspect = camera.aspect;
  const prevSelVis = selRing.visible;

  state.playing = false;
  selRing.visible = false;
  if (cameraTrackId) state.activeCameraTrackId = cameraTrackId;
  camera.aspect = outW / outH;
  camera.updateProjectionMatrix();

  const tmp = document.createElement("canvas");
  tmp.width = outW;
  tmp.height = outH;
  const ctx = tmp.getContext("2d");

  const frames = [];
  for (let i = 0; i < totalFrames; i++) {
    const u = totalFrames > 1 ? i / (totalFrames - 1) : 0;
    const t = tStart + (tEnd - tStart) * u;
    evaluateWorldAt(t);
    renderer.render(scene, camera);
    ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, outW, outH);
    frames.push(tmp.toDataURL("image/jpeg", 0.86));
  }

  camera.aspect = prevAspect;
  camera.updateProjectionMatrix();
  state.activeCameraTrackId = prevTrack;
  state.playing = prevPlay;
  state.simTime = prevTime;
  selRing.visible = prevSelVis;
  evaluateWorldAt(prevTime);
  renderer.render(scene, camera);
  return frames;
}

function captureObjectOrthoFrontBack(objectId) {
  const rt = state.runtimes.get(objectId);
  if (!rt) throw new Error(`Object ${objectId} not found in live scene`);

  let heroMesh = null;
  rt.group.traverse(n => { if (n.userData.isSDFHeroMesh) heroMesh = n; });
  if (!heroMesh) throw new Error(`Object ${objectId} has no implicit_sdf mesh`);

  const isoScene = new THREE.Scene();
  isoScene.background = new THREE.Color(120 / 255, 124 / 255, 130 / 255);
  const amb = new THREE.AmbientLight("#ffffff", 1.15);
  const key = new THREE.DirectionalLight("#ffffff", 0.95);
  key.position.set(1.5, 2.5, 3.0);
  const fill = new THREE.DirectionalLight("#e6eef8", 0.85);
  fill.position.set(-1.5, 1.5, -3.0);
  isoScene.add(amb, key, fill);

  const hasVC = Boolean(heroMesh.geometry.attributes.color);
  const clayMat = new THREE.MeshStandardMaterial({ color: "#e8e3da", roughness: 0.65, metalness: 0.05, vertexColors: hasVC });
  isoScene.add(new THREE.Mesh(heroMesh.geometry, clayMat));

  const pb = heroMesh.userData.sdfProjBounds || { cx: 0, cy: 1.1, span: 2.6 };
  const half = pb.span * 0.5;
  const orthoCam = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, 30);

  const prevTone = renderer.toneMapping;
  renderer.toneMapping = THREE.NoToneMapping;

  const outCanvas = document.createElement("canvas");
  outCanvas.width = 512;
  outCanvas.height = 512;
  const ctx = outCanvas.getContext("2d");

  renderer.setSize(512, 512, false);
  orthoCam.position.set(pb.cx, pb.cy, 8.0);
  orthoCam.lookAt(pb.cx, pb.cy, 0);
  renderer.render(isoScene, orthoCam);
  ctx.drawImage(canvas, 0, 0, 512, 512);
  const front_b64 = outCanvas.toDataURL("image/png");

  orthoCam.position.set(pb.cx, pb.cy, -8.0);
  orthoCam.lookAt(pb.cx, pb.cy, 0);
  renderer.render(isoScene, orthoCam);
  ctx.drawImage(canvas, 0, 0, 512, 512);
  const back_b64 = outCanvas.toDataURL("image/png");

  clayMat.dispose();
  renderer.toneMapping = prevTone;
  resize();
  renderer.render(scene, camera);
  return { front_b64, back_b64, bounds: pb };
}

function measureSyncGpuFrameMs(numFrames = 24) {
  const gl = renderer.getContext();
  renderer.render(scene, camera);
  gl.finish();
  const samples = [];
  for (let i = 0; i < numFrames; i++) {
    const t0 = performance.now();
    renderer.render(scene, camera);
    gl.finish();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return {
    frames: numFrames,
    resolution: [canvas.width, canvas.height],
    min_ms: Number(samples[0].toFixed(3)),
    median_ms: Number(samples[Math.floor(samples.length / 2)].toFixed(3)),
    mean_ms: Number(mean.toFixed(3)),
    p95_ms: Number(samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))].toFixed(3)),
    effective_fps: Number((1000 / Math.max(mean, 0.01)).toFixed(1)),
  };
}

// ---------------------------------------------------------------------------
// Dual Interactive Camera Controller: Orbit 360° + Free-Walk WASD + Mouse Look
// ---------------------------------------------------------------------------
function updateOrbitCamera() {
  const sinPhi = Math.sin(state.orbitPhi);
  camera.position.set(
    state.orbitTarget.x + state.orbitDist * sinPhi * Math.sin(state.orbitTheta),
    state.orbitTarget.y + state.orbitDist * Math.cos(state.orbitPhi),
    state.orbitTarget.z + state.orbitDist * sinPhi * Math.cos(state.orbitTheta)
  );
  camera.lookAt(state.orbitTarget);
}

function setOrbitFromLook(pos, target) {
  state.activeCameraTrackId = "__free__";
  const sel = document.getElementById("camTrackSelect");
  if (sel) sel.value = "__free__";
  state.orbitTarget.copy(target);
  const off = pos.clone().sub(target);
  state.orbitDist = Math.max(2.5, Math.min(85, off.length()));
  state.orbitTheta = Math.atan2(off.x, off.z);
  state.orbitPhi = Math.max(0.16, Math.min(Math.PI * 0.485, Math.acos(THREE.MathUtils.clamp(off.y / state.orbitDist, -1, 1))));
  updateOrbitCamera();
}

function setCameraMode(mode) {
  state.camMode = mode;
  state.activeCameraTrackId = "__free__";
  const sel = document.getElementById("camTrackSelect");
  if (sel) sel.value = "__free__";
  document.getElementById("btnOrbitMode").classList.toggle("active", mode === "orbit");
  document.getElementById("btnWalkMode").classList.toggle("active", mode === "walk");
  if (mode === "walk") {
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    state.walkYaw = Math.atan2(-dir.x, -dir.z);
    state.walkPitch = Math.asin(THREE.MathUtils.clamp(dir.y, -0.95, 0.95));
    if (camera.position.y > 7.5 && state.world) {
      const gh = sampleTerrainHeight(state.world.terrain, camera.position.x, camera.position.z);
      camera.position.y = gh + 2.1;
    }
    if (canvas.requestPointerLock) {
      try { canvas.requestPointerLock(); } catch {}
    }
  } else {
    if (document.pointerLockElement === canvas && document.exitPointerLock) document.exitPointerLock();
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    setOrbitFromLook(camera.position.clone(), camera.position.clone().addScaledVector(dir, 14));
  }
}

function updateWalkCamera(dt) {
  const euler = new THREE.Euler(state.walkPitch, state.walkYaw, 0, "YXZ");
  camera.quaternion.setFromEuler(euler);

  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const spd = (state.keys.has("ShiftLeft") || state.keys.has("ShiftRight") ? 14.0 : 7.0) * dt;

  if (state.keys.has("KeyW") || state.keys.has("ArrowUp")) camera.position.addScaledVector(forward, spd);
  if (state.keys.has("KeyS") || state.keys.has("ArrowDown")) camera.position.addScaledVector(forward, -spd);
  if (state.keys.has("KeyD") || state.keys.has("ArrowRight")) camera.position.addScaledVector(right, spd);
  if (state.keys.has("KeyA") || state.keys.has("ArrowLeft")) camera.position.addScaledVector(right, -spd);
  if (state.keys.has("Space") || state.keys.has("KeyE")) camera.position.y += spd;
  if (state.keys.has("KeyQ") || state.keys.has("ControlLeft")) camera.position.y -= spd;

  if (state.world) {
    const minY = sampleTerrainHeight(state.world.terrain, camera.position.x, camera.position.z) + 1.35;
    if (camera.position.y < minY) camera.position.y = minY;
  }
}

let dragBtn = -1, lastMX = 0, lastMY = 0, downMX = 0, downMY = 0;
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

canvas.addEventListener("contextmenu", e => e.preventDefault());
canvas.addEventListener("mousedown", e => {
  dragBtn = e.button;
  lastMX = downMX = e.clientX;
  lastMY = downMY = e.clientY;
});
window.addEventListener("mouseup", e => {
  if (dragBtn === 0 && Math.hypot(e.clientX - downMX, e.clientY - downMY) < 4 && state.camMode === "orbit") {
    const rect = canvas.getBoundingClientRect();
    ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(worldRoot.children, true);
    const hitObj = hits.find(h => h.object?.userData?.objectId && !h.object?.userData?.isContactAO);
    selectObject(hitObj ? hitObj.object.userData.objectId : null);
  }
  dragBtn = -1;
});
window.addEventListener("mousemove", e => {
  if (state.activeCameraTrackId !== "__free__") return;
  if (state.camMode === "walk") {
    if (document.pointerLockElement === canvas || dragBtn === 0) {
      const dx = document.pointerLockElement === canvas ? e.movementX : (e.clientX - lastMX);
      const dy = document.pointerLockElement === canvas ? e.movementY : (e.clientY - lastMY);
      state.walkYaw -= dx * 0.0026;
      state.walkPitch = THREE.MathUtils.clamp(state.walkPitch - dy * 0.0024, -1.4, 1.4);
    }
    lastMX = e.clientX; lastMY = e.clientY;
    return;
  }
  if (dragBtn === 0) {
    const dx = e.clientX - lastMX;
    const dy = e.clientY - lastMY;
    state.orbitTheta -= dx * 0.0065;
    state.orbitPhi = THREE.MathUtils.clamp(state.orbitPhi - dy * 0.0055, 0.14, Math.PI * 0.485);
    updateOrbitCamera();
  } else if (dragBtn === 2) {
    const dx = e.clientX - lastMX;
    const dy = e.clientY - lastMY;
    const panSpeed = state.orbitDist * 0.0014;
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
    const up = new THREE.Vector3(0, 1, 0);
    state.orbitTarget.addScaledVector(right, -dx * panSpeed);
    state.orbitTarget.addScaledVector(up, dy * panSpeed);
    updateOrbitCamera();
  }
  lastMX = e.clientX; lastMY = e.clientY;
});
canvas.addEventListener("wheel", e => {
  e.preventDefault();
  if (state.camMode === "orbit" && state.activeCameraTrackId === "__free__") {
    state.orbitDist = THREE.MathUtils.clamp(state.orbitDist * (1 + e.deltaY * 0.001), 2.5, 90);
    updateOrbitCamera();
  }
}, { passive: false });

window.addEventListener("keydown", e => {
  if (document.activeElement && ["TEXTAREA", "INPUT", "SELECT"].includes(document.activeElement.tagName)) return;
  if (e.code === "KeyF") { setCameraMode(state.camMode === "walk" ? "orbit" : "walk"); return; }
  state.keys.add(e.code);
});
window.addEventListener("keyup", e => state.keys.delete(e.code));

function selectObject(objectId) {
  state.selectedId = objectId;
  const rt = objectId ? state.runtimes.get(objectId) : null;
  if (rt && state.world) {
    const px = rt.group.position.x || rt.center.x;
    const pz = rt.group.position.z || rt.center.z;
    const gy = sampleTerrainHeight(state.world.terrain, px, pz);
    selRing.position.set(rt.center.x, gy + 0.08, rt.center.z);
    selRing.scale.setScalar(Math.max(0.65, rt.radius * 0.85));
    selRing.visible = true;
    document.getElementById("selectedHint").innerHTML =
      `Selected: <b style="color:var(--accent);">${rt.spec.name}</b> (${rt.spec.id})`;
  } else {
    selRing.visible = false;
    document.getElementById("selectedHint").textContent = "Selected: none (click any 3D object or Outliner item)";
  }
  document.querySelectorAll(".obj-row").forEach(el =>
    el.classList.toggle("selected", el.dataset.oid === objectId)
  );
}

// ---------------------------------------------------------------------------
// 4-Viewpoint 3D Render Plate Capture -> Gemini 4 Hydrogen Audit
// ---------------------------------------------------------------------------
function capture4ViewPlate() {
  const prevPos = camera.position.clone();
  const prevQuat = camera.quaternion.clone();
  const prevAspect = camera.aspect;
  const prevSelVis = selRing.visible;
  selRing.visible = false;

  let hero = [...state.runtimes.values()].find(r => r.spec.carrier === "implicit_sdf")
    || [...state.runtimes.values()].find(r => r.spec.carrier === "procedural_assembly")
    || [...state.runtimes.values()].find(r => r.spec.parametric?.kind === "fountain")
    || [...state.runtimes.values()][0];
  const heroCenter = hero ? hero.center.clone() : new THREE.Vector3(0, 1.8, 0);
  const heroRad = hero ? Math.max(2.6, Math.min(5.5, hero.radius * 2.0)) : 4.5;

  const enc = state.world?.terrain?.enclosure || "open_sky";
  const isInterior = enc === "space_bridge" || enc === "sci_fi_corridor" || enc === "interior_room" || enc === "cathedral_hall";
  let views;
  if (isInterior) {
    const [W, H, D] = state.world?.terrain?.enclosure_size || [24, 8.5, 28];
    const hw = W * 0.38, hd = D * 0.38, ch = Math.min(H - 1.2, Math.max(3.8, H * 0.65));
    views = [
      { label: "1. ELEVATED INTERIOR OVERVIEW", pos: new THREE.Vector3(hw, ch, hd), look: new THREE.Vector3(0, 1.4, -hd * 0.4) },
      { label: "2. EYE-LEVEL FORWARD VIEW", pos: new THREE.Vector3(0, 1.9, hd * 0.92), look: new THREE.Vector3(0, 1.8, -hd) },
      { label: "3. OPPOSITE 180° REVERSE VIEW", pos: new THREE.Vector3(-hw * 0.55, 2.2, -hd * 0.78), look: new THREE.Vector3(0, 1.7, hd * 0.5) },
      {
        label: `4. HERO CLOSE-UP (${hero ? hero.spec.id : "center"})`,
        pos: new THREE.Vector3(
          THREE.MathUtils.clamp(heroCenter.x + heroRad * 0.7, -hw, hw),
          THREE.MathUtils.clamp(heroCenter.y + 1.3, 1.4, ch),
          THREE.MathUtils.clamp(heroCenter.z + heroRad * 0.85, -hd, hd)
        ),
        look: heroCenter,
      },
    ];
  } else {
    views = [
      { label: "1. ELEVATED 3/4 OVERVIEW", pos: new THREE.Vector3(19, 13.5, 19), look: new THREE.Vector3(0, 2.2, 0) },
      { label: "2. EYE-LEVEL FRONT VIEW", pos: new THREE.Vector3(0, 2.3, 17.5), look: new THREE.Vector3(0, 2.4, -1) },
      { label: "3. OPPOSITE 180° BACK VIEW (FULL 3D)", pos: new THREE.Vector3(-15, 7.5, -22), look: new THREE.Vector3(0, 2.6, 0) },
      { label: `4. HERO CLOSE-UP (${hero ? hero.spec.id : "center"})`, pos: heroCenter.clone().add(new THREE.Vector3(heroRad, heroRad * 0.55, heroRad)), look: heroCenter },
    ];
  }

  const pw = 512, ph = 320;
  const plate = document.createElement("canvas");
  plate.width = pw * 2;
  plate.height = ph * 2;
  const ctx = plate.getContext("2d");

  camera.aspect = pw / ph;
  camera.updateProjectionMatrix();

  views.forEach((v, idx) => {
    camera.position.copy(v.pos);
    camera.lookAt(v.look);
    renderer.render(scene, camera);

    const gx = (idx % 2) * pw;
    const gy = Math.floor(idx / 2) * ph;
    ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, gx, gy, pw, ph);
    ctx.fillStyle = "rgba(9, 11, 16, 0.78)";
    ctx.fillRect(gx, gy, pw, 24);
    ctx.fillStyle = "#e6ecf8";
    ctx.font = "bold 12px ui-monospace, Menlo, monospace";
    ctx.fillText(v.label, gx + 8, gy + 16);
  });

  camera.aspect = prevAspect;
  camera.updateProjectionMatrix();
  camera.position.copy(prevPos);
  camera.quaternion.copy(prevQuat);
  selRing.visible = prevSelVis;
  renderer.render(scene, camera);

  return plate.toDataURL("image/jpeg", 0.90);
}

async function runHydrogen4ViewAudit(allowRepair = true) {
  if (!state.world) return null;
  const badge = document.getElementById("auditBadge");
  badge.textContent = "AUDITING 4 VIEWS...";
  badge.className = "pill h";
  const plateDataUrl = capture4ViewPlate();

  const res = await fetch(`/api/worlds/${state.world.world_id}/audit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plate_base64: plateDataUrl, allow_repair: allowRepair }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || "Audit failed");

  state.world = data.world;
  if (data.repaired_ids && data.repaired_ids.length > 0) {
    const objMap = new Map(state.world.objects.map(o => [o.id, o]));
    for (const rid of data.repaired_ids) {
      const sp = objMap.get(rid);
      if (sp) await mountSingleObject(sp, state.world, false);
    }
  }
  renderSidebars();
  return data;
}

// ---------------------------------------------------------------------------
// UI Rendering & Modals
// ---------------------------------------------------------------------------
function openModal(url, title, isVideo = false) {
  document.getElementById("modalTitle").textContent = title;
  const imgEl = document.getElementById("modalImg");
  const vidEl = document.getElementById("modalVideo");
  if (isVideo) {
    imgEl.style.display = "none";
    vidEl.style.display = "block";
    vidEl.src = url;
  } else {
    vidEl.style.display = "none";
    vidEl.pause();
    imgEl.style.display = "block";
    imgEl.src = url;
  }
  document.getElementById("modal").classList.add("open");
}

function renderSidebars() {
  const w = state.world;
  if (!w) return;

  const regBar = document.getElementById("regionsBar");
  if (regBar) {
    regBar.innerHTML = (w.regions || [])
      .map(r => `<span class="pill g">${r.region_id} (${(r.object_ids || []).length})</span>`)
      .join("");
  }

  const outliner = document.getElementById("outliner");
  outliner.innerHTML = "";
  const vis = (w.objects || []).filter(o => o.visible);
  document.getElementById("objCountBadge").textContent = `${vis.length} objs`;

  const byCol = new Map();
  for (const o of vis) {
    if (!byCol.has(o.collection)) byCol.set(o.collection, []);
    byCol.get(o.collection).push(o);
  }
  for (const [colName, items] of byCol.entries()) {
    const grp = document.createElement("div");
    grp.className = "collection-group";
    grp.innerHTML = `<div class="collection-hdr">▸ ${colName} (${items.length})</div>`;
    for (const o of items) {
      const row = document.createElement("div");
      row.className = "obj-row" + (state.selectedId === o.id ? " selected" : "");
      row.dataset.oid = o.id;
      const isBaked = Boolean(o.implicit_sdf?.baked_front_url);
      const tagClass = o.carrier === "implicit_sdf" ? "tag-sdf" : (o.carrier === "articulated_agent" ? "tag-agent" : "tag-param");
      const tagTxt = o.carrier === "implicit_sdf"
        ? (isBaked ? `SDF+BAKE` : `SDF ${o.implicit_sdf?.face_count || ""}`)
        : (o.carrier === "procedural_assembly"
          ? `ASM ${o.procedural?.parts?.length || 0}p`
          : (o.carrier === "articulated_agent" ? (o.agent?.role || o.agent?.rig_kind) : o.parametric?.kind || "param"));
      const behIcon = o.behavior?.kind && o.behavior.kind !== "none" ? ` → ${o.behavior.target_id || o.behavior.kind}` : "";
      row.innerHTML = `
        <span class="obj-name" title="${o.id}${behIcon}">${o.name}<span style="color:var(--muted); font-size:9.5px;"> v${o.version}${behIcon}</span></span>
        <span class="carrier-tag ${tagClass}">${tagTxt}</span>
      `;
      row.onclick = () => selectObject(o.id);
      row.ondblclick = () => inspectObject(o.id);
      grp.appendChild(row);
    }
    outliner.appendChild(grp);
  }

  const c = w.cumulative_costs || {};
  document.getElementById("kpiCarbon").textContent = c.carbon_calls || 0;
  document.getElementById("kpiHydrogen").textContent = c.hydrogen_calls || 0;
  document.getElementById("kpiNB").textContent = c.nano_banana_texture_calls || 0;
  document.getElementById("kpiSDF").textContent = c.sdf_meshes_compiled || 0;
  document.getElementById("kpiRev").textContent = w.revision || 1;

  const lastWithAudit = [...(w.history || [])].reverse().find(r => r.audit);
  const auditBadge = document.getElementById("auditBadge");
  const auditBox = document.getElementById("auditBox");
  if (lastWithAudit && lastWithAudit.audit) {
    const a = lastWithAudit.audit;
    auditBadge.textContent = a.status;
    auditBadge.className = "pill " + (a.status === "PASS" ? "g" : "w");
    const defs = (a.defects || []).map(d =>
      `<div class="mono" style="color:${d.severity === 'high' ? 'var(--red)' : 'var(--amber)'};">• [${d.severity}] ${d.category}: ${d.description}</div>`
    ).join("");
    const fixTxt = (a.fixes || []).length
      ? `<div class="mono" style="color:var(--green);">Auto-repaired: ${a.fixes.map(f => `${f.object_id} (${f.reason})`).join("; ")}</div>`
      : "";
    auditBox.innerHTML = `
      <div class="kpi-grid" style="margin-bottom:5px;">
        <div class="kpi"><div class="v">${a.geometry_3d_score.toFixed(1)}</div><div class="k">3D Geo</div></div>
        <div class="kpi"><div class="v">${a.spatial_coherence_score.toFixed(1)}</div><div class="k">Spatial</div></div>
        <div class="kpi"><div class="v">${(a.prompt_coverage_score ?? a.lighting_material_score).toFixed(1)}</div><div class="k">Prompt Cov</div></div>
      </div>
      <div style="color:var(--text); margin-bottom:4px;">${a.summary}</div>
      ${fixTxt}${defs}
      ${a.multiview_plate_url ? `<img class="audit-img" id="auditPlateThumb" src="${a.multiview_plate_url}" style="margin-top:6px;" />` : ""}
    `;
    const thumb = document.getElementById("auditPlateThumb");
    if (thumb) thumb.onclick = () => openModal(a.multiview_plate_url, `Rev ${lastWithAudit.revision} — Gemini 4 Hydrogen 4-View Audit`);
  } else {
    auditBadge.textContent = "READY";
    auditBadge.className = "pill";
  }

  const hist = document.getElementById("historyBox");
  hist.innerHTML = "";
  for (const rev of [...(w.history || [])].reverse()) {
    const el = document.createElement("div");
    el.className = "rev-item";
    const t = rev.timings || {};
    const firstVis = t.time_to_first_visible_ms ? `TTFV ${(t.time_to_first_visible_ms / 1000).toFixed(2)}s · ` : "";
    el.innerHTML = `
      <div class="row" style="justify-content:space-between;">
        <b>Rev ${rev.revision}: ${rev.action}</b>
        <span class="pill ${rev.rebuilt_entire_world ? 'c' : 'g'}">${rev.changed_object_ids.length}Δ / ${rev.unchanged_object_ids.length} kept</span>
      </div>
      <div style="color:var(--text);">"${rev.instruction}"</div>
      <div class="mono" style="color:var(--muted);">
        ${rev.carbon_summary}<br/>
        ${firstVis}Total ${((t.total_ms || 0) / 1000).toFixed(2)}s (C ${(t.carbon_ms || 0).toFixed(0)}ms, H ${(t.hydrogen_ms || 0).toFixed(0)}ms, NB ${(t.nano_banana_ms || 0).toFixed(0)}ms)
      </div>
    `;
    hist.appendChild(el);
  }
}

function inspectObject(objectId) {
  const rt = state.runtimes.get(objectId);
  if (!rt) return;
  selectObject(objectId);
  setCameraMode("orbit");
  const dist = Math.max(3.6, rt.radius * 2.6);
  const target = rt.center.clone();
  setOrbitFromLook(target.clone().add(new THREE.Vector3(dist * 0.72, dist * 0.42, dist * 0.72)), target);
}

async function refreshWorldsList() {
  const res = await fetch("/api/worlds");
  const data = await res.json();
  const box = document.getElementById("worldsList");
  box.innerHTML = "";
  if (!data.worlds.length) {
    box.innerHTML = `<div style="color:var(--muted);">No worlds generated yet.</div>`;
    return;
  }
  for (const item of data.worlds) {
    const el = document.createElement("div");
    el.className = "world-chip" + (state.world && state.world.world_id === item.world_id ? " active" : "");
    el.innerHTML = `
      <div style="font-weight:600;">${item.title}</div>
      <div class="mono" style="color:var(--muted);">rev ${item.revision} · ${item.object_count} objs (${item.sdf_count} SDF, ${item.agent_count} agents)</div>
    `;
    el.onclick = async () => {
      const r = await fetch(`/api/worlds/${item.world_id}`);
      await loadFullWorld(await r.json(), true);
      refreshWorldsList();
    };
    box.appendChild(el);
  }
  if (!state.world && data.worlds.length > 0) {
    const r = await fetch(`/api/worlds/${data.worlds[0].world_id}`);
    const firstWorld = await r.json();
    if (!state.world) {
      await loadFullWorld(firstWorld, true);
      refreshWorldsList();
    }
  }
}

// ---------------------------------------------------------------------------
// Streamed World Creation, Fast Live Edit (Non-Blocking!) & Region Expansion
// ---------------------------------------------------------------------------
async function streamCreateWorld(prompt) {
  const statusEl = document.getElementById("genStatus");
  const badge = document.getElementById("genLatencyBadge");
  const tStart = performance.now();
  let ttfv = null, firstObj = null, objCount = 0, texCount = 0;

  state.isStreamingGen = true;
  document.getElementById("btnGenerate").disabled = true;
  statusEl.textContent = "Stage 0: Flash Lite scaffold -> launching parallel Carbon/Hydrogen/NB workers...";
  badge.textContent = "Gen: streaming...";

  try {
    const res = await fetch("/api/worlds/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const worldId = res.headers.get("X-World-Id");

    await consumeWorldOpStream(res, async op => {
      const dt = (performance.now() - tStart) / 1000;
      await applyWorldOp(op);

      if (op.domain === "init" && ttfv === null) {
        ttfv = dt;
        badge.textContent = `TTFV ${ttfv.toFixed(2)}s`;
        statusEl.textContent = `Scaffold live in ${ttfv.toFixed(2)}s! Streaming parallel Carbon+Hydrogen objects & PBR... (Interactive NOW)`;
      } else if (op.domain === "object") {
        objCount++;
        if (firstObj === null) {
          firstObj = dt;
          badge.textContent = `TTFV ${ttfv?.toFixed(1) || "--"}s · 1stObj ${firstObj.toFixed(1)}s`;
        }
        statusEl.textContent = `Live: ${objCount} objs · ${texCount} PBR textures (${dt.toFixed(1)}s) — Orbit/WASD/Edit active!`;
      } else if (op.domain === "texture") {
        texCount++;
        statusEl.textContent = `Refined in-place: ${op.target_id} [${op.payload.tier}] (${dt.toFixed(1)}s)`;
      } else if (op.domain === "status" && op.action === "complete") {
        const tm = op.payload.timings || {};
        badge.textContent = `TTFV ${(tm.time_to_first_visible_ms / 1000 || ttfv || 0).toFixed(1)}s · Geo ${(tm.time_to_geometry_complete_ms / 1000 || 0).toFixed(1)}s · PBR ${(tm.total_ms / 1000 || dt).toFixed(1)}s`;
        statusEl.textContent = `Complete: ${objCount} objs, ${texCount} PBR upgrades | TTFV ${(ttfv || 0).toFixed(2)}s, Total ${dt.toFixed(1)}s`;
      }
    });

    if (worldId) {
      const full = await (await fetch(`/api/worlds/${worldId}`)).json();
      state.world = full;
      syncCameraDropdown();
      renderSidebars();
      await refreshWorldsList();
    }
    return { ttfv_s: ttfv, first_obj_s: firstObj, total_s: (performance.now() - tStart) / 1000, objCount, texCount };
  } finally {
    state.isStreamingGen = false;
    document.getElementById("btnGenerate").disabled = false;
  }
}

async function streamEditWorld(instruction) {
  if (!state.world) return null;
  const statusEl = document.getElementById("editStatus");
  const badge = document.getElementById("editLatencyBadge");
  const tStart = performance.now();
  let ttfc = null;
  statusEl.textContent = "Applying sub-second surgical diff...";
  badge.textContent = "Edit: parsing...";

  const res = await fetch(`/api/worlds/${state.world.world_id}/edit/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instruction, selected_object_id: state.selectedId }),
  });

  let finalDelta = null;
  await consumeWorldOpStream(res, async op => {
    const dt = (performance.now() - tStart) / 1000;
    await applyWorldOp(op);
    if (op.phase === "edit" && ttfc === null && op.domain !== "status") {
      ttfc = dt;
      badge.textContent = `Edit TTFC: ${ttfc.toFixed(2)}s`;
      statusEl.textContent = `Visible in ${ttfc.toFixed(2)}s! Refining any new PBR/SDF assets in parallel...`;
    }
    if (op.domain === "status" && op.action === "complete") {
      finalDelta = op.payload.delta || null;
      const tm = finalDelta?.timings || {};
      const tFirst = (tm.time_to_first_visible_ms || (ttfc || dt) * 1000) / 1000;
      const tRef = (tm.total_ms || dt * 1000) / 1000;
      badge.textContent = `Edit ${tFirst.toFixed(2)}s` + (tRef > tFirst + 0.4 ? ` (Ref ${tRef.toFixed(1)}s)` : "");
      if (finalDelta) {
        const kept = (finalDelta.unchanged_object_ids || []).length;
        const mut = (finalDelta.changed_object_ids || []).length;
        document.getElementById("kpiPreserved").textContent = `${kept}/${kept + mut}`;
        document.getElementById("localityBadge").textContent = `Edit ${tFirst.toFixed(2)}s: ${mut}Δ · ${kept} kept`;
      }
      statusEl.textContent = `Rev ${op.payload.revision}: TTFC ${tFirst.toFixed(2)}s · Refined ${tRef.toFixed(2)}s — ${finalDelta?.summary || "done"}`;
    }
  });

  const full = await (await fetch(`/api/worlds/${state.world.world_id}`)).json();
  state.world = full;
  syncCameraDropdown();
  renderSidebars();
  await refreshWorldsList();
  return { ttfc_s: ttfc, total_s: (performance.now() - tStart) / 1000, delta: finalDelta };
}

async function streamExpandRegion(rx, rz, hint = "") {
  if (!state.world) return null;
  const statusEl = document.getElementById("fidelityStatus");
  const tStart = performance.now();
  statusEl.textContent = `Expanding persistent adjacent region r_${rx}_${rz}...`;

  const res = await fetch(`/api/worlds/${state.world.world_id}/expand-region/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rx, rz, direction_hint: hint }),
  });

  let info = null;
  await consumeWorldOpStream(res, async op => {
    await applyWorldOp(op);
    if (op.domain === "status" && op.action === "complete") {
      info = op.payload.region_expansion || null;
    }
  });

  const dt = (performance.now() - tStart) / 1000;
  if (info?.cached) {
    statusEl.textContent = `Region ${info.region_id} ALREADY PERSISTED (0 calls, ${info.existing_object_ids.length} objs untouched)!`;
  } else {
    statusEl.textContent = `Region r_${rx}_${rz} streamed +${info?.added_object_ids?.length || 0} persistent objs in ${dt.toFixed(1)}s!`;
  }
  const full = await (await fetch(`/api/worlds/${state.world.world_id}`)).json();
  state.world = full;
  renderSidebars();
  return info;
}

// ---------------------------------------------------------------------------
// Button, Timeline & Chat Event Handlers
// ---------------------------------------------------------------------------
document.querySelectorAll(".preset-btn").forEach(b => {
  b.onclick = () => { document.getElementById("worldPrompt").value = b.dataset.p; };
});
document.querySelectorAll(".edit-chip").forEach(b => {
  b.onclick = () => { document.getElementById("chatEdit").value = b.dataset.e; };
});

document.getElementById("btnGenerate").onclick = async () => {
  const prompt = document.getElementById("worldPrompt").value.trim();
  if (!prompt) return;
  try {
    await streamCreateWorld(prompt);
  } catch (err) {
    document.getElementById("genStatus").textContent = `Error: ${err.message}`;
  }
};

document.getElementById("btnLoadWedding").onclick = async () => {
  document.getElementById("genStatus").textContent = "Loading scripted 3D Courtyard Wedding Benchmark...";
  try {
    const r = await fetch("/api/worlds/wedding-benchmark", { method: "POST" });
    const w = await r.json();
    await loadFullWorld(w, true);
    state.simTime = 0;
    state.activeCameraTrackId = "wedding_dolly_arc";
    syncCameraDropdown();
    evaluateWorldAt(0);
    await refreshWorldsList();
    document.getElementById("genStatus").textContent = `Loaded ${w.title} (22 objs, 3 CameraTracks, deterministic Bride→Groom timeline).`;
  } catch (err) {
    document.getElementById("genStatus").textContent = `Error: ${err.message}`;
  }
};

document.getElementById("btnApplyEdit").onclick = async () => {
  const instruction = document.getElementById("chatEdit").value.trim();
  if (!instruction || !state.world) return;
  try {
    await streamEditWorld(instruction);
  } catch (err) {
    document.getElementById("editStatus").textContent = `Error: ${err.message}`;
  }
};

document.getElementById("btnUndo").onclick = async () => {
  if (!state.world) return;
  const r = await fetch(`/api/worlds/${state.world.world_id}/undo`, { method: "POST" });
  await loadFullWorld(await r.json(), false);
  await refreshWorldsList();
  document.getElementById("editStatus").textContent = `Restored rev ${state.world.revision} (0 calls).`;
};

document.getElementById("btnExpandEast").onclick = () => streamExpandRegion(1, 0, "east courtyard terrace");
document.getElementById("btnExpandNorth").onclick = () => streamExpandRegion(0, -1, "north hilltop overlook");

document.getElementById("btnRunAudit").onclick = async () => {
  if (!state.world) return;
  document.getElementById("editStatus").textContent = "Capturing 4 live 3D viewpoints -> Gemini 4 Hydrogen audit...";
  try {
    const res = await runHydrogen4ViewAudit(true);
    document.getElementById("editStatus").textContent = `Hydrogen Audit: ${res.verdict.status} (3D=${res.verdict.geometry_3d_score}, Spatial=${res.verdict.spatial_coherence_score}).`;
  } catch (err) {
    document.getElementById("editStatus").textContent = `Audit error: ${err.message}`;
  }
};

document.getElementById("btnEnhancePBR").onclick = async () => {
  if (!state.world) return;
  document.getElementById("fidelityStatus").textContent = "Approach A: Roof/hill PBR + cavity AO + 3D SDF-AO...";
  const r = await fetch(`/api/worlds/${state.world.world_id}/enhance-materials`, { method: "POST" });
  const data = await r.json();
  if (r.ok) {
    await loadFullWorld(data.world, false);
    document.getElementById("fidelityStatus").textContent = `Approach A: +${data.enhancement.new_textures.length} PBR sets, ${data.enhancement.sdf_recompiled} SDF-AO.`;
  }
};

document.getElementById("btnBakeHero").onclick = async () => {
  if (!state.world) return;
  const sdfObj = (state.selectedId && state.world.objects.find(o => o.id === state.selectedId && o.carrier === "implicit_sdf"))
    || state.world.objects.find(o => o.visible && o.carrier === "implicit_sdf");
  if (!sdfObj) { document.getElementById("fidelityStatus").textContent = "No SDF object found."; return; }
  document.getElementById("fidelityStatus").textContent = `Approach B: Baking 360° dual-proj onto ${sdfObj.id}...`;
  const { front_b64, back_b64 } = captureObjectOrthoFrontBack(sdfObj.id);
  const r = await fetch(`/api/worlds/${state.world.world_id}/objects/${sdfObj.id}/bake-neural`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ front_b64, back_b64 }),
  });
  const data = await r.json();
  if (r.ok) {
    state.world = data.world;
    const updated = state.world.objects.find(o => o.id === sdfObj.id);
    if (updated) await mountSingleObject(updated, state.world, false);
    renderSidebars();
    inspectObject(sdfObj.id);
    document.getElementById("fidelityStatus").textContent = `Approach B baked (${(data.bake.inference_ms / 1000).toFixed(1)}s).`;
  }
};

document.getElementById("btnNeuralStill").onclick = async () => {
  if (!state.world) return;
  document.getElementById("fidelityStatus").textContent = "Approach C: G-Buffer -> Nano Banana still...";
  const gbuf = captureGBufferPasses(null, null, 768, 480);
  const r = await fetch(`/api/worlds/${state.world.world_id}/neural-render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tag: `cam_${Date.now() % 10000}`,
      mode: "gbuffer_conditioned",
      rgb_b64: gbuf.rgb, depth_b64: gbuf.depth, normal_b64: gbuf.normals, obj_id_b64: gbuf.obj_id,
    }),
  });
  const data = await r.json();
  if (r.ok) {
    openModal(data.enhanced_rgb_url, `Approach C Still (Edge F1=${data.metrics.edge_f1_3px})`);
    document.getElementById("fidelityStatus").textContent = `Approach C: Edge F1=${data.metrics.edge_f1_3px}.`;
  }
};

// Timeline & Camera Track Controls
document.getElementById("btnPlayPause").onclick = () => {
  state.playing = !state.playing;
  const b = document.getElementById("btnPlayPause");
  b.textContent = state.playing ? "Pause" : "Play";
  b.classList.toggle("active", state.playing);
};

document.getElementById("timeScrubber").oninput = e => {
  state.simTime = parseFloat(e.target.value) || 0;
  document.getElementById("timeLabel").textContent = `t=${state.simTime.toFixed(2)}s`;
  evaluateWorldAt(state.simTime);
};

document.getElementById("camTrackSelect").onchange = e => {
  state.activeCameraTrackId = e.target.value;
  const track = (state.world?.cameras || []).find(c => c.id === state.activeCameraTrackId);
  state.durationS = track ? track.duration_s : 12.0;
  document.getElementById("timeScrubber").max = String(state.durationS);
  if (state.simTime > state.durationS) state.simTime = 0;
  evaluateWorldAt(state.simTime);
};

document.getElementById("btnOrbitMode").onclick = () => setCameraMode("orbit");
document.getElementById("btnWalkMode").onclick = () => setCameraMode("walk");
document.getElementById("btnCamFront").onclick = () => {
  setCameraMode("orbit");
  setOrbitFromLook(new THREE.Vector3(0, 2.5, 18.5), new THREE.Vector3(0, 2.5, 0));
};
document.getElementById("btnCamBack").onclick = () => {
  setCameraMode("orbit");
  setOrbitFromLook(new THREE.Vector3(-15, 7.5, -22), new THREE.Vector3(0, 2.8, 0));
};
document.getElementById("btnCamOverview").onclick = () => {
  setCameraMode("orbit");
  setOrbitFromLook(new THREE.Vector3(20, 14, 20), new THREE.Vector3(0, 2.0, 0));
};
document.getElementById("btnCamInspect").onclick = () => {
  if (state.selectedId) inspectObject(state.selectedId);
};
document.getElementById("modalClose").onclick = () => {
  document.getElementById("modalVideo").pause();
  document.getElementById("modal").classList.remove("open");
};
document.getElementById("modal").onclick = e => {
  if (e.target.id === "modal") {
    document.getElementById("modalVideo").pause();
    document.getElementById("modal").classList.remove("open");
  }
};

function resize() {
  const parent = canvas.parentElement;
  const w = Math.max(1, parent.clientWidth);
  const h = Math.max(1, parent.clientHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

// Expose clean deterministic API for benchmarking, multi-camera video capture, and automation
window.__WORLD_STUDIO__ = {
  state,
  loadFullWorld,
  mountSingleObject,
  applyWorldOp,
  evaluateWorldAt,
  renderAt(t, cameraTrackId = null) {
    state.playing = false;
    state.simTime = t;
    if (cameraTrackId !== null) state.activeCameraTrackId = cameraTrackId;
    evaluateWorldAt(t);
    renderer.render(scene, camera);
    return canvas.toDataURL("image/jpeg", 0.92);
  },
  streamCreateWorld,
  streamEditWorld,
  streamExpandRegion,
  capture4ViewPlate,
  captureGBufferPasses,
  captureEntityTurnaround3View,
  captureShotKeyframes,
  captureDenseGuideFrames,
  captureObjectOrthoFrontBack,
  measureSyncGpuFrameMs,
  runHydrogen4ViewAudit,
  setOrbitFromLook,
  setCameraMode,
  selectObject,
  inspectObject,
  THREE,
};

let lastTime = performance.now(), frames = 0, fpsTimer = 0;
function animate(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  if (state.playing) {
    state.simTime = (state.simTime + dt) % Math.max(0.5, state.durationS);
    const scrub = document.getElementById("timeScrubber");
    if (scrub) scrub.value = state.simTime.toFixed(2);
    const lbl = document.getElementById("timeLabel");
    if (lbl) lbl.textContent = `t=${state.simTime.toFixed(2)}s`;
  }

  // Smooth progressive pop-in animations for newly streamed 3D objects
  if (state.popAnimations.size > 0) {
    for (const [oid, anim] of state.popAnimations.entries()) {
      const rt = state.runtimes.get(oid);
      if (!rt) { state.popAnimations.delete(oid); continue; }
      const u = Math.min(1, (now - anim.startMs) / 240);
      const ease = 1 - Math.pow(1 - u, 3);
      rt.group.scale.setScalar(Math.max(0.05, anim.targetScale * ease));
      if (u >= 1) state.popAnimations.delete(oid);
    }
  }

  frames++; fpsTimer += dt;
  if (fpsTimer >= 0.5) {
    document.getElementById("fpsBadge").textContent = `${Math.round(frames / fpsTimer)} FPS`;
    frames = 0; fpsTimer = 0;
  }

  if (state.activeCameraTrackId === "__free__" && state.camMode === "walk") updateWalkCamera(dt);
  evaluateWorldAt(state.simTime);

  if (state.world) {
    const p = camera.position;
    const camLbl = state.activeCameraTrackId === "__free__" ? state.camMode.toUpperCase() : `TRACK:${state.activeCameraTrackId}`;
    const streamBadge = state.isStreamingGen ? ` · <b style="color:var(--amber);">STREAMING LIVE</b>` : "";
    document.getElementById("vpHud").innerHTML =
      `<b>${state.world.title}</b> [Rev ${state.world.revision}] · ${camLbl}${streamBadge}<br/>` +
      `Cam (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}) · ${state.runtimes.size} objs · ${Object.keys(state.world.textures || {}).length} PBR · t=${state.simTime.toFixed(2)}s`;
  }

  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

refreshWorldsList().then(() => requestAnimationFrame(animate));

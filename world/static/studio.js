/* WorldIR 3D Studio — Full 3D Three.js WebGL2 Runtime:
 *  - Physically-based Rayleigh+Mie scattering sky, warm bounce fill, 2048px PCFSoftShadowMap, PMREM IBL
 *  - Animated water ripples, dual-biome terrain splat, baked 3D SDF-AO, Object-Space Dual-Projection Neural Shader
 *  - Free WASD + Mouse Look walking/flying AND 360° Orbit + Click-to-Select object inspection
 *  - Deterministic G-Buffer exporter (RGB, Linear Depth, World Normals, Object-ID) + Orthographic Object Capture
 *  - Synchronized gl.finish() GPU profiler + Automated 4-Viewpoint Gemini 4 Hydrogen visual auditing
 */

import * as THREE from "./vendor/three.module.min.js";
import {
  buildArticulatedAgent,
  buildImplicitSDFObject,
  buildParametricObject,
  buildTerrain,
  sampleTerrainHeight,
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
const camera = new THREE.PerspectiveCamera(54, 16 / 9, 0.15, 280);
camera.position.set(0, 4.8, 22);

// Primary Sun / Moon directional shadow light
const sunLight = new THREE.DirectionalLight("#fff0d6", 2.8);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
sunLight.shadow.camera.near = 2;
sunLight.shadow.camera.far = 110;
const shadowBound = 32;
sunLight.shadow.camera.left = -shadowBound;
sunLight.shadow.camera.right = shadowBound;
sunLight.shadow.camera.top = shadowBound;
sunLight.shadow.camera.bottom = -shadowBound;
sunLight.shadow.bias = -0.0004;
sunLight.shadow.normalBias = 0.02;
scene.add(sunLight);

// Subtle warm back-bounce fill (simulates sunlit plaza wall GI bounce without washing shadows)
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
      // Smooth Rayleigh gradient + soft aerial haze band along the horizon
      vec3 sky = mix(uHorizon, uZenith, pow(h, 0.46));
      float hazeBand = exp(-abs(d.y) * 9.0);
      sky = mix(sky, mix(uHorizon, uFogColor, 0.55), hazeBand * 0.65);
      // Forward Mie solar scattering halo + crisp sun disc
      float sunCos = max(dot(d, normalize(uSunDir)), 0.0);
      sky += uSunColor * pow(sunCos, 6.0) * 0.24 * (1.0 - h * 0.45);
      sky += uSunColor * pow(sunCos, 48.0) * 0.48;
      sky += uSunColor * smoothstep(0.9985, 0.9996, sunCos) * 1.9;
      // Below horizon smoothly matches ground fog
      sky = mix(uFogColor * 0.72, sky, smoothstep(-0.06, 0.03, d.y));
      gl_FragColor = vec4(sky, 1.0);
    }
  `,
});
const skyDome = new THREE.Mesh(new THREE.SphereGeometry(175, 28, 18), skyMat);
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

// Soft layered atmospheric clouds (warmer lit underside during golden hour)
const cloudGroup = new THREE.Group();
scene.add(cloudGroup);
function rebuildClouds(count, atm) {
  while (cloudGroup.children.length) cloudGroup.remove(cloudGroup.children[0]);
  const isNight = atm.time_of_day === "night";
  const cColor = new THREE.Color(isNight ? "#2a354d" : "#fff7ee").lerp(new THREE.Color(atm.sky_horizon || "#f2be88"), isNight ? 0.1 : 0.28);
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
    cg.position.set(Math.cos(ang) * rad, 30 + (i % 3) * 6.5, Math.sin(ang) * rad);
    for (let k = 0; k < 6; k++) {
      const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(2.0 + (k % 3) * 0.85, 2), cMat);
      puff.scale.set(1.65, 0.72, 1.25);
      puff.position.set((k - 2.5) * 1.65, (k % 2) * 0.65, ((k * 5) % 3 - 1) * 1.15);
      cg.add(puff);
    }
    cg.userData.driftSpeed = 0.22 + (i % 3) * 0.14;
    cloudGroup.add(cg);
  }
}

// Selection highlight ring on ground
const selRingGeo = new THREE.RingGeometry(1.2, 1.48, 32);
selRingGeo.rotateX(-Math.PI / 2);
const selRing = new THREE.Mesh(
  selRingGeo,
  new THREE.MeshBasicMaterial({ color: "#38bdf8", side: THREE.DoubleSide, transparent: true, opacity: 0.85 })
);
selRing.visible = false;
scene.add(selRing);

// ---------------------------------------------------------------------------
// World Runtime Registry (Preserves Persistent Object3D Instances Across Edits!)
// ---------------------------------------------------------------------------
const worldRoot = new THREE.Group();
scene.add(worldRoot);

const state = {
  world: null,
  terrainGroup: null,
  runtimes: new Map(),
  selectedId: null,
  camMode: "orbit",
  busy: false,
  orbitTarget: new THREE.Vector3(0, 2.5, 0),
  orbitDist: 23,
  orbitTheta: 0.28,
  orbitPhi: 1.24,
  walkYaw: 0,
  walkPitch: -0.06,
  keys: new Set(),
  videoTime: 0,
};
const srcVideoEl = document.getElementById("srcVideo");

function applyAtmosphere(atm) {
  const isNight = atm.time_of_day === "night" || atm.time_of_day === "dusk";
  const el = THREE.MathUtils.degToRad(atm.sun_elevation_deg ?? 32);
  const az = THREE.MathUtils.degToRad(atm.sun_azimuth_deg ?? 46);
  const sunDir = new THREE.Vector3(
    Math.cos(el) * Math.sin(az),
    Math.sin(el),
    Math.cos(el) * Math.cos(az)
  ).normalize();

  sunLight.position.copy(sunDir).multiplyScalar(48);
  sunLight.color.set(atm.sun_color || "#ffeed2");
  sunLight.intensity = atm.sun_intensity ?? 2.9;

  bounceLight.position.copy(sunDir).multiplyScalar(-34);
  bounceLight.position.y = Math.max(8, bounceLight.position.y);
  bounceLight.color.set(isNight ? "#334c78" : (atm.sky_horizon || "#f2be88"));
  bounceLight.intensity = isNight ? 0.28 : 0.48;

  hemiLight.color.set(atm.sky_zenith || "#6fa4e0");
  hemiLight.groundColor.set(isNight ? "#1a1f2b" : "#705d47");
  hemiLight.intensity = (atm.ambient_intensity ?? 0.75) * 0.88;

  skyUniforms.uZenith.value.set(atm.sky_zenith || "#24528a");
  skyUniforms.uHorizon.value.set(atm.sky_horizon || "#f2be88");
  skyUniforms.uFogColor.value.set(atm.fog_color || "#dfc9ae");
  skyUniforms.uSunDir.value.copy(sunDir);
  skyUniforms.uSunColor.value.set(atm.sun_color || "#ffeed2");

  scene.fog = new THREE.FogExp2(atm.fog_color || "#dfc9ae", atm.fog_density ?? 0.0075);
  renderer.toneMappingExposure = isNight ? 1.15 : 0.96;

  rebuildClouds(atm.cloud_count ?? 8, atm);
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
  if (obj.carrier === "articulated_agent" && (obj.agent?.rig_kind === "bird_flock" || obj.agent?.rig_kind === "floating_lanterns")) {
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
    radius: Math.max(1.2, Math.hypot(size.x, size.z) * 0.5),
  };
}

async function mountSingleObject(obj, world) {
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
}

async function loadFullWorld(world, resetCam = true) {
  state.world = world;
  while (worldRoot.children.length) worldRoot.remove(worldRoot.children[0]);
  state.runtimes.clear();
  state.selectedId = null;
  selRing.visible = false;

  state.terrainGroup = buildTerrain(world.terrain, world.textures || {});
  worldRoot.add(state.terrainGroup);
  applyAtmosphere(world.atmosphere);

  await Promise.all(world.objects.filter(o => o.visible).map(o => mountSingleObject(o, world)));

  syncSourceVideo(world);

  if (resetCam) {
    const sp = world.camera_spawn || [0, 5, 22];
    const lk = world.camera_look_at || [0, 2.5, 0];
    setOrbitFromLook(new THREE.Vector3(...sp), new THREE.Vector3(...lk));
  }
  renderSidebars();
}

async function applySurgicalDelta(newWorld, delta) {
  state.world = newWorld;

  if (delta.terrain_changed) {
    if (state.terrainGroup) worldRoot.remove(state.terrainGroup);
    state.terrainGroup = buildTerrain(newWorld.terrain, newWorld.textures || {});
    worldRoot.add(state.terrainGroup);
  }
  if (delta.atmosphere_changed) {
    applyAtmosphere(newWorld.atmosphere);
  }

  const behOnly = new Set(delta.behavior_only_ids || []);
  const changed = new Set(delta.changed_object_ids || []);
  const removed = new Set(delta.removed_ids || []);
  const objById = new Map(newWorld.objects.map(o => [o.id, o]));

  for (const rid of removed) {
    const rt = state.runtimes.get(rid);
    if (rt) {
      worldRoot.remove(rt.group);
      state.runtimes.delete(rid);
    }
    if (state.selectedId === rid) selectObject(null);
  }

  for (const bid of behOnly) {
    const rt = state.runtimes.get(bid);
    const updatedSpec = objById.get(bid);
    if (rt && updatedSpec) {
      rt.spec = updatedSpec;
      if (rt.group.userData.flockMembers) {
        for (const bird of rt.group.userData.flockMembers) {
          bird.userData.agentState.mode = "FLYING";
          bird.userData.agentState.timer = 0;
        }
      }
    }
  }

  const toRemount = [];
  for (const cid of changed) {
    if (behOnly.has(cid) || removed.has(cid)) continue;
    const updatedSpec = objById.get(cid);
    if (updatedSpec && updatedSpec.visible) {
      toRemount.push(mountSingleObject(updatedSpec, newWorld));
    }
  }
  await Promise.all(toRemount);

  if (state.selectedId) selectObject(state.selectedId);

  const preservedCount = (delta.unchanged_object_ids || []).length;
  const totalVis = newWorld.objects.filter(o => o.visible).length;
  document.getElementById("kpiPreserved").textContent = `${preservedCount}/${totalVis}`;
  document.getElementById("localityBadge").textContent =
    `Surgical Edit: ${changed.size} mutated · ${preservedCount} untouched`;

  renderSidebars();
}

// ---------------------------------------------------------------------------
// Autonomous Real-Time 3D Behaviors & Animations
// ---------------------------------------------------------------------------
function resolveTargetBounds(targetId) {
  if (targetId && state.runtimes.has(targetId)) {
    const rt = state.runtimes.get(targetId);
    return { cx: rt.center.x, cz: rt.center.z, topY: rt.topY, radius: rt.radius };
  }
  return { cx: 0, cz: 0, topY: 3.2, radius: 3.0 };
}

// ---------------------------------------------------------------------------
// Video-tracked agents: replay OpenCV trajectories lifted into 3D, synced to the source video
// ---------------------------------------------------------------------------
function sampleVideoTrack(track, vt) {
  const pts = track.points;
  if (!pts || !pts.length) return null;
  if (vt < pts[0][0] - 0.05 || vt > pts[pts.length - 1][0] + 0.05) return null;
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid][0] <= vt) lo = mid; else hi = mid;
  }
  const a = pts[lo], b = pts[hi];
  const k = THREE.MathUtils.clamp((vt - a[0]) / Math.max(b[0] - a[0], 1e-6), 0, 1);
  return new THREE.Vector3(a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k);
}

function updateVideoPathAgent(rt, dt, terrain) {
  const sv = state.world?.source_video;
  const trackId = rt.spec.behavior?.video_track_id;
  const track = sv && trackId ? sv.tracks.find(x => x.id === trackId) : null;
  if (!track) return false;
  const vt = state.videoTime;
  const g = rt.group;
  const members = g.userData.flockMembers || g.userData.lanternMembers;

  if (members) {
    members.forEach((m, i) => {
      const st = m.userData.agentState;
      const p = sampleVideoTrack(track, vt - i * 0.12);
      if (!p) { m.visible = false; return; }
      if (i > 0) { p.x += (st.radiusOffset || 0) * 0.7; p.y += (st.heightOffset || 0) * 0.7; }
      const prev = st.pos.clone();
      if (!m.visible || prev.distanceTo(p) > 6) st.pos.copy(p); else st.pos.lerp(p, Math.min(1, dt * 12));
      m.visible = true;
      m.position.copy(st.pos);
      const vel = st.pos.clone().sub(prev);
      if (m.userData.wingL) {
        if (vel.lengthSq() > 1e-6) m.lookAt(st.pos.clone().add(vel));
        st.flapPhase = (st.flapPhase || 0) + dt * 10.5;
        const flap = Math.sin(st.flapPhase) * 0.72;
        m.userData.wingL.rotation.z = flap;
        m.userData.wingR.rotation.z = -flap;
      }
    });
    return true;
  }

  if (g.userData.patrolMesh) {
    const p = sampleVideoTrack(track, vt);
    if (!p) { g.visible = false; return true; }
    const isBoat = rt.spec.agent?.rig_kind === "boat_cruiser" || track.region === "water";
    p.y = isBoat ? (terrain.water_level ?? -0.4) + 0.05 : sampleTerrainHeight(terrain, p.x, p.z);
    const prev = g.position.clone();
    if (!g.visible || prev.distanceTo(p) > 6) g.position.copy(p); else g.position.lerp(p, Math.min(1, dt * 10));
    g.visible = true;
    const moveVec = g.position.clone().sub(prev);
    const spd = moveVec.length() / Math.max(dt, 1e-4);
    if (moveVec.lengthSq() > 1e-6) g.rotation.y = Math.atan2(-moveVec.z, moveVec.x);
    const pm = g.userData.patrolMesh;
    if (pm.userData.wheels) for (const w of pm.userData.wheels) w.rotation.z -= dt * spd * 1.8;
    if (pm.userData.legs) for (const leg of pm.userData.legs) leg.rotation.z = Math.sin(performance.now() * 0.0085 + leg.userData.phase) * 0.48 * Math.min(1, spd);
    return true;
  }
  return false;
}

function syncSourceVideo(world) {
  const pip = document.getElementById("videoPip");
  const camBtn = document.getElementById("btnCamVideo");
  const sv = world?.source_video;
  if (!sv) {
    pip.hidden = true;
    camBtn.hidden = true;
    srcVideoEl.pause();
    srcVideoEl.removeAttribute("src");
    srcVideoEl.load();
    return;
  }
  pip.hidden = false;
  camBtn.hidden = false;
  document.getElementById("pipTitle").textContent = `${sv.filename} · synced to 3D`;
  if (!srcVideoEl.src.endsWith(sv.url)) {
    srcVideoEl.src = sv.url;
    srcVideoEl.play().catch(() => {});
  }
}

function updateAutonomousWorld(t, dt) {
  if (!state.world) return;
  const wind = state.world.atmosphere?.wind_strength ?? 0.5;
  const terrain = state.world.terrain;

  for (const cg of cloudGroup.children) {
    cg.position.x += cg.userData.driftSpeed * wind * dt;
    if (cg.position.x > 70) cg.position.x = -70;
  }

  // Scroll bay/terrain water ripples
  const wm = state.terrainGroup?.userData?.waterMesh;
  const wnt = state.terrainGroup?.userData?.waterNormalTex;
  if (wm) wm.position.y = (terrain.water_level ?? -0.4) + Math.sin(t * 1.4) * 0.03;
  if (wnt) {
    wnt.offset.x = (t * 0.045) % 1.0;
    wnt.offset.y = (t * 0.032) % 1.0;
  }

  for (const rt of state.runtimes.values()) {
    const { spec, group } = rt;
    if (spec.behavior?.kind === "follow_video_path" && updateVideoPathAgent(rt, dt, terrain)) continue;

    if (group.userData.waterNormalTex) {
      group.userData.waterNormalTex.offset.x = (t * 0.09) % 1.0;
      group.userData.waterNormalTex.offset.y = (-t * 0.06) % 1.0;
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

    if (group.userData.spinRotorZ) group.userData.spinRotorZ.rotation.z -= dt * (0.65 + wind * 0.6);
    if (group.userData.sweepBeamY) group.userData.sweepBeamY.rotation.y += dt * 0.75;
    if (group.userData.clockHands) {
      for (const hand of group.userData.clockHands) hand.rotation.z = -t * 0.25;
    }

    if (group.userData.flockMembers) {
      const beh = spec.behavior || {};
      const tgt = resolveTargetBounds(beh.target_id);
      const orbitR = Math.max(tgt.radius + 1.8, beh.orbit_radius || 6.0);
      const orbitH = Math.max(tgt.topY + 1.6, beh.orbit_height || 6.0);
      const speed = beh.speed || 0.7;
      const canPerch = beh.kind === "orbit_and_perch";
      const flyDur = beh.fly_duration_sec || 7.5;
      const perchDur = beh.perch_duration_sec || 3.5;

      for (const bird of group.userData.flockMembers) {
        const st = bird.userData.agentState;
        st.timer += dt;
        if (canPerch && st.mode === "FLYING" && st.timer > flyDur) {
          st.mode = "LANDING"; st.timer = 0;
        } else if (st.mode === "PERCHED" && st.timer > perchDur) {
          st.mode = "FLYING"; st.timer = 0;
        }

        const slotAng = (st.perchSlot * 2.1) % (Math.PI * 2);
        const perchRad = Math.min(tgt.radius * 0.45, 1.35);
        const perchPos = new THREE.Vector3(
          tgt.cx + Math.cos(slotAng) * perchRad,
          tgt.topY + 0.14,
          tgt.cz + Math.sin(slotAng) * perchRad
        );

        let desiredPos;
        if (st.mode === "PERCHED") {
          st.pos.lerp(perchPos, Math.min(1, dt * 6));
          bird.position.copy(st.pos);
          bird.userData.wingL.rotation.z = THREE.MathUtils.lerp(bird.userData.wingL.rotation.z, -1.1, dt * 5);
          bird.userData.wingR.rotation.z = THREE.MathUtils.lerp(bird.userData.wingR.rotation.z, 1.1, dt * 5);
          bird.rotation.z = THREE.MathUtils.lerp(bird.rotation.z, 0, dt * 5);
          bird.rotation.x = THREE.MathUtils.lerp(bird.rotation.x, 0, dt * 5);
          bird.rotation.y += Math.sin(t * 1.7 + st.perchSlot) * 0.008;
          continue;
        } else if (st.mode === "LANDING") {
          desiredPos = perchPos;
          if (st.pos.distanceTo(perchPos) < 0.35) { st.mode = "PERCHED"; st.timer = 0; }
        } else {
          st.angle += dt * speed * (0.85 + 0.2 * Math.sin(st.perchSlot));
          const rNow = orbitR + st.radiusOffset;
          const yNow = orbitH + st.heightOffset + Math.sin(st.angle * 2.0 + st.perchSlot) * 0.75;
          desiredPos = new THREE.Vector3(tgt.cx + Math.cos(st.angle) * rNow, yNow, tgt.cz + Math.sin(st.angle) * rNow);
        }

        const toTarget = desiredPos.clone().sub(st.pos);
        const dist = toTarget.length();
        const maxSpeed = st.mode === "LANDING" ? 4.5 : Math.max(4.5, orbitR * speed * 1.25);
        const steer = toTarget.normalize().multiplyScalar(Math.min(maxSpeed, dist * 2.2));
        st.vel.lerp(steer, Math.min(1, dt * 3.2));
        st.pos.addScaledVector(st.vel, dt);
        bird.position.copy(st.pos);

        if (st.vel.lengthSq() > 0.01) {
          bird.lookAt(st.pos.clone().add(st.vel));
          bird.rotation.z = THREE.MathUtils.lerp(bird.rotation.z, st.mode === "FLYING" ? -0.32 : 0.0, dt * 4);
        }

        st.flapPhase += dt * (st.mode === "LANDING" ? 15.0 : 10.5);
        const flap = Math.sin(st.flapPhase) * 0.72;
        bird.userData.wingL.rotation.z = flap;
        bird.userData.wingR.rotation.z = -flap;
      }
    }

    if (group.userData.lanternMembers) {
      const beh = spec.behavior || {};
      const tgt = resolveTargetBounds(beh.target_id);
      const rad = beh.orbit_radius || 5.5;
      const baseH = Math.max(tgt.topY + 1.2, beh.orbit_height || 4.8);
      for (const lg of group.userData.lanternMembers) {
        const st = lg.userData.agentState;
        st.angle += dt * (beh.speed || 0.25);
        const target = new THREE.Vector3(
          tgt.cx + Math.cos(st.angle) * (rad + st.radiusOffset),
          baseH + st.heightOffset + Math.sin(t * 1.4 + st.angle) * 0.55,
          tgt.cz + Math.sin(st.angle) * (rad + st.radiusOffset)
        );
        st.pos.lerp(target, Math.min(1, dt * 2.0));
        lg.position.copy(st.pos);
        lg.rotation.y += dt * 0.4;
      }
    }

    if (group.userData.patrolMesh) {
      const beh = spec.behavior || {};
      const tgt = resolveTargetBounds(beh.target_id);
      const rad = Math.max(tgt.radius + 2.5, beh.orbit_radius || 7.5);
      const spd = beh.speed || 0.45;
      group.userData.patrolAngle += dt * spd;
      const ang = group.userData.patrolAngle;
      const nx = tgt.cx + Math.cos(ang) * rad;
      const nz = tgt.cz + Math.sin(ang) * rad;
      const isBoat = spec.agent?.rig_kind === "boat_cruiser";
      const ny = isBoat ? (terrain.water_level ?? -0.4) + 0.05 : sampleTerrainHeight(terrain, nx, nz);

      const pm = group.userData.patrolMesh;
      const prevPos = group.position.clone();
      group.position.lerp(new THREE.Vector3(nx, ny, nz), Math.min(1, dt * 5.0));
      const moveVec = group.position.clone().sub(prevPos);
      if (moveVec.lengthSq() > 1e-6) {
        group.rotation.y = Math.atan2(-moveVec.z, moveVec.x);
      }
      if (pm.userData.wheels) {
        for (const w of pm.userData.wheels) w.rotation.z -= dt * spd * rad * 1.8;
      }
      if (pm.userData.legs) {
        for (const leg of pm.userData.legs) leg.rotation.z = Math.sin(t * 8.5 + leg.userData.phase) * 0.48;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Deterministic G-Buffer Exporter (Approach C) + Ortho Front/Back Capture (Approach B)
// + Synchronized gl.finish() GPU Frame Profiler
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

  // 1. Beauty RGB pass
  const rgb = snap(0.92);

  // Hide sky, clouds, fog, and contact-AO planes for pure geometric G-Buffer passes
  skyDome.visible = false;
  cloudGroup.visible = false;
  scene.fog = null;
  renderer.toneMapping = THREE.NoToneMapping;

  const hiddenAO = [];
  worldRoot.traverse(n => {
    if (n.userData.isContactAO && n.visible) { n.visible = false; hiddenAO.push(n); }
  });

  // 2. Linear Depth pass
  scene.background = new THREE.Color("#000000");
  scene.overrideMaterial = linearDepthMat;
  const depth = snap(0.90);

  // 3. Surface Normals pass
  scene.background = new THREE.Color("#8080ff");
  scene.overrideMaterial = normalPassMat;
  const normals = snap(0.90);
  scene.overrideMaterial = null;

  // 4. Deterministic Object-ID Segmentation pass
  scene.background = new THREE.Color("#10141c");
  const savedMats = [];
  const idMatCache = new Map();
  worldRoot.traverse(n => {
    if (n.isMesh && n.visible) {
      const oid = n.userData.objectId || "__terrain__";
      if (!idMatCache.has(oid)) {
        idMatCache.set(oid, new THREE.MeshBasicMaterial({ color: oid === "__terrain__" ? new THREE.Color("#2b323d") : hashIdToColor(oid) }));
      }
      savedMats.push([n, n.material]);
      n.material = idMatCache.get(oid);
    }
  });
  const obj_id = snap(0.92);

  // Restore scene completely
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

function captureObjectOrthoFrontBack(objectId) {
  const rt = state.runtimes.get(objectId);
  if (!rt) throw new Error(`Object ${objectId} not found in live scene`);

  let heroMesh = null;
  rt.group.traverse(n => { if (n.userData.isSDFHeroMesh) heroMesh = n; });
  if (!heroMesh) throw new Error(`Object ${objectId} has no implicit_sdf mesh`);

  // Build isolated studio scene containing ONLY a clone of the SDF mesh with neutral white+SDF-AO shading
  const isoScene = new THREE.Scene();
  isoScene.background = new THREE.Color(120 / 255, 124 / 255, 130 / 255);
  const amb = new THREE.AmbientLight("#ffffff", 1.15);
  const key = new THREE.DirectionalLight("#ffffff", 0.95);
  key.position.set(1.5, 2.5, 3.0);
  const fill = new THREE.DirectionalLight("#e6eef8", 0.85);
  fill.position.set(-1.5, 1.5, -3.0);
  isoScene.add(amb, key, fill);

  const hasVC = Boolean(heroMesh.geometry.attributes.color);
  const clayMat = new THREE.MeshStandardMaterial({
    color: "#e8e3da",
    roughness: 0.65,
    metalness: 0.05,
    vertexColors: hasVC,
  });
  const clone = new THREE.Mesh(heroMesh.geometry, clayMat);
  isoScene.add(clone);

  const pb = heroMesh.userData.sdfProjBounds || { cx: 0, cy: 1.1, span: 2.6 };
  const half = pb.span * 0.5;
  const orthoCam = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, 30);

  const prevW = canvas.width, prevH = canvas.height;
  const prevTone = renderer.toneMapping;
  renderer.toneMapping = THREE.NoToneMapping;

  const outCanvas = document.createElement("canvas");
  outCanvas.width = 512;
  outCanvas.height = 512;
  const ctx = outCanvas.getContext("2d");

  // Render square into current renderer viewport centered
  renderer.setSize(512, 512, false);

  // Front (+Z looking toward origin)
  orthoCam.position.set(pb.cx, pb.cy, 8.0);
  orthoCam.lookAt(pb.cx, pb.cy, 0);
  renderer.render(isoScene, orthoCam);
  ctx.drawImage(canvas, 0, 0, 512, 512);
  const front_b64 = outCanvas.toDataURL("image/png");

  // Back (-Z looking toward origin)
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
  // Warmup
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
// Dual Camera Controller: Orbit 360° + Free-Walk/Fly WASD + Mouse Look
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
  state.orbitTarget.copy(target);
  const off = pos.clone().sub(target);
  state.orbitDist = Math.max(3, Math.min(68, off.length()));
  state.orbitTheta = Math.atan2(off.x, off.z);
  state.orbitPhi = Math.max(0.18, Math.min(Math.PI * 0.48, Math.acos(THREE.MathUtils.clamp(off.y / state.orbitDist, -1, 1))));
  updateOrbitCamera();
}

function setCameraMode(mode) {
  state.camMode = mode;
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
  const spd = (state.keys.has("ShiftLeft") || state.keys.has("ShiftRight") ? 13.0 : 6.8) * dt;

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
  if (state.camMode === "orbit") {
    state.orbitDist = THREE.MathUtils.clamp(state.orbitDist * (1 + e.deltaY * 0.001), 2.5, 72);
    updateOrbitCamera();
  }
}, { passive: false });

window.addEventListener("keydown", e => {
  if (document.activeElement && ["TEXTAREA", "INPUT"].includes(document.activeElement.tagName)) return;
  if (e.code === "KeyF") { setCameraMode(state.camMode === "walk" ? "orbit" : "walk"); return; }
  state.keys.add(e.code);
});
window.addEventListener("keyup", e => state.keys.delete(e.code));

function selectObject(objectId) {
  state.selectedId = objectId;
  const rt = objectId ? state.runtimes.get(objectId) : null;
  if (rt && state.world) {
    const [x, , z] = rt.spec.position;
    const gy = sampleTerrainHeight(state.world.terrain, x, z);
    selRing.position.set(rt.center.x, gy + 0.08, rt.center.z);
    selRing.scale.setScalar(Math.max(0.7, rt.radius * 0.85));
    selRing.visible = true;
    document.getElementById("selectedHint").innerHTML =
      `Selected: <b style="color:var(--accent);">${rt.spec.name}</b> (${rt.spec.id} · ${rt.spec.carrier})`;
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
    || [...state.runtimes.values()].find(r => r.spec.parametric?.kind === "fountain")
    || [...state.runtimes.values()][0];
  const heroCenter = hero ? hero.center.clone() : new THREE.Vector3(0, 2, 0);
  const heroRad = hero ? Math.max(3.5, hero.radius * 2.2) : 6.0;

  const views = [
    { label: "1. ELEVATED 3/4 OVERVIEW", pos: new THREE.Vector3(19, 13.5, 19), look: new THREE.Vector3(0, 2.2, 0) },
    { label: "2. EYE-LEVEL FRONT VIEW", pos: new THREE.Vector3(0, 2.3, 17.5), look: new THREE.Vector3(0, 2.6, -1) },
    { label: "3. OPPOSITE 180° BACK VIEW (FULL 3D)", pos: new THREE.Vector3(-15, 7.5, -22), look: new THREE.Vector3(0, 2.8, 0) },
    { label: `4. HERO CLOSE-UP (${hero ? hero.spec.id : "center"})`, pos: heroCenter.clone().add(new THREE.Vector3(heroRad, heroRad * 0.55, heroRad)), look: heroCenter },
  ];

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
      if (sp) await mountSingleObject(sp, state.world);
    }
  }
  renderSidebars();
  return data;
}

// ---------------------------------------------------------------------------
// UI Rendering & Fidelity Lab Actions
// ---------------------------------------------------------------------------
function openModal(url, title) {
  document.getElementById("modalTitle").textContent = title;
  document.getElementById("modalImg").src = url;
  document.getElementById("modal").classList.add("open");
}

function renderSidebars() {
  const w = state.world;
  if (!w) return;

  const outliner = document.getElementById("outliner");
  outliner.innerHTML = "";
  const vis = w.objects.filter(o => o.visible);
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
        : (o.carrier === "articulated_agent" ? `AGENT ${o.agent?.rig_kind}` : o.parametric?.kind || "param");
      const behIcon = o.behavior?.kind && o.behavior.kind !== "none" ? ` → ${o.behavior.target_id || o.behavior.kind}` : "";
      row.innerHTML = `
        <span class="obj-name" title="${o.id}${behIcon}">${o.name}<span style="color:var(--muted); font-size:10px;"> v${o.version}${behIcon}</span></span>
        <span class="carrier-tag ${tagClass}">${tagTxt}</span>
      `;
      row.onclick = () => selectObject(o.id);
      row.ondblclick = () => inspectObject(o.id);
      grp.appendChild(row);
    }
    outliner.appendChild(grp);
  }

  const c = w.cumulative_costs;
  document.getElementById("kpiCarbon").textContent = c.carbon_calls;
  document.getElementById("kpiHydrogen").textContent = c.hydrogen_calls;
  document.getElementById("kpiNB").textContent = c.nano_banana_texture_calls;
  document.getElementById("kpiSDF").textContent = c.sdf_meshes_compiled;
  document.getElementById("kpiRev").textContent = w.revision;

  const lastWithAudit = [...w.history].reverse().find(r => r.audit);
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
        <div class="kpi"><div class="v">${a.lighting_material_score.toFixed(1)}</div><div class="k">Lighting</div></div>
      </div>
      <div style="color:var(--text); margin-bottom:4px;">${a.summary}</div>
      ${fixTxt}${defs}
      ${a.multiview_plate_url ? `<img class="audit-img" id="auditPlateThumb" src="${a.multiview_plate_url}" style="margin-top:6px;" title="Click to inspect full 4-view 3D plate" />` : ""}
    `;
    const thumb = document.getElementById("auditPlateThumb");
    if (thumb) thumb.onclick = () => openModal(a.multiview_plate_url, `Rev ${lastWithAudit.revision} — Gemini 4 Hydrogen 4-View 3D Audit`);
  } else {
    auditBadge.textContent = "READY";
    auditBadge.className = "pill";
  }

  const hist = document.getElementById("historyBox");
  hist.innerHTML = "";
  for (const rev of [...w.history].reverse()) {
    const el = document.createElement("div");
    el.className = "rev-item";
    const t = rev.timings;
    el.innerHTML = `
      <div class="row" style="justify-content:space-between;">
        <b>Rev ${rev.revision}: ${rev.action}</b>
        <span class="pill ${rev.rebuilt_entire_world ? 'c' : 'g'}">${rev.changed_object_ids.length}Δ / ${rev.unchanged_object_ids.length} kept</span>
      </div>
      <div style="color:var(--text);">"${rev.instruction}"</div>
      <div class="mono" style="color:var(--muted);">
        ${rev.carbon_summary}<br/>
        Changed: [${rev.changed_object_ids.join(", ") || "env"}] | NB tex: ${rev.costs.nano_banana_texture_calls} | SDF: ${rev.costs.sdf_meshes_compiled}<br/>
        Time: ${(t.total_ms / 1000).toFixed(1)}s (Carbon ${t.carbon_ms.toFixed(0)}ms, NB ${t.nano_banana_ms.toFixed(0)}ms, SDF ${t.sdf_compile_ms.toFixed(0)}ms)
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
  const dist = Math.max(4.5, rt.radius * 2.5);
  const target = rt.center.clone();
  setOrbitFromLook(target.clone().add(new THREE.Vector3(dist * 0.75, dist * 0.45, dist * 0.75)), target);
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
      <div style="font-weight:600;">${item.from_video ? "🎬 " : ""}${item.title}</div>
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
    await loadFullWorld(await r.json(), true);
    refreshWorldsList();
  }
}

function setBusy(flag, elId, msg = "") {
  state.busy = flag;
  ["btnGenerate", "btnVideoWorld", "btnVideoSample", "btnApplyEdit", "btnUndo", "btnRunAudit", "btnEnhancePBR", "btnBakeHero", "btnNeuralStill"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = flag;
  });
  if (elId) document.getElementById(elId).textContent = msg;
}

// ---------------------------------------------------------------------------
// Button & Chat Event Handlers
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
  setBusy(true, "genStatus", "Gemini 4 Carbon compiling 3D WorldIR -> Nano Banana PBR -> Marching Cubes SDF...");
  try {
    const r = await fetch("/api/worlds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const world = await r.json();
    if (!r.ok) throw new Error(world.detail || "Generation failed");
    await loadFullWorld(world, true);
    await refreshWorldsList();
    setBusy(true, "genStatus", "Running independent 4-Viewpoint Gemini 4 Hydrogen spatial audit...");
    await runHydrogen4ViewAudit(true);
    setBusy(false, "genStatus", `Compiled ${world.title} (${world.objects.length} persistent 3D objects).`);
  } catch (err) {
    setBusy(false, "genStatus", `Error: ${err.message}`);
  }
};

async function reconstructFromVideo(useSample) {
  const fileEl = document.getElementById("videoFile");
  const file = fileEl.files && fileEl.files[0];
  if (!useSample && !file) {
    document.getElementById("videoStatus").textContent = "Choose a video file first (or use the sample).";
    return;
  }
  const form = new FormData();
  if (useSample) form.append("use_sample", "true"); else form.append("file", file);
  form.append("hint", document.getElementById("videoHint").value.trim());
  const t0 = performance.now();
  setBusy(true, "videoStatus", "OpenCV tracking moving objects -> Gemini 4 Carbon reconstructing the 3D scene from frames -> lifting tracks to 3D paths... (1-3 min)");
  const tick = setInterval(() => {
    document.getElementById("videoStatus").textContent = `Reconstructing 3D world from video... ${Math.round((performance.now() - t0) / 1000)}s`;
  }, 1000);
  try {
    const r = await fetch("/api/worlds/from-video", { method: "POST", body: form });
    const world = await r.json();
    if (!r.ok) throw new Error(world.detail || "Reconstruction failed");
    await loadFullWorld(world, true);
    await refreshWorldsList();
    const nTracks = world.source_video?.tracks?.length || 0;
    setBusy(false, "videoStatus", `Reconstructed ${world.title}: ${world.objects.length} persistent 3D objects, ${nTracks} video-tracked agents (${Math.round((performance.now() - t0) / 1000)}s). Walk around it, or chat-edit it below.`);
  } catch (err) {
    setBusy(false, "videoStatus", `Error: ${err.message}`);
  } finally {
    clearInterval(tick);
  }
}
document.getElementById("btnVideoWorld").onclick = () => reconstructFromVideo(false);
document.getElementById("btnVideoSample").onclick = () => reconstructFromVideo(true);
document.getElementById("btnPipToggle").onclick = () => {
  const pip = document.getElementById("videoPip");
  pip.classList.toggle("collapsed");
  document.getElementById("btnPipToggle").textContent = pip.classList.contains("collapsed") ? "+" : "–";
};

document.getElementById("btnApplyEdit").onclick = async () => {
  if (!state.world) return;
  const instruction = document.getElementById("chatEdit").value.trim();
  if (!instruction) return;
  setBusy(true, "editStatus", "Gemini 4 Carbon compiling surgical 3D WorldDiff (unrelated objects preserved)...");
  try {
    const r = await fetch(`/api/worlds/${state.world.world_id}/edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction, selected_object_id: state.selectedId }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || "Edit failed");
    await applySurgicalDelta(data.world, data.delta);
    await refreshWorldsList();
    setBusy(false, "editStatus", `Rev ${data.world.revision}: ${data.delta.action} (${data.delta.changed_object_ids.length} mutated, ${data.delta.unchanged_object_ids.length} preserved).`);
  } catch (err) {
    setBusy(false, "editStatus", `Error: ${err.message}`);
  }
};

document.getElementById("btnUndo").onclick = async () => {
  if (!state.world) return;
  setBusy(true, "editStatus", "Restoring previous immutable revision (0 neural calls)...");
  try {
    const r = await fetch(`/api/worlds/${state.world.world_id}/undo`, { method: "POST" });
    await loadFullWorld(await r.json(), false);
    await refreshWorldsList();
    setBusy(false, "editStatus", `Restored revision ${state.world.revision} (0 neural calls).`);
  } catch (err) {
    setBusy(false, "editStatus", `Error: ${err.message}`);
  }
};

document.getElementById("btnRunAudit").onclick = async () => {
  if (!state.world) return;
  setBusy(true, "editStatus", "Capturing 4 live 3D camera viewpoints -> Gemini 4 Hydrogen spatial audit...");
  try {
    const res = await runHydrogen4ViewAudit(true);
    setBusy(false, "editStatus", `Hydrogen Audit: ${res.verdict.status} (3D=${res.verdict.geometry_3d_score}, Spatial=${res.verdict.spatial_coherence_score}).`);
  } catch (err) {
    setBusy(false, "editStatus", `Audit error: ${err.message}`);
  }
};

// Fidelity Lab buttons (Approaches A, B, C directly accessible in the Studio!)
document.getElementById("btnEnhancePBR").onclick = async () => {
  if (!state.world) return;
  setBusy(true, "fidelityStatus", "Approach A: Synthesizing persistent roof/hill PBR + cavity AO + 3D SDF-AO...");
  try {
    const r = await fetch(`/api/worlds/${state.world.world_id}/enhance-materials`, { method: "POST" });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || "Enhance failed");
    await loadFullWorld(data.world, false);
    await refreshWorldsList();
    setBusy(false, "fidelityStatus", `Approach A complete: +${data.enhancement.new_textures.length} PBR sets, ${data.enhancement.sdf_recompiled} SDF-AO meshes.`);
  } catch (err) {
    setBusy(false, "fidelityStatus", `Error: ${err.message}`);
  }
};

document.getElementById("btnBakeHero").onclick = async () => {
  if (!state.world) return;
  const sdfObj = (state.selectedId && state.world.objects.find(o => o.id === state.selectedId && o.carrier === "implicit_sdf"))
    || state.world.objects.find(o => o.visible && o.carrier === "implicit_sdf");
  if (!sdfObj) {
    document.getElementById("fidelityStatus").textContent = "No implicit_sdf object in this world to bake.";
    return;
  }
  setBusy(true, "fidelityStatus", `Approach B: Capturing ortho Front+Back of ${sdfObj.id} -> 1 Nano Banana object-space bake...`);
  try {
    const { front_b64, back_b64 } = captureObjectOrthoFrontBack(sdfObj.id);
    const r = await fetch(`/api/worlds/${state.world.world_id}/objects/${sdfObj.id}/bake-neural`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ front_b64, back_b64 }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || "Bake failed");
    state.world = data.world;
    const updated = state.world.objects.find(o => o.id === sdfObj.id);
    if (updated) await mountSingleObject(updated, state.world);
    renderSidebars();
    inspectObject(sdfObj.id);
    setBusy(false, "fidelityStatus", `Approach B baked onto ${sdfObj.id} (${(data.bake.inference_ms / 1000).toFixed(1)}s) — walk 360° @ 60 FPS!`);
  } catch (err) {
    setBusy(false, "fidelityStatus", `Error: ${err.message}`);
  }
};

document.getElementById("btnNeuralStill").onclick = async () => {
  if (!state.world) return;
  setBusy(true, "fidelityStatus", "Approach C: Exporting live G-Buffer (RGB+Depth+Normals+ObjectID) -> Nano Banana still...");
  try {
    const gbuf = captureGBufferPasses(null, null, 768, 480);
    const r = await fetch(`/api/worlds/${state.world.world_id}/neural-render`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tag: `cam_${Date.now() % 10000}`,
        mode: "gbuffer_conditioned",
        rgb_b64: gbuf.rgb,
        depth_b64: gbuf.depth,
        normal_b64: gbuf.normals,
        obj_id_b64: gbuf.obj_id,
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || "Neural still failed");
    const m = data.metrics;
    setBusy(false, "fidelityStatus", `Approach C (${(m.inference_ms / 1000).toFixed(1)}s): Edge F1=${m.edge_f1_3px}, ObjMask Recall=${m.object_silhouette_recall}`);
    openModal(data.enhanced_rgb_url, `Approach C: G-Buffer Neural Still (Edge F1=${m.edge_f1_3px}, ${(m.inference_ms / 1000).toFixed(1)}s)`);
  } catch (err) {
    setBusy(false, "fidelityStatus", `Error: ${err.message}`);
  }
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
document.getElementById("btnCamVideo").onclick = () => {
  const sv = state.world?.source_video;
  if (!sv) return;
  setCameraMode("orbit");
  setOrbitFromLook(new THREE.Vector3(...sv.camera_pos), new THREE.Vector3(...sv.camera_look_at));
};
document.getElementById("btnCamInspect").onclick = () => {
  if (state.selectedId) inspectObject(state.selectedId);
};
document.getElementById("modalClose").onclick = () => document.getElementById("modal").classList.remove("open");
document.getElementById("modal").onclick = e => { if (e.target.id === "modal") e.target.classList.remove("open"); };

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

// Expose clean hooks for reproducible multi-camera benchmarking & live inspection
window.__WORLD_STUDIO__ = {
  state,
  loadFullWorld,
  mountSingleObject,
  capture4ViewPlate,
  captureGBufferPasses,
  captureObjectOrthoFrontBack,
  measureSyncGpuFrameMs,
  runHydrogen4ViewAudit,
  setOrbitFromLook,
  setCameraMode,
  selectObject,
  inspectObject,
  THREE,
};

let lastTime = performance.now(), frames = 0, fpsTimer = 0, elapsed = 0;
function animate(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  elapsed += dt;
  frames++; fpsTimer += dt;
  if (fpsTimer >= 0.5) {
    document.getElementById("fpsBadge").textContent = `${Math.round(frames / fpsTimer)} FPS`;
    frames = 0; fpsTimer = 0;
  }

  if (state.camMode === "walk") updateWalkCamera(dt);
  const sv = state.world?.source_video;
  if (sv) {
    state.videoTime = srcVideoEl.readyState >= 2 ? srcVideoEl.currentTime : (state.videoTime + dt) % Math.max(sv.duration, 0.5);
  }
  updateAutonomousWorld(elapsed, dt);

  if (state.world) {
    const p = camera.position;
    document.getElementById("vpHud").innerHTML =
      `<b>${state.world.title}</b> [Rev ${state.world.revision}] · Mode: <b>${state.camMode.toUpperCase()}</b><br/>` +
      `Cam (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}) · ${state.runtimes.size} live 3D objects · ${state.world.atmosphere.time_of_day}<br/>` +
      `Orbit: Drag/Zoom/Click | Walk: <b>F</b> + WASD + Mouse`;
  }

  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

refreshWorldsList().then(() => requestAnimationFrame(animate));

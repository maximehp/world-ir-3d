/* WorldIR 3D Studio — Full 3D Three.js WebGL2 Runtime:
 *  - Real PBR shadows (2048px PCFSoftShadowMap), live Sky Dome + PMREM Reflections, volumetric clouds
 *  - Free WASD + Mouse Look walking/flying AND 360° Orbit + Click-to-Select object inspection
 *  - True surgical hot-patching: preserves live persistent objects & mid-flight agent trajectories
 *  - Automated 4-Viewpoint 3D render plate capture for independent Gemini 4 Hydrogen visual auditing
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
// Three.js Renderer, Scene, Lights, Sky Dome & PMREM Environment
// ---------------------------------------------------------------------------
const canvas = document.getElementById("viewport3d");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(54, 16 / 9, 0.15, 280);
camera.position.set(0, 4.8, 22);

// Sun + Hemisphere bounce light
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
sunLight.shadow.bias = -0.0005;
sunLight.shadow.normalBias = 0.025;
scene.add(sunLight);

const hemiLight = new THREE.HemisphereLight("#8cb6e8", "#5b5142", 0.78);
scene.add(hemiLight);

// Procedural Sky Dome shader + dynamic PMREM environment generator for real reflections
const skyUniforms = {
  uZenith: { value: new THREE.Color("#2b588f") },
  uHorizon: { value: new THREE.Color("#f2b880") },
  uSunDir: { value: new THREE.Vector3(0.5, 0.5, 0.5).normalize() },
  uSunColor: { value: new THREE.Color("#fff0d6") },
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
    uniform vec3 uSunDir;
    uniform vec3 uSunColor;
    varying vec3 vWorldDir;
    void main() {
      vec3 d = normalize(vWorldDir);
      float h = clamp(d.y, 0.0, 1.0);
      vec3 col = mix(uHorizon, uZenith, pow(h, 0.52));
      float sunAmt = max(dot(d, normalize(uSunDir)), 0.0);
      col += uSunColor * pow(sunAmt, 14.0) * 0.35;
      col += uSunColor * smoothstep(0.997, 0.9994, sunAmt) * 1.6;
      gl_FragColor = vec4(col, 1.0);
    }
  `,
});
const skyDome = new THREE.Mesh(new THREE.SphereGeometry(170, 24, 16), skyMat);
scene.add(skyDome);

const pmremGen = new THREE.PMREMGenerator(renderer);
let envRenderTarget = null;
function refreshEnvironmentIBL() {
  const envScene = new THREE.Scene();
  const envSky = new THREE.Mesh(new THREE.SphereGeometry(30, 16, 12), skyMat);
  envScene.add(envSky);
  if (envRenderTarget) envRenderTarget.dispose();
  envRenderTarget = pmremGen.fromScene(envScene, 0.04);
  scene.environment = envRenderTarget.texture;
}

// Drifting soft 3D cloud puffs
const cloudGroup = new THREE.Group();
scene.add(cloudGroup);
function rebuildClouds(count, isNight) {
  while (cloudGroup.children.length) cloudGroup.remove(cloudGroup.children[0]);
  const cMat = new THREE.MeshStandardMaterial({
    color: isNight ? "#33415c" : "#f7f3ee",
    roughness: 1.0,
    transparent: true,
    opacity: isNight ? 0.45 : 0.82,
  });
  for (let i = 0; i < count; i++) {
    const cg = new THREE.Group();
    const ang = (i / Math.max(count, 1)) * Math.PI * 2 + 0.3;
    const rad = 22 + (i % 4) * 12;
    cg.position.set(Math.cos(ang) * rad, 19 + (i % 3) * 4.5, Math.sin(ang) * rad);
    for (let k = 0; k < 4; k++) {
      const puff = new THREE.Mesh(new THREE.SphereGeometry(1.6 + (k % 2) * 0.8, 10, 8), cMat);
      puff.scale.set(1.5, 0.65, 1.15);
      puff.position.set((k - 1.5) * 1.5, (k % 2) * 0.45, ((k * 7) % 3 - 1) * 0.8);
      cg.add(puff);
    }
    cg.userData.driftSpeed = 0.25 + (i % 3) * 0.15;
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
  // Map<objectId, { spec, group, topY, radius }>
  runtimes: new Map(),
  selectedId: null,
  camMode: "orbit", // "orbit" | "walk"
  busy: false,
  // Orbit spherical state
  orbitTarget: new THREE.Vector3(0, 2.5, 0),
  orbitDist: 23,
  orbitTheta: 0.28,
  orbitPhi: 1.24,
  // Walk / Free-fly Euler state
  walkYaw: 0,
  walkPitch: -0.06,
  keys: new Set(),
};

function applyAtmosphere(atm) {
  const isNight = atm.time_of_day === "night" || atm.time_of_day === "dusk";
  const el = THREE.MathUtils.degToRad(atm.sun_elevation_deg ?? 34);
  const az = THREE.MathUtils.degToRad(atm.sun_azimuth_deg ?? 42);
  const sunDir = new THREE.Vector3(
    Math.cos(el) * Math.sin(az),
    Math.sin(el),
    Math.cos(el) * Math.cos(az)
  ).normalize();

  sunLight.position.copy(sunDir).multiplyScalar(48);
  sunLight.color.set(atm.sun_color || "#fff0d6");
  sunLight.intensity = atm.sun_intensity ?? 2.8;

  hemiLight.color.set(atm.sky_zenith || "#6fa4e0");
  hemiLight.groundColor.set(isNight ? "#1a1f2b" : "#615342");
  hemiLight.intensity = atm.ambient_intensity ?? 0.75;

  skyUniforms.uZenith.value.set(atm.sky_zenith || "#2b588f");
  skyUniforms.uHorizon.value.set(atm.sky_horizon || "#f2b880");
  skyUniforms.uSunDir.value.copy(sunDir);
  skyUniforms.uSunColor.value.set(atm.sun_color || "#fff0d6");

  scene.fog = new THREE.FogExp2(atm.fog_color || "#d8c4ae", atm.fog_density ?? 0.008);
  renderer.toneMappingExposure = isNight ? 1.18 : 1.06;

  rebuildClouds(atm.cloud_count ?? 8, isNight);
  refreshEnvironmentIBL();

  // Dynamically adjust existing building windows & lamppost lights without rebuilding geometry!
  for (const rt of state.runtimes.values()) {
    const g = rt.group;
    if (g.userData.windowGlassMat) {
      g.userData.windowGlassMat.emissiveIntensity = isNight ? 1.9 : 0.42;
    }
    if (g.userData.lampLight) {
      g.userData.lampLight.intensity = isNight ? 18.0 : 3.5;
    }
    if (g.userData.lampGlowMat) {
      g.userData.lampGlowMat.emissiveIntensity = isNight ? 3.2 : 1.0;
    }
  }
}

function positionObjectOnTerrain(obj, group, terrain) {
  const [x, yOff, z] = obj.position || [0, 0, 0];
  const groundY = sampleTerrainHeight(terrain, x, z);
  if (obj.carrier === "articulated_agent" && (obj.agent?.rig_kind === "bird_flock" || obj.agent?.rig_kind === "floating_lanterns")) {
    // Flock members manage their own world coordinates in world space
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
  const box = new THREE.Box3().setFromObject(group);
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
  // Remove old instance for this ID ONLY if rebuilding this specific object
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
  // Clear previous world objects
  while (worldRoot.children.length) worldRoot.remove(worldRoot.children[0]);
  state.runtimes.clear();
  state.selectedId = null;
  selRing.visible = false;

  // Build terrain + atmosphere
  state.terrainGroup = buildTerrain(world.terrain, world.textures || {});
  worldRoot.add(state.terrainGroup);
  applyAtmosphere(world.atmosphere);

  // Mount all persistent objects concurrently (SDF meshes fetch in parallel)
  await Promise.all(world.objects.filter(o => o.visible).map(o => mountSingleObject(o, world)));

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

  // Remove deleted objects ONLY
  for (const rid of removed) {
    const rt = state.runtimes.get(rid);
    if (rt) {
      worldRoot.remove(rt.group);
      state.runtimes.delete(rid);
    }
    if (state.selectedId === rid) selectObject(null);
  }

  // Hot-patch behavior-only objects IN-PLACE without destroying their live 3D instances!
  for (const bid of behOnly) {
    const rt = state.runtimes.get(bid);
    const updatedSpec = objById.get(bid);
    if (rt && updatedSpec) {
      rt.spec = updatedSpec;
      // Nudge perched birds to take off smoothly toward their new target immediately!
      if (rt.group.userData.flockMembers) {
        for (const bird of rt.group.userData.flockMembers) {
          bird.userData.agentState.mode = "FLYING";
          bird.userData.agentState.timer = 0;
        }
      }
    }
  }

  // Rebuild ONLY objects whose geometry/material/transform actually changed (unrelated objects stay bit-exact untouched!)
  const toRemount = [];
  for (const cid of changed) {
    if (behOnly.has(cid) || removed.has(cid)) continue;
    const updatedSpec = objById.get(cid);
    if (updatedSpec && updatedSpec.visible) {
      toRemount.push(mountSingleObject(updatedSpec, newWorld));
    }
  }
  await Promise.all(toRemount);

  // Refresh selection ring if selected object moved/rescaled
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
    return {
      cx: rt.center.x,
      cz: rt.center.z,
      topY: rt.topY,
      radius: rt.radius,
    };
  }
  return { cx: 0, cz: 0, topY: 3.2, radius: 3.0 };
}

function updateAutonomousWorld(t, dt) {
  if (!state.world) return;
  const wind = state.world.atmosphere?.wind_strength ?? 0.5;
  const terrain = state.world.terrain;

  // Drift clouds
  for (const cg of cloudGroup.children) {
    cg.position.x += cg.userData.driftSpeed * wind * dt;
    if (cg.position.x > 65) cg.position.x = -65;
  }

  // Animate reflective water ripple shimmer
  const wm = state.terrainGroup?.userData?.waterMesh;
  if (wm) {
    wm.position.y = (terrain.water_level ?? -0.4) + Math.sin(t * 1.4) * 0.035;
  }

  for (const rt of state.runtimes.values()) {
    const { spec, group } = rt;

    // 1. Fountain parabolic 3D water jets
    if (group.userData.waterDrops) {
      for (const drop of group.userData.waterDrops) {
        const d = drop.userData;
        const u = (d.phase + t * 0.85) % 1.0;
        const r = u * d.radius;
        const arcY = d.topY + 0.95 * u - (0.95 + (d.topY - d.poolY)) * u * u;
        drop.position.set(Math.cos(d.ang) * r, Math.max(d.poolY, arcY), Math.sin(d.ang) * r);
      }
    }

    // 2. Tree wind sway
    if (group.userData.swayGroup) {
      const ph = group.userData.swayPhase || 0;
      group.userData.swayGroup.rotation.z = Math.sin(t * 1.3 + ph) * 0.035 * wind;
      group.userData.swayGroup.rotation.x = Math.cos(t * 0.95 + ph) * 0.022 * wind;
    }

    // 3. Windmill sails, Lighthouse beam, Clock hands
    if (group.userData.spinRotorZ) {
      group.userData.spinRotorZ.rotation.z -= dt * (0.65 + wind * 0.6);
    }
    if (group.userData.sweepBeamY) {
      group.userData.sweepBeamY.rotation.y += dt * 0.75;
    }
    if (group.userData.clockHands) {
      for (const hand of group.userData.clockHands) hand.rotation.z = -t * 0.25;
    }

    // 4. Autonomous Flock of Flapping & Perching 3D Birds!
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

        // State transitions between circling and perching on target's real 3D roof/rim!
        if (canPerch && st.mode === "FLYING" && st.timer > flyDur) {
          st.mode = "LANDING";
          st.timer = 0;
        } else if (st.mode === "PERCHED" && st.timer > perchDur) {
          st.mode = "FLYING";
          st.timer = 0;
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
          // Fold wings calmly while perched on roof/fountain rim
          bird.userData.wingL.rotation.z = THREE.MathUtils.lerp(bird.userData.wingL.rotation.z, -1.1, dt * 5);
          bird.userData.wingR.rotation.z = THREE.MathUtils.lerp(bird.userData.wingR.rotation.z, 1.1, dt * 5);
          bird.rotation.z = THREE.MathUtils.lerp(bird.rotation.z, 0, dt * 5);
          bird.rotation.x = THREE.MathUtils.lerp(bird.rotation.x, 0, dt * 5);
          bird.rotation.y += Math.sin(t * 1.7 + st.perchSlot) * 0.008;
          continue;
        } else if (st.mode === "LANDING") {
          desiredPos = perchPos;
          if (st.pos.distanceTo(perchPos) < 0.35) {
            st.mode = "PERCHED";
            st.timer = 0;
          }
        } else {
          // Smooth 3D circling orbit around target (disappearing behind buildings and emerging!)
          st.angle += dt * speed * (0.85 + 0.2 * Math.sin(st.perchSlot));
          const rNow = orbitR + st.radiusOffset;
          const yNow = orbitH + st.heightOffset + Math.sin(st.angle * 2.0 + st.perchSlot) * 0.75;
          desiredPos = new THREE.Vector3(
            tgt.cx + Math.cos(st.angle) * rNow,
            yNow,
            tgt.cz + Math.sin(st.angle) * rNow
          );
        }

        // Smooth steering force so mid-flight target switches ("circle the fountain instead!") glide naturally!
        const toTarget = desiredPos.clone().sub(st.pos);
        const dist = toTarget.length();
        const maxSpeed = st.mode === "LANDING" ? 4.5 : Math.max(4.5, orbitR * speed * 1.25);
        const steer = toTarget.normalize().multiplyScalar(Math.min(maxSpeed, dist * 2.2));
        st.vel.lerp(steer, Math.min(1, dt * 3.2));
        st.pos.addScaledVector(st.vel, dt);
        bird.position.copy(st.pos);

        // Face velocity direction + bank realistically into turns
        if (st.vel.lengthSq() > 0.01) {
          const lookPt = st.pos.clone().add(st.vel);
          bird.lookAt(lookPt);
          const bank = st.mode === "FLYING" ? -0.32 : 0.0;
          bird.rotation.z = THREE.MathUtils.lerp(bird.rotation.z, bank, dt * 4);
        }

        // Hinged 3D wing flapping
        st.flapPhase += dt * (st.mode === "LANDING" ? 15.0 : 10.5);
        const flap = Math.sin(st.flapPhase) * 0.72;
        bird.userData.wingL.rotation.z = flap;
        bird.userData.wingR.rotation.z = -flap;
      }
    }

    // 5. Drifting Floating Lanterns
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

    // 6. Ground Patrolling Agent (Scooter / Fox / Boat) following h(x, z) terrain!
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
        // Vehicle/fox forward axis is +X -> atan2(-dz, dx)
        const targetYaw = Math.atan2(-moveVec.z, moveVec.x);
        group.rotation.y = targetYaw;
      }
      // Spin wheels or trot legs!
      if (pm.userData.wheels) {
        for (const w of pm.userData.wheels) w.rotation.z -= dt * spd * rad * 1.8;
      }
      if (pm.userData.legs) {
        for (const leg of pm.userData.legs) {
          leg.rotation.z = Math.sin(t * 8.5 + leg.userData.phase) * 0.48;
        }
      }
    }
  }
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
    // Initialize yaw/pitch from current camera orientation
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    state.walkYaw = Math.atan2(-dir.x, -dir.z);
    state.walkPitch = Math.asin(THREE.MathUtils.clamp(dir.y, -0.95, 0.95));
    // Drop to eye level if currently high up
    if (camera.position.y > 7.5 && state.world) {
      const gh = sampleTerrainHeight(state.world.terrain, camera.position.x, camera.position.z);
      camera.position.y = gh + 2.1;
    }
    if (canvas.requestPointerLock) {
      try { canvas.requestPointerLock(); } catch {}
    }
  } else {
    if (document.pointerLockElement === canvas && document.exitPointerLock) {
      document.exitPointerLock();
    }
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

  // Keep camera cleanly above terrain heightfield
  if (state.world) {
    const minY = sampleTerrainHeight(state.world.terrain, camera.position.x, camera.position.z) + 1.35;
    if (camera.position.y < minY) camera.position.y = minY;
  }
}

// Mouse drag / pointer-lock / wheel / raycast selection
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
    // Click-to-select 3D object via raycasting
    const rect = canvas.getBoundingClientRect();
    ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(worldRoot.children, true);
    const hitObj = hits.find(h => h.object?.userData?.objectId);
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
    lastMX = e.clientX;
    lastMY = e.clientY;
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
  lastMX = e.clientX;
  lastMY = e.clientY;
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
  if (e.code === "KeyF") {
    setCameraMode(state.camMode === "walk" ? "orbit" : "walk");
    return;
  }
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

  // Pick a hero landmark (SDF sculpture or fountain or first visible landmark) for View 4 close-up
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

  // Restore exact live user camera
  camera.aspect = prevAspect;
  camera.updateProjectionMatrix();
  camera.position.copy(prevPos);
  camera.quaternion.copy(prevQuat);
  selRing.visible = prevSelVis;
  renderer.render(scene, camera);

  return plate.toDataURL("image/jpeg", 0.88);
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
    // Hot-update ONLY the objects Hydrogen repaired!
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
// UI Rendering: Blender-Style Outliner, Audit Panel, History, World List
// ---------------------------------------------------------------------------
function openModal(url, title) {
  document.getElementById("modalTitle").textContent = title;
  document.getElementById("modalImg").src = url;
  document.getElementById("modal").classList.add("open");
}

function renderSidebars() {
  const w = state.world;
  if (!w) return;

  // Outliner grouped by Blender-style Collections
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
      const tagClass = o.carrier === "implicit_sdf" ? "tag-sdf" : (o.carrier === "articulated_agent" ? "tag-agent" : "tag-param");
      const tagTxt = o.carrier === "implicit_sdf"
        ? `SDF ${o.implicit_sdf?.face_count || ""}`
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

  // Cost Ledger
  const c = w.cumulative_costs;
  document.getElementById("kpiCarbon").textContent = c.carbon_calls;
  document.getElementById("kpiHydrogen").textContent = c.hydrogen_calls;
  document.getElementById("kpiNB").textContent = c.nano_banana_texture_calls;
  document.getElementById("kpiSDF").textContent = c.sdf_meshes_compiled;
  document.getElementById("kpiRev").textContent = w.revision;

  // Latest Hydrogen 4-View Audit
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

  // Revision History
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
        Carbon: ${rev.carbon_summary}<br/>
        Changed: [${rev.changed_object_ids.join(", ") || "env"}] | NB tex: ${rev.costs.nano_banana_texture_calls} | SDF: ${rev.costs.sdf_meshes_compiled}<br/>
        Time: ${(t.total_ms/1000).toFixed(1)}s (Carbon ${t.carbon_ms.toFixed(0)}ms, NB ${t.nano_banana_ms.toFixed(0)}ms, SDF ${t.sdf_compile_ms.toFixed(0)}ms)
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
    await loadFullWorld(await r.json(), true);
    refreshWorldsList();
  }
}

function setBusy(flag, elId, msg = "") {
  state.busy = flag;
  ["btnGenerate", "btnApplyEdit", "btnUndo", "btnRunAudit"].forEach(id => {
    document.getElementById(id).disabled = flag;
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
  setBusy(true, "genStatus", "Gemini 4 Carbon compiling 3D WorldIR -> Nano Banana PBR textures -> Marching Cubes SDF...");
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
    setBusy(true, "genStatus", "World rendered! Running independent 4-Viewpoint Gemini 4 Hydrogen spatial audit...");
    await runHydrogen4ViewAudit(true);
    setBusy(false, "genStatus", `Compiled ${world.title} (${world.objects.length} persistent 3D objects).`);
  } catch (err) {
    setBusy(false, "genStatus", `Error: ${err.message}`);
  }
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
document.getElementById("modalClose").onclick = () => document.getElementById("modal").classList.remove("open");
document.getElementById("modal").onclick = e => { if (e.target.id === "modal") e.target.classList.remove("open"); };

// Resize handling
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

// Expose clean hook for automated testing / multi-view capture
window.__WORLD_STUDIO__ = {
  state,
  capture4ViewPlate,
  runHydrogen4ViewAudit,
  setOrbitFromLook,
  setCameraMode,
  selectObject,
  inspectObject,
  THREE,
};

// Main Real-Time 60 FPS Loop
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

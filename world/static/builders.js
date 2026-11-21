/* High-Craft Multi-Carrier 3D Builders for WorldIR (Enhanced Persistent PBR + SDF-AO + Dual-Projection Neural Baking):
 *   1. Dual-Biome Splat Heightfield Terrain + Animated Normal-Mapped Reflective Water
 *   2. Parametric Multi-Part 3D Assemblies (Terracotta Tile Roof PBR, Eaves Rafters, Daytime Reflective Glass,
 *      Grounded Contact-AO Skirts, Organic Multi-Cluster Foliage, Sparkling Fountain Water Jets)
 *   3. Implicit Smooth-Min SDF Marching Cubes Mesh Loader w/ Baked 3D SDF-AO Vertex Colors +
 *      Approach B Object-Space Dual-Projection Neural PBR Shader (Front +Z / Back -Z @ 60 FPS)
 *   4. Articulated Autonomous Agents (Flapping/Banking/Perching Birds, Trotting Foxes, Patrolling Vehicles)
 */

import * as THREE from "./vendor/three.module.min.js";

// ---------------------------------------------------------------------------
// Shared Deterministic Helpers & Analytic Heightfield h(x, z)
// ---------------------------------------------------------------------------
function seededRand(seed) {
  let s = (seed * 9301 + 49297) % 233280;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function smoothstep(e0, e1, x) {
  const t = Math.max(0, Math.min(1, (x - e0) / Math.max(e1 - e0, 1e-6)));
  return t * t * (3 - 2 * t);
}

export function sampleTerrainHeight(terrain, x, z) {
  const gkind = terrain.ground_kind || "outdoor_hills";
  if (gkind === "interior_deck" || gkind === "flat_floor" || gkind === "none") {
    return 0.0;
  }
  const r = Math.hypot(x, z);
  const pr = terrain.plaza_radius ?? 15.0;
  const hh = terrain.hill_height ?? 3.0;
  // Continuous undulating forest floor when ground_kind === "forest_floor" or plaza_radius <= 0.1
  const hillMask = (gkind === "forest_floor" || pr <= 0.1)
    ? 1.0
    : smoothstep(pr * 0.85, pr * 1.6, r);

  const n1 = Math.sin(x * 0.085 + 0.4) * Math.cos(z * 0.085 - 0.3);
  const n2 = Math.sin(x * 0.17 - z * 0.14 + 1.2) * 0.45;
  const n3 = Math.cos((x + z) * 0.055) * 0.55;
  let h = (n1 * 0.5 + n2 * 0.35 + n3 * 0.35 + (gkind === "forest_floor" ? 0.15 : 0.45)) * hh * hillMask;

  if (terrain.has_water && terrain.style === "coastal_harbor") {
    const seaBlend = smoothstep(Math.max(4.0, pr) * 0.55, Math.max(4.0, pr) * 1.15, z);
    h = h * (1.0 - seaBlend) + (terrain.water_level - 1.2) * seaBlend;
  } else if (terrain.has_water && gkind === "forest_floor") {
    // Winding woodland stream cutting naturally through the forest floor
    const stream = Math.abs(x - Math.sin(z * 0.14) * 3.8 - 2.5);
    const carve = 1.0 - smoothstep(1.2, 3.8, stream);
    h = h * (1.0 - carve * 0.85) + (terrain.water_level - 0.65) * carve;
  } else if (terrain.has_water) {
    const stream = Math.abs(z - Math.sin(x * 0.12) * 5.0 - Math.max(4.0, pr) * 0.85);
    const carve = 1.0 - smoothstep(1.8, 5.5, stream);
    h = h * (1.0 - carve * 0.8) + (terrain.water_level - 0.9) * carve;
  }
  return h;
}

// ---------------------------------------------------------------------------
// Shared Procedural Micro-Detail Maps (Contact AO, Water Ripples, Foliage Bump, Wood Grain)
// Generated once in memory with zero network calls!
// ---------------------------------------------------------------------------
const procCache = {};

function makeNormalCanvas(size, heightFn, strength = 2.5) {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(size, size);
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      h[y * size + x] = heightFn(x / size, y / size);
    }
  }
  for (let y = 0; y < size; y++) {
    const ym = (y - 1 + size) % size;
    const yp = (y + 1) % size;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;
      const dx = (h[y * size + xp] - h[y * size + xm]) * strength;
      const dy = (h[yp * size + x] - h[ym * size + x]) * strength;
      const len = Math.hypot(dx, dy, 1.0);
      const idx = (y * size + x) * 4;
      img.data[idx] = Math.round(((-dx / len) * 0.5 + 0.5) * 255);
      img.data[idx + 1] = Math.round(((-dy / len) * 0.5 + 0.5) * 255);
      img.data[idx + 2] = Math.round(((1.0 / len) * 0.5 + 0.5) * 255);
      img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

export function getWaterNormalMap() {
  if (!procCache.waterNormal) {
    const TAU = Math.PI * 2;
    procCache.waterNormal = makeNormalCanvas(192, (u, v) => {
      return (
        Math.sin(u * TAU * 4 + v * TAU * 2) * 0.35 +
        Math.cos(u * TAU * 7 - v * TAU * 5) * 0.25 +
        Math.sin(u * TAU * 11 + v * TAU * 9) * 0.16 +
        Math.cos((u + v) * TAU * 16) * 0.10
      );
    }, 1.8);
    procCache.waterNormal.repeat.set(3, 3);
  }
  return procCache.waterNormal;
}

function getFoliageNormalMap() {
  if (!procCache.foliageNormal) {
    const TAU = Math.PI * 2;
    procCache.foliageNormal = makeNormalCanvas(128, (u, v) => {
      const a = Math.sin(u * TAU * 12) * Math.cos(v * TAU * 12) * 0.4;
      const b = Math.sin((u * 19 + v * 13) * TAU) * 0.32;
      const c = Math.cos((u * 27 - v * 23) * TAU) * 0.25;
      return a + b + c;
    }, 3.0);
    procCache.foliageNormal.repeat.set(3, 3);
  }
  return procCache.foliageNormal;
}

function getWoodNormalMap() {
  if (!procCache.woodNormal) {
    const TAU = Math.PI * 2;
    procCache.woodNormal = makeNormalCanvas(128, (u, v) => {
      return Math.sin(u * TAU * 18 + Math.sin(v * TAU * 3) * 1.4) * 0.45 + Math.cos(v * TAU * 6) * 0.15;
    }, 2.2);
    procCache.woodNormal.repeat.set(2, 2);
  }
  return procCache.woodNormal;
}

function getContactAOTexture() {
  if (!procCache.contactAO) {
    const size = 128;
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const ctx = c.getContext("2d");
    const grad = ctx.createRadialGradient(size / 2, size / 2, size * 0.12, size / 2, size / 2, size * 0.5);
    grad.addColorStop(0.0, "rgba(14, 11, 8, 0.52)");
    grad.addColorStop(0.55, "rgba(14, 11, 8, 0.26)");
    grad.addColorStop(1.0, "rgba(14, 11, 8, 0.0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    procCache.contactAO = new THREE.CanvasTexture(c);
  }
  return procCache.contactAO;
}

function addContactAO(group, rx, rz, opacity = 0.78) {
  const mat = new THREE.MeshBasicMaterial({
    map: getContactAOTexture(),
    transparent: true,
    opacity,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(rx * 2.35, rz * 2.35), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.025;
  mesh.userData.isContactAO = true;
  group.add(mesh);
}

// ---------------------------------------------------------------------------
// PBR Material Factory (Nano Banana Albedo + Normal + Roughness + Cavity AO)
// ---------------------------------------------------------------------------
const texLoader = new THREE.TextureLoader();
const loadedTexCache = new Map();

function loadRepeatTex(url, repeatX, repeatY, isColor) {
  const key = `${url}|${repeatX}|${repeatY}|${isColor}`;
  if (loadedTexCache.has(key)) return loadedTexCache.get(key);
  const tex = texLoader.load(url);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = 8;
  if (isColor) tex.colorSpace = THREE.SRGBColorSpace;
  loadedTexCache.set(key, tex);
  return tex;
}

function loadClampTex(url, isColor) {
  const key = `CLAMP|${url}|${isColor}`;
  if (loadedTexCache.has(key)) return loadedTexCache.get(key);
  const tex = texLoader.load(url);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;
  if (isColor) tex.colorSpace = THREE.SRGBColorSpace;
  loadedTexCache.set(key, tex);
  return tex;
}

export function createPBRMaterial(matSpec, texturesDict, options = {}) {
  const color = new THREE.Color(options.overrideColor || matSpec.color || "#c8b8a2");
  const repeat = options.repeat ?? matSpec.texture_repeat ?? 2.0;
  const repeatY = options.repeatY ?? repeat;
  const texId = options.textureIdOverride !== undefined ? options.textureIdOverride : matSpec.texture_id;
  const normalStrength = options.normalStrength ?? 1.05;
  const tintWeight = options.tintWeight ?? 0.22;
  const params = {
    color: color.clone(),
    roughness: options.roughness ?? matSpec.roughness ?? 0.76,
    metalness: options.metalness ?? matSpec.metalness ?? 0.05,
    emissive: new THREE.Color(options.emissive ?? matSpec.emissive ?? "#000000"),
    emissiveIntensity: options.emissiveIntensity ?? matSpec.emissive_intensity ?? 0.0,
    envMapIntensity: options.envMapIntensity ?? 0.85,
  };
  const texAsset = !options.noTexture && texId ? texturesDict[texId] : null;
  if (texAsset) {
    params.map = loadRepeatTex(texAsset.albedo_url, repeat, repeatY, true);
    params.normalMap = loadRepeatTex(texAsset.normal_url, repeat, repeatY, false);
    params.normalScale = new THREE.Vector2(normalStrength, normalStrength);
    params.roughnessMap = loadRepeatTex(texAsset.roughness_url, repeat, repeatY, false);
    if (texAsset.ao_url) {
      params.aoMap = loadRepeatTex(texAsset.ao_url, repeat, repeatY, false);
      params.aoMapIntensity = 0.75;
    }
    params.color = new THREE.Color("#ffffff").lerp(color, tintWeight);
  }
  const mat = new THREE.MeshStandardMaterial(params);
  if (!options.noTexture && texId) {
    mat.userData.pbrBinding = {
      texId,
      repeat,
      repeatY,
      normalStrength,
      tintWeight,
      baseColor: color.clone(),
    };
  }
  return mat;
}

function loadRepeatTexAsync(url, repeatX, repeatY, isColor) {
  const key = `${url}|${repeatX}|${repeatY}|${isColor}`;
  if (loadedTexCache.has(key)) return Promise.resolve(loadedTexCache.get(key));
  return new Promise((resolve, reject) => {
    texLoader.load(
      url,
      tex => {
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(repeatX, repeatY);
        tex.anisotropy = 8;
        if (isColor) tex.colorSpace = THREE.SRGBColorSpace;
        loadedTexCache.set(key, tex);
        resolve(tex);
      },
      undefined,
      err => reject(err)
    );
  });
}

export async function upgradeMaterialsWithTexture(worldRoot, texAsset) {
  // Hot-swap newly arrived provisional/refined PBR maps onto every live Three.js material referencing texAsset.id IN PLACE.
  const matchingMats = new Set();
  worldRoot.traverse(n => {
    if (!n.isMesh || !n.material) return;
    const mats = Array.isArray(n.material) ? n.material : [n.material];
    for (const m of mats) {
      if (m.userData?.pbrBinding?.texId === texAsset.id) matchingMats.add(m);
    }
  });
  if (matchingMats.size === 0) return 0;

  for (const m of matchingMats) {
    const b = m.userData.pbrBinding;
    try {
      const [alb, nrm, rgh, ao] = await Promise.all([
        loadRepeatTexAsync(texAsset.albedo_url, b.repeat, b.repeatY, true),
        loadRepeatTexAsync(texAsset.normal_url, b.repeat, b.repeatY, false),
        loadRepeatTexAsync(texAsset.roughness_url, b.repeat, b.repeatY, false),
        texAsset.ao_url ? loadRepeatTexAsync(texAsset.ao_url, b.repeat, b.repeatY, false) : Promise.resolve(null),
      ]);
      m.map = alb;
      m.normalMap = nrm;
      m.normalScale = new THREE.Vector2(b.normalStrength, b.normalStrength);
      m.roughnessMap = rgh;
      if (ao) {
        m.aoMap = ao;
        m.aoMapIntensity = 0.75;
      }
      m.color.copy(new THREE.Color("#ffffff").lerp(b.baseColor, b.tintWeight));
      m.needsUpdate = true;
    } catch (e) {
      console.warn("In-place PBR upgrade failed for", texAsset.id, e);
    }
  }
  return matchingMats.size;
}

function ensureUV2ForAO(mesh) {
  const geo = mesh.geometry;
  if (geo && geo.attributes.uv && !geo.attributes.uv2) {
    geo.setAttribute("uv2", geo.attributes.uv);
  }
}

function enableShadows(root) {
  root.traverse(n => {
    if (n.isMesh && !n.userData.isContactAO) {
      n.castShadow = true;
      n.receiveShadow = true;
      ensureUV2ForAO(n);
    }
  });
  return root;
}

function buildSpaceBackdrop() {
  const g = new THREE.Group();
  // Crisp procedural 3D Starfield sphere outside the ship viewport
  const count = 1400;
  const pos = new Float32Array(count * 3);
  const cols = new Float32Array(count * 3);
  const rng = seededRand(777);
  const cTmp = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const u = rng(), v = rng();
    const theta = u * Math.PI * 2;
    const phi = Math.acos(2 * v - 1);
    const r = 95 + rng() * 60;
    pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    pos[i * 3 + 1] = r * Math.cos(phi);
    pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    const tint = rng();
    cTmp.set(tint < 0.25 ? "#9fd4ff" : tint < 0.45 ? "#ffdcb2" : "#ffffff");
    cols[i * 3] = cTmp.r; cols[i * 3 + 1] = cTmp.g; cols[i * 3 + 2] = cTmp.b;
  }
  const sGeo = new THREE.BufferGeometry();
  sGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  sGeo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
  const stars = new THREE.Points(sGeo, new THREE.PointsMaterial({ size: 0.72, vertexColors: true, transparent: true, opacity: 0.95 }));
  g.add(stars);

  // Distant ringed alien gas giant & glowing nebula visible straight through the forward bridge viewport (-Z)
  const planet = new THREE.Mesh(
    new THREE.SphereGeometry(11.5, 28, 22),
    new THREE.MeshStandardMaterial({ color: "#4d78b8", emissive: "#1c3663", emissiveIntensity: 0.55, roughness: 0.72 })
  );
  planet.position.set(-14, 10, -78);
  g.add(planet);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(15.0, 22.5, 48),
    new THREE.MeshBasicMaterial({ color: "#88c6f2", side: THREE.DoubleSide, transparent: true, opacity: 0.42 })
  );
  ring.position.copy(planet.position);
  ring.rotation.set(1.22, 0.25, -0.35);
  g.add(ring);

  const nebGlow = new THREE.Mesh(
    new THREE.SphereGeometry(26, 18, 14),
    new THREE.MeshBasicMaterial({ color: "#6d3bb5", transparent: true, opacity: 0.14, side: THREE.BackSide, depthWrite: false })
  );
  nebGlow.position.set(22, 6, -86);
  g.add(nebGlow);

  return g;
}

function buildArchitecturalEnclosure(terrain, texturesDict) {
  const enc = terrain.enclosure || "open_sky";
  if (enc === "open_sky") return null;
  const g = new THREE.Group();
  const [W, H, D] = terrain.enclosure_size || [24, 8.5, 28];
  const baseCol = terrain.enclosure_color || "#1e2633";
  const accentCol = terrain.enclosure_accent || "#38e8ff";

  const isSciFi = enc === "space_bridge" || enc === "sci_fi_corridor";
  const wallMat = createPBRMaterial(
    { color: baseCol, roughness: isSciFi ? 0.36 : 0.82, metalness: isSciFi ? 0.78 : 0.05, texture_id: terrain.texture_id },
    texturesDict,
    { repeat: 3.0, tintWeight: isSciFi ? 0.55 : 0.35 }
  );
  const trimMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(baseCol).offsetHSL(0, 0, isSciFi ? 0.08 : -0.06),
    roughness: isSciFi ? 0.28 : 0.75,
    metalness: isSciFi ? 0.85 : 0.15,
  });
  const glowMat = new THREE.MeshStandardMaterial({
    color: accentCol,
    emissive: new THREE.Color(accentCol),
    emissiveIntensity: 2.6,
    roughness: 0.2,
  });

  if (isSciFi) {
    // Side angled bulkheads (left & right)
    for (const sx of [-1, 1]) {
      const lowerWall = new THREE.Mesh(new THREE.BoxGeometry(0.65, H * 0.56, D), wallMat);
      lowerWall.position.set(sx * (W * 0.5), H * 0.28, 0);
      lowerWall.receiveShadow = true;
      g.add(lowerWall);

      const upperCant = new THREE.Mesh(new THREE.BoxGeometry(0.65, H * 0.55, D), wallMat);
      upperCant.position.set(sx * (W * 0.44), H * 0.76, 0);
      upperCant.rotation.z = sx * 0.32;
      g.add(upperCant);

      // Recessed luminous sci-fi trim strip along lower deck & mid-wall
      const stripLow = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.10, D - 1.5), glowMat);
      stripLow.position.set(sx * (W * 0.5 - 0.36), 0.18, 0);
      g.add(stripLow);

      const stripMid = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.14, D - 2.0), glowMat);
      stripMid.position.set(sx * (W * 0.5 - 0.36), H * 0.48, 0);
      g.add(stripMid);
    }

    // Ceiling deck + ribbed structural hull arch frames
    const ceiling = new THREE.Mesh(new THREE.BoxGeometry(W * 0.92, 0.55, D), wallMat);
    ceiling.position.set(0, H, 0);
    g.add(ceiling);

    const nRibs = 6;
    for (let i = 0; i < nRibs; i++) {
      const rz = -D * 0.44 + (i / (nRibs - 1)) * (D * 0.88);
      const topBeam = new THREE.Mesh(new THREE.BoxGeometry(W * 0.88, 0.42, 0.52), trimMat);
      topBeam.position.set(0, H - 0.32, rz);
      g.add(topBeam);
      for (const sx of [-1, 1]) {
        const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.55, H, 0.56), trimMat);
        pillar.position.set(sx * (W * 0.48), H * 0.5, rz);
        g.add(pillar);
      }
      // Overhead light bar on every other rib
      if (i % 2 === 0) {
        const lBar = new THREE.Mesh(new THREE.BoxGeometry(W * 0.42, 0.12, 0.22), glowMat);
        lBar.position.set(0, H - 0.56, rz);
        g.add(lBar);
        const pl = new THREE.PointLight(accentCol, 14.0, 22.0, 1.5);
        pl.position.set(0, H - 1.1, rz);
        g.add(pl);
      }
    }

    // Rear bulkhead wall (+Z) with framed blast doorway
    const backWall = new THREE.Mesh(new THREE.BoxGeometry(W, H, 0.65), wallMat);
    backWall.position.set(0, H * 0.5, D * 0.5);
    g.add(backWall);
    const doorFrame = new THREE.Mesh(new THREE.BoxGeometry(3.4, 3.8, 0.85), trimMat);
    doorFrame.position.set(0, 1.9, D * 0.5 - 0.1);
    g.add(doorFrame);
    const doorGlow = new THREE.Mesh(new THREE.BoxGeometry(3.5, 0.12, 0.92), glowMat);
    doorGlow.position.set(0, 3.82, D * 0.5 - 0.1);
    g.add(doorGlow);

    // Forward Panoramic Bridge Viewport (-Z): low sill + upper header + angled mullions + translucent glass!
    const sill = new THREE.Mesh(new THREE.BoxGeometry(W, H * 0.22, 0.75), wallMat);
    sill.position.set(0, H * 0.11, -D * 0.5);
    g.add(sill);
    const header = new THREE.Mesh(new THREE.BoxGeometry(W, H * 0.18, 0.75), wallMat);
    header.position.set(0, H * 0.91, -D * 0.5);
    g.add(header);
    for (const mx of [-W * 0.34, -W * 0.14, W * 0.14, W * 0.34]) {
      const mullion = new THREE.Mesh(new THREE.BoxGeometry(0.28, H * 0.68, 0.45), trimMat);
      mullion.position.set(mx, H * 0.52, -D * 0.5);
      g.add(mullion);
    }
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: "#88c8ff",
      roughness: 0.06,
      metalness: 0.1,
      transparent: true,
      opacity: 0.14,
      clearcoat: 1.0,
      depthWrite: false,
    });
    const viewportGlass = new THREE.Mesh(new THREE.PlaneGeometry(W * 0.94, H * 0.64), glassMat);
    viewportGlass.position.set(0, H * 0.52, -D * 0.5 + 0.12);
    g.add(viewportGlass);

    // Add real 3D deep-space stars & ringed planet outside the viewport!
    g.add(buildSpaceBackdrop());
    // Soft warm bridge deck key light
    const deckKey = new THREE.PointLight("#dcefff", 18.0, 28.0, 1.4);
    deckKey.position.set(0, H - 1.5, 0);
    g.add(deckKey);
    return g;
  }

  if (enc === "interior_room" || enc === "cathedral_hall") {
    // Full enclosed architectural room / hall with warm clerestory glow
    for (const sx of [-1, 1]) {
      const wMesh = new THREE.Mesh(new THREE.BoxGeometry(0.6, H, D), wallMat);
      wMesh.position.set(sx * W * 0.5, H * 0.5, 0);
      wMesh.receiveShadow = true;
      g.add(wMesh);
    }
    for (const sz of [-1, 1]) {
      const wMesh = new THREE.Mesh(new THREE.BoxGeometry(W, H, 0.6), wallMat);
      wMesh.position.set(0, H * 0.5, sz * D * 0.5);
      wMesh.receiveShadow = true;
      g.add(wMesh);
    }
    const ceil = new THREE.Mesh(new THREE.BoxGeometry(W, 0.5, D), trimMat);
    ceil.position.set(0, H, 0);
    g.add(ceil);
    for (let i = 0; i < 4; i++) {
      const rz = -D * 0.35 + (i / 3) * D * 0.7;
      const beam = new THREE.Mesh(new THREE.BoxGeometry(W - 0.5, 0.35, 0.38), trimMat);
      beam.position.set(0, H - 0.35, rz);
      g.add(beam);
      const pl = new THREE.PointLight("#ffe6c2", 18.0, 24.0, 1.4);
      pl.position.set(0, H - 1.2, rz);
      g.add(pl);
    }
    return g;
  }

  if (enc === "forest_canopy") {
    // Dense surrounding primeval forest perimeter trunks + dappled light shafts!
    const rng = seededRand(314);
    const trunkMat = new THREE.MeshStandardMaterial({ color: "#3d2c1e", roughness: 0.95, normalMap: getWoodNormalMap() });
    const leafMat = new THREE.MeshStandardMaterial({ color: "#203d22", roughness: 0.92, normalMap: getFoliageNormalMap() });
    const nPerim = 24;
    for (let i = 0; i < nPerim; i++) {
      const a = (i / nPerim) * Math.PI * 2 + (rng() - 0.5) * 0.14;
      const r = 21.0 + rng() * 9.0;
      const tx = Math.cos(a) * r;
      const tz = Math.sin(a) * r;
      const gy = sampleTerrainHeight(terrain, tx, tz);
      const th = 12.0 + rng() * 7.0;
      const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.62, th, 8), trunkMat);
      tr.position.set(tx, gy + th * 0.5, tz);
      g.add(tr);
      const crown = new THREE.Mesh(new THREE.DodecahedronGeometry(3.4 + rng() * 2.0, 1), leafMat);
      crown.scale.set(1.25, 0.8, 1.25);
      crown.position.set(tx, gy + th * 0.92, tz);
      g.add(crown);
    }
    // Soft translucent diagonal forest sunbeams
    const beamMat = new THREE.MeshBasicMaterial({
      color: "#fff4cf",
      transparent: true,
      opacity: 0.055,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    for (let i = 0; i < 4; i++) {
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 2.8, 18.0, 12, 1, true), beamMat);
      shaft.position.set(-6 + i * 4.5, 8.5, -5 + (i % 2) * 7.0);
      shaft.rotation.z = 0.28;
      shaft.rotation.x = 0.12;
      g.add(shaft);
    }
    return g;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Carrier 1: General Environment Floor / Heightfield Terrain + Enclosures + Water
// ---------------------------------------------------------------------------
export function buildTerrain(terrain, texturesDict) {
  const group = new THREE.Group();
  group.name = "terrain_group";

  const gkind = terrain.ground_kind || "outdoor_hills";
  const enc = terrain.enclosure || "open_sky";
  const isInterior = enc === "space_bridge" || enc === "sci_fi_corridor" || enc === "interior_room" || enc === "cathedral_hall";

  const encGroup = buildArchitecturalEnclosure(terrain, texturesDict);
  if (encGroup) group.add(encGroup);

  if (terrain.space_stars && enc === "open_sky") {
    group.add(buildSpaceBackdrop());
  }

  if (gkind !== "none") {
    const [eW, , eD] = terrain.enclosure_size || [24, 8.5, 28];
    const sizeX = isInterior ? eW : (terrain.size || 72);
    const sizeZ = isInterior ? eD : (terrain.size || 72);
    const segs = isInterior ? 16 : 120;
    const geo = new THREE.PlaneGeometry(sizeX, sizeZ, segs, segs);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const splatWeight = new Float32Array(pos.count);
    const cPlaza = new THREE.Color(terrain.ground_color || "#8a8275");
    const cHill = new THREE.Color(terrain.hill_color || "#4f6d3f");
    const cTmp = new THREE.Color();
    const pr = terrain.plaza_radius ?? 15.0;

    const hasDualTex = !isInterior && Boolean(
      terrain.texture_id && texturesDict[terrain.texture_id] && terrain.hill_texture_id && texturesDict[terrain.hill_texture_id]
    );

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = sampleTerrainHeight(terrain, x, z);
      pos.setY(i, y);

      const r = Math.hypot(x, z);
      let blend = 0.0;
      if (gkind === "forest_floor" || pr <= 0.1) {
        blend = 0.5 + 0.5 * Math.sin(x * 0.16) * Math.cos(z * 0.16);
      } else if (!isInterior && gkind === "outdoor_hills") {
        const wobble = Math.sin(Math.atan2(z, x) * 7.0) * 0.65 + Math.cos(x * 0.35) * 0.45;
        blend = smoothstep(pr * 0.80 + wobble, pr * 1.18 + wobble, r);
      }
      splatWeight[i] = blend;

      const micro = isInterior ? 1.0 : (0.93 + 0.07 * Math.sin(x * 0.85) * Math.cos(z * 0.85));
      if (hasDualTex) {
        const shade = (1.0 - 0.10 * blend) * micro;
        colors[i * 3] = shade;
        colors[i * 3 + 1] = shade;
        colors[i * 3 + 2] = shade;
      } else {
        cTmp.copy(cPlaza).lerp(cHill, isInterior ? 0.0 : blend).multiplyScalar(micro);
        colors[i * 3] = cTmp.r;
        colors[i * 3 + 1] = cTmp.g;
        colors[i * 3 + 2] = cTmp.b;
      }
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.setAttribute("aHillWeight", new THREE.BufferAttribute(splatWeight, 1));
    geo.setAttribute("uv2", geo.attributes.uv);
    geo.computeVertexNormals();

    const plazaTex = terrain.texture_id ? texturesDict[terrain.texture_id] : null;
    const hillTex = terrain.hill_texture_id ? texturesDict[terrain.hill_texture_id] : null;
    const rep = Math.max(4, Math.round(Math.max(sizeX, sizeZ) / 4.2));

    const matParams = {
      vertexColors: true,
      roughness: gkind === "interior_deck" ? 0.38 : 0.9,
      metalness: gkind === "interior_deck" ? 0.65 : 0.02,
      envMapIntensity: gkind === "interior_deck" ? 1.15 : 0.55,
    };
    if (plazaTex) {
      matParams.map = loadRepeatTex(plazaTex.albedo_url, rep, rep, true);
      matParams.normalMap = loadRepeatTex(plazaTex.normal_url, rep, rep, false);
      matParams.normalScale = new THREE.Vector2(1.15, 1.15);
      matParams.roughnessMap = loadRepeatTex(plazaTex.roughness_url, rep, rep, false);
      if (plazaTex.ao_url) {
        matParams.aoMap = loadRepeatTex(plazaTex.ao_url, rep, rep, false);
        matParams.aoMapIntensity = 0.8;
      }
    }
    const terrainMat = new THREE.MeshStandardMaterial(matParams);

    if (plazaTex && hillTex && !isInterior) {
      const hillAlb = loadRepeatTex(hillTex.albedo_url, Math.round(sizeX / 5.5), Math.round(sizeZ / 5.5), true);
      terrainMat.onBeforeCompile = shader => {
        shader.uniforms.uHillMap = { value: hillAlb };
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", "#include <common>\nattribute float aHillWeight;\nvarying float vHillW;\nvarying vec2 vWorldXZ;")
          .replace("#include <begin_vertex>", "#include <begin_vertex>\nvHillW = aHillWeight;\nvWorldXZ = position.xz;");
        shader.fragmentShader = shader.fragmentShader
          .replace("#include <common>", "#include <common>\nuniform sampler2D uHillMap;\nvarying float vHillW;\nvarying vec2 vWorldXZ;")
          .replace(
            "#include <map_fragment>",
            `#include <map_fragment>
             vec4 hillSample = texture2D(uHillMap, vWorldXZ * 0.14);
             diffuseColor.rgb = mix(diffuseColor.rgb, hillSample.rgb, clamp(vHillW, 0.0, 1.0));`
          );
      };
    }

    const mesh = new THREE.Mesh(geo, terrainMat);
    mesh.receiveShadow = true;
    group.add(mesh);

    // ONLY build cobblestone plaza curbs for actual outdoor cobblestone plazas with plaza_radius >= 6m!
    if (!isInterior && gkind === "outdoor_hills" && terrain.style === "cobblestone_plaza" && pr >= 6.0) {
      const curbMat = plazaTex
        ? createPBRMaterial({ color: "#b7ab98", roughness: 0.88, texture_id: terrain.texture_id }, texturesDict, { repeat: 0.8, tintWeight: 0.35 })
        : new THREE.MeshStandardMaterial({ color: "#a59b8b", roughness: 0.9 });
      const nCurbs = 44;
      const curbR = pr * 0.82;
      const segLen = (2 * Math.PI * curbR) / nCurbs * 0.94;
      for (let i = 0; i < nCurbs; i++) {
        const a = (i / nCurbs) * Math.PI * 2;
        const blk = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.18, segLen), curbMat);
        blk.position.set(Math.cos(a) * curbR, 0.06, Math.sin(a) * curbR);
        blk.rotation.y = -a;
        blk.receiveShadow = true;
        blk.castShadow = true;
        group.add(blk);
      }
    }
  }

  // Animated normal-mapped reflective water plane
  let waterMesh = null;
  if (terrain.has_water && !isInterior) {
    const size = terrain.size || 72;
    const wGeo = new THREE.PlaneGeometry(size * 1.25, size * 1.25, 48, 48);
    wGeo.rotateX(-Math.PI / 2);
    const wNorm = getWaterNormalMap().clone();
    wNorm.needsUpdate = true;
    wNorm.repeat.set(14, 14);
    const wMat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(terrain.water_color || "#1e5e7e"),
      roughness: 0.07,
      metalness: 0.12,
      normalMap: wNorm,
      normalScale: new THREE.Vector2(0.45, 0.45),
      reflectivity: 0.95,
      clearcoat: 1.0,
      clearcoatRoughness: 0.06,
      transparent: true,
      opacity: 0.9,
      envMapIntensity: 1.45,
    });
    waterMesh = new THREE.Mesh(wGeo, wMat);
    waterMesh.position.y = terrain.water_level ?? -0.4;
    waterMesh.receiveShadow = true;
    group.add(waterMesh);
    group.userData.waterNormalTex = wNorm;
  }

  group.userData.waterMesh = waterMesh;
  return group;
}

// ---------------------------------------------------------------------------
// Carrier 2: Parametric Multi-Part 3D Assemblies (Upgraded PBR + Micro-Detail)
// ---------------------------------------------------------------------------
function addWindowGrid(group, w, h, d, floors, frameMat, glassMat, shutterMat, stoneMat) {
  const floorH = h / floors;
  const colsFront = Math.max(2, Math.min(4, Math.floor(w / 1.55)));
  const colsSide = Math.max(1, Math.min(3, Math.floor(d / 1.75)));

  function placeWindow(wx, wy, wz, rotY) {
    const wg = new THREE.Group();
    wg.position.set(wx, wy, wz);
    wg.rotation.y = rotY;
    // Recessed dark interior reveal + stone surround
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(0.96, 0.12, 0.20), stoneMat);
    lintel.position.set(0, 0.54, 0.04);
    wg.add(lintel);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.78, 1.02, 0.14), frameMat);
    wg.add(frame);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(0.60, 0.84, 0.15), glassMat);
    glass.position.z = 0.01;
    wg.add(glass);
    // Cross mullions
    wg.add(new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.86, 0.17), frameMat));
    wg.add(new THREE.Mesh(new THREE.BoxGeometry(0.60, 0.045, 0.17), frameMat));
    // Projecting weathered stone sill
    const sill = new THREE.Mesh(new THREE.BoxGeometry(0.94, 0.10, 0.24), stoneMat);
    sill.position.set(0, -0.54, 0.06);
    wg.add(sill);
    // Slightly angled louvered shutters for real 3D shadow relief!
    for (const sx of [-1, 1]) {
      const sh = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.96, 0.055), shutterMat);
      sh.position.set(sx * 0.49, 0, 0.07);
      sh.rotation.y = -sx * 0.16;
      wg.add(sh);
    }
    group.add(wg);
  }

  for (let f = 0; f < floors; f++) {
    const wy = 0.45 + f * floorH + floorH * 0.52;
    for (let c = 0; c < colsFront; c++) {
      const u = (c + 0.5) / colsFront - 0.5;
      const wx = u * (w - 0.95);
      if (!(f === 0 && Math.abs(wx) < 0.9)) placeWindow(wx, wy, d / 2 + 0.02, 0);
      placeWindow(wx, wy, -d / 2 - 0.02, Math.PI);
    }
    for (let c = 0; c < colsSide; c++) {
      const u = (c + 0.5) / colsSide - 0.5;
      const wz = u * (d - 0.95);
      placeWindow(w / 2 + 0.02, wy, wz, Math.PI / 2);
      placeWindow(-w / 2 - 0.02, wy, wz, -Math.PI / 2);
    }
  }
}

function buildRoofMaterial(obj, texturesDict) {
  const rTexId = obj.material.roof_texture_id || "roof_tiles_pbr";
  if (rTexId) {
    const mat = createPBRMaterial(obj.material, texturesDict, {
      textureIdOverride: rTexId,
      overrideColor: obj.material.secondary_color || "#9b4935",
      repeat: 2.0,
      roughness: 0.84,
      normalStrength: 1.45,
      tintWeight: 0.18,
      emissive: "#000000",
      emissiveIntensity: 0.0,
    });
    if (!texturesDict[rTexId]) {
      mat.normalMap = getWoodNormalMap();
      mat.normalScale = new THREE.Vector2(0.55, 0.55);
    }
    return mat;
  }
  return new THREE.MeshStandardMaterial({
    color: obj.material.secondary_color || "#8d4332",
    roughness: 0.82,
    normalMap: getWoodNormalMap(),
    normalScale: new THREE.Vector2(0.55, 0.55),
  });
}

function buildBuilding(obj, texturesDict, isNight) {
  const p = obj.parametric;
  const g = new THREE.Group();
  const w = p.width || 4.8;
  const h = p.height || 5.2;
  const d = p.depth || 4.2;
  const floors = Math.max(1, p.floors || 2);

  addContactAO(g, w * 0.58, d * 0.58, 0.72);

  const wallMat = createPBRMaterial(obj.material, texturesDict, {
    repeat: 2.2,
    emissive: "#000000",
    emissiveIntensity: 0.0,
    normalStrength: 1.15,
  });
  const plinthMat = createPBRMaterial(obj.material, texturesDict, {
    overrideColor: "#797268",
    repeat: 1.6,
    roughness: 0.92,
    tintWeight: 0.55,
    emissive: "#000000",
    emissiveIntensity: 0.0,
  });
  const roofMat = buildRoofMaterial(obj, texturesDict);
  const woodNrm = getWoodNormalMap();
  const frameMat = new THREE.MeshStandardMaterial({ color: "#443122", roughness: 0.84, normalMap: woodNrm, normalScale: new THREE.Vector2(0.6, 0.6) });
  const shutterMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(obj.material.secondary_color || "#3f5f4e").offsetHSL(0.05, -0.06, -0.08),
    roughness: 0.82,
    normalMap: woodNrm,
    normalScale: new THREE.Vector2(0.7, 0.7),
  });

  // Realistic daytime dark reflective glass -> warm glowing amber windows at dusk/night!
  const glowInt = isNight ? Math.max(obj.material.emissive_intensity || 0, 2.0) : 0.12;
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: isNight ? "#5c4a32" : "#22303f",
    emissive: new THREE.Color(obj.material.accent_color || "#ffc468"),
    emissiveIntensity: p.light_on ? glowInt : 0.03,
    roughness: 0.10,
    metalness: 0.42,
    clearcoat: 0.9,
    envMapIntensity: 1.35,
  });

  // Foundation stone plinth + chamfered base ledge
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(w + 0.30, 0.48, d + 0.30), plinthMat);
  plinth.position.y = 0.24;
  g.add(plinth);

  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
  body.position.y = 0.46 + h / 2;
  g.add(body);

  // Corner stone quoins
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const pil = new THREE.Mesh(new THREE.BoxGeometry(0.28, h + 0.06, 0.28), plinthMat);
      pil.position.set(sx * (w / 2 - 0.03), 0.46 + h / 2, sz * (d / 2 - 0.03));
      g.add(pil);
    }
  }

  // Moulded cornice & eaves rafters under overhang
  const cornice = new THREE.Mesh(new THREE.BoxGeometry(w + 0.38, 0.22, d + 0.38), plinthMat);
  cornice.position.y = 0.46 + h;
  g.add(cornice);

  // Recessed front doorway + stone architrave + entry steps
  const doorGroup = new THREE.Group();
  doorGroup.position.set(0, 0.46, d / 2 + 0.02);
  const surround = new THREE.Mesh(new THREE.BoxGeometry(1.42, 2.2, 0.20), plinthMat);
  surround.position.y = 1.1;
  doorGroup.add(surround);
  const doorLeaf = new THREE.Mesh(new THREE.BoxGeometry(1.06, 1.94, 0.23), frameMat);
  doorLeaf.position.y = 0.97;
  doorGroup.add(doorLeaf);
  const lintelTop = new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.16, 0.28), plinthMat);
  lintelTop.position.set(0, 2.24, 0.04);
  doorGroup.add(lintelTop);
  const step1 = new THREE.Mesh(new THREE.BoxGeometry(1.65, 0.22, 0.56), plinthMat);
  step1.position.set(0, -0.11, 0.26);
  doorGroup.add(step1);
  const step2 = new THREE.Mesh(new THREE.BoxGeometry(1.92, 0.22, 0.86), plinthMat);
  step2.position.set(0, -0.33, 0.40);
  doorGroup.add(step2);
  g.add(doorGroup);

  addWindowGrid(g, w, h, d, floors, frameMat, glassMat, shutterMat, plinthMat);

  if (p.has_balcony && floors >= 2) {
    const by = 0.46 + h / floors;
    const slab = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.16, 0.98), plinthMat);
    slab.position.set(0, by, d / 2 + 0.48);
    g.add(slab);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(2.24, 0.08, 0.08), frameMat);
    rail.position.set(0, by + 0.8, d / 2 + 0.92);
    g.add(rail);
    for (let rx = -0.98; rx <= 0.99; rx += 0.28) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.76, 0.055), frameMat);
      post.position.set(rx, by + 0.4, d / 2 + 0.92);
      g.add(post);
    }
  }

  // Roof geometry with proper UV-mapped roof tiles + wooden rafters under eaves!
  const roofBaseY = 0.46 + h + 0.08;
  const roofH = Math.min(3.3, Math.max(1.5, Math.min(w, d) * 0.48));
  if (p.roof_style === "gable") {
    // Gable end masonry triangles
    const gableShape = new THREE.Shape();
    gableShape.moveTo(-w / 2, 0);
    gableShape.lineTo(w / 2, 0);
    gableShape.lineTo(0, roofH - 0.08);
    gableShape.closePath();
    const gableGeo = new THREE.ExtrudeGeometry(gableShape, { depth: d - 0.04, bevelEnabled: false });
    gableGeo.translate(0, 0, -(d - 0.04) / 2);
    const gableWall = new THREE.Mesh(gableGeo, wallMat);
    gableWall.position.y = roofBaseY;
    g.add(gableWall);

    // Two pitched overhanging roof slabs with clean planar UVs so terracotta tiles orient realistically!
    const halfSpan = w / 2 + 0.48;
    const slopeLen = Math.hypot(halfSpan, roofH);
    const slopeAng = Math.atan2(roofH, halfSpan);
    for (const side of [-1, 1]) {
      const slab = new THREE.Mesh(new THREE.BoxGeometry(slopeLen, 0.16, d + 0.86), roofMat);
      slab.position.set(side * halfSpan * 0.5, roofBaseY + roofH * 0.5 + 0.04, 0);
      slab.rotation.z = -side * slopeAng;
      g.add(slab);
    }
    // Exposed wooden eaves rafters
    const nRafters = Math.max(5, Math.round(d * 1.4));
    for (let i = 0; i < nRafters; i++) {
      const rz = -d / 2 - 0.25 + (i / (nRafters - 1)) * (d + 0.5);
      const beam = new THREE.Mesh(new THREE.BoxGeometry(w + 0.85, 0.09, 0.09), frameMat);
      beam.position.set(0, roofBaseY - 0.02, rz);
      g.add(beam);
    }
    // Rounded terracotta ridge cap
    const ridge = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, d + 0.92, 8), roofMat);
    ridge.rotation.x = Math.PI / 2;
    ridge.position.set(0, roofBaseY + roofH + 0.08, 0);
    g.add(ridge);
  } else if (p.roof_style === "hip") {
    const pyr = new THREE.Mesh(new THREE.ConeGeometry(Math.hypot(w, d) * 0.58, roofH, 4), roofMat);
    pyr.rotation.y = Math.PI / 4;
    pyr.scale.set(w / Math.max(d, 0.1), 1, 1);
    pyr.position.y = roofBaseY + roofH / 2;
    g.add(pyr);
  } else if (p.roof_style === "dome") {
    const dome = new THREE.Mesh(new THREE.SphereGeometry(Math.min(w, d) * 0.46, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), roofMat);
    dome.position.y = roofBaseY;
    g.add(dome);
  } else {
    const par = new THREE.Mesh(new THREE.BoxGeometry(w + 0.22, 0.45, d + 0.22), plinthMat);
    par.position.y = roofBaseY + 0.2;
    g.add(par);
  }

  if (p.has_chimney) {
    const ch = new THREE.Mesh(new THREE.BoxGeometry(0.64, roofH + 0.95, 0.64), plinthMat);
    ch.position.set(w * 0.28, roofBaseY + (roofH + 0.95) * 0.45, -d * 0.18);
    g.add(ch);
    const chCap = new THREE.Mesh(new THREE.BoxGeometry(0.80, 0.12, 0.80), roofMat);
    chCap.position.set(w * 0.28, roofBaseY + (roofH + 0.95) * 0.93, -d * 0.18);
    g.add(chCap);
  }

  g.userData.windowGlassMat = glassMat;
  return enableShadows(g);
}

function buildTower(obj, texturesDict, isNight) {
  const p = obj.parametric;
  const g = new THREE.Group();
  const w = Math.min(5.0, Math.max(2.6, p.width || 3.4));
  const h = Math.max(7.5, p.height || 11.0);

  addContactAO(g, w * 0.68, w * 0.68, 0.78);

  const wallMat = createPBRMaterial(obj.material, texturesDict, {
    repeat: 2.5,
    emissive: "#000000",
    emissiveIntensity: 0.0,
    normalStrength: 1.2,
  });
  const trimMat = createPBRMaterial(obj.material, texturesDict, {
    overrideColor: "#7e7569",
    repeat: 1.6,
    roughness: 0.9,
    tintWeight: 0.55,
    emissive: "#000000",
    emissiveIntensity: 0.0,
  });
  const roofMat = buildRoofMaterial(obj, texturesDict);
  const dialMat = new THREE.MeshStandardMaterial({
    color: "#f5eedc",
    emissive: new THREE.Color(obj.material.accent_color || "#ffd790"),
    emissiveIntensity: isNight ? Math.max(obj.material.emissive_intensity || 0, 1.45) : 0.18,
    roughness: 0.35,
  });
  const handMat = new THREE.MeshStandardMaterial({ color: "#1c1c20", roughness: 0.28, metalness: 0.78 });

  const base = new THREE.Mesh(new THREE.BoxGeometry(w + 0.75, 1.35, w + 0.75), trimMat);
  base.position.y = 0.675;
  g.add(base);

  const shaftH = h * 0.68;
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(w, shaftH, w), wallMat);
  shaft.position.y = 1.35 + shaftH / 2;
  g.add(shaft);

  for (const frac of [0.35, 0.72, 1.0]) {
    const belt = new THREE.Mesh(new THREE.BoxGeometry(w + 0.36, 0.24, w + 0.36), trimMat);
    belt.position.y = 1.35 + shaftH * frac;
    g.add(belt);
  }

  const clockY = 1.35 + shaftH * 0.78;
  const clockHands = [];
  for (let side = 0; side < 4; side++) {
    const cg = new THREE.Group();
    const ang = side * (Math.PI / 2);
    cg.position.set(Math.sin(ang) * (w / 2 + 0.06), clockY, Math.cos(ang) * (w / 2 + 0.06));
    cg.rotation.y = ang;
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.30, w * 0.30, 0.12, 24), trimMat);
    rim.rotation.x = Math.PI / 2;
    cg.add(rim);
    const face = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.24, w * 0.24, 0.14, 24), dialMat);
    face.rotation.x = Math.PI / 2;
    cg.add(face);
    // Hour markers around clock dial
    for (let hr = 0; hr < 12; hr++) {
      const ha = (hr / 12) * Math.PI * 2;
      const tick = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.09, 0.03), handMat);
      tick.position.set(Math.sin(ha) * w * 0.19, Math.cos(ha) * w * 0.19, 0.08);
      tick.rotation.z = -ha;
      cg.add(tick);
    }
    const minHand = new THREE.Mesh(new THREE.BoxGeometry(0.05, w * 0.18, 0.04), handMat);
    minHand.position.set(0, w * 0.08, 0.09);
    const pivot = new THREE.Group();
    pivot.add(minHand);
    cg.add(pivot);
    clockHands.push(pivot);
    g.add(cg);
  }

  const belfryY = 1.35 + shaftH;
  const belfryH = h * 0.2;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const col = new THREE.Mesh(new THREE.BoxGeometry(0.44, belfryH, 0.44), trimMat);
      col.position.set(sx * (w * 0.38), belfryY + belfryH / 2, sz * (w * 0.38));
      g.add(col);
    }
  }
  const bellMat = new THREE.MeshStandardMaterial({ color: "#b68c43", roughness: 0.32, metalness: 0.82 });
  const bell = new THREE.Mesh(new THREE.ConeGeometry(w * 0.16, belfryH * 0.48, 16), bellMat);
  bell.position.y = belfryY + belfryH * 0.56;
  g.add(bell);

  const spireH = h * 0.34;
  const spire = new THREE.Mesh(new THREE.ConeGeometry(w * 0.80, spireH, 4), roofMat);
  spire.rotation.y = Math.PI / 4;
  spire.position.y = belfryY + belfryH + spireH / 2;
  g.add(spire);
  const finial = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 12), bellMat);
  finial.position.y = belfryY + belfryH + spireH + 0.12;
  g.add(finial);

  g.userData.clockHands = clockHands;
  g.userData.windowGlassMat = dialMat;
  return enableShadows(g);
}

function buildFountain(obj, texturesDict) {
  const p = obj.parametric;
  const g = new THREE.Group();
  const r = Math.max(1.8, (p.width || 4.2) * 0.5);

  addContactAO(g, r * 1.25, r * 1.25, 0.72);

  const stoneMat = createPBRMaterial(obj.material, texturesDict, {
    repeat: 2.2,
    roughness: 0.78,
    normalStrength: 1.25,
    tintWeight: 0.25,
  });
  const darkStone = createPBRMaterial(obj.material, texturesDict, {
    overrideColor: "#6d675f",
    repeat: 1.6,
    roughness: 0.88,
    tintWeight: 0.55,
  });

  // Animated sparkling normal-mapped water pool!
  const wNorm = getWaterNormalMap().clone();
  wNorm.needsUpdate = true;
  wNorm.repeat.set(2.5, 2.5);
  const waterMat = new THREE.MeshPhysicalMaterial({
    color: "#1b6b88",
    roughness: 0.05,
    metalness: 0.12,
    normalMap: wNorm,
    normalScale: new THREE.Vector2(0.55, 0.55),
    clearcoat: 1.0,
    clearcoatRoughness: 0.05,
    transparent: true,
    opacity: 0.88,
    envMapIntensity: 1.65,
  });

  const step = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.16, r * 1.24, 0.24, 8), darkStone);
  step.position.y = 0.12;
  g.add(step);

  // Carved hollow rim: outer wall + inner dark floor + coping lip
  const outerRim = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.04, 0.78, 8), stoneMat);
  outerRim.position.y = 0.62;
  g.add(outerRim);
  const coping = new THREE.Mesh(new THREE.TorusGeometry(r * 0.94, 0.14, 8, 8), stoneMat);
  coping.rotation.x = Math.PI / 2;
  coping.rotation.z = Math.PI / 8;
  coping.position.y = 1.02;
  g.add(coping);

  const pool = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.86, r * 0.86, 0.14, 24), waterMat);
  pool.position.y = 0.96;
  g.add(pool);

  const col = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.17, r * 0.28, 2.35, 14), stoneMat);
  col.position.y = 1.62;
  g.add(col);
  const bowl1 = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.52, r * 0.20, 0.34, 18), stoneMat);
  bowl1.position.y = 1.98;
  g.add(bowl1);
  const bowl2 = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.30, r * 0.13, 0.26, 16), stoneMat);
  bowl2.position.y = 2.74;
  g.add(bowl2);
  const nozzle = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10), stoneMat);
  nozzle.position.y = 3.0;
  g.add(nozzle);

  // Live animated 3D parabolic water-jet droplets
  const drops = [];
  const dropGeo = new THREE.SphereGeometry(0.055, 7, 7);
  const dropMat = new THREE.MeshPhysicalMaterial({
    color: "#daf6ff",
    emissive: "#50a8c8",
    emissiveIntensity: 0.18,
    roughness: 0.04,
    clearcoat: 1.0,
    transparent: true,
    opacity: 0.84,
  });
  const jets = 8;
  const perJet = 8;
  for (let j = 0; j < jets; j++) {
    const ang = (j / jets) * Math.PI * 2;
    for (let k = 0; k < perJet; k++) {
      const m = new THREE.Mesh(dropGeo, dropMat);
      m.userData = { ang, phase: k / perJet, radius: r * 0.65, topY: 3.05, poolY: 1.02 };
      g.add(m);
      drops.push(m);
    }
  }
  g.userData.waterDrops = drops;
  g.userData.waterNormalTex = wNorm;
  return enableShadows(g);
}

function buildTree(obj) {
  const p = obj.parametric;
  const g = new THREE.Group();
  const rng = seededRand(p.seed || 42);
  const h = Math.max(2.8, p.height || 5.6);
  const style = p.tree_style || "oak";

  addContactAO(g, h * 0.24, h * 0.24, 0.62);

  const barkMat = new THREE.MeshStandardMaterial({
    color: obj.material.secondary_color || "#533d2b",
    roughness: 0.94,
    normalMap: getWoodNormalMap(),
    normalScale: new THREE.Vector2(1.4, 1.4),
  });
  const baseLeaf = new THREE.Color(
    obj.material.color || (style === "blossom" ? "#f4a7be" : style === "pine" ? "#264932" : "#3a6230")
  );
  const foliageNrm = getFoliageNormalMap();
  const canopyGroup = new THREE.Group();

  function makeLeafMat(hOff, sOff, lOff) {
    return new THREE.MeshStandardMaterial({
      color: baseLeaf.clone().offsetHSL(hOff, sOff, lOff),
      roughness: 0.88,
      metalness: 0.0,
      normalMap: foliageNrm,
      normalScale: new THREE.Vector2(1.35, 1.35),
      envMapIntensity: 0.45,
    });
  }

  if (style === "pine") {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.34, h * 0.44, 9), barkMat);
    trunk.position.y = h * 0.22;
    g.add(trunk);
    const tiers = 7;
    for (let i = 0; i < tiers; i++) {
      const frac = i / (tiers - 1);
      const rad = (1.6 - frac * 1.12) * (h / 5.5);
      const boughs = 5 + (tiers - i);
      const ty = h * 0.28 + frac * h * 0.68;
      const mat = makeLeafMat((rng() - 0.5) * 0.03, 0, (frac - 0.35) * 0.09);
      for (let b = 0; b < boughs; b++) {
        const ang = (b / boughs) * Math.PI * 2 + i * 0.6;
        const puff = new THREE.Mesh(new THREE.DodecahedronGeometry(Math.max(0.22, rad * 0.42), 1), mat);
        puff.scale.set(1.25, 0.65, 0.95);
        puff.position.set(Math.cos(ang) * rad * 0.45, ty + (rng() - 0.5) * 0.16, Math.sin(ang) * rad * 0.45);
        puff.rotation.set((rng() - 0.5) * 0.4, ang, 0.28);
        canopyGroup.add(puff);
      }
    }
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.35, 1.0, 7), makeLeafMat(0, 0, 0.06));
    tip.position.y = h * 0.97;
    canopyGroup.add(tip);
  } else if (style === "cypress") {
    // Organic multi-cluster Mediterranean cypress (replaces smooth Play-Doh ovals!)
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.28, h * 0.30, 8), barkMat);
    trunk.position.y = h * 0.15;
    g.add(trunk);

    const layers = 10;
    for (let i = 0; i < layers; i++) {
      const frac = i / (layers - 1);
      const envRad = Math.pow(Math.sin(frac * Math.PI * 0.88 + 0.18), 0.75) * 0.68 * (h / 6.0);
      const ly = h * 0.20 + frac * h * 0.76;
      const subClusters = i === layers - 1 ? 1 : 4;
      for (let k = 0; k < subClusters; k++) {
        const ang = (k / subClusters) * Math.PI * 2 + i * 0.95 + rng() * 0.35;
        const rOff = subClusters === 1 ? 0 : envRad * (0.42 + rng() * 0.22);
        const cRad = Math.max(0.18, envRad * (0.58 + rng() * 0.22));
        // Sunlit outer/upper tips vs deeper shaded foliage core!
        const lShift = (frac - 0.45) * 0.09 + (k % 2 === 0 ? 0.03 : -0.04);
        const cluster = new THREE.Mesh(
          new THREE.IcosahedronGeometry(cRad, 1),
          makeLeafMat((rng() - 0.5) * 0.03, (rng() - 0.5) * 0.06, lShift)
        );
        cluster.scale.set(0.9 + rng() * 0.25, 1.35 + rng() * 0.35, 0.9 + rng() * 0.25);
        cluster.position.set(Math.cos(ang) * rOff, ly + (rng() - 0.5) * 0.18, Math.sin(ang) * rOff);
        cluster.rotation.set(rng() * 0.5, rng() * Math.PI, rng() * 0.5);
        canopyGroup.add(cluster);
      }
    }
  } else {
    // Rich branching oak / blossom with dense multi-scale clustered foliage
    const trunkH = h * 0.5;
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.38, trunkH, 9), barkMat);
    trunk.position.y = trunkH / 2;
    g.add(trunk);

    const nBranches = 5 + Math.floor(rng() * 2);
    for (let b = 0; b < nBranches; b++) {
      const ang = (b / nBranches) * Math.PI * 2 + rng() * 0.4;
      const tilt = 0.42 + rng() * 0.35;
      const bLen = h * (0.28 + rng() * 0.14);
      const br = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.14, bLen, 7), barkMat);
      br.position.set(Math.cos(ang) * bLen * 0.32, trunkH * 0.82 + bLen * 0.32, Math.sin(ang) * bLen * 0.32);
      br.rotation.z = -Math.cos(ang) * tilt;
      br.rotation.x = Math.sin(ang) * tilt;
      g.add(br);

      const bx = Math.cos(ang) * bLen * 0.72;
      const by = trunkH * 0.90 + bLen * 0.55;
      const bz = Math.sin(ang) * bLen * 0.72;
      for (let sub = 0; sub < 3; sub++) {
        const sa = sub * 2.1 + rng();
        const clRad = h * (0.14 + rng() * 0.08);
        const cl = new THREE.Mesh(
          new THREE.IcosahedronGeometry(clRad, 1),
          makeLeafMat((rng() - 0.5) * 0.04, 0, (sub - 1) * 0.045)
        );
        cl.scale.set(1.15, 0.82, 1.1);
        cl.position.set(bx + Math.cos(sa) * clRad * 0.65, by + (sub - 1) * 0.22, bz + Math.sin(sa) * clRad * 0.65);
        canopyGroup.add(cl);
      }
    }
    const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(h * 0.24, 1), makeLeafMat(0, 0, 0.05));
    crown.scale.set(1.2, 0.85, 1.15);
    crown.position.set(0, trunkH + h * 0.30, 0);
    canopyGroup.add(crown);
  }

  g.add(canopyGroup);
  g.userData.swayGroup = canopyGroup;
  g.userData.swayPhase = (p.seed || 42) * 0.7;
  return enableShadows(g);
}

function buildArchway(obj, texturesDict) {
  const p = obj.parametric;
  const g = new THREE.Group();
  const w = Math.max(3.6, p.width || 5.4);
  const h = Math.max(3.6, p.height || 5.0);
  const d = Math.max(1.0, p.depth || 1.6);
  const mat = createPBRMaterial(obj.material, texturesDict, { repeat: 2.0, normalStrength: 1.2 });
  const trim = createPBRMaterial(obj.material, texturesDict, { overrideColor: obj.material.secondary_color || "#8d8272", repeat: 1.5, tintWeight: 0.5 });

  const pierW = w * 0.22;
  const span = w - pierW * 2;
  const pierH = h * 0.58;

  for (const sx of [-1, 1]) {
    const px = sx * (span / 2 + pierW / 2);
    const base = new THREE.Mesh(new THREE.BoxGeometry(pierW + 0.28, 0.46, d + 0.28), trim);
    base.position.set(px, 0.23, 0);
    g.add(base);
    const pier = new THREE.Mesh(new THREE.BoxGeometry(pierW, pierH, d), mat);
    pier.position.set(px, pierH / 2, 0);
    g.add(pier);
  }
  addContactAO(g, w * 0.55, d * 0.72, 0.65);

  const rInner = span / 2;
  const nBlocks = 11;
  const archThick = Math.max(0.55, pierW * 0.85);
  for (let i = 0; i < nBlocks; i++) {
    const ang = (Math.PI * (i + 0.5)) / nBlocks;
    const isKey = i === Math.floor(nBlocks / 2);
    const blk = new THREE.Mesh(
      new THREE.BoxGeometry(archThick * (isKey ? 1.18 : 1.0), ((Math.PI * (rInner + archThick * 0.5)) / nBlocks) * 1.12, d * (isKey ? 1.08 : 1.0)),
      isKey ? trim : mat
    );
    const rMid = rInner + archThick * 0.5;
    blk.position.set(Math.cos(ang) * rMid, pierH + Math.sin(ang) * rMid, 0);
    blk.rotation.z = ang;
    g.add(blk);
  }

  const topY = pierH + rInner + archThick + 0.2;
  const ent = new THREE.Mesh(new THREE.BoxGeometry(w + 0.48, 0.42, d + 0.36), trim);
  ent.position.y = topY;
  g.add(ent);
  return enableShadows(g);
}

function buildLampPost(obj, isNight) {
  const p = obj.parametric;
  const g = new THREE.Group();
  const h = Math.max(2.6, p.height || 3.8);
  addContactAO(g, 0.55, 0.55, 0.55);

  const iron = new THREE.MeshStandardMaterial({ color: obj.material.color || "#22262c", roughness: 0.38, metalness: 0.82 });
  const glow = new THREE.MeshStandardMaterial({
    color: "#fff5d6",
    emissive: new THREE.Color(obj.material.accent_color || "#ffbe55"),
    emissiveIntensity: p.light_on ? (isNight ? 3.2 : 0.75) : 0.0,
    roughness: 0.18,
  });

  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.28, 0.65, 8), iron);
  base.position.y = 0.325;
  g.add(base);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.11, h - 0.65, 8), iron);
  pole.position.y = 0.65 + (h - 0.65) / 2;
  g.add(pole);
  const lantern = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.16, 0.48, 6), glow);
  lantern.position.y = h + 0.18;
  g.add(lantern);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.26, 6), iron);
  cap.position.y = h + 0.52;
  g.add(cap);

  if (p.light_on) {
    const pl = new THREE.PointLight(obj.material.accent_color || "#ffbe55", isNight ? 20 : 2.5, 16, 1.7);
    pl.position.set(0, h + 0.15, 0);
    g.add(pl);
    g.userData.lampLight = pl;
  }
  g.userData.lampGlowMat = glow;
  return enableShadows(g);
}

function buildMarketStall(obj) {
  const p = obj.parametric;
  const g = new THREE.Group();
  const w = p.width || 3.2, d = p.depth || 2.0, h = p.height || 2.7;
  addContactAO(g, w * 0.58, d * 0.62, 0.65);

  const wood = new THREE.MeshStandardMaterial({ color: "#68472b", roughness: 0.88, normalMap: getWoodNormalMap() });
  const cloth1 = new THREE.MeshStandardMaterial({ color: obj.material.color || "#b83b36", roughness: 0.9 });
  const cloth2 = new THREE.MeshStandardMaterial({ color: obj.material.secondary_color || "#ece2cf", roughness: 0.9 });

  const counter = new THREE.Mesh(new THREE.BoxGeometry(w, 0.92, d * 0.72), wood);
  counter.position.set(0, 0.46, 0);
  g.add(counter);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const ph = sz > 0 ? h * 0.88 : h;
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.11, ph, 0.11), wood);
      post.position.set(sx * (w / 2 - 0.08), ph / 2, sz * (d / 2 - 0.08));
      g.add(post);
    }
  }
  const stripes = 6;
  const sw = (w + 0.3) / stripes;
  for (let i = 0; i < stripes; i++) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(sw, 0.07, d + 0.45), i % 2 === 0 ? cloth1 : cloth2);
    s.position.set(-(w + 0.3) / 2 + sw * (i + 0.5), h * 0.94, 0.05);
    s.rotation.x = 0.18;
    g.add(s);
  }
  const fruitColors = ["#d94f30", "#e6a92e", "#5b9a3d", "#9a427c"];
  for (let i = 0; i < 4; i++) {
    const cx = -(w * 0.34) + i * (w * 0.23);
    const crate = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.24, 0.55), wood);
    crate.position.set(cx, 1.04, 0);
    g.add(crate);
    const goods = new THREE.Mesh(
      new THREE.DodecahedronGeometry(0.22, 1),
      new THREE.MeshStandardMaterial({ color: fruitColors[i % fruitColors.length], roughness: 0.65 })
    );
    goods.scale.set(1.1, 0.6, 1.0);
    goods.position.set(cx, 1.18, 0);
    g.add(goods);
  }
  return enableShadows(g);
}

function buildWindmill(obj, texturesDict) {
  const p = obj.parametric;
  const g = new THREE.Group();
  const h = Math.max(7.0, p.height || 9.5);
  const rBase = Math.max(1.6, (p.width || 3.8) * 0.5);
  addContactAO(g, rBase * 1.15, rBase * 1.15, 0.72);

  const wallMat = createPBRMaterial(obj.material, texturesDict, { repeat: 2.2 });
  const roofMat = buildRoofMaterial(obj, texturesDict);
  const sailWood = new THREE.MeshStandardMaterial({ color: "#503623", roughness: 0.85, normalMap: getWoodNormalMap() });
  const sailCloth = new THREE.MeshStandardMaterial({ color: "#efe6d3", roughness: 0.85, side: THREE.DoubleSide });

  const body = new THREE.Mesh(new THREE.CylinderGeometry(rBase * 0.62, rBase, h * 0.78, 14), wallMat);
  body.position.y = h * 0.39;
  g.add(body);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(rBase * 0.74, h * 0.26, 14), roofMat);
  cap.position.y = h * 0.78 + h * 0.13;
  g.add(cap);

  const rotor = new THREE.Group();
  rotor.position.set(0, h * 0.72, rBase * 0.68);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.5, 10), sailWood);
  hub.rotation.x = Math.PI / 2;
  rotor.add(hub);
  const bladeLen = h * 0.44;
  for (let i = 0; i < 4; i++) {
    const bg = new THREE.Group();
    bg.rotation.z = (i * Math.PI) / 2;
    const spar = new THREE.Mesh(new THREE.BoxGeometry(0.12, bladeLen, 0.1), sailWood);
    spar.position.y = bladeLen / 2;
    bg.add(spar);
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.75, bladeLen * 0.78), sailCloth);
    cloth.position.set(0.38, bladeLen * 0.58, 0.04);
    bg.add(cloth);
    rotor.add(bg);
  }
  g.add(rotor);
  g.userData.spinRotorZ = rotor;
  return enableShadows(g);
}

function buildSculptedVehicle(kind, matSpec, texturesDict) {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(matSpec.color || "#b82e2a"),
    roughness: 0.22,
    metalness: 0.35,
    clearcoat: 0.85,
    clearcoatRoughness: 0.12,
    envMapIntensity: 1.35,
  });
  const accentMat = new THREE.MeshStandardMaterial({ color: matSpec.secondary_color || "#7c4c28", roughness: 0.72 });
  const tireMat = new THREE.MeshStandardMaterial({ color: "#1c1e22", roughness: 0.9 });
  const chromeMat = new THREE.MeshStandardMaterial({ color: "#d8dee6", roughness: 0.14, metalness: 0.92, envMapIntensity: 1.5 });
  const headMat = new THREE.MeshStandardMaterial({ color: "#fff8dd", emissive: "#ffe49e", emissiveIntensity: 1.8 });
  const wheels = [];

  function makeWheel(x, y, z, r, tube) {
    const wg = new THREE.Group();
    wg.position.set(x, y, z);
    const tire = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 10, 18), tireMat);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.65, r * 0.65, tube * 1.4, 12), chromeMat);
    rim.rotation.x = Math.PI / 2;
    wg.add(tire, rim);
    g.add(wg);
    wheels.push(wg);
  }

  if (kind === "scooter" || kind === "scooter_rider") {
    addContactAO(g, 0.85, 0.42, 0.55);
    makeWheel(-0.58, 0.28, 0, 0.22, 0.075);
    makeWheel(0.58, 0.28, 0, 0.22, 0.075);
    const rearCowl = new THREE.Mesh(new THREE.SphereGeometry(0.36, 14, 12), bodyMat);
    rearCowl.scale.set(1.45, 0.85, 0.92);
    rearCowl.position.set(-0.42, 0.56, 0);
    g.add(rearCowl);
    const floor = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.12, 0.42), bodyMat);
    floor.position.set(0.05, 0.32, 0);
    g.add(floor);
    const shield = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.76, 0.46), bodyMat);
    shield.position.set(0.46, 0.7, 0);
    shield.rotation.z = 0.22;
    g.add(shield);
    const fender = new THREE.Mesh(new THREE.SphereGeometry(0.24, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), bodyMat);
    fender.scale.set(1.3, 0.8, 0.85);
    fender.position.set(0.58, 0.36, 0);
    g.add(fender);
    const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.14, 0.36), accentMat);
    saddle.position.set(-0.22, 0.88, 0);
    g.add(saddle);
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.68, 8), chromeMat);
    bar.rotation.x = Math.PI / 2;
    bar.position.set(0.39, 1.08, 0);
    g.add(bar);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 10), headMat);
    lamp.position.set(0.52, 1.06, 0);
    g.add(lamp);
  } else if (kind === "boat" || kind === "boat_cruiser") {
    const hull = new THREE.Mesh(new THREE.ConeGeometry(0.95, 3.2, 6), createPBRMaterial(matSpec, texturesDict, { roughness: 0.65 }));
    hull.rotation.z = -Math.PI / 2;
    hull.scale.set(0.55, 1.0, 1.0);
    hull.position.y = 0.35;
    g.add(hull);
    const deck = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.12, 1.15), accentMat);
    deck.position.set(-0.1, 0.56, 0);
    g.add(deck);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, 2.6, 8), accentMat);
    mast.position.set(0.1, 1.8, 0);
    g.add(mast);
    const sail = new THREE.Mesh(
      new THREE.ConeGeometry(0.95, 2.1, 3),
      new THREE.MeshStandardMaterial({ color: "#f7f2e8", roughness: 0.85, side: THREE.DoubleSide })
    );
    sail.scale.set(0.08, 1.0, 1.0);
    sail.position.set(-0.25, 1.9, 0);
    g.add(sail);
  } else {
    addContactAO(g, 1.75, 0.92, 0.62);
    for (const wx of [-1.05, 1.05]) {
      for (const wz of [-0.72, 0.72]) makeWheel(wx, 0.34, wz, 0.28, 0.1);
    }
    const lower = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.68, 1.56), bodyMat);
    lower.position.y = 0.66;
    g.add(lower);
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.65, 0.62, 1.38), bodyMat);
    cabin.position.set(-0.15, 1.24, 0);
    g.add(cabin);
    const glass = new THREE.Mesh(
      new THREE.BoxGeometry(1.48, 0.44, 1.42),
      new THREE.MeshPhysicalMaterial({ color: "#223447", roughness: 0.08, metalness: 0.55, clearcoat: 1.0 })
    );
    glass.position.set(-0.15, 1.26, 0);
    g.add(glass);
    for (const lz of [-0.52, 0.52]) {
      const hl = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.1, 10), headMat);
      hl.rotation.z = Math.PI / 2;
      hl.position.set(1.62, 0.72, lz);
      g.add(hl);
    }
  }
  g.userData.wheels = wheels;
  return enableShadows(g);
}

function buildBench(obj) {
  const g = new THREE.Group();
  addContactAO(g, 1.02, 0.42, 0.55);
  const wood = new THREE.MeshStandardMaterial({ color: obj.material.color || "#6f4b30", roughness: 0.85, normalMap: getWoodNormalMap() });
  const iron = new THREE.MeshStandardMaterial({ color: "#24272d", roughness: 0.42, metalness: 0.8 });
  const seat = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.09, 0.52), wood);
  seat.position.y = 0.48;
  g.add(seat);
  const back = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.46, 0.08), wood);
  back.position.set(0, 0.82, -0.24);
  back.rotation.x = -0.15;
  g.add(back);
  for (const lx of [-0.75, 0.75]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.48, 0.48), iron);
    leg.position.set(lx, 0.24, 0);
    g.add(leg);
  }
  return enableShadows(g);
}

function buildGazebo(obj, texturesDict) {
  const p = obj.parametric;
  const g = new THREE.Group();
  const r = Math.max(1.8, (p.width || 4.0) * 0.5);
  const h = Math.max(3.2, p.height || 4.0);
  addContactAO(g, r * 1.15, r * 1.15, 0.68);
  const stone = createPBRMaterial(obj.material, texturesDict, { repeat: 2.0 });
  const roofMat = buildRoofMaterial(obj, texturesDict);

  const floor = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.08, 0.35, 8), stone);
  floor.position.y = 0.175;
  g.add(floor);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, h * 0.68, 10), stone);
    col.position.set(Math.cos(a) * (r * 0.82), 0.35 + h * 0.34, Math.sin(a) * (r * 0.82));
    g.add(col);
  }
  const roof = new THREE.Mesh(new THREE.ConeGeometry(r * 1.15, h * 0.36, 8), roofMat);
  roof.position.y = 0.35 + h * 0.68 + h * 0.18;
  g.add(roof);
  return enableShadows(g);
}

function buildLighthouse(obj) {
  const p = obj.parametric;
  const g = new THREE.Group();
  const h = Math.max(8.5, p.height || 12.0);
  const r = Math.max(1.4, (p.width || 3.4) * 0.5);
  addContactAO(g, r * 1.25, r * 1.25, 0.72);
  const white = new THREE.MeshStandardMaterial({ color: obj.material.color || "#f0ece4", roughness: 0.76 });
  const red = new THREE.MeshStandardMaterial({ color: obj.material.secondary_color || "#b8362c", roughness: 0.76 });
  const segs = 4;
  const segH = (h * 0.78) / segs;
  for (let i = 0; i < segs; i++) {
    const rBot = r * (1.0 - i * 0.12);
    const rTop = r * (1.0 - (i + 1) * 0.12);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, segH, 16), i % 2 === 0 ? white : red);
    m.position.y = i * segH + segH / 2;
    g.add(m);
  }
  const topY = h * 0.78;
  const lantern = new THREE.Mesh(
    new THREE.CylinderGeometry(r * 0.45, r * 0.45, 1.3, 12),
    new THREE.MeshStandardMaterial({ color: "#fff8d6", emissive: "#ffd56b", emissiveIntensity: 2.6 })
  );
  lantern.position.y = topY + 0.65;
  g.add(lantern);
  const dome = new THREE.Mesh(new THREE.ConeGeometry(r * 0.56, 1.1, 12), red);
  dome.position.y = topY + 1.8;
  g.add(dome);
  const beamGroup = new THREE.Group();
  beamGroup.position.y = topY + 0.65;
  const beam = new THREE.Mesh(
    new THREE.ConeGeometry(2.2, 16.0, 14, 1, true),
    new THREE.MeshBasicMaterial({ color: "#ffe7a3", transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false })
  );
  beam.rotation.z = Math.PI / 2;
  beam.position.x = 8.0;
  beamGroup.add(beam);
  g.add(beamGroup);
  g.userData.sweepBeamY = beamGroup;
  return enableShadows(g);
}

export function buildParametricObject(obj, texturesDict, isNight) {
  const k = obj.parametric?.kind || "building";
  switch (k) {
    case "building": return buildBuilding(obj, texturesDict, isNight);
    case "tower": return buildTower(obj, texturesDict, isNight);
    case "fountain": return buildFountain(obj, texturesDict);
    case "tree": return buildTree(obj);
    case "archway":
    case "bridge": return buildArchway(obj, texturesDict);
    case "lamp_post": return buildLampPost(obj, isNight);
    case "market_stall": return buildMarketStall(obj);
    case "bench": return buildBench(obj);
    case "gazebo": return buildGazebo(obj, texturesDict);
    case "windmill": return buildWindmill(obj, texturesDict);
    case "lighthouse": return buildLighthouse(obj);
    case "scooter":
    case "car":
    case "boat": return buildSculptedVehicle(k, obj.material, texturesDict);
    default: return buildBuilding(obj, texturesDict, isNight);
  }
}

// ---------------------------------------------------------------------------
// Carrier 5: General-Purpose Composable 3D Part-Tree Grammar (`procedural_assembly`)
// ---------------------------------------------------------------------------
function makeAssemblyGeometry(part) {
  const s = part.size || [1, 1, 1];
  const sx = Math.max(0.02, Math.abs(s[0] ?? 1));
  const sy = Math.max(0.02, Math.abs(s[1] ?? 1));
  const sz = Math.max(0.02, Math.abs(s[2] ?? 1));

  switch (part.shape) {
    case "box":
      return new THREE.BoxGeometry(sx, sy, sz);
    case "cylinder":
      return new THREE.CylinderGeometry(sx, sy, sz, 16);
    case "cone":
      return new THREE.ConeGeometry(sx, sy, 14);
    case "sphere": {
      const geo = new THREE.SphereGeometry(1.0, 16, 12);
      geo.scale(sx, sy, sz);
      return geo;
    }
    case "capsule":
      return new THREE.CapsuleGeometry(sx, sy, 6, 12);
    case "torus": {
      const arc = THREE.MathUtils.degToRad(Math.max(20, Math.min(360, s[2] || 360)));
      return new THREE.TorusGeometry(sx, Math.min(sx * 0.48, sy), 12, 24, arc);
    }
    case "arch_segment": {
      const innerR = Math.max(0.2, sx);
      const outerR = Math.max(innerR + 0.15, sy);
      const shape = new THREE.Shape();
      shape.absarc(0, 0, outerR, 0, Math.PI, false);
      shape.absarc(0, 0, innerR, Math.PI, 0, true);
      shape.closePath();
      const geo = new THREE.ExtrudeGeometry(shape, { depth: sz, bevelEnabled: false, curveSegments: 18 });
      geo.translate(0, 0, -sz * 0.5);
      return geo;
    }
    case "plane":
      return new THREE.PlaneGeometry(sx, sy);
    case "ring":
      return new THREE.RingGeometry(Math.min(sx, sy * 0.9), Math.max(sx + 0.05, sy), 28);
    case "icosahedron": {
      const geo = new THREE.IcosahedronGeometry(1.0, 1);
      geo.scale(sx, sy, sz);
      return geo;
    }
    case "dodecahedron": {
      const geo = new THREE.DodecahedronGeometry(1.0, 1);
      geo.scale(sx, sy, sz);
      return geo;
    }
    default:
      return new THREE.BoxGeometry(sx, sy, sz);
  }
}

export function buildProceduralAssembly(obj, texturesDict) {
  const spec = obj.procedural;
  const g = new THREE.Group();
  if (!spec || !Array.isArray(spec.parts) || spec.parts.length === 0) return g;

  if ((spec.contact_ao_radius ?? 1.2) > 0.05) {
    addContactAO(g, spec.contact_ao_radius, spec.contact_ao_radius, 0.58);
  }

  const animatedParts = [];
  const baseMatSpec = obj.material || {};

  for (const part of spec.parts) {
    const geo = makeAssemblyGeometry(part);
    const texId = part.texture_id !== undefined ? part.texture_id : (part.opacity < 0.95 || part.emissive_intensity > 0.5 ? null : baseMatSpec.texture_id);
    const isTranslucent = (part.opacity ?? 1.0) < 0.99;

    let mat;
    if (isTranslucent) {
      mat = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(part.color || baseMatSpec.color || "#7dd3fc"),
        roughness: part.roughness ?? 0.14,
        metalness: part.metalness ?? 0.1,
        emissive: new THREE.Color(part.emissive || "#000000"),
        emissiveIntensity: part.emissive_intensity ?? 0.0,
        transparent: true,
        opacity: part.opacity,
        clearcoat: 0.7,
        side: THREE.DoubleSide,
        depthWrite: part.opacity > 0.65,
      });
    } else {
      mat = createPBRMaterial(baseMatSpec, texturesDict, {
        overrideColor: part.color || baseMatSpec.color,
        textureIdOverride: texId,
        roughness: part.roughness ?? baseMatSpec.roughness ?? 0.65,
        metalness: part.metalness ?? baseMatSpec.metalness ?? 0.12,
        emissive: part.emissive ?? "#000000",
        emissiveIntensity: part.emissive_intensity ?? 0.0,
        tintWeight: texId ? 0.35 : 1.0,
      });
      if (part.shape === "plane" || part.shape === "ring") mat.side = THREE.DoubleSide;
    }

    const repCount = Math.max(1, Math.min(16, part.repeat_count || 1));
    const repOff = part.repeat_offset || [0, 0, 0];
    const repRotY = THREE.MathUtils.degToRad(part.repeat_rot_y_deg || 0);
    const sides = part.mirror_x ? [1, -1] : [1];
    const basePos = part.pos || [0, 0, 0];
    const baseRot = part.rot_deg || [0, 0, 0];

    for (const sgn of sides) {
      for (let r = 0; r < repCount; r++) {
        const m = new THREE.Mesh(geo, mat);
        const px = (basePos[0] + repOff[0] * r) * sgn;
        const py = basePos[1] + repOff[1] * r;
        const pz = basePos[2] + repOff[2] * r;

        if (Math.abs(repRotY) > 1e-4 && repCount > 1) {
          const ang = repRotY * r;
          const ca = Math.cos(ang), sa = Math.sin(ang);
          m.position.set(px * ca - pz * sa, py, px * sa + pz * ca);
          m.rotation.set(
            THREE.MathUtils.degToRad(baseRot[0]),
            THREE.MathUtils.degToRad(baseRot[1]) * sgn + ang,
            THREE.MathUtils.degToRad(baseRot[2]) * sgn
          );
        } else {
          m.position.set(px, py, pz);
          m.rotation.set(
            THREE.MathUtils.degToRad(baseRot[0]),
            THREE.MathUtils.degToRad(baseRot[1]) * sgn,
            THREE.MathUtils.degToRad(baseRot[2]) * sgn
          );
        }

        if (part.anim && part.anim !== "none") {
          animatedParts.push({
            mesh: m,
            anim: part.anim,
            baseY: m.position.y,
            baseRotX: m.rotation.x,
            baseRotY: m.rotation.y,
            baseRotZ: m.rotation.z,
            baseEmissive: part.emissive_intensity || 1.0,
            phase: r * 0.7 + sgn,
          });
        }
        g.add(m);
      }
    }
  }

  if (spec.light_color && (spec.light_intensity || 0) > 0.1) {
    const lp = spec.light_pos || [0, 2, 0];
    const pl = new THREE.PointLight(spec.light_color, spec.light_intensity, spec.light_distance || 14, 1.6);
    pl.position.set(lp[0], lp[1], lp[2]);
    g.add(pl);
  }

  if (animatedParts.length > 0) g.userData.animatedParts = animatedParts;
  return enableShadows(g);
}

// ---------------------------------------------------------------------------
// Carrier 3: Implicit Signed Distance Field w/ Baked 3D SDF-AO + Approach B Dual-Projection Neural Shader!
// ---------------------------------------------------------------------------
export async function buildImplicitSDFObject(obj, texturesDict) {
  const g = new THREE.Group();
  const sdf = obj.implicit_sdf;
  let plinthH = 0;

  addContactAO(g, 1.25, 1.25, 0.72);

  if (sdf?.pedestal) {
    const pMat = createPBRMaterial(obj.material, texturesDict, {
      overrideColor: obj.material.secondary_color || "#8b8378",
      repeat: 1.4,
      roughness: 0.85,
      tintWeight: 0.45,
    });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.22, 0.32, 8), pMat);
    base.position.y = 0.16;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.76, 0.84, 0.85, 8), pMat);
    shaft.position.y = 0.74;
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.94, 0.82, 0.18, 8), pMat);
    cap.position.y = 1.24;
    g.add(base, shaft, cap);
    plinthH = 1.32;
  }

  if (sdf?.mesh_url) {
    const res = await fetch(sdf.mesh_url);
    const data = await res.json();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(data.positions, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(data.normals, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(data.uvs, 2));
    geo.setAttribute("uv2", new THREE.Float32BufferAttribute(data.uvs, 2));
    const hasAOColors = Array.isArray(data.colors) && data.colors.length === data.positions.length;
    if (hasAOColors) {
      geo.setAttribute("color", new THREE.Float32BufferAttribute(data.colors, 3));
    }
    geo.setIndex(data.indices);

    const bMin = data.bounds?.min || [-1, 0, -1];
    const bMax = data.bounds?.max || [1, 2, 1];
    const cx = 0.5 * (bMin[0] + bMax[0]);
    const cy = 0.5 * (bMin[1] + bMax[1]);
    const span = Math.max(bMax[0] - bMin[0], bMax[1] - bMin[1], bMax[2] - bMin[2], 0.5) * 1.18;

    let mat;
    // Approach B: Persistent Object-Space Dual-Projection Neural Shader (Front +Z / Back -Z @ 60 FPS!)
    if (sdf.baked_front_url && sdf.baked_back_url) {
      const fAlb = loadClampTex(sdf.baked_front_url, true);
      const bAlb = loadClampTex(sdf.baked_back_url, true);
      const fNrm = sdf.baked_front_normal_url ? loadClampTex(sdf.baked_front_normal_url, false) : null;
      const bNrm = sdf.baked_back_normal_url ? loadClampTex(sdf.baked_back_normal_url, false) : null;

      mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color("#ffffff"),
        roughness: Math.max(0.32, obj.material.roughness ?? 0.48),
        metalness: obj.material.metalness ?? 0.08,
        vertexColors: hasAOColors,
        envMapIntensity: 0.95,
      });

      mat.onBeforeCompile = shader => {
        shader.uniforms.uBakedFront = { value: fAlb };
        shader.uniforms.uBakedBack = { value: bAlb };
        shader.uniforms.uBakedFrontNrm = { value: fNrm || fAlb };
        shader.uniforms.uBakedBackNrm = { value: bNrm || bAlb };
        shader.uniforms.uHasBakedNrm = { value: fNrm && bNrm ? 1.0 : 0.0 };
        shader.uniforms.uProjCenter = { value: new THREE.Vector2(cx, cy) };
        shader.uniforms.uProjSpan = { value: span };

        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", "#include <common>\nvarying vec3 vObjPos;\nvarying vec3 vObjNrm;")
          .replace("#include <begin_vertex>", "#include <begin_vertex>\nvObjPos = position;\nvObjNrm = normalize(normal);");

        shader.fragmentShader = shader.fragmentShader
          .replace(
            "#include <common>",
            `#include <common>
             uniform sampler2D uBakedFront;
             uniform sampler2D uBakedBack;
             uniform sampler2D uBakedFrontNrm;
             uniform sampler2D uBakedBackNrm;
             uniform float uHasBakedNrm;
             uniform vec2 uProjCenter;
             uniform float uProjSpan;
             varying vec3 vObjPos;
             varying vec3 vObjNrm;`
          )
          .replace(
            "#include <map_fragment>",
            `vec2 uvFront = clamp((vObjPos.xy - uProjCenter) / uProjSpan + 0.5, 0.01, 0.99);
             vec2 uvBack  = vec2(1.0 - uvFront.x, uvFront.y);
             float wFront = smoothstep(-0.32, 0.32, vObjNrm.z);
             vec3 cFront = texture2D(uBakedFront, uvFront).rgb;
             vec3 cBack  = texture2D(uBakedBack,  uvBack).rgb;
             vec3 bakedCol = mix(cBack, cFront, wFront);
             if (uHasBakedNrm > 0.5) {
               vec3 nF = texture2D(uBakedFrontNrm, uvFront).rgb * 2.0 - 1.0;
               vec3 nB = texture2D(uBakedBackNrm,  uvBack).rgb * 2.0 - 1.0;
               vec3 nBlend = mix(nB, nF, wFront);
               // Subtle high-frequency carved micro-relief shading from neural normal map
               float reliefShade = clamp(0.86 + 0.24 * nBlend.y + 0.14 * nBlend.x, 0.68, 1.18);
               bakedCol *= reliefShade;
             }
             diffuseColor.rgb *= bakedCol;`
          );
      };
    } else {
      // Approach A: Persistent Nano Banana PBR + 3D Baked SDF-AO Vertex Colors
      mat = createPBRMaterial(obj.material, texturesDict, {
        roughness: Math.max(0.42, obj.material.roughness ?? 0.52),
        metalness: obj.material.metalness ?? 0.12,
        normalStrength: 1.2,
        tintWeight: 0.18,
      });
      if (hasAOColors) mat.vertexColors = true;
    }

    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = plinthH;
    mesh.userData.isSDFHeroMesh = true;
    mesh.userData.sdfProjBounds = { cx, cy, span };
    g.add(mesh);
  }
  return enableShadows(g);
}

// ---------------------------------------------------------------------------
// Carrier 4: Articulated Autonomous Agents (Flapping Birds, Trotting Fox, Patrol Vehicles)
// ---------------------------------------------------------------------------
function makeSingleBird(matBody, matAccent) {
  const bird = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), matBody);
  body.scale.set(0.78, 0.72, 1.75);
  bird.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), matBody);
  head.position.set(0, 0.1, 0.34);
  bird.add(head);
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.16, 6), matAccent);
  beak.rotation.x = Math.PI / 2;
  beak.position.set(0, 0.08, 0.48);
  bird.add(beak);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.03, 0.34), matBody);
  tail.position.set(0, 0.02, -0.42);
  tail.rotation.x = 0.12;
  bird.add(tail);

  function makeWing(side) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.13, 0.05, 0.04);
    const inner = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.035, 0.24), matBody);
    inner.position.set(side * 0.23, 0, -0.02);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.36, 4), matBody);
    tip.rotation.z = -side * Math.PI / 2;
    tip.scale.set(1, 1, 0.32);
    tip.position.set(side * 0.56, 0, -0.06);
    pivot.add(inner, tip);
    bird.add(pivot);
    return pivot;
  }
  bird.userData.wingL = makeWing(-1);
  bird.userData.wingR = makeWing(1);
  return enableShadows(bird);
}

function makeArticulatedFox(matSpec) {
  const g = new THREE.Group();
  const fur = new THREE.MeshStandardMaterial({ color: matSpec.color || "#c85b28", roughness: 0.85 });
  const cream = new THREE.MeshStandardMaterial({ color: matSpec.secondary_color || "#f3e8d8", roughness: 0.88 });
  const dark = new THREE.MeshStandardMaterial({ color: "#221d1a", roughness: 0.8 });

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.65, 6, 12), fur);
  torso.rotation.z = Math.PI / 2;
  torso.position.set(0, 0.54, 0);
  g.add(torso);
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.21, 0.46, 8), fur);
  head.rotation.z = -Math.PI / 2;
  head.position.set(0.62, 0.72, 0);
  g.add(head);
  for (const ez of [-0.11, 0.11]) {
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.22, 6), dark);
    ear.position.set(0.44, 0.92, ez);
    g.add(ear);
  }
  const tail = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.52, 6, 10), fur);
  tail.rotation.z = 1.15;
  tail.position.set(-0.68, 0.62, 0);
  g.add(tail);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 8), cream);
  tip.position.set(-0.92, 0.74, 0);
  g.add(tip);

  const legs = [];
  for (const [lx, lz, phase] of [[0.3, 0.13, 0], [0.3, -0.13, Math.PI], [-0.3, 0.13, Math.PI], [-0.3, -0.13, 0]]) {
    const pivot = new THREE.Group();
    pivot.position.set(lx, 0.44, lz);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.04, 0.44, 8), dark);
    leg.position.y = -0.22;
    pivot.add(leg);
    pivot.userData.phase = phase;
    g.add(pivot);
    legs.push(pivot);
  }
  g.userData.legs = legs;
  return enableShadows(g);
}

function makeArticulatedHuman(obj) {
  const ag = obj.agent || {};
  const matSpec = obj.material || {};
  const g = new THREE.Group();
  addContactAO(g, 0.42, 0.42, 0.58);

  const role = ag.role || "guest";
  const garment = ag.garment_style || (role === "bride" ? "gown_aline" : role === "groom" ? "tuxedo" : "suit");
  const isGown = garment === "gown_aline" || garment === "gown_sheath" || garment === "dress_cocktail";

  const skinMat = new THREE.MeshStandardMaterial({
    color: ag.skin_tone || "#e5b898",
    roughness: 0.62,
    metalness: 0.02,
  });
  const hairMat = new THREE.MeshStandardMaterial({
    color: ag.hair_color || (role === "bride" ? "#4b2e1e" : "#251c16"),
    roughness: 0.72,
    metalness: 0.05,
  });
  const primaryMat = new THREE.MeshPhysicalMaterial({
    color: matSpec.color || (role === "bride" ? "#fbf6ee" : "#1a1d24"),
    roughness: matSpec.roughness ?? (isGown ? 0.44 : 0.64),
    metalness: matSpec.metalness ?? 0.03,
    sheen: isGown ? 0.85 : 0.35,
    sheenRoughness: 0.5,
    sheenColor: new THREE.Color(matSpec.secondary_color || "#ffffff"),
  });
  const secondaryMat = new THREE.MeshStandardMaterial({
    color: matSpec.secondary_color || "#f3efe8",
    roughness: 0.55,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: matSpec.accent_color || "#d8a86a",
    roughness: 0.42,
    metalness: 0.25,
  });
  const shoeMat = new THREE.MeshStandardMaterial({
    color: isGown ? "#ede5d8" : "#17171a",
    roughness: 0.35,
    metalness: 0.15,
  });
  const eyeWhiteMat = new THREE.MeshStandardMaterial({ color: "#f6f6f6", roughness: 0.18 });
  const irisMat = new THREE.MeshStandardMaterial({ color: "#322218", roughness: 0.12 });

  // Lower body: articulated legs (hidden/layered inside gown for bridal silhouette, visible for suits/cocktail)
  const legs = [];
  const legLen = 0.82;
  const hipY = 0.88;
  for (const [side, lx, phase] of [[-1, -0.105, 0], [1, 0.105, Math.PI]]) {
    const hip = new THREE.Group();
    hip.position.set(lx, hipY, 0);
    const upper = new THREE.Mesh(
      new THREE.CylinderGeometry(0.082, 0.068, legLen * 0.52, 10),
      isGown ? skinMat : primaryMat
    );
    upper.position.y = -legLen * 0.26;
    hip.add(upper);
    const lower = new THREE.Mesh(
      new THREE.CylinderGeometry(0.064, 0.048, legLen * 0.48, 10),
      isGown ? skinMat : primaryMat
    );
    lower.position.y = -legLen * 0.72;
    hip.add(lower);
    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.075, 0.22), shoeMat);
    shoe.position.set(0, -legLen + 0.01, 0.045);
    hip.add(shoe);
    hip.userData.phase = phase;
    hip.userData.side = side;
    g.add(hip);
    legs.push(hip);
  }

  // Flowing Gown / Skirt geometry (for Bride or female guests)
  let skirtMesh = null;
  if (garment === "gown_aline") {
    const skirtGeo = new THREE.CylinderGeometry(0.175, 0.64, 0.96, 22, 4);
    const sPos = skirtGeo.attributes.position;
    for (let i = 0; i < sPos.count; i++) {
      const vx = sPos.getX(i), vy = sPos.getY(i), vz = sPos.getZ(i);
      const ang = Math.atan2(vz, vx);
      const flare = Math.max(0, (0.48 - vy) / 0.96);
      const pleat = 1.0 + 0.06 * Math.sin(ang * 10.0) * flare;
      // Gentle bridal train extending toward -Z (back)
      const trainZ = vz < 0 ? vz * (1.0 + 0.38 * flare) : vz;
      sPos.setXYZ(i, vx * pleat, vy, trainZ * pleat);
    }
    skirtGeo.computeVertexNormals();
    skirtMesh = new THREE.Mesh(skirtGeo, primaryMat);
    skirtMesh.position.set(0, 0.52, -0.02);
    g.add(skirtMesh);
  } else if (garment === "gown_sheath") {
    skirtMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.29, 0.94, 18), primaryMat);
    skirtMesh.position.set(0, 0.52, 0);
    g.add(skirtMesh);
  } else if (garment === "dress_cocktail") {
    skirtMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.34, 0.62, 18), primaryMat);
    skirtMesh.position.set(0, 0.68, 0);
    g.add(skirtMesh);
  }

  // Sculpted Torso / Bodice / Tailored Jacket
  const torsoGroup = new THREE.Group();
  torsoGroup.position.set(0, hipY, 0);
  const torsoW = isGown ? 0.17 : 0.21;
  const torso = new THREE.Mesh(
    new THREE.CylinderGeometry(torsoW * 1.12, torsoW * 0.88, 0.50, 14),
    primaryMat
  );
  torso.scale.set(1.15, 1.0, 0.72);
  torso.position.y = 0.26;
  torsoGroup.add(torso);

  // Shoulders
  const shoulders = new THREE.Mesh(new THREE.SphereGeometry(torsoW * 1.14, 14, 10), isGown ? skinMat : primaryMat);
  shoulders.scale.set(1.22, 0.45, 0.68);
  shoulders.position.y = 0.49;
  torsoGroup.add(shoulders);

  // Tuxedo / Suit shirt V-front, bow tie, lapels & boutonniere
  if (garment === "tuxedo" || garment === "suit") {
    const shirt = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.28, 4), secondaryMat);
    shirt.rotation.z = Math.PI;
    shirt.rotation.y = Math.PI / 4;
    shirt.scale.set(1.0, 1.0, 0.26);
    shirt.position.set(0, 0.39, 0.13);
    torsoGroup.add(shirt);
    const tie = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.038, 0.03), garment === "tuxedo" ? primaryMat : accentMat);
    tie.position.set(0, 0.48, 0.15);
    torsoGroup.add(tie);
    if (role === "groom") {
      const rose = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 8), new THREE.MeshStandardMaterial({ color: "#fff8f4", roughness: 0.5 }));
      rose.position.set(0.11, 0.41, 0.145);
      torsoGroup.add(rose);
    }
  } else if (isGown) {
    // Delicate waist sash / lace trim
    const sash = new THREE.Mesh(new THREE.TorusGeometry(0.165, 0.025, 8, 18), secondaryMat);
    sash.rotation.x = Math.PI / 2;
    sash.scale.set(1.08, 0.78, 1.0);
    sash.position.y = 0.08;
    torsoGroup.add(sash);
  }

  // Neck + Articulated Head Pivot (allows natural gaze tracking toward partner!)
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.064, 0.12, 10), skinMat);
  neck.position.y = 0.56;
  torsoGroup.add(neck);

  const headPivot = new THREE.Group();
  headPivot.position.set(0, 0.63, 0);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.125, 16, 14), skinMat);
  head.scale.set(0.88, 1.08, 0.94);
  head.position.y = 0.10;
  headPivot.add(head);

  // Expressive Eyes, Nose & Smile
  for (const ex of [-0.044, 0.044]) {
    const eyeW = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 8), eyeWhiteMat);
    eyeW.position.set(ex, 0.115, 0.102);
    headPivot.add(eyeW);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.011, 8, 8), irisMat);
    pupil.position.set(ex, 0.115, 0.114);
    headPivot.add(pupil);
  }
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.016, 0.045, 6), skinMat);
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 0.095, 0.122);
  headPivot.add(nose);

  // Hairstyle (romantic bridal updo vs neat tailored short hair)
  const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.132, 14, 12, 0, Math.PI * 2, 0, Math.PI * 0.62), hairMat);
  hairCap.scale.set(0.92, 1.06, 0.98);
  hairCap.position.set(0, 0.115, -0.01);
  headPivot.add(hairCap);
  if (isGown) {
    const bun = new THREE.Mesh(new THREE.SphereGeometry(0.082, 12, 10), hairMat);
    bun.position.set(0, 0.11, -0.12);
    headPivot.add(bun);
    const sideHair = new THREE.Mesh(new THREE.CylinderGeometry(0.118, 0.105, 0.16, 12, 1, false, Math.PI * 0.55, Math.PI * 0.9), hairMat);
    sideHair.position.set(0, 0.06, -0.02);
    headPivot.add(sideHair);
  }

  // Sheer Flowing Cathedral Bridal Veil attached to back of head
  let veilMesh = null;
  if (ag.has_veil) {
    const veilMat = new THREE.MeshPhysicalMaterial({
      color: "#ffffff",
      roughness: 0.35,
      transparent: true,
      opacity: 0.42,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const veilGeo = new THREE.PlaneGeometry(0.72, 1.35, 8, 12);
    const vPos = veilGeo.attributes.position;
    for (let i = 0; i < vPos.count; i++) {
      const vx = vPos.getX(i), vy = vPos.getY(i);
      const tDown = (0.675 - vy) / 1.35;
      const arch = -0.16 - tDown * 0.34 - Math.sin(tDown * Math.PI) * 0.12;
      const flareX = vx * (0.38 + tDown * 0.95);
      vPos.setXYZ(i, flareX, vy - 0.65, arch);
    }
    veilGeo.computeVertexNormals();
    veilMesh = new THREE.Mesh(veilGeo, veilMat);
    veilMesh.position.set(0, 0.14, -0.02);
    headPivot.add(veilMesh);
  }
  torsoGroup.add(headPivot);

  // Articulated Arms + Optional Bridal Rose Bouquet
  const arms = [];
  for (const [side, ax, phase] of [[-1, -(torsoW * 1.32), Math.PI], [1, torsoW * 1.32, 0]]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(ax, 0.47, 0);
    const upperA = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.042, 0.28, 8), isGown ? skinMat : primaryMat);
    upperA.position.y = -0.14;
    shoulder.add(upperA);
    const foreA = new THREE.Mesh(new THREE.CylinderGeometry(0.040, 0.032, 0.26, 8), isGown ? skinMat : primaryMat);
    foreA.position.set(0, -0.39, ag.has_bouquet ? 0.08 : 0.02);
    if (ag.has_bouquet) foreA.rotation.x = -0.72;
    shoulder.add(foreA);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.038, 8, 8), skinMat);
    hand.position.set(0, ag.has_bouquet ? -0.44 : -0.53, ag.has_bouquet ? 0.21 : 0.04);
    shoulder.add(hand);
    shoulder.userData.phase = phase;
    shoulder.userData.side = side;
    if (ag.has_bouquet) {
      shoulder.rotation.z = -side * 0.22;
      shoulder.rotation.x = -0.35;
    }
    torsoGroup.add(shoulder);
    arms.push(shoulder);
  }

  if (ag.has_bouquet) {
    const bq = new THREE.Group();
    bq.position.set(0, 0.06, 0.26);
    const leafMat = new THREE.MeshStandardMaterial({ color: "#436e42", roughness: 0.78 });
    const stem = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.18, 8), leafMat);
    stem.rotation.x = Math.PI;
    stem.position.y = -0.06;
    bq.add(stem);
    const roseCols = ["#fff8f4", "#f6cfd5", "#fff2e6", "#eab5be"];
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      const r = i === 0 ? 0 : 0.075;
      const fl = new THREE.Mesh(
        new THREE.DodecahedronGeometry(0.046, 0),
        new THREE.MeshStandardMaterial({ color: roseCols[i % roseCols.length], roughness: 0.55 })
      );
      fl.position.set(Math.cos(a) * r, 0.03 + (i % 2) * 0.025, Math.sin(a) * r);
      bq.add(fl);
    }
    torsoGroup.add(bq);
  }

  g.add(torsoGroup);
  g.userData.humanRig = { legs, arms, headPivot, torsoGroup, skirtMesh, veilMesh, hasBouquet: Boolean(ag.has_bouquet) };
  return enableShadows(g);
}

export function buildArticulatedAgent(obj, texturesDict) {
  const ag = obj.agent || { rig_kind: "bird_flock", count: 5, entity_scale: 1.0 };
  const root = new THREE.Group();
  const sc = ag.entity_scale || 1.0;

  if (ag.rig_kind === "human_character") {
    const human = makeArticulatedHuman(obj);
    human.scale.setScalar(sc);
    root.add(human);
    root.userData.humanMesh = human;
    return root;
  }

  if (ag.rig_kind === "bird_flock") {
    const matBody = new THREE.MeshStandardMaterial({ color: obj.material.color || "#3a6ea5", roughness: 0.62 });
    const matBeak = new THREE.MeshStandardMaterial({ color: obj.material.accent_color || "#e8a538", roughness: 0.45 });
    const members = [];
    const n = Math.max(1, Math.min(14, ag.count || 5));
    for (let i = 0; i < n; i++) {
      const b = makeSingleBird(matBody, matBeak);
      b.scale.setScalar(sc * (0.85 + 0.3 * ((i * 7) % 5) / 4));
      const ang = (i / n) * Math.PI * 2;
      const rad = (obj.behavior?.orbit_radius || 6.0) + (i % 3 - 1) * 1.1;
      const h = (obj.behavior?.orbit_height || 6.0) + (i % 2) * 0.9;
      b.position.set(Math.cos(ang) * rad, h, Math.sin(ang) * rad);
      b.userData.agentState = {
        angle: ang,
        radiusOffset: (i % 3 - 1) * 1.15,
        heightOffset: ((i * 3) % 4 - 1.5) * 0.55,
        flapPhase: i * 1.37,
        mode: "FLYING",
        timer: i * 1.4,
        perchSlot: i,
        pos: b.position.clone(),
        vel: new THREE.Vector3(-Math.sin(ang), 0, Math.cos(ang)),
      };
      root.add(b);
      members.push(b);
    }
    root.userData.flockMembers = members;
  } else if (ag.rig_kind === "floating_lanterns") {
    const members = [];
    const n = Math.max(2, Math.min(14, ag.count || 6));
    const paperMat = new THREE.MeshStandardMaterial({
      color: obj.material.color || "#ff9e44",
      emissive: new THREE.Color(obj.material.accent_color || "#ffae3d"),
      emissiveIntensity: 2.2,
      roughness: 0.6,
    });
    for (let i = 0; i < n; i++) {
      const lg = new THREE.Group();
      const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.2, 0.58, 8), paperMat);
      lg.add(cyl);
      if (i < 3) {
        const pl = new THREE.PointLight("#ffad42", 7, 10, 1.8);
        lg.add(pl);
      }
      const ang = (i / n) * Math.PI * 2;
      lg.position.set(Math.cos(ang) * 4.5, 4.0 + (i % 3) * 1.2, Math.sin(ang) * 4.5);
      lg.userData.agentState = { angle: ang, radiusOffset: (i % 3 - 1) * 1.3, heightOffset: (i % 3) * 0.9, pos: lg.position.clone() };
      lg.scale.setScalar(sc);
      root.add(lg);
      members.push(lg);
    }
    root.userData.lanternMembers = members;
  } else if (ag.rig_kind === "fox") {
    const fox = makeArticulatedFox(obj.material);
    fox.scale.setScalar(sc);
    root.add(fox);
    root.userData.patrolMesh = fox;
    root.userData.patrolAngle = 0;
  } else {
    const v = buildSculptedVehicle(ag.rig_kind, obj.material, texturesDict);
    v.scale.setScalar(sc);
    root.add(v);
    root.userData.patrolMesh = v;
    root.userData.patrolAngle = 0;
  }

  return root;
}

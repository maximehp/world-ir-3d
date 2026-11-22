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
  const r = Math.hypot(x, z);
  const pr = terrain.plaza_radius ?? (terrain.style === "plain" ? 0 : 15);
  const hh = terrain.hill_height ?? (terrain.style === "plain" ? 0 : 3);
  const hillMask = pr > 0 ? smoothstep(pr * 0.85, pr * 1.6, r) : 1;

  const n1 = Math.sin(x * 0.085 + 0.4) * Math.cos(z * 0.085 - 0.3);
  const n2 = Math.sin(x * 0.17 - z * 0.14 + 1.2) * 0.45;
  const n3 = Math.cos((x + z) * 0.055) * 0.55;
  let h = (n1 * 0.5 + n2 * 0.35 + n3 * 0.35 + 0.45) * hh * hillMask;

  if (terrain.has_water && terrain.style === "coastal_harbor") {
    const shoreScale = pr > 0 ? pr : (terrain.size ?? 72) * 0.2;
    const seaBlend = smoothstep(shoreScale * 0.55, shoreScale * 1.15, z);
    h = h * (1.0 - seaBlend) + (terrain.water_level - 1.2) * seaBlend;
  } else if (terrain.has_water) {
    const stream = Math.abs(z - Math.sin(x * 0.12) * 5.0 - pr * 0.85);
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

// Emissive roles: "body" surfaces keep only a faint glow so neon/night styles read as dark materials with
// glowing trim, "trim" surfaces (cornices, frames, bands, rims) carry the boosted neon glow.
function emissiveForRole(options, matSpec) {
  if (options.emissiveIntensity !== undefined) return options.emissiveIntensity;
  const base = matSpec.emissive_intensity ?? 0.0;
  if (options.emissiveRole === "body") return base * 0.18;
  if (options.emissiveRole === "recess") return base * 0.55;
  if (options.emissiveRole === "trim") return base > 0.02 ? Math.min(3.2, Math.max(1.4, base * 3.0)) : 0.0;
  return base;
}

export function createPBRMaterial(matSpec, texturesDict, options = {}) {
  const color = new THREE.Color(options.overrideColor || matSpec.color || "#c8b8a2");
  const repeat = options.repeat ?? matSpec.texture_repeat ?? 2.0;
  const repeatY = options.repeatY ?? repeat;
  const texId = options.textureIdOverride !== undefined ? options.textureIdOverride : matSpec.texture_id;
  const params = {
    color,
    roughness: options.roughness ?? matSpec.roughness ?? 0.76,
    metalness: options.metalness ?? matSpec.metalness ?? 0.05,
    emissive: new THREE.Color(options.emissive ?? matSpec.emissive ?? "#000000"),
    emissiveIntensity: emissiveForRole(options, matSpec),
    envMapIntensity: options.envMapIntensity ?? 0.85,
  };
  const texAsset = !options.noTexture && texId ? texturesDict[texId] : null;
  if (texAsset) {
    params.map = loadRepeatTex(texAsset.albedo_url, repeat, repeatY, true);
    params.normalMap = loadRepeatTex(texAsset.normal_url, repeat, repeatY, false);
    params.normalScale = new THREE.Vector2(options.normalStrength ?? 1.05, options.normalStrength ?? 1.05);
    params.roughnessMap = loadRepeatTex(texAsset.roughness_url, repeat, repeatY, false);
    if (texAsset.ao_url) {
      params.aoMap = loadRepeatTex(texAsset.ao_url, repeat, repeatY, false);
      params.aoMapIntensity = 0.75;
    }
    params.color = new THREE.Color("#ffffff").lerp(color, options.tintWeight ?? 0.22);
  }
  return new THREE.MeshStandardMaterial(params);
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

// ---------------------------------------------------------------------------
// Carrier 1: Dual-Biome Splat Heightfield Terrain + Animated Normal-Mapped Water
// ---------------------------------------------------------------------------
export function buildTerrain(terrain, texturesDict) {
  const group = new THREE.Group();
  group.name = "terrain_group";

  const size = terrain.size || 72;
  const segs = 120;
  const geo = new THREE.PlaneGeometry(size, size, segs, segs);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const splatWeight = new Float32Array(pos.count);
  const cPlaza = new THREE.Color(terrain.ground_color || "#8a8275");
  const cHill = new THREE.Color(terrain.hill_color || "#4f6d3f");
  const cTmp = new THREE.Color();
  const pr = terrain.plaza_radius ?? (terrain.style === "plain" ? 0 : 15);
  const hillHeight = terrain.hill_height ?? (terrain.style === "plain" ? 0 : 3);

  const hasDualTex = Boolean(terrain.texture_id && texturesDict[terrain.texture_id] && terrain.hill_texture_id && texturesDict[terrain.hill_texture_id]);

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = sampleTerrainHeight(terrain, x, z);
    pos.setY(i, y);

    let blend = 0;
    if (pr > 0) {
      const wobble = Math.sin(Math.atan2(z, x) * 7.0) * 0.65 + Math.cos(x * 0.35) * 0.45;
      blend = smoothstep(pr * 0.80 + wobble, pr * 1.18 + wobble, Math.hypot(x, z));
    } else if (hillHeight > 0) {
      blend = smoothstep(0, hillHeight, y);
    }
    splatWeight[i] = blend;

    const micro = 0.93 + 0.07 * Math.sin(x * 0.85) * Math.cos(z * 0.85);
    if (hasDualTex) {
      // Subtle ambient modulation only — true colors come from dual Nano Banana PBR maps!
      const shade = (1.0 - 0.10 * blend) * micro;
      colors[i * 3] = shade;
      colors[i * 3 + 1] = shade;
      colors[i * 3 + 2] = shade;
    } else {
      cTmp.copy(cPlaza).lerp(cHill, blend).multiplyScalar(micro);
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
  const rep = Math.round(size / 4.2);

  const matParams = {
    vertexColors: true,
    roughness: 0.9,
    metalness: 0.02,
    envMapIntensity: 0.55,
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

  // Dual-biome PBR splat shader: cobblestones on plaza, lush Nano Banana grass/meadow on rolling hills!
  if (plazaTex && hillTex) {
    const hillAlb = loadRepeatTex(hillTex.albedo_url, Math.round(size / 5.5), Math.round(size / 5.5), true);
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

  // Segmented natural cut-stone plaza curb blocks (instead of bare plastic torus!)
  if (pr > 0 && terrain.style === "cobblestone_plaza") {
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

  // Animated normal-mapped reflective water plane
  let waterMesh = null;
  if (terrain.has_water) {
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
  const rTexId = obj.material.roof_texture_id || (texturesDict["roof_tiles_pbr"] ? "roof_tiles_pbr" : null);
  if (rTexId && texturesDict[rTexId]) {
    return createPBRMaterial(obj.material, texturesDict, {
      textureIdOverride: rTexId,
      overrideColor: obj.material.secondary_color || "#9b4935",
      repeat: 2.0,
      roughness: 0.84,
      normalStrength: 1.45,
      tintWeight: 0.16,
      emissive: "#000000",
      emissiveIntensity: 0.0,
    });
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
  const mat = createPBRMaterial(obj.material, texturesDict, { repeat: 2.0, normalStrength: 1.2, emissiveRole: "body" });
  const trim = createPBRMaterial(obj.material, texturesDict, { overrideColor: obj.material.secondary_color || "#8d8272", repeat: 1.5, tintWeight: 0.5, emissiveRole: "trim" });

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

// Low humpback footbridge: an arched walking deck spanning `width` along local X, with parapets and a voussoir arch underneath.
function buildFootbridge(obj, texturesDict) {
  const p = obj.parametric;
  const g = new THREE.Group();
  const span = Math.max(2.4, p.width || 5.0);
  const rise = THREE.MathUtils.clamp(p.height || span * 0.22, 0.4, span * 0.4);
  const deckW = Math.max(0.9, p.depth || 1.6);
  const mat = createPBRMaterial(obj.material, texturesDict, { repeat: 1.6, normalStrength: 1.2, emissiveRole: "body" });
  const trim = createPBRMaterial(obj.material, texturesDict, { overrideColor: obj.material.secondary_color || "#8d8272", repeat: 1.2, tintWeight: 0.5, emissiveRole: "trim" });

  const deckThick = 0.22;
  const parapetH = 0.42, parapetT = 0.16;
  const N = 14;
  const yAt = (x) => rise * Math.cos((Math.PI * x) / span) + 0.12; // 0.12 at the banks, rise at the crown
  for (let i = 0; i < N; i++) {
    const x0 = -span / 2 + (span * i) / N, x1 = -span / 2 + (span * (i + 1)) / N;
    const y0 = yAt(x0), y1 = yAt(x1);
    const len = Math.hypot(x1 - x0, y1 - y0) + 0.02;
    const ang = Math.atan2(y1 - y0, x1 - x0);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const deck = new THREE.Mesh(new THREE.BoxGeometry(len, deckThick, deckW), mat);
    deck.position.set(cx, cy, 0);
    deck.rotation.z = ang;
    g.add(deck);
    for (const sz of [-1, 1]) {
      const par = new THREE.Mesh(new THREE.BoxGeometry(len, parapetH, parapetT), trim);
      const off = deckThick / 2 + parapetH / 2;
      par.position.set(cx - Math.sin(ang) * off, cy + Math.cos(ang) * off, sz * (deckW / 2 - parapetT / 2));
      par.rotation.z = ang;
      g.add(par);
    }
    // spandrel fill under the deck down to the water line, thinning toward the arch crown
    const fillH = Math.max(0.05, Math.min(y0, y1) - 0.02);
    const crownGap = rise * 0.75 * Math.cos((Math.PI * cx) / span);
    const h = Math.max(0.05, fillH - Math.max(0, crownGap));
    if (h > 0.08) {
      const fill = new THREE.Mesh(new THREE.BoxGeometry(span / N + 0.02, h, deckW * 0.94), mat);
      fill.position.set(cx, Math.min(y0, y1) - h / 2, 0);
      g.add(fill);
    }
  }
  // end posts / newels
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.26, parapetH + 0.3, 0.26), trim);
    post.position.set(sx * (span / 2 - 0.1), 0.12 + (parapetH + 0.3) / 2, sz * (deckW / 2 - parapetT / 2));
    g.add(post);
  }
  addContactAO(g, span * 0.55, deckW * 0.7, 0.4);
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

// ---------------------------------------------------------------------------
// Monumental Architecture Kit: domed_hall, minaret, reflecting_pool, platform
// (Mughal / Islamic / classical landmark vocabulary: onion & hemispherical lathe domes,
//  pointed-arch iwans set in pishtaq frames, chhatri pavilions, guldasta pinnacles)
// ---------------------------------------------------------------------------
const ONION_PROFILE = [
  [1.0, 0.0], [1.1, 0.08], [1.19, 0.2], [1.22, 0.33], [1.17, 0.46], [1.03, 0.58],
  [0.82, 0.69], [0.58, 0.79], [0.36, 0.87], [0.19, 0.93], [0.08, 0.975], [0.0, 1.0],
];

function domeGeometry(baseR, h, style = "onion", segs = 56) {
  let pts;
  if (style === "hemisphere") {
    pts = [];
    for (let i = 0; i <= 16; i++) {
      const a = (i / 16) * Math.PI / 2;
      pts.push(new THREE.Vector2(Math.max(0.0001, Math.cos(a) * baseR), Math.sin(a) * h));
    }
  } else {
    const curve = new THREE.SplineCurve(ONION_PROFILE.map(([r, y]) => new THREE.Vector2(r * baseR, y * h)));
    pts = curve.getPoints(40).map(v => new THREE.Vector2(Math.max(0.0001, v.x), v.y));
  }
  const geo = new THREE.LatheGeometry(pts, segs);
  geo.computeVertexNormals();
  return geo;
}

function pointedArchShape(w, h) {
  const hs = Math.max(h * 0.25, h - w * 0.62);
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0);
  s.lineTo(-w / 2, hs);
  s.quadraticCurveTo(-w / 2, hs + w * 0.42, 0, h);
  s.quadraticCurveTo(w / 2, hs + w * 0.42, w / 2, hs);
  s.lineTo(w / 2, 0);
  s.closePath();
  return s;
}

function archPanel(w, h, depth, mat) {
  const geo = new THREE.ExtrudeGeometry(pointedArchShape(w, h), { depth, bevelEnabled: false, curveSegments: 10 });
  return new THREE.Mesh(geo, mat);
}

function goldMaterial(obj) {
  return new THREE.MeshStandardMaterial({
    color: obj.material.accent_color || "#d8b15a", metalness: 0.92, roughness: 0.22, envMapIntensity: 1.6,
  });
}

function shadeMaterial(obj, texturesDict, factor) {
  const c = new THREE.Color(obj.material.color || "#eeeae2").multiplyScalar(factor);
  return createPBRMaterial(obj.material, texturesDict, { overrideColor: "#" + c.getHexString(), roughness: 0.9, tintWeight: 0.6, emissiveRole: "recess" });
}

function finial(obj, h) {
  const g = new THREE.Group();
  const gold = goldMaterial(obj);
  const spike = new THREE.Mesh(new THREE.CylinderGeometry(h * 0.018, h * 0.05, h, 10), gold);
  spike.position.y = h / 2;
  g.add(spike);
  [0.22, 0.42, 0.6].forEach((t, i) => {
    const b = new THREE.Mesh(new THREE.SphereGeometry(h * (0.11 - i * 0.025), 14, 10), gold);
    b.position.y = h * t;
    g.add(b);
  });
  const crescent = new THREE.Mesh(new THREE.TorusGeometry(h * 0.09, h * 0.018, 6, 16, Math.PI * 1.3), gold);
  crescent.position.y = h * 0.86;
  crescent.rotation.z = Math.PI * 0.85;
  g.add(crescent);
  return g;
}

function chhatri(obj, texturesDict, r, colH, domeStyle = "onion") {
  const g = new THREE.Group();
  const stone = createPBRMaterial(obj.material, texturesDict, { repeat: 1.0, roughness: 0.5, emissiveRole: "body" });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.12, r * 1.18, r * 0.25, 8), stone);
  base.position.y = r * 0.125;
  g.add(base);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const c = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.07, r * 0.08, colH, 8), stone);
    c.position.set(Math.cos(a) * r * 0.92, r * 0.25 + colH / 2, Math.sin(a) * r * 0.92);
    g.add(c);
  }
  const eave = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.22, r * 1.05, r * 0.16, 8), stone);
  eave.position.y = r * 0.25 + colH + r * 0.08;
  g.add(eave);
  const dome = new THREE.Mesh(domeGeometry(r * 0.88, r * 1.35, domeStyle, 32), stone);
  dome.position.y = r * 0.25 + colH + r * 0.16;
  g.add(dome);
  const f = finial(obj, r * 0.7);
  f.position.y = dome.position.y + r * 1.3;
  g.add(f);
  return g;
}

function buildDomedHall(obj, texturesDict) {
  const p = obj.parametric;
  const g = new THREE.Group();
  const W = Math.max(6, p.width || 12);
  const H = Math.max(8, p.height || 16);
  const style = p.dome_style || "onion";
  const hb = H * 0.42;           // main body height
  const c = W * 0.17;            // chamfer
  addContactAO(g, W * 0.62, W * 0.62, 0.7);

  const marble = createPBRMaterial(obj.material, texturesDict, { repeat: 3.0, roughness: 0.42, normalStrength: 0.6, envMapIntensity: 1.1, emissiveRole: "body" });
  const frameMat = createPBRMaterial(obj.material, texturesDict, {
    overrideColor: obj.material.secondary_color || "#b9a98d", repeat: 2.0, roughness: 0.5, tintWeight: 0.55, emissiveRole: "trim",
  });
  const recess = shadeMaterial(obj, texturesDict, 0.42);
  const recessDeep = shadeMaterial(obj, texturesDict, 0.26);

  // Chamfered-square body (extruded octagon)
  const hw = W / 2;
  const sh = new THREE.Shape();
  sh.moveTo(-hw + c, -hw); sh.lineTo(hw - c, -hw); sh.lineTo(hw, -hw + c); sh.lineTo(hw, hw - c);
  sh.lineTo(hw - c, hw); sh.lineTo(-hw + c, hw); sh.lineTo(-hw, hw - c); sh.lineTo(-hw, -hw + c); sh.closePath();
  const bodyGeo = new THREE.ExtrudeGeometry(sh, { depth: hb, bevelEnabled: false });
  bodyGeo.rotateX(-Math.PI / 2);
  const body = new THREE.Mesh(bodyGeo, marble);
  g.add(body);
  // Cornice band
  const corniceGeo = new THREE.ExtrudeGeometry(sh, { depth: hb * 0.035, bevelEnabled: false });
  corniceGeo.rotateX(-Math.PI / 2);
  const cornice = new THREE.Mesh(corniceGeo, frameMat);
  cornice.scale.set(1.025, 1, 1.025);
  cornice.position.y = hb * 0.965;
  g.add(cornice);

  // Four facades: pishtaq frame + great iwan + stacked side arches
  for (let k = 0; k < 4; k++) {
    const face = new THREE.Group();
    face.rotation.y = (k * Math.PI) / 2;
    const pw = W * 0.44, ph = hb * 1.08;
    const pish = new THREE.Mesh(new THREE.BoxGeometry(pw, ph, W * 0.03), marble);
    pish.position.set(0, ph / 2, hw + W * 0.012);
    face.add(pish);
    const pishTrim = new THREE.Mesh(new THREE.BoxGeometry(pw * 1.02, ph * 0.03, W * 0.035), frameMat);
    pishTrim.position.set(0, ph, hw + W * 0.012);
    face.add(pishTrim);
    const outer = archPanel(pw * 0.74, ph * 0.86, 0.02, frameMat);
    outer.position.set(0, 0, hw + W * 0.028);
    face.add(outer);
    const iwan = archPanel(pw * 0.64, ph * 0.8, 0.03, recess);
    iwan.position.set(0, 0, hw + W * 0.03);
    face.add(iwan);
    const door = archPanel(pw * 0.26, ph * 0.36, 0.035, recessDeep);
    door.position.set(0, 0, hw + W * 0.032);
    face.add(door);
    // Side bays on the flat face, two levels
    for (const sx of [-1, 1]) {
      for (const lvl of [0, 1]) {
        const a = archPanel(W * 0.085, hb * 0.36, 0.03, recess);
        a.position.set(sx * W * 0.31, hb * (0.06 + lvl * 0.47), hw + 0.005);
        face.add(a);
      }
    }
    // Chamfer face arches (two levels)
    const ch = new THREE.Group();
    ch.position.set(hw - c / 2, 0, hw - c / 2);
    ch.rotation.y = Math.PI / 4;
    for (const lvl of [0, 1]) {
      const a = archPanel(c * 0.8, hb * 0.36, 0.03, recess);
      a.position.set(0, hb * (0.06 + lvl * 0.47), 0.01);
      ch.add(a);
    }
    face.add(ch);
    // Guldasta pinnacles at chamfer corners
    for (const sx of [-1, 1]) {
      const pin = new THREE.Mesh(new THREE.CylinderGeometry(W * 0.012, W * 0.016, hb * 0.3, 8), marble);
      pin.position.set(sx * (hw - c), hb + hb * 0.15, hw);
      face.add(pin);
      const bud = new THREE.Mesh(domeGeometry(W * 0.02, W * 0.05, "onion", 12), marble);
      bud.position.set(sx * (hw - c), hb * 1.3, hw);
      face.add(bud);
    }
    g.add(face);
  }

  // Drum + great dome + finial
  const Rd = W * 0.25;
  const drumH = H * 0.075;
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(Rd, Rd * 1.03, drumH, 48), marble);
  drum.position.y = hb + drumH / 2;
  g.add(drum);
  const drumBand = new THREE.Mesh(new THREE.CylinderGeometry(Rd * 1.04, Rd * 1.04, drumH * 0.12, 48), frameMat);
  drumBand.position.y = hb + drumH * 0.94;
  g.add(drumBand);
  const domeH = style === "hemisphere" ? Rd * 0.95 : H * 0.36;
  const dome = new THREE.Mesh(domeGeometry(Rd * 1.0, domeH, style, 64), marble);
  dome.position.y = hb + drumH;
  g.add(dome);
  const lotus = new THREE.Mesh(new THREE.CylinderGeometry(Rd * 0.06, Rd * 0.14, domeH * 0.05, 16), frameMat);
  lotus.position.y = hb + drumH + domeH * 0.985;
  g.add(lotus);
  const f = finial(obj, H * 0.085);
  f.position.y = hb + drumH + domeH;
  g.add(f);

  // Four corner chhatris
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const k = chhatri(obj, texturesDict, W * 0.075, H * 0.085, style);
    k.position.set(sx * W * 0.33, hb, sz * W * 0.33);
    g.add(k);
  }
  return enableShadows(g);
}

function buildMinaret(obj, texturesDict) {
  const p = obj.parametric;
  const g = new THREE.Group();
  const H = Math.max(6, p.height || 14);
  const w = Math.max(0.8, Math.min(p.width || 1.6, H * 0.16));
  addContactAO(g, w * 1.1, w * 1.1, 0.7);
  const marble = createPBRMaterial(obj.material, texturesDict, { repeat: 1.5, roughness: 0.42, normalStrength: 0.6, envMapIntensity: 1.1, emissiveRole: "body" });
  const trim = createPBRMaterial(obj.material, texturesDict, {
    overrideColor: obj.material.secondary_color || "#b9a98d", repeat: 1.0, roughness: 0.5, tintWeight: 0.55, emissiveRole: "trim",
  });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.78, w * 0.85, H * 0.06, 8), marble);
  base.position.y = H * 0.03;
  g.add(base);
  const levels = [0.06, 0.36, 0.62, 0.84];
  const radii = [w * 0.5, w * 0.45, w * 0.4, w * 0.36];
  for (let i = 0; i < 3; i++) {
    const y0 = H * levels[i], y1 = H * levels[i + 1];
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(radii[i + 1], radii[i], y1 - y0, 24), marble);
    shaft.position.y = (y0 + y1) / 2;
    g.add(shaft);
    for (let b = 1; b <= 2; b++) {
      const band = new THREE.Mesh(new THREE.CylinderGeometry(radii[i] * 1.01, radii[i] * 1.01, H * 0.006, 24), trim);
      band.position.y = y0 + (y1 - y0) * (b / 3);
      g.add(band);
    }
    // Balcony with corbel ring and rail
    const by = y1;
    const corbel = new THREE.Mesh(new THREE.CylinderGeometry(radii[i + 1] * 1.55, radii[i + 1] * 1.02, H * 0.025, 24), marble);
    corbel.position.y = by - H * 0.0125;
    g.add(corbel);
    const deck = new THREE.Mesh(new THREE.CylinderGeometry(radii[i + 1] * 1.6, radii[i + 1] * 1.6, H * 0.008, 24), trim);
    deck.position.y = by;
    g.add(deck);
    const rail = new THREE.Mesh(new THREE.TorusGeometry(radii[i + 1] * 1.55, w * 0.03, 6, 28), marble);
    rail.rotation.x = Math.PI / 2;
    rail.position.y = by + H * 0.022;
    g.add(rail);
  }
  const k = chhatri(obj, texturesDict, radii[3] * 1.25, H * 0.055, p.dome_style || "onion");
  k.position.y = H * 0.84;
  g.add(k);
  return enableShadows(g);
}

function buildReflectingPool(obj, texturesDict) {
  const p = obj.parametric;
  const g = new THREE.Group();
  const W = Math.max(1.2, p.width || 3);
  const L = Math.max(4, p.depth || 20);
  // Molten mode: a strongly emissive WARM hue (lava / fire / molten metal) turns the liquid into glowing magma
  const em = new THREE.Color(obj.material.emissive || "#000000");
  const hsl = {}; em.getHSL(hsl);
  const molten = (obj.material.emissive_intensity || 0) >= 0.6 && hsl.s > 0.4 && hsl.l > 0.2 && (hsl.h < 0.12 || hsl.h > 0.95);
  const stone = createPBRMaterial(obj.material, texturesDict, molten
    ? { repeat: 2.0, roughness: 0.7, emissiveIntensity: 0 }
    : { repeat: 2.0, roughness: 0.55, emissiveRole: "recess" });
  const walkMat = createPBRMaterial(obj.material, texturesDict, {
    overrideColor: molten ? obj.material.color : (obj.material.secondary_color || "#d9cfbf"), repeat: 6, roughness: 0.7, tintWeight: 0.5,
    ...(molten ? { emissiveIntensity: 0 } : { emissiveRole: "body" }),
  });
  const walkW = Math.max(1.2, W * 0.6);
  for (const sx of [-1, 1]) {
    const walk = new THREE.Mesh(new THREE.BoxGeometry(walkW, 0.08, L + 0.8), walkMat);
    walk.position.set(sx * (W / 2 + 0.3 + walkW / 2), 0.04, 0);
    g.add(walk);
  }
  const rimH = 0.34, rimT = 0.3;
  const rims = [
    [W + rimT * 2, rimT, 0, L / 2 + rimT / 2], [W + rimT * 2, rimT, 0, -L / 2 - rimT / 2],
    [rimT, L, W / 2 + rimT / 2, 0], [rimT, L, -W / 2 - rimT / 2, 0],
  ];
  for (const [sx, sz, x, z] of rims) {
    const r = new THREE.Mesh(new THREE.BoxGeometry(sx, rimH, sz), stone);
    r.position.set(x, rimH / 2, z);
    g.add(r);
  }
  const floor = new THREE.Mesh(new THREE.BoxGeometry(W, 0.06, L), new THREE.MeshStandardMaterial({ color: "#163845", roughness: 0.9 }));
  floor.position.y = 0.03;
  g.add(floor);
  const wNorm = getWaterNormalMap().clone();
  wNorm.needsUpdate = true;
  wNorm.repeat.set(Math.max(1, W / 2), Math.max(2, L / 2));
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(W, L),
    new THREE.MeshPhysicalMaterial({
      // Water takes the accent hue but stays deep so it reflects rather than glows
      color: new THREE.Color(obj.material.accent_color && obj.material.accent_color !== "#ffd584" ? obj.material.accent_color : "#2c6f86").multiplyScalar(0.5),
      roughness: 0.02, metalness: 0.2, clearcoat: 1.0, clearcoatRoughness: 0.03,
      normalMap: wNorm, normalScale: new THREE.Vector2(0.18, 0.18), envMapIntensity: 2.1, transparent: true, opacity: 0.93,
    })
  );
  if (molten) {
    water.material = new THREE.MeshStandardMaterial({
      color: "#2a0e05", emissive: em, emissiveIntensity: Math.min(1.5, obj.material.emissive_intensity * 0.65),
      roughness: 0.55, metalness: 0.1, normalMap: wNorm, normalScale: new THREE.Vector2(0.9, 0.9),
    });
    wNorm.repeat.set(Math.max(1, W / 3), Math.max(2, L / 3));
  }
  water.rotation.x = -Math.PI / 2;
  water.position.y = rimH - 0.07;
  water.receiveShadow = true;
  g.add(water);
  // Central line of fountain jets
  const drops = [];
  const dropGeo = new THREE.SphereGeometry(0.045, 6, 6);
  const dropMat = new THREE.MeshPhysicalMaterial({ color: "#e6fbff", emissive: "#6ab9d4", emissiveIntensity: 0.2, roughness: 0.04, transparent: true, opacity: 0.82 });
  const nJets = Math.max(2, Math.min(14, Math.floor(L / 2.6)));
  for (let j = 0; j < nJets; j++) {
    const oz = -L / 2 + (L / nJets) * (j + 0.5);
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.12, 8), stone);
    nozzle.position.set(0, rimH - 0.04, oz);
    g.add(nozzle);
    for (let k = 0; k < 6; k++) {
      const m = new THREE.Mesh(dropGeo, dropMat);
      m.userData = { ang: k * 1.05 + j, phase: k / 6, radius: 0.22, topY: rimH + 0.55, poolY: rimH - 0.07, ox: 0, oz };
      g.add(m);
      drops.push(m);
    }
  }
  g.userData.waterDrops = drops;
  g.userData.waterNormalTex = wNorm;
  enableShadows(g);
  water.castShadow = false;
  return g;
}

function buildPlatform(obj, texturesDict) {
  const p = obj.parametric;
  const g = new THREE.Group();
  const W = Math.max(2, p.width || 20);
  const D = Math.max(2, p.depth || 20);
  const H = Math.max(0.3, Math.min(p.height || 1.4, 6));
  addContactAO(g, W * 0.55, D * 0.55, 0.6);
  const stone = createPBRMaterial(obj.material, texturesDict, { repeat: Math.max(2, W / 6), roughness: 0.55, emissiveRole: "body" });
  const trim = createPBRMaterial(obj.material, texturesDict, {
    overrideColor: obj.material.secondary_color || "#cfc3ae", repeat: 2, roughness: 0.6, tintWeight: 0.5, emissiveRole: "trim",
  });
  const recess = shadeMaterial(obj, texturesDict, 0.5);
  const body = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), stone);
  body.position.y = H / 2;
  g.add(body);
  const cap = new THREE.Mesh(new THREE.BoxGeometry(W + 0.3, Math.min(0.16, H * 0.12), D + 0.3), trim);
  cap.position.y = H;
  g.add(cap);
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(W + 0.24, Math.min(0.2, H * 0.14), D + 0.24), trim);
  plinth.position.y = Math.min(0.1, H * 0.07);
  g.add(plinth);
  // Blind arcade along all four sides
  if (H >= 0.8) {
    const ah = H * 0.62, aw = Math.min(1.4, ah * 0.62);
    const sides = [[W, D / 2, 0], [W, -D / 2, Math.PI], [D, W / 2, Math.PI / 2], [D, -W / 2, -Math.PI / 2]];
    for (const [len, off, rot] of sides) {
      const side = new THREE.Group();
      side.rotation.y = rot;
      const n = Math.max(1, Math.floor(len / (aw * 1.7)));
      for (let i = 0; i < n; i++) {
        const x = -len / 2 + (len / n) * (i + 0.5);
        if (rot === 0 && Math.abs(x) < Math.min(W * 0.14, 2.6)) continue; // leave room for steps
        const a = archPanel(aw, ah, 0.02, recess);
        a.position.set(x, H * 0.16, Math.abs(off) + 0.005);
        side.add(a);
      }
      g.add(side);
    }
  }
  // Front steps (+Z)
  const sw = Math.min(W * 0.24, 5);
  const nSteps = Math.max(2, Math.round(H / 0.22));
  for (let i = 0; i < nSteps; i++) {
    const sh = (H / nSteps) * (i + 1);
    const st = new THREE.Mesh(new THREE.BoxGeometry(sw, sh, 0.36), trim);
    st.position.set(0, sh / 2, D / 2 + 0.18 + (nSteps - 1 - i) * 0.36);
    g.add(st);
  }
  return enableShadows(g);
}

function buildPrimitive(obj, texturesDict) {
  const { shape, width, height, depth } = obj.parametric;
  let geometry;
  switch (shape) {
    case "sphere": geometry = new THREE.SphereGeometry(0.5, 32, 20); break;
    case "cylinder": geometry = new THREE.CylinderGeometry(0.5, 0.5, 1, 32); break;
    case "cone": geometry = new THREE.ConeGeometry(0.5, 1, 32); break;
    default: geometry = new THREE.BoxGeometry(1, 1, 1); break;
  }
  geometry.scale(width, height, depth);
  geometry.translate(0, height / 2, 0);
  return enableShadows(new THREE.Mesh(geometry, createPBRMaterial(obj.material, texturesDict)));
}

export function buildParametricObject(obj, texturesDict, isNight) {
  const k = obj.parametric?.kind;
  switch (k) {
    case "primitive": return buildPrimitive(obj, texturesDict);
    case "building": return buildBuilding(obj, texturesDict, isNight);
    case "tower": return buildTower(obj, texturesDict, isNight);
    case "domed_hall": return buildDomedHall(obj, texturesDict);
    case "minaret": return buildMinaret(obj, texturesDict);
    case "reflecting_pool": return buildReflectingPool(obj, texturesDict);
    case "platform": return buildPlatform(obj, texturesDict);
    case "fountain": return buildFountain(obj, texturesDict);
    case "tree": return buildTree(obj);
    case "archway": return buildArchway(obj, texturesDict);
    case "bridge": return buildFootbridge(obj, texturesDict);
    case "lamp_post": return buildLampPost(obj, isNight);
    case "market_stall": return buildMarketStall(obj);
    case "bench": return buildBench(obj);
    case "gazebo": return buildGazebo(obj, texturesDict);
    case "windmill": return buildWindmill(obj, texturesDict);
    case "lighthouse": return buildLighthouse(obj);
    case "scooter":
    case "car":
    case "boat": return buildSculptedVehicle(k, obj.material, texturesDict);
    default: throw new Error(`Missing or unsupported parametric geometry on ${obj.id}: ${k}`);
  }
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

export function buildArticulatedAgent(obj, texturesDict) {
  const ag = obj.agent || { rig_kind: "bird_flock", count: 5, entity_scale: 1.0 };
  const root = new THREE.Group();
  const sc = ag.entity_scale || 1.0;

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
    const n = Math.max(1, Math.min(14, ag.count ?? 1));
    const paperMat = new THREE.MeshStandardMaterial({
      color: obj.material.color || "#ff9e44",
      emissive: new THREE.Color(obj.material.color || "#ff9e44").lerp(new THREE.Color(obj.material.accent_color || "#ffae3d"), 0.35),
      emissiveIntensity: 1.15,
      roughness: 0.6,
      transparent: true,
      opacity: 0.94,
    });
    const capMat = new THREE.MeshStandardMaterial({ color: "#2b211b", roughness: 0.7, metalness: 0.3 });
    for (let i = 0; i < n; i++) {
      const lg = new THREE.Group();
      const cyl = new THREE.Mesh(new THREE.SphereGeometry(0.3, 14, 10), paperMat);
      cyl.scale.set(1, 1.25, 1);
      lg.add(cyl);
      for (const yy of [0.36, -0.36]) {
        const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.06, 10), capMat);
        cap.position.y = yy;
        lg.add(cap);
      }
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

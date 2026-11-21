/* High-Craft Multi-Carrier 3D Builders for WorldIR:
 *   1. Analytic Heightfield Terrain + Reflective Animated Water
 *   2. Parametric Multi-Part 3D Assemblies (Buildings, Towers, Fountains w/ 3D Water Jets,
 *      Branching Trees, Walkable Vaulted Arches, Windmills, Lighthouses, Lamps, Vehicles)
 *   3. Implicit Smooth-Min SDF Marching Cubes Mesh Loader (Organic Sculptures / Statues)
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
  const pr = terrain.plaza_radius || 15.0;
  const hh = terrain.hill_height ?? 3.0;
  const hillMask = smoothstep(pr * 0.85, pr * 1.6, r);

  // Smooth multi-octave analytic rolling hills
  const n1 = Math.sin(x * 0.085 + 0.4) * Math.cos(z * 0.085 - 0.3);
  const n2 = Math.sin(x * 0.17 - z * 0.14 + 1.2) * 0.45;
  const n3 = Math.cos((x + z) * 0.055) * 0.55;
  let h = (n1 * 0.5 + n2 * 0.35 + n3 * 0.35 + 0.45) * hh * hillMask;

  // Gently slope down toward water on +Z / harbor edge if coastal_harbor
  if (terrain.has_water && terrain.style === "coastal_harbor") {
    const seaBlend = smoothstep(pr * 0.55, pr * 1.15, z);
    h = h * (1.0 - seaBlend) + (terrain.water_level - 1.2) * seaBlend;
  } else if (terrain.has_water) {
    // Carve a scenic winding stream/basin outside the inner plaza
    const stream = Math.abs(z - Math.sin(x * 0.12) * 5.0 - pr * 0.85);
    const carve = 1.0 - smoothstep(1.8, 5.5, stream);
    h = h * (1.0 - carve * 0.8) + (terrain.water_level - 0.9) * carve;
  }
  return h;
}

// ---------------------------------------------------------------------------
// PBR Material Factory (Supports Nano Banana Seamless Albedo + Normal + Roughness)
// ---------------------------------------------------------------------------
const texLoader = new THREE.TextureLoader();
const loadedTexCache = new Map();

function loadRepeatTex(url, repeat, isColor) {
  const key = `${url}|${repeat}|${isColor}`;
  if (loadedTexCache.has(key)) return loadedTexCache.get(key);
  const tex = texLoader.load(url);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 8;
  if (isColor) tex.colorSpace = THREE.SRGBColorSpace;
  loadedTexCache.set(key, tex);
  return tex;
}

export function createPBRMaterial(matSpec, texturesDict, options = {}) {
  const color = new THREE.Color(options.overrideColor || matSpec.color || "#c8b8a2");
  const repeat = options.repeat ?? matSpec.texture_repeat ?? 2.0;
  const params = {
    color,
    roughness: options.roughness ?? matSpec.roughness ?? 0.72,
    metalness: options.metalness ?? matSpec.metalness ?? 0.06,
    emissive: new THREE.Color(options.emissive || matSpec.emissive || "#000000"),
    emissiveIntensity: options.emissiveIntensity ?? matSpec.emissive_intensity ?? 0.0,
  };
  const texAsset = !options.noTexture && matSpec.texture_id ? texturesDict[matSpec.texture_id] : null;
  if (texAsset) {
    params.map = loadRepeatTex(texAsset.albedo_url, repeat, true);
    params.normalMap = loadRepeatTex(texAsset.normal_url, repeat, false);
    params.normalScale = new THREE.Vector2(0.85, 0.85);
    params.roughnessMap = loadRepeatTex(texAsset.roughness_url, repeat, false);
    // Tint subtly rather than crushing Nano Banana albedo
    params.color = new THREE.Color("#ffffff").lerp(color, 0.28);
  }
  return new THREE.MeshStandardMaterial(params);
}

function enableShadows(root) {
  root.traverse(n => {
    if (n.isMesh) {
      n.castShadow = true;
      n.receiveShadow = true;
    }
  });
  return root;
}

// ---------------------------------------------------------------------------
// Carrier 1: Analytic Heightfield Terrain + Animated Reflective Water
// ---------------------------------------------------------------------------
export function buildTerrain(terrain, texturesDict) {
  const group = new THREE.Group();
  group.name = "terrain_group";

  const size = terrain.size || 72;
  const segs = 112;
  const geo = new THREE.PlaneGeometry(size, size, segs, segs);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const cPlaza = new THREE.Color(terrain.ground_color || "#8a8275");
  const cHill = new THREE.Color(terrain.hill_color || "#4f6d3f");
  const cTmp = new THREE.Color();
  const pr = terrain.plaza_radius || 15.0;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = sampleTerrainHeight(terrain, x, z);
    pos.setY(i, y);

    const r = Math.hypot(x, z);
    const blend = smoothstep(pr * 0.78, pr * 1.25, r);
    const micro = 0.94 + 0.06 * Math.sin(x * 0.9) * Math.cos(z * 0.9);
    cTmp.copy(cPlaza).lerp(cHill, blend).multiplyScalar(micro);
    colors[i * 3] = cTmp.r;
    colors[i * 3 + 1] = cTmp.g;
    colors[i * 3 + 2] = cTmp.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const texAsset = terrain.texture_id ? texturesDict[terrain.texture_id] : null;
  const matParams = {
    vertexColors: true,
    roughness: 0.9,
    metalness: 0.02,
  };
  if (texAsset) {
    const rep = Math.round(size / 4.5);
    matParams.map = loadRepeatTex(texAsset.albedo_url, rep, true);
    matParams.normalMap = loadRepeatTex(texAsset.normal_url, rep, false);
    matParams.normalScale = new THREE.Vector2(0.75, 0.75);
    matParams.roughnessMap = loadRepeatTex(texAsset.roughness_url, rep, false);
  }
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial(matParams));
  mesh.receiveShadow = true;
  group.add(mesh);

  // Subtle decorative stone curb ring framing the central plaza
  if (terrain.style === "cobblestone_plaza") {
    const ringGeo = new THREE.TorusGeometry(pr * 0.82, 0.14, 8, 64);
    ringGeo.rotateX(Math.PI / 2);
    const ringMat = new THREE.MeshStandardMaterial({ color: "#b6aa97", roughness: 0.85 });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.y = 0.05;
    ring.receiveShadow = true;
    group.add(ring);
  }

  // Optional animated reflective water plane
  let waterMesh = null;
  if (terrain.has_water) {
    const wGeo = new THREE.PlaneGeometry(size * 1.2, size * 1.2, 48, 48);
    wGeo.rotateX(-Math.PI / 2);
    const wMat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(terrain.water_color || "#246c8f"),
      roughness: 0.08,
      metalness: 0.15,
      transmission: 0.18,
      transparent: true,
      opacity: 0.86,
      reflectivity: 0.92,
      clearcoat: 1.0,
      clearcoatRoughness: 0.08,
    });
    waterMesh = new THREE.Mesh(wGeo, wMat);
    waterMesh.position.y = terrain.water_level ?? -0.4;
    waterMesh.receiveShadow = true;
    group.add(waterMesh);
  }

  group.userData.waterMesh = waterMesh;
  return group;
}

// ---------------------------------------------------------------------------
// Carrier 2: Parametric Multi-Part 3D Assemblies
// ---------------------------------------------------------------------------
function addWindowGrid(group, w, h, d, floors, frameMat, glassMat, shutterMat) {
  const floorH = h / floors;
  const colsFront = Math.max(2, Math.min(4, Math.floor(w / 1.55)));
  const colsSide = Math.max(1, Math.min(3, Math.floor(d / 1.75)));

  function placeWindow(wx, wy, wz, rotY) {
    const wg = new THREE.Group();
    wg.position.set(wx, wy, wz);
    wg.rotation.y = rotY;
    // Frame surround
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.76, 1.02, 0.12), frameMat);
    wg.add(frame);
    // Warm recessed glowing glass
    const glass = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.84, 0.14), glassMat);
    glass.position.z = 0.01;
    wg.add(glass);
    // Cross mullions
    wg.add(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.86, 0.16), frameMat));
    wg.add(new THREE.Mesh(new THREE.BoxGeometry(0.60, 0.05, 0.16), frameMat));
    // Stone sill
    const sill = new THREE.Mesh(new THREE.BoxGeometry(0.90, 0.09, 0.22), frameMat);
    sill.position.set(0, -0.53, 0.05);
    wg.add(sill);
    // Side shutters
    for (const sx of [-0.48, 0.48]) {
      const sh = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.96, 0.06), shutterMat);
      sh.position.set(sx, 0, 0.05);
      wg.add(sh);
    }
    group.add(wg);
  }

  for (let f = 0; f < floors; f++) {
    const wy = 0.45 + f * floorH + floorH * 0.52;
    // Front (+Z) & Back (-Z) — leave center ground floor clear for door on Front!
    for (let c = 0; c < colsFront; c++) {
      const u = (c + 0.5) / colsFront - 0.5;
      const wx = u * (w - 0.9);
      if (!(f === 0 && Math.abs(wx) < 0.85)) {
        placeWindow(wx, wy, d / 2 + 0.02, 0);
      }
      placeWindow(wx, wy, -d / 2 - 0.02, Math.PI);
    }
    // Left (-X) & Right (+X) — real 360-degree architectural detail on all sides!
    for (let c = 0; c < colsSide; c++) {
      const u = (c + 0.5) / colsSide - 0.5;
      const wz = u * (d - 0.9);
      placeWindow(w / 2 + 0.02, wy, wz, Math.PI / 2);
      placeWindow(-w / 2 - 0.02, wy, wz, -Math.PI / 2);
    }
  }
}

function buildBuilding(obj, texturesDict, isNight) {
  const p = obj.parametric;
  const g = new THREE.Group();
  const w = p.width || 4.8;
  const h = p.height || 5.2;
  const d = p.depth || 4.2;
  const floors = Math.max(1, p.floors || 2);

  const wallMat = createPBRMaterial(obj.material, texturesDict, { repeat: 2.2, emissive: "#000000", emissiveIntensity: 0.0 });
  const plinthMat = new THREE.MeshStandardMaterial({ color: "#767068", roughness: 0.92 });
  const roofMat = new THREE.MeshStandardMaterial({ color: obj.material.secondary_color || "#8d4332", roughness: 0.78 });
  const frameMat = new THREE.MeshStandardMaterial({ color: "#4a3728", roughness: 0.82 });
  const shutterMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(obj.material.secondary_color || "#3f5f4e").offsetHSL(0.05, -0.05, -0.06),
    roughness: 0.8,
  });
  const glowInt = Math.max(obj.material.emissive_intensity || 0, isNight ? 1.95 : 0.45);
  const glassMat = new THREE.MeshStandardMaterial({
    color: "#3b4858",
    emissive: new THREE.Color(obj.material.accent_color || "#ffcc70"),
    emissiveIntensity: p.light_on ? glowInt : 0.05,
    roughness: 0.18,
    metalness: 0.35,
  });

  // Foundation stone plinth
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(w + 0.28, 0.46, d + 0.28), plinthMat);
  plinth.position.y = 0.23;
  g.add(plinth);

  // Main architectural mass
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
  body.position.y = 0.45 + h / 2;
  g.add(body);

  // Corner stone quoins/pilasters for real 3D silhouette depth
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const pil = new THREE.Mesh(new THREE.BoxGeometry(0.26, h + 0.06, 0.26), plinthMat);
      pil.position.set(sx * (w / 2 - 0.04), 0.45 + h / 2, sz * (d / 2 - 0.04));
      g.add(pil);
    }
  }

  // Cornice band below roof
  const cornice = new THREE.Mesh(new THREE.BoxGeometry(w + 0.34, 0.22, d + 0.34), plinthMat);
  cornice.position.y = 0.45 + h;
  g.add(cornice);

  // Recessed front doorway + arched surround + stone steps
  const doorGroup = new THREE.Group();
  doorGroup.position.set(0, 0.45, d / 2 + 0.02);
  const surround = new THREE.Mesh(new THREE.BoxGeometry(1.36, 2.15, 0.18), plinthMat);
  surround.position.y = 1.07;
  doorGroup.add(surround);
  const doorLeaf = new THREE.Mesh(new THREE.BoxGeometry(1.06, 1.92, 0.22), frameMat);
  doorLeaf.position.y = 0.96;
  doorGroup.add(doorLeaf);
  const step1 = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.22, 0.55), plinthMat);
  step1.position.set(0, -0.11, 0.25);
  doorGroup.add(step1);
  const step2 = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.22, 0.85), plinthMat);
  step2.position.set(0, -0.33, 0.38);
  doorGroup.add(step2);
  g.add(doorGroup);

  // Windows on ALL 4 sides
  addWindowGrid(g, w, h, d, floors, frameMat, glassMat, shutterMat);

  // Optional 2nd-floor balcony
  if (p.has_balcony && floors >= 2) {
    const by = 0.45 + h / floors;
    const slab = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.16, 0.95), plinthMat);
    slab.position.set(0, by, d / 2 + 0.45);
    g.add(slab);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(2.15, 0.08, 0.08), frameMat);
    rail.position.set(0, by + 0.78, d / 2 + 0.88);
    g.add(rail);
    for (let rx = -0.95; rx <= 0.96; rx += 0.32) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.74, 0.06), frameMat);
      post.position.set(rx, by + 0.4, d / 2 + 0.88);
      g.add(post);
    }
  }

  // Roof geometry (gable, hip, cone, dome, flat parapet)
  const roofBaseY = 0.45 + h + 0.08;
  const roofH = Math.min(3.4, Math.max(1.5, Math.min(w, d) * 0.48));
  if (p.roof_style === "gable") {
    // True pitched extruded triangular prism roof with overhanging eaves!
    const shape = new THREE.Shape();
    shape.moveTo(-w / 2 - 0.35, 0);
    shape.lineTo(w / 2 + 0.35, 0);
    shape.lineTo(0, roofH);
    shape.closePath();
    const extrude = new THREE.ExtrudeGeometry(shape, { depth: d + 0.65, bevelEnabled: false });
    extrude.translate(0, 0, -(d + 0.65) / 2);
    const roof = new THREE.Mesh(extrude, roofMat);
    roof.position.y = roofBaseY;
    g.add(roof);
    // Ridge beam
    const ridge = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.2, d + 0.74), frameMat);
    ridge.position.set(0, roofBaseY + roofH, 0);
    g.add(ridge);
  } else if (p.roof_style === "hip") {
    const pyr = new THREE.Mesh(new THREE.ConeGeometry(Math.hypot(w, d) * 0.56, roofH, 4), roofMat);
    pyr.rotation.y = Math.PI / 4;
    pyr.scale.set(w / Math.max(d, 0.1), 1, 1);
    pyr.position.y = roofBaseY + roofH / 2;
    g.add(pyr);
  } else if (p.roof_style === "dome") {
    const dome = new THREE.Mesh(new THREE.SphereGeometry(Math.min(w, d) * 0.46, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), roofMat);
    dome.position.y = roofBaseY;
    g.add(dome);
  } else {
    // Flat terrace with stone parapet wall
    const par = new THREE.Mesh(new THREE.BoxGeometry(w + 0.2, 0.45, d + 0.2), plinthMat);
    par.position.y = roofBaseY + 0.2;
    g.add(par);
  }

  // Optional brick chimney
  if (p.has_chimney) {
    const ch = new THREE.Mesh(new THREE.BoxGeometry(0.62, roofH + 0.9, 0.62), plinthMat);
    ch.position.set(w * 0.28, roofBaseY + (roofH + 0.9) * 0.45, -d * 0.18);
    g.add(ch);
  }

  g.userData.windowGlassMat = glassMat;
  return enableShadows(g);
}

function buildTower(obj, texturesDict, isNight) {
  const p = obj.parametric;
  const g = new THREE.Group();
  const w = Math.min(5.0, Math.max(2.6, p.width || 3.4));
  const h = Math.max(7.5, p.height || 11.0);

  const wallMat = createPBRMaterial(obj.material, texturesDict, { repeat: 2.5, emissive: "#000000", emissiveIntensity: 0.0 });
  const trimMat = new THREE.MeshStandardMaterial({ color: "#7f766a", roughness: 0.88 });
  const roofMat = new THREE.MeshStandardMaterial({ color: obj.material.secondary_color || "#5c3b30", roughness: 0.68 });
  const dialMat = new THREE.MeshStandardMaterial({
    color: "#f6efe0",
    emissive: new THREE.Color(obj.material.accent_color || "#ffdca3"),
    emissiveIntensity: Math.max(obj.material.emissive_intensity || 0, isNight ? 1.4 : 0.25),
    roughness: 0.4,
  });
  const handMat = new THREE.MeshStandardMaterial({ color: "#1c1c20", roughness: 0.3, metalness: 0.7 });

  // Stepped masonry base
  const base = new THREE.Mesh(new THREE.BoxGeometry(w + 0.7, 1.3, w + 0.7), trimMat);
  base.position.y = 0.65;
  g.add(base);

  // Main shaft
  const shaftH = h * 0.68;
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(w, shaftH, w), wallMat);
  shaft.position.y = 1.3 + shaftH / 2;
  g.add(shaft);

  // Stone belt courses
  for (const frac of [0.35, 0.72, 1.0]) {
    const belt = new THREE.Mesh(new THREE.BoxGeometry(w + 0.32, 0.24, w + 0.32), trimMat);
    belt.position.y = 1.3 + shaftH * frac;
    g.add(belt);
  }

  // Clock dials on ALL 4 sides (with live rotating hands!)
  const clockY = 1.3 + shaftH * 0.78;
  const clockHands = [];
  for (let side = 0; side < 4; side++) {
    const cg = new THREE.Group();
    const ang = side * (Math.PI / 2);
    cg.position.set(Math.sin(ang) * (w / 2 + 0.06), clockY, Math.cos(ang) * (w / 2 + 0.06));
    cg.rotation.y = ang;
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.29, w * 0.29, 0.1, 20), trimMat);
    rim.rotation.x = Math.PI / 2;
    cg.add(rim);
    const face = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.24, w * 0.24, 0.12, 20), dialMat);
    face.rotation.x = Math.PI / 2;
    cg.add(face);
    const minHand = new THREE.Mesh(new THREE.BoxGeometry(0.05, w * 0.19, 0.04), handMat);
    minHand.position.set(0, w * 0.08, 0.08);
    const pivot = new THREE.Group();
    pivot.add(minHand);
    cg.add(pivot);
    clockHands.push(pivot);
    g.add(cg);
  }

  // Open belfry lantern with 4 corner pillars + hanging bronze bell
  const belfryY = 1.3 + shaftH;
  const belfryH = h * 0.2;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const col = new THREE.Mesh(new THREE.BoxGeometry(0.42, belfryH, 0.42), trimMat);
      col.position.set(sx * (w * 0.38), belfryY + belfryH / 2, sz * (w * 0.38));
      g.add(col);
    }
  }
  const bell = new THREE.Mesh(
    new THREE.ConeGeometry(w * 0.16, belfryH * 0.48, 14),
    new THREE.MeshStandardMaterial({ color: "#b68c43", roughness: 0.35, metalness: 0.78 })
  );
  bell.position.y = belfryY + belfryH * 0.56;
  g.add(bell);

  // Steep spire roof + finial
  const spireH = h * 0.34;
  const spire = new THREE.Mesh(new THREE.ConeGeometry(w * 0.78, spireH, 4), roofMat);
  spire.rotation.y = Math.PI / 4;
  spire.position.y = belfryY + belfryH + spireH / 2;
  g.add(spire);
  const finial = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 10), bell.material);
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
  const stoneMat = createPBRMaterial(obj.material, texturesDict, { repeat: 2.0 });
  const darkStone = new THREE.MeshStandardMaterial({ color: "#68645d", roughness: 0.88 });
  const waterMat = new THREE.MeshPhysicalMaterial({
    color: "#38a3c7",
    roughness: 0.06,
    metalness: 0.12,
    clearcoat: 1.0,
    transparent: true,
    opacity: 0.86,
  });

  // Stepped octagonal plinth & basin rim
  const step = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.15, r * 1.22, 0.24, 8), darkStone);
  step.position.y = 0.12;
  g.add(step);

  const outerRim = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.04, 0.82, 8), stoneMat);
  outerRim.position.y = 0.62;
  g.add(outerRim);

  // Hollow water surface inside rim
  const pool = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.84, r * 0.84, 0.16, 16), waterMat);
  pool.position.y = 0.96;
  g.add(pool);

  // Central carved pedestal + 2 stacked bowls
  const col = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.18, r * 0.28, 2.3, 12), stoneMat);
  col.position.y = 1.6;
  g.add(col);
  const bowl1 = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.52, r * 0.22, 0.36, 16), stoneMat);
  bowl1.position.y = 1.95;
  g.add(bowl1);
  const bowl2 = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.30, r * 0.14, 0.28, 16), stoneMat);
  bowl2.position.y = 2.72;
  g.add(bowl2);
  const nozzle = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 10), stoneMat);
  nozzle.position.y = 3.0;
  g.add(nozzle);

  // Live animated 3D parabolic water-jet droplets (8 radial arcs!)
  const drops = [];
  const dropGeo = new THREE.SphereGeometry(0.065, 6, 6);
  const dropMat = new THREE.MeshPhysicalMaterial({
    color: "#c8f1ff",
    emissive: "#48a6c9",
    emissiveIntensity: 0.22,
    roughness: 0.05,
    transparent: true,
    opacity: 0.82,
  });
  const jets = 8;
  const perJet = 7;
  for (let j = 0; j < jets; j++) {
    const ang = (j / jets) * Math.PI * 2;
    for (let k = 0; k < perJet; k++) {
      const m = new THREE.Mesh(dropGeo, dropMat);
      m.userData = { ang, phase: k / perJet, radius: r * 0.66, topY: 3.05, poolY: 1.02 };
      g.add(m);
      drops.push(m);
    }
  }
  g.userData.waterDrops = drops;
  return enableShadows(g);
}

function buildTree(obj) {
  const p = obj.parametric;
  const g = new THREE.Group();
  const rng = seededRand(p.seed || 42);
  const h = Math.max(2.6, p.height || 5.4);
  const style = p.tree_style || "oak";

  const barkMat = new THREE.MeshStandardMaterial({ color: obj.material.secondary_color || "#59412e", roughness: 0.94 });
  const leafColor = new THREE.Color(
    obj.material.color || (style === "blossom" ? "#f4a7be" : style === "pine" ? "#274e37" : "#3f7036")
  );
  const canopyGroup = new THREE.Group();

  if (style === "pine") {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.34, h * 0.42, 8), barkMat);
    trunk.position.y = h * 0.21;
    g.add(trunk);
    const tiers = 5;
    for (let i = 0; i < tiers; i++) {
      const frac = i / (tiers - 1);
      const rad = (1.65 - frac * 1.1) * (h / 5.5);
      const coneH = (1.85 - frac * 0.5) * (h / 5.5);
      const cMat = new THREE.MeshStandardMaterial({
        color: leafColor.clone().offsetHSL(0, 0, (frac - 0.3) * 0.07),
        roughness: 0.88,
      });
      const cone = new THREE.Mesh(new THREE.ConeGeometry(rad, coneH, 9), cMat);
      cone.position.y = h * 0.32 + i * (h * 0.145);
      cone.rotation.y = rng() * Math.PI;
      canopyGroup.add(cone);
    }
  } else if (style === "cypress") {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.24, h * 0.25, 8), barkMat);
    trunk.position.y = h * 0.12;
    g.add(trunk);
    for (let i = 0; i < 6; i++) {
      const frac = i / 5;
      const rad = Math.sin(frac * Math.PI * 0.85 + 0.25) * 0.72 * (h / 6.0);
      const puff = new THREE.Mesh(
        new THREE.DodecahedronGeometry(Math.max(0.28, rad), 1),
        new THREE.MeshStandardMaterial({ color: leafColor.clone().offsetHSL(0, 0, (frac - 0.5) * 0.06), roughness: 0.9 })
      );
      puff.scale.set(1, 1.55, 1);
      puff.position.y = h * 0.25 + frac * h * 0.68;
      canopyGroup.add(puff);
    }
  } else {
    // Branching deciduous oak / cherry blossom / palm
    const trunkH = h * 0.5;
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.38, trunkH, 9), barkMat);
    trunk.position.y = trunkH / 2;
    g.add(trunk);

    const nBranches = 4 + Math.floor(rng() * 3);
    for (let b = 0; b < nBranches; b++) {
      const ang = (b / nBranches) * Math.PI * 2 + rng() * 0.4;
      const tilt = 0.42 + rng() * 0.35;
      const bLen = h * (0.28 + rng() * 0.14);
      const br = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.15, bLen, 7), barkMat);
      br.position.set(Math.cos(ang) * bLen * 0.32, trunkH * 0.82 + bLen * 0.32, Math.sin(ang) * bLen * 0.32);
      br.rotation.z = -Math.cos(ang) * tilt;
      br.rotation.x = Math.sin(ang) * tilt;
      g.add(br);

      const clRad = h * (0.21 + rng() * 0.10);
      const cl = new THREE.Mesh(
        new THREE.IcosahedronGeometry(clRad, 1),
        new THREE.MeshStandardMaterial({
          color: leafColor.clone().offsetHSL((rng() - 0.5) * 0.04, 0, (rng() - 0.4) * 0.08),
          roughness: 0.88,
        })
      );
      cl.scale.set(1.15, 0.86, 1.12);
      cl.position.set(Math.cos(ang) * bLen * 0.72, trunkH * 0.92 + bLen * 0.55, Math.sin(ang) * bLen * 0.72);
      canopyGroup.add(cl);
    }
    // Crown center cluster
    const crown = new THREE.Mesh(
      new THREE.IcosahedronGeometry(h * 0.27, 1),
      new THREE.MeshStandardMaterial({ color: leafColor.clone().offsetHSL(0, 0, 0.04), roughness: 0.86 })
    );
    crown.scale.set(1.2, 0.88, 1.15);
    crown.position.set(0, trunkH + h * 0.28, 0);
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
  const mat = createPBRMaterial(obj.material, texturesDict, { repeat: 2.0 });
  const trim = new THREE.MeshStandardMaterial({ color: obj.material.secondary_color || "#8d8272", roughness: 0.88 });

  const pierW = w * 0.22;
  const span = w - pierW * 2;
  const pierH = h * 0.58;

  for (const sx of [-1, 1]) {
    const base = new THREE.Mesh(new THREE.BoxGeometry(pierW + 0.25, 0.45, d + 0.25), trim);
    base.position.set(sx * (span / 2 + pierW / 2), 0.225, 0);
    g.add(base);
    const pier = new THREE.Mesh(new THREE.BoxGeometry(pierW, pierH, d), mat);
    pier.position.set(sx * (span / 2 + pierW / 2), pierH / 2, 0);
    g.add(pier);
  }

  // Radial voussoir arch blocks forming a true walkable semicircular vault
  const rInner = span / 2;
  const nBlocks = 11;
  const archThick = Math.max(0.55, pierW * 0.85);
  for (let i = 0; i < nBlocks; i++) {
    const ang = Math.PI * (i + 0.5) / nBlocks;
    const isKey = i === Math.floor(nBlocks / 2);
    const blk = new THREE.Mesh(
      new THREE.BoxGeometry(archThick * (isKey ? 1.18 : 1.0), (Math.PI * (rInner + archThick * 0.5)) / nBlocks * 1.12, d * (isKey ? 1.08 : 1.0)),
      isKey ? trim : mat
    );
    const rMid = rInner + archThick * 0.5;
    blk.position.set(Math.cos(ang) * rMid, pierH + Math.sin(ang) * rMid, 0);
    blk.rotation.z = ang;
    g.add(blk);
  }

  // Upper cornice entablature
  const topY = pierH + rInner + archThick + 0.2;
  const ent = new THREE.Mesh(new THREE.BoxGeometry(w + 0.45, 0.42, d + 0.35), trim);
  ent.position.y = topY;
  g.add(ent);
  return enableShadows(g);
}

function buildLampPost(obj, isNight) {
  const p = obj.parametric;
  const g = new THREE.Group();
  const h = Math.max(2.6, p.height || 3.8);
  const iron = new THREE.MeshStandardMaterial({ color: obj.material.color || "#252930", roughness: 0.42, metalness: 0.78 });
  const glow = new THREE.MeshStandardMaterial({
    color: "#fff5d6",
    emissive: new THREE.Color(obj.material.accent_color || "#ffbe55"),
    emissiveIntensity: p.light_on ? (isNight ? 3.2 : 1.1) : 0.0,
    roughness: 0.2,
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
    const pl = new THREE.PointLight(obj.material.accent_color || "#ffbe55", isNight ? 18 : 3.5, 16, 1.7);
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
  const wood = new THREE.MeshStandardMaterial({ color: "#6b4a2e", roughness: 0.88 });
  const cloth1 = new THREE.MeshStandardMaterial({ color: obj.material.color || "#c73e3a", roughness: 0.85 });
  const cloth2 = new THREE.MeshStandardMaterial({ color: obj.material.secondary_color || "#f3ead8", roughness: 0.85 });

  // Counter
  const counter = new THREE.Mesh(new THREE.BoxGeometry(w, 0.92, d * 0.72), wood);
  counter.position.set(0, 0.46, 0);
  g.add(counter);
  // 4 Corner posts
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const ph = sz > 0 ? h * 0.88 : h;
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.11, ph, 0.11), wood);
      post.position.set(sx * (w / 2 - 0.08), ph / 2, sz * (d / 2 - 0.08));
      g.add(post);
    }
  }
  // Striped angled awning
  const stripes = 6;
  const sw = (w + 0.3) / stripes;
  for (let i = 0; i < stripes; i++) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(sw, 0.07, d + 0.45), i % 2 === 0 ? cloth1 : cloth2);
    s.position.set(-(w + 0.3) / 2 + sw * (i + 0.5), h * 0.94, 0.05);
    s.rotation.x = 0.18;
    g.add(s);
  }
  // Colorful produce crates on counter
  const fruitColors = ["#d94f30", "#e6a92e", "#5b9a3d", "#9a427c"];
  for (let i = 0; i < 4; i++) {
    const cx = -(w * 0.34) + i * (w * 0.23);
    const crate = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.24, 0.55), wood);
    crate.position.set(cx, 1.04, 0);
    g.add(crate);
    const goods = new THREE.Mesh(
      new THREE.DodecahedronGeometry(0.22, 0),
      new THREE.MeshStandardMaterial({ color: fruitColors[i % fruitColors.length], roughness: 0.7 })
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
  const wallMat = createPBRMaterial(obj.material, texturesDict, { repeat: 2.2 });
  const roofMat = new THREE.MeshStandardMaterial({ color: obj.material.secondary_color || "#633e2c", roughness: 0.8 });
  const sailWood = new THREE.MeshStandardMaterial({ color: "#503623", roughness: 0.85 });
  const sailCloth = new THREE.MeshStandardMaterial({ color: "#f2ead8", roughness: 0.82, side: THREE.DoubleSide });

  const body = new THREE.Mesh(new THREE.CylinderGeometry(rBase * 0.62, rBase, h * 0.78, 12), wallMat);
  body.position.y = h * 0.39;
  g.add(body);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(rBase * 0.72, h * 0.26, 12), roofMat);
  cap.position.y = h * 0.78 + h * 0.13;
  g.add(cap);

  // Rotating 4-blade 3D sails
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
  const bodyMat = createPBRMaterial(matSpec, texturesDict, { roughness: 0.28, metalness: 0.38, noTexture: !matSpec.texture_id });
  const accentMat = new THREE.MeshStandardMaterial({ color: matSpec.secondary_color || "#7c4c28", roughness: 0.75 });
  const tireMat = new THREE.MeshStandardMaterial({ color: "#1d1f24", roughness: 0.9 });
  const chromeMat = new THREE.MeshStandardMaterial({ color: "#d8dee6", roughness: 0.18, metalness: 0.9 });
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
    // Recognizable 3D vintage Vespa-style scooter oriented along +X
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
    const hull = new THREE.Mesh(new THREE.ConeGeometry(0.95, 3.2, 6), bodyMat);
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
    // Classic 3D car oriented along +X
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
      new THREE.MeshStandardMaterial({ color: "#283c4f", roughness: 0.1, metalness: 0.6 })
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
  const wood = new THREE.MeshStandardMaterial({ color: obj.material.color || "#6f4b30", roughness: 0.85 });
  const iron = new THREE.MeshStandardMaterial({ color: "#272a30", roughness: 0.45, metalness: 0.75 });
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
  const stone = createPBRMaterial(obj.material, texturesDict, { repeat: 2.0 });
  const roofMat = new THREE.MeshStandardMaterial({ color: obj.material.secondary_color || "#5c4a3e", roughness: 0.75 });

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

function buildLighthouse(obj, texturesDict) {
  const p = obj.parametric;
  const g = new THREE.Group();
  const h = Math.max(8.5, p.height || 12.0);
  const r = Math.max(1.4, (p.width || 3.4) * 0.5);
  const white = new THREE.MeshStandardMaterial({ color: obj.material.color || "#f0ece4", roughness: 0.75 });
  const red = new THREE.MeshStandardMaterial({ color: obj.material.secondary_color || "#b8362c", roughness: 0.75 });
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
  // Sweeping light beam cone
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
    case "lighthouse": return buildLighthouse(obj, texturesDict);
    case "scooter":
    case "car":
    case "boat": return buildSculptedVehicle(k, obj.material, texturesDict);
    default: return buildBuilding(obj, texturesDict, isNight);
  }
}

// ---------------------------------------------------------------------------
// Carrier 3: Implicit Signed Distance Field (Marching Cubes Mesh Loader)
// ---------------------------------------------------------------------------
export async function buildImplicitSDFObject(obj, texturesDict) {
  const g = new THREE.Group();
  const sdf = obj.implicit_sdf;
  let plinthH = 0;

  if (sdf?.pedestal) {
    const pMat = new THREE.MeshStandardMaterial({ color: obj.material.secondary_color || "#8b8378", roughness: 0.86 });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.22, 0.32, 8), pMat);
    base.position.y = 0.16;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.76, 0.84, 0.85, 8), pMat);
    shaft.position.y = 0.74;
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.92, 0.82, 0.18, 8), pMat);
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
    geo.setIndex(data.indices);

    const mat = createPBRMaterial(obj.material, texturesDict, {
      roughness: obj.material.roughness ?? 0.42,
      metalness: obj.material.metalness ?? 0.18,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = plinthH;
    g.add(mesh);
  }
  return enableShadows(g);
}

// ---------------------------------------------------------------------------
// Carrier 4: Articulated Autonomous Agents (Flapping Birds, Trotting Fox, Patrol Vehicles)
// ---------------------------------------------------------------------------
function makeSingleBird(matBody, matAccent) {
  const bird = new THREE.Group();
  // Aerodynamic 3D torso oriented along +Z forward
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

  // Left & Right hinged wings with inner + outer primary feather sweep
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
    const matBody = new THREE.MeshStandardMaterial({ color: obj.material.color || "#3a6ea5", roughness: 0.65 });
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

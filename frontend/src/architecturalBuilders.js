import * as THREE from 'three';

/**
 * Authentic Mughal Bulbous Onion Dome via LatheGeometry + Gilded Finial Spire
 */
export function createOnionDome(radius, height, domeMat, goldMat) {
  const group = new THREE.Group();
  const pts = [
    new THREE.Vector2(radius * 0.88, 0.0),
    new THREE.Vector2(radius * 0.92, height * 0.12),
    new THREE.Vector2(radius * 1.04, height * 0.34),
    new THREE.Vector2(radius * 0.98, height * 0.54),
    new THREE.Vector2(radius * 0.76, height * 0.72),
    new THREE.Vector2(radius * 0.44, height * 0.86),
    new THREE.Vector2(radius * 0.16, height * 0.95),
    new THREE.Vector2(0.0, height),
  ];
  const domeGeo = new THREE.LatheGeometry(pts, 28);
  const dome = new THREE.Mesh(domeGeo, domeMat);
  dome.castShadow = true;
  dome.receiveShadow = true;
  group.add(dome);

  // Inverted lotus cap + gilded kalasha finial spire
  const finialH = height * 0.34;
  const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.03, radius * 0.08, finialH, 10), goldMat);
  spire.position.y = height + finialH * 0.45;
  group.add(spire);

  const orb1 = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.11, 10, 8), goldMat);
  orb1.position.y = height + finialH * 0.25;
  const orb2 = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.075, 10, 8), goldMat);
  orb2.position.y = height + finialH * 0.56;
  group.add(orb1, orb2);

  return group;
}

/**
 * Open Pillared Chhatri Pavilion (8 slender columns + mini onion dome)
 */
function createChhatri(radius, pillarH, marbleMat, domeMat, goldMat) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(radius * 1.05, radius * 1.1, 0.22, 8), marbleMat);
  base.position.y = 0.11;
  g.add(base);

  const colCount = 8;
  for (let i = 0; i < colCount; i++) {
    const a = (i / colCount) * Math.PI * 2;
    const col = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.08, radius * 0.095, pillarH, 8), marbleMat);
    col.position.set(Math.cos(a) * radius * 0.82, pillarH * 0.5 + 0.2, Math.sin(a) * radius * 0.82);
    col.castShadow = true;
    g.add(col);
  }

  const cornice = new THREE.Mesh(new THREE.CylinderGeometry(radius * 1.18, radius * 1.0, 0.24, 8), marbleMat);
  cornice.position.y = pillarH + 0.3;
  cornice.castShadow = true;
  g.add(cornice);

  const miniDome = createOnionDome(radius * 0.92, radius * 1.15, domeMat, goldMat);
  miniDome.position.y = pillarH + 0.4;
  g.add(miniDome);

  return g;
}

/**
 * Raised White Marble Plinth / Terrace with blind arch moldings & front steps
 */
export function createPlinth(spec) {
  const group = new THREE.Group();
  const w = spec.width || 30;
  const h = spec.height || 2.6;
  const d = spec.depth || 24;

  const marbleMat = new THREE.MeshStandardMaterial({
    color: spec.wall_color || '#f3efe6',
    roughness: 0.45,
    metalness: 0.04,
  });
  const trimMat = new THREE.MeshStandardMaterial({
    color: spec.accent_color || '#d9d2c5',
    roughness: 0.65,
  });
  const recessMat = new THREE.MeshStandardMaterial({
    color: '#c9c1b2',
    roughness: 0.85,
  });

  // Main terrace block
  const block = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), marbleMat);
  block.position.y = h * 0.5;
  block.castShadow = true;
  block.receiveShadow = true;
  group.add(block);

  // Top marble cornice lip
  const lip = new THREE.Mesh(new THREE.BoxGeometry(w + 0.35, 0.22, d + 0.35), trimMat);
  lip.position.y = h - 0.11;
  lip.receiveShadow = true;
  group.add(lip);

  // Subtle decorative blind arches along front & back edges
  const archCount = Math.max(4, Math.floor(w / 2.6));
  const spacing = (w - 2.4) / archCount;
  for (let i = 0; i < archCount; i++) {
    const ax = -w * 0.5 + 1.2 + spacing * (i + 0.5);
    const nicheFront = new THREE.Mesh(new THREE.BoxGeometry(spacing * 0.62, h * 0.58, 0.14), recessMat);
    nicheFront.position.set(ax, h * 0.45, d * 0.5 + 0.02);
    const nicheBack = nicheFront.clone();
    nicheBack.position.z = -d * 0.5 - 0.02;
    group.add(nicheFront, nicheBack);
  }

  // Grand central marble entrance steps on front (+Z)
  for (let s = 0; s < 4; s++) {
    const stepH = h / 4;
    const step = new THREE.Mesh(new THREE.BoxGeometry(4.4 + s * 0.35, stepH, 0.65), marbleMat);
    step.position.set(0, h - stepH * (s + 0.5), d * 0.5 + 0.35 + s * 0.55);
    step.castShadow = true;
    step.receiveShadow = true;
    group.add(step);
  }

  group.position.set(spec.x, spec.elevation_y || 0, spec.z);
  group.rotation.y = spec.rotation_y || 0;
  return { group, windowMat: null, chimneyTop: null };
}

/**
 * Grand Mughal Mausoleum / Palace (Taj Mahal centerpiece!)
 */
export function createMausoleum(spec) {
  const group = new THREE.Group();
  const w = spec.width || 14.6;
  const h = spec.height || 9.8;
  const d = spec.depth || 14.6;

  const marbleMat = new THREE.MeshStandardMaterial({
    color: spec.wall_color || '#f3efe6',
    roughness: 0.42,
    metalness: 0.05,
  });
  const domeMat = new THREE.MeshStandardMaterial({
    color: spec.dome_color || '#faf7f0',
    roughness: 0.32,
    metalness: 0.06,
  });
  const trimMat = new THREE.MeshStandardMaterial({
    color: spec.accent_color || '#d8cbb5',
    roughness: 0.6,
  });
  const recessMat = new THREE.MeshStandardMaterial({
    color: '#6b6359',
    roughness: 0.92,
  });
  const deepRecessMat = new THREE.MeshStandardMaterial({
    color: '#3f3a34',
    roughness: 0.95,
  });
  const goldMat = new THREE.MeshStandardMaterial({
    color: '#eab308',
    metalness: 0.8,
    roughness: 0.25,
  });

  // Main marble body
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), marbleMat);
  body.position.y = h * 0.5;
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // Top parapet cornice
  const parapet = new THREE.Mesh(new THREE.BoxGeometry(w + 0.4, 0.55, d + 0.4), trimMat);
  parapet.position.y = h + 0.25;
  parapet.castShadow = true;
  group.add(parapet);

  // Build Pishtaq (grand central arched portal) + 2-tier flanking alcoves on all 4 facades
  const buildFacade = (rotY, faceSpan, faceDist) => {
    const fg = new THREE.Group();
    fg.rotation.y = rotY;

    // Projecting Pishtaq frame rising above main roofline
    const pW = faceSpan * 0.44;
    const pH = h * 1.18;
    const pishtaq = new THREE.Mesh(new THREE.BoxGeometry(pW, pH, 0.65), marbleMat);
    pishtaq.position.set(0, pH * 0.5, faceDist + 0.2);
    pishtaq.castShadow = true;
    pishtaq.receiveShadow = true;
    fg.add(pishtaq);

    // Pishtaq decorative border trim
    const pTop = new THREE.Mesh(new THREE.BoxGeometry(pW + 0.26, 0.32, 0.78), trimMat);
    pTop.position.set(0, pH + 0.14, faceDist + 0.22);
    fg.add(pTop);

    // Deep central recessed iwan arch
    const archW = pW * 0.66;
    const archH = h * 0.76;
    const iwanRect = new THREE.Mesh(new THREE.BoxGeometry(archW, archH * 0.68, 0.35), deepRecessMat);
    iwanRect.position.set(0, archH * 0.34, faceDist + 0.42);
    fg.add(iwanRect);

    const iwanTop = new THREE.Mesh(new THREE.CylinderGeometry(archW * 0.5, archW * 0.5, 0.35, 16), deepRecessMat);
    iwanTop.rotation.x = Math.PI / 2;
    iwanTop.position.set(0, archH * 0.68, faceDist + 0.42);
    fg.add(iwanTop);

    // Slender guldasta pinnacles flanking the pishtaq
    for (const side of [-1, 1]) {
      const gul = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, pH + 1.5, 8), marbleMat);
      gul.position.set(side * (pW * 0.5 + 0.12), (pH + 1.5) * 0.5, faceDist + 0.48);
      gul.castShadow = true;
      fg.add(gul);
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 8), goldMat);
      tip.position.set(side * (pW * 0.5 + 0.12), pH + 1.62, faceDist + 0.48);
      fg.add(tip);
    }

    // Flanking 2-tier arched alcoves (left & right of Pishtaq)
    for (const side of [-1, 1]) {
      const ax = side * (faceSpan * 0.34);
      for (const tierY of [h * 0.25, h * 0.68]) {
        const alc = new THREE.Mesh(new THREE.BoxGeometry(faceSpan * 0.16, h * 0.32, 0.24), recessMat);
        alc.position.set(ax, tierY, faceDist + 0.06);
        fg.add(alc);
        const alcArc = new THREE.Mesh(
          new THREE.CylinderGeometry(faceSpan * 0.08, faceSpan * 0.08, 0.24, 12),
          recessMat
        );
        alcArc.rotation.x = Math.PI / 2;
        alcArc.position.set(ax, tierY + h * 0.16, faceDist + 0.06);
        fg.add(alcArc);
      }
    }

    group.add(fg);
  };

  buildFacade(0, w, d * 0.5);
  buildFacade(Math.PI, w, d * 0.5);
  buildFacade(Math.PI / 2, d, w * 0.5);
  buildFacade(-Math.PI / 2, d, w * 0.5);

  // High Cylindrical Drum supporting the Grand Central Onion Dome
  const domeR = Math.min(w, d) * 0.32;
  const drumH = h * 0.28;
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(domeR * 0.92, domeR * 0.96, drumH, 28), marbleMat);
  drum.position.y = h + drumH * 0.5;
  drum.castShadow = true;
  drum.receiveShadow = true;
  group.add(drum);

  const drumBand = new THREE.Mesh(new THREE.TorusGeometry(domeR * 0.94, 0.12, 8, 28), trimMat);
  drumBand.rotation.x = Math.PI / 2;
  drumBand.position.y = h + drumH * 0.85;
  group.add(drumBand);

  const mainDome = createOnionDome(domeR, domeR * 1.48, domeMat, goldMat);
  mainDome.position.y = h + drumH - 0.1;
  group.add(mainDome);

  // 4 Corner Chhatri Domed Pavilions
  if (spec.has_chhatris !== false) {
    const chR = Math.min(w, d) * 0.125;
    const offX = w * 0.33;
    const offZ = d * 0.33;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const ch = createChhatri(chR, chR * 1.15, marbleMat, domeMat, goldMat);
        ch.position.set(sx * offX, h + 0.35, sz * offZ);
        group.add(ch);
      }
    }
  }

  group.position.set(spec.x, spec.elevation_y || 0, spec.z);
  group.rotation.y = spec.rotation_y || 0;
  return { group, windowMat: null, chimneyTop: null };
}

/**
 * Slender Tapering White Marble Minaret with Balconies & Chhatri Lantern Top
 */
export function createMinaret(spec) {
  const group = new THREE.Group();
  const baseR = (spec.width || 2.1) * 0.5;
  const h = spec.height || 13.5;
  const numBalconies = spec.num_balconies ?? 3;

  const marbleMat = new THREE.MeshStandardMaterial({
    color: spec.wall_color || '#f3efe6',
    roughness: 0.44,
    metalness: 0.04,
  });
  const domeMat = new THREE.MeshStandardMaterial({
    color: spec.dome_color || '#faf7f0',
    roughness: 0.34,
  });
  const trimMat = new THREE.MeshStandardMaterial({
    color: spec.accent_color || '#d8cbb5',
    roughness: 0.65,
  });
  const goldMat = new THREE.MeshStandardMaterial({
    color: '#eab308',
    metalness: 0.8,
    roughness: 0.25,
  });

  // Octagonal plinth base
  const octBase = new THREE.Mesh(new THREE.CylinderGeometry(baseR * 1.15, baseR * 1.25, 1.0, 8), marbleMat);
  octBase.position.y = 0.5;
  octBase.castShadow = true;
  octBase.receiveShadow = true;
  group.add(octBase);

  // Tapering main shaft
  const shaftH = h * 0.84;
  const topR = baseR * 0.62;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(topR, baseR, shaftH, 20), marbleMat);
  shaft.position.y = 1.0 + shaftH * 0.5;
  shaft.castShadow = true;
  shaft.receiveShadow = true;
  group.add(shaft);

  // Projecting circular balconies along shaft
  for (let i = 1; i <= numBalconies; i++) {
    const frac = i / (numBalconies + 0.25);
    const by = 1.0 + shaftH * frac;
    const rAtY = THREE.MathUtils.lerp(baseR, topR, frac);
    const balc = new THREE.Mesh(new THREE.CylinderGeometry(rAtY * 1.48, rAtY * 1.22, 0.32, 20), trimMat);
    balc.position.y = by;
    balc.castShadow = true;
    const rail = new THREE.Mesh(new THREE.TorusGeometry(rAtY * 1.44, 0.07, 8, 20), marbleMat);
    rail.rotation.x = Math.PI / 2;
    rail.position.y = by + 0.24;
    group.add(balc, rail);
  }

  // Top open chhatri lantern + mini onion dome
  const topLantern = createChhatri(topR * 1.15, topR * 1.8, marbleMat, domeMat, goldMat);
  topLantern.position.y = 1.0 + shaftH;
  group.add(topLantern);

  group.position.set(spec.x, spec.elevation_y || 0, spec.z);
  group.rotation.y = spec.rotation_y || 0;
  return { group, windowMat: null, chimneyTop: null };
}

/**
 * Red Sandstone Mosque / Jawab Pavilion with White Marble Trim & Triple Domes
 */
export function createMosque(spec) {
  const group = new THREE.Group();
  const w = spec.width || 15.0;
  const h = spec.height || 7.2;
  const d = spec.depth || 7.8;

  const wallMat = new THREE.MeshStandardMaterial({
    color: spec.wall_color || '#a35744',
    roughness: 0.82,
  });
  const trimMat = new THREE.MeshStandardMaterial({
    color: spec.accent_color || '#f3efe6',
    roughness: 0.45,
  });
  const domeMat = new THREE.MeshStandardMaterial({
    color: spec.dome_color || '#f6f2e9',
    roughness: 0.36,
  });
  const recessMat = new THREE.MeshStandardMaterial({ color: '#45241c', roughness: 0.95 });
  const goldMat = new THREE.MeshStandardMaterial({ color: '#eab308', metalness: 0.8, roughness: 0.25 });

  // Plinth base
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(w * 1.06, 0.9, d * 1.08), wallMat);
  plinth.position.y = 0.45;
  plinth.castShadow = true;
  plinth.receiveShadow = true;
  group.add(plinth);

  // Main sandstone hall
  const hall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
  hall.position.y = 0.9 + h * 0.5;
  hall.castShadow = true;
  hall.receiveShadow = true;
  group.add(hall);

  // White marble cornice band
  const band = new THREE.Mesh(new THREE.BoxGeometry(w + 0.25, 0.35, d + 0.25), trimMat);
  band.position.y = 0.9 + h;
  group.add(band);

  // Central Pishtaq portal + arch on front (+Z)
  const pW = w * 0.34;
  const pH = h * 1.18;
  const portal = new THREE.Mesh(new THREE.BoxGeometry(pW, pH, 0.6), wallMat);
  portal.position.set(0, 0.9 + pH * 0.5, d * 0.5 + 0.15);
  portal.castShadow = true;
  group.add(portal);

  const portalArch = new THREE.Mesh(new THREE.BoxGeometry(pW * 0.62, h * 0.72, 0.3), recessMat);
  portalArch.position.set(0, 0.9 + h * 0.36, d * 0.5 + 0.38);
  group.add(portalArch);

  // Flanking side arches
  for (const side of [-1, 1]) {
    const sArch = new THREE.Mesh(new THREE.BoxGeometry(w * 0.16, h * 0.52, 0.24), recessMat);
    sArch.position.set(side * w * 0.32, 0.9 + h * 0.26, d * 0.5 + 0.05);
    group.add(sArch);
  }

  // Triple White Marble Onion Domes (large central + 2 flanking)
  const mainDome = createOnionDome(d * 0.36, d * 0.54, domeMat, goldMat);
  mainDome.position.set(0, 0.9 + h + 0.1, 0);
  group.add(mainDome);

  for (const side of [-1, 1]) {
    const sideDome = createOnionDome(d * 0.22, d * 0.34, domeMat, goldMat);
    sideDome.position.set(side * w * 0.31, 0.9 + h + 0.1, 0);
    group.add(sideDome);
  }

  group.position.set(spec.x, spec.elevation_y || 0, spec.z);
  group.rotation.y = spec.rotation_y || 0;
  return { group, windowMat: null, chimneyTop: null };
}

/**
 * Monumental Stepped Limestone Pyramid (Khufu, Khafre with smooth capstone, Menkaure)
 */
export function createPyramid(spec) {
  const group = new THREE.Group();
  const w = spec.width || 18.0;
  const h = spec.height || 14.0;
  const d = spec.depth || 18.0;

  const stoneMat = new THREE.MeshStandardMaterial({
    color: spec.wall_color || '#b88a58',
    roughness: 0.92,
    metalness: 0.02,
    flatShading: true,
  });
  const altStoneMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(spec.wall_color || '#b88a58').multiplyScalar(0.93),
    roughness: 0.95,
    flatShading: true,
  });
  const capMat = new THREE.MeshStandardMaterial({
    color: spec.accent_color || '#e6cfa3',
    roughness: 0.72,
    metalness: 0.04,
    flatShading: true,
  });

  // Stepped limestone masonry courses (gives authentic Giza block texture & shadows!)
  const hasSmoothCap = Boolean(spec.has_chhatris);
  const steps = Math.max(8, Math.min(20, Math.round(h * 1.1)));
  const maxStep = hasSmoothCap ? Math.floor(steps * 0.74) : steps;
  const stepH = h / steps;

  for (let i = 0; i < maxStep; i++) {
    const frac = i / steps;
    const nextFrac = (i + 1) / steps;
    const curW = w * (1 - frac);
    const curD = d * (1 - frac);
    const tier = new THREE.Mesh(
      new THREE.BoxGeometry(curW, stepH * 1.04, curD),
      i % 2 === 0 ? stoneMat : altStoneMat
    );
    tier.position.y = (i + 0.5) * stepH;
    tier.castShadow = true;
    tier.receiveShadow = true;
    group.add(tier);
  }

  // Smooth Tura limestone casing capstone (e.g. Pyramid of Khafre!)
  if (hasSmoothCap) {
    const capBaseFrac = maxStep / steps;
    const capH = h * (1 - capBaseFrac);
    const capW = w * (1 - capBaseFrac);
    const capRadius = (capW * Math.SQRT2) / 2;
    const capGeo = new THREE.ConeGeometry(capRadius, capH, 4);
    capGeo.rotateY(Math.PI / 4);
    const cap = new THREE.Mesh(capGeo, capMat);
    cap.position.y = h * capBaseFrac + capH * 0.5;
    cap.castShadow = true;
    cap.receiveShadow = true;
    group.add(cap);
  }

  // Ancient entrance portal recess on front face
  const portal = new THREE.Mesh(
    new THREE.BoxGeometry(Math.max(1.0, w * 0.09), Math.max(1.2, h * 0.14), 0.7),
    new THREE.MeshStandardMaterial({ color: '#3b2c1e', roughness: 0.96 })
  );
  portal.position.set(0, h * 0.13, d * 0.44);
  group.add(portal);

  group.position.set(spec.x, spec.elevation_y || 0, spec.z);
  group.rotation.y = spec.rotation_y || 0;
  return { group, windowMat: null, chimneyTop: null };
}

/**
 * The Great Sphinx of Giza (reclining lion body, outstretched paws, Dream Stele, Nemes headdress)
 */
export function createSphinx(spec) {
  const group = new THREE.Group();
  const s = (spec.height || 4.4) / 4.4;

  const stoneMat = new THREE.MeshStandardMaterial({
    color: spec.wall_color || '#c99f6b',
    roughness: 0.9,
    flatShading: true,
  });
  const trimMat = new THREE.MeshStandardMaterial({
    color: spec.accent_color || '#e2c291',
    roughness: 0.85,
    flatShading: true,
  });

  // Plinth & reclining lion torso
  const body = new THREE.Mesh(new THREE.BoxGeometry(3.2 * s, 2.2 * s, 6.2 * s), stoneMat);
  body.position.set(0, 1.1 * s, -0.8 * s);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // Haunches
  const haunch = new THREE.Mesh(new THREE.BoxGeometry(3.5 * s, 1.8 * s, 2.2 * s), stoneMat);
  haunch.position.set(0, 0.9 * s, -3.2 * s);
  haunch.castShadow = true;
  group.add(haunch);

  // Two outstretched monumental front paws
  for (const side of [-1, 1]) {
    const paw = new THREE.Mesh(new THREE.BoxGeometry(1.0 * s, 0.9 * s, 3.6 * s), stoneMat);
    paw.position.set(side * 1.15 * s, 0.45 * s, 3.4 * s);
    paw.castShadow = true;
    paw.receiveShadow = true;
    group.add(paw);
  }

  // Dream Stele tablet between the paws
  const stele = new THREE.Mesh(new THREE.BoxGeometry(0.95 * s, 1.4 * s, 0.25 * s), trimMat);
  stele.position.set(0, 0.7 * s, 2.8 * s);
  stele.castShadow = true;
  group.add(stele);

  // Chest & Pharaoh head + iconic Nemes headdress
  const chest = new THREE.Mesh(new THREE.BoxGeometry(2.6 * s, 2.6 * s, 1.8 * s), stoneMat);
  chest.position.set(0, 1.6 * s, 1.6 * s);
  chest.castShadow = true;
  group.add(chest);

  const nemes = new THREE.Mesh(new THREE.CylinderGeometry(1.0 * s, 1.55 * s, 1.9 * s, 6), trimMat);
  nemes.position.set(0, 3.4 * s, 1.75 * s);
  nemes.castShadow = true;
  group.add(nemes);

  const face = new THREE.Mesh(new THREE.BoxGeometry(1.15 * s, 1.25 * s, 1.1 * s), stoneMat);
  face.position.set(0, 3.35 * s, 2.15 * s);
  face.castShadow = true;
  group.add(face);

  group.position.set(spec.x, spec.elevation_y || 0, spec.z);
  group.rotation.y = spec.rotation_y || 0;
  return { group, windowMat: null, chimneyTop: null };
}

/**
 * Ancient Egyptian Mortuary Temple / Mastaba Field Ruins
 */
export function createRuins(spec) {
  const group = new THREE.Group();
  const w = spec.width || 9.0;
  const h = spec.height || 2.2;
  const d = spec.depth || 7.5;

  const stoneMat = new THREE.MeshStandardMaterial({
    color: spec.wall_color || '#c29a6a',
    roughness: 0.94,
    flatShading: true,
  });
  const blockMat = new THREE.MeshStandardMaterial({
    color: spec.accent_color || '#dec094',
    roughness: 0.92,
    flatShading: true,
  });

  // Foundation slab
  const base = new THREE.Mesh(new THREE.BoxGeometry(w, 0.35, d), stoneMat);
  base.position.y = 0.175;
  base.receiveShadow = true;
  group.add(base);

  // Ruined perimeter walls & mastaba blocks
  const walls = [
    [-w * 0.44, h * 0.4, 0, 0.7, h * 0.8, d * 0.85],
    [w * 0.44, h * 0.3, -d * 0.15, 0.7, h * 0.6, d * 0.55],
    [0, h * 0.45, -d * 0.44, w * 0.88, h * 0.9, 0.7],
    [-w * 0.12, h * 0.35, d * 0.1, w * 0.32, h * 0.7, d * 0.25],
    [w * 0.18, h * 0.28, d * 0.2, w * 0.22, h * 0.56, d * 0.22],
  ];
  for (let i = 0; i < walls.length; i++) {
    const [px, py, pz, bw, bh, bd] = walls[i];
    const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), i % 2 === 0 ? stoneMat : blockMat);
    m.position.set(px, py + 0.3, pz);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  }

  // Weathered temple columns
  for (let c = 0; c < 4; c++) {
    const colH = h * (0.65 + (c % 2) * 0.35);
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.38, colH, 10), blockMat);
    col.position.set(-w * 0.25 + c * (w * 0.18), colH * 0.5 + 0.3, -d * 0.12);
    col.castShadow = true;
    group.add(col);
  }

  group.position.set(spec.x, spec.elevation_y || 0, spec.z);
  group.rotation.y = spec.rotation_y || 0;
  return { group, windowMat: null, chimneyTop: null };
}

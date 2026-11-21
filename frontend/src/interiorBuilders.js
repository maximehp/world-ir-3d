import * as THREE from 'three';

/**
 * Builds an octagonal room ring of 8 marble piers + upper arch lintels
 */
function buildOctagonRoom(radius, height, wallMat, trimMat, openDoorways = true) {
  const g = new THREE.Group();
  const sides = 8;
  const sideLen = 2 * radius * Math.sin(Math.PI / sides);

  for (let i = 0; i < sides; i++) {
    const angle = (i / sides) * Math.PI * 2 + Math.PI / sides;
    const cx = Math.cos(angle) * radius;
    const cz = Math.sin(angle) * radius;

    // Corner pier
    const pAngle = (i / sides) * Math.PI * 2;
    const pier = new THREE.Mesh(
      new THREE.BoxGeometry(0.42, height, 0.42),
      wallMat
    );
    pier.position.set(Math.cos(pAngle) * radius, height * 0.5, Math.sin(pAngle) * radius);
    pier.rotation.y = -pAngle;
    pier.castShadow = true;
    pier.receiveShadow = true;
    g.add(pier);

    // Upper spandrel / arch lintel between piers (leaves arched doorway open below)
    const lintelH = openDoorways ? height * 0.34 : height;
    const lintelY = openDoorways ? height - lintelH * 0.5 : height * 0.5;
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(sideLen * 0.86, lintelH, 0.28),
      i % 2 === 0 ? wallMat : trimMat
    );
    wall.position.set(cx, lintelY, cz);
    wall.rotation.y = -angle + Math.PI / 2;
    wall.castShadow = true;
    wall.receiveShadow = true;
    g.add(wall);
  }
  return g;
}

/**
 * Builds a stepped inlaid marble cenotaph (tomb monument)
 */
function buildCenotaph(scaleX, scaleY, scaleZ, marbleMat, inlayMat) {
  const g = new THREE.Group();
  const tier1 = new THREE.Mesh(new THREE.BoxGeometry(scaleX * 1.35, scaleY * 0.28, scaleZ * 1.25), marbleMat);
  tier1.position.y = scaleY * 0.14;
  tier1.castShadow = true;
  tier1.receiveShadow = true;

  const tier2 = new THREE.Mesh(new THREE.BoxGeometry(scaleX * 1.1, scaleY * 0.28, scaleZ * 1.05), inlayMat);
  tier2.position.y = scaleY * 0.42;
  tier2.castShadow = true;

  const top = new THREE.Mesh(new THREE.BoxGeometry(scaleX * 0.82, scaleY * 0.42, scaleZ * 0.85), marbleMat);
  top.position.y = scaleY * 0.76;
  top.castShadow = true;

  const ridge = new THREE.Mesh(
    new THREE.CylinderGeometry(scaleX * 0.16, scaleX * 0.22, scaleZ * 0.76, 8),
    inlayMat
  );
  ridge.rotation.x = Math.PI / 2;
  ridge.position.y = scaleY * 1.02;

  g.add(tier1, tier2, top, ridge);
  return g;
}

/**
 * Complete Taj Mahal / Hasht-Bihisht Internal Architecture:
 * - Double-Shelled Dome (inner vaulted dome + structural cavity + hanging brass chandelier)
 * - Hasht-Bihisht 9-Room Floor Plan (Central Octagonal Chamber + 4 Corner Octagonal Rooms + 4 Cardinal Rooms + Hallways)
 * - Carved Octagonal Marble Jali Screen + Twin Cenotaphs (Mumtaz Mahal & Shah Jahan)
 * - Underground Crypt Chamber + Descending Staircase + Lower Real Tombs
 */
export function buildHashtBihishtInterior(spec, interior) {
  const group = new THREE.Group();
  const w = spec.width || 14.6;
  const h = spec.height || 9.8;
  const d = spec.depth || 14.6;
  const minSpan = Math.min(w, d);

  const marbleMat = new THREE.MeshStandardMaterial({
    color: interior.marble_color || '#efe9dc',
    roughness: 0.42,
    metalness: 0.04,
    side: THREE.DoubleSide,
  });
  const vaultMat = new THREE.MeshStandardMaterial({
    color: interior.vault_color || '#dfd4be',
    roughness: 0.55,
    side: THREE.DoubleSide,
  });
  const floorMat = new THREE.MeshStandardMaterial({
    color: interior.floor_color || '#e5dcc8',
    roughness: 0.35,
    metalness: 0.08,
  });
  const darkTileMat = new THREE.MeshStandardMaterial({
    color: '#8c7e6a',
    roughness: 0.45,
  });
  const jaliMat = new THREE.MeshStandardMaterial({
    color: '#faf6ed',
    roughness: 0.35,
    transparent: true,
    opacity: 0.88,
  });
  const inlayMat = new THREE.MeshStandardMaterial({
    color: '#c4b193',
    roughness: 0.4,
  });
  const goldMat = new THREE.MeshStandardMaterial({
    color: '#f59e0b',
    emissive: '#d97706',
    emissiveIntensity: 0.45,
    metalness: 0.8,
    roughness: 0.25,
  });

  // 1. Main Interior Marble Floor Slab + Geometric Star Inlay Pattern
  const floorSlab = new THREE.Mesh(new THREE.BoxGeometry(w * 0.94, 0.16, d * 0.94), floorMat);
  floorSlab.position.y = 0.08;
  floorSlab.receiveShadow = true;
  group.add(floorSlab);

  const centerTile = new THREE.Mesh(new THREE.CylinderGeometry(minSpan * 0.24, minSpan * 0.24, 0.18, 8), darkTileMat);
  centerTile.position.y = 0.09;
  centerTile.receiveShadow = true;
  group.add(centerTile);

  // 2. Hasht-Bihisht 9-Room Floor Plan & Hallways
  if (interior.show_rooms !== false) {
    const roomGroup = new THREE.Group();
    const centralR = minSpan * 0.22;
    const chamberH = h * 0.88;

    // Central Two-Story Octagonal Sanctuary
    const centralOct = buildOctagonRoom(centralR, chamberH, marbleMat, vaultMat, true);
    roomGroup.add(centralOct);

    // Mid-height gallery cornice ring inside central chamber
    const galleryRing = new THREE.Mesh(new THREE.TorusGeometry(centralR * 0.96, 0.12, 8, 8), inlayMat);
    galleryRing.rotation.x = Math.PI / 2;
    galleryRing.position.y = chamberH * 0.52;
    roomGroup.add(galleryRing);

    // 4 Corner Octagonal Rooms (NW, NE, SW, SE) + Diagonal Connecting Hallways
    const cornerOffX = w * 0.31;
    const cornerOffZ = d * 0.31;
    const cornerR = minSpan * 0.115;
    const cornerH = h * 0.72;

    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const cRoom = buildOctagonRoom(cornerR, cornerH, marbleMat, vaultMat, true);
        cRoom.position.set(sx * cornerOffX, 0, sz * cornerOffZ);
        roomGroup.add(cRoom);

        // Diagonal hallway walls linking corner room to central octagon
        const diagAngle = Math.atan2(sz * cornerOffZ, sx * cornerOffX);
        const hallLen = Math.hypot(cornerOffX, cornerOffZ) - centralR - cornerR + 0.3;
        const midX = sx * cornerOffX * 0.54;
        const midZ = sz * cornerOffZ * 0.54;
        for (const side of [-1, 1]) {
          const hw = new THREE.Mesh(new THREE.BoxGeometry(hallLen, cornerH * 0.65, 0.18), vaultMat);
          const perpX = -Math.sin(diagAngle) * side * 0.58;
          const perpZ = Math.cos(diagAngle) * side * 0.58;
          hw.position.set(midX + perpX, cornerH * 0.325, midZ + perpZ);
          hw.rotation.y = -diagAngle;
          hw.receiveShadow = true;
          roomGroup.add(hw);
        }
      }
    }

    // 4 Cardinal Rectangular Vestibule Rooms (N, S, E, W) + Cardinal Hallways
    const cardDistX = w * 0.34;
    const cardDistZ = d * 0.34;
    const cardSpots = [
      [0, -cardDistZ, 0],
      [0, cardDistZ, Math.PI],
      [-cardDistX, 0, Math.PI / 2],
      [cardDistX, 0, -Math.PI / 2],
    ];
    for (const [cx, cz, ry] of cardSpots) {
      const vg = new THREE.Group();
      vg.position.set(cx, 0, cz);
      vg.rotation.y = ry;

      for (const side of [-1, 1]) {
        const sideWall = new THREE.Mesh(new THREE.BoxGeometry(0.24, cornerH * 0.8, minSpan * 0.17), marbleMat);
        sideWall.position.set(side * minSpan * 0.11, cornerH * 0.4, 0);
        sideWall.castShadow = true;
        sideWall.receiveShadow = true;
        vg.add(sideWall);
      }
      const vaultRoof = new THREE.Mesh(new THREE.BoxGeometry(minSpan * 0.24, 0.24, minSpan * 0.18), vaultMat);
      vaultRoof.position.y = cornerH * 0.82;
      vg.add(vaultRoof);

      roomGroup.add(vg);
    }

    group.add(roomGroup);
  }

  // 3. Double-Shelled Dome (Inner Vaulted Dome Shell + Structural Cavity + Hanging Brass Lamp)
  if (interior.show_double_dome !== false) {
    const domeGroup = new THREE.Group();
    const innerR = minSpan * 0.235;
    const innerH = h * 0.58;

    // Lower Inner Vaulted Dome Shell sitting directly over the Central Octagonal Chamber
    // (leaving the iconic hollow air cavity between this inner shell and the tall outer onion dome!)
    const innerPts = [
      new THREE.Vector2(innerR, 0),
      new THREE.Vector2(innerR * 0.96, innerH * 0.28),
      new THREE.Vector2(innerR * 0.82, innerH * 0.56),
      new THREE.Vector2(innerR * 0.54, innerH * 0.80),
      new THREE.Vector2(innerR * 0.22, innerH * 0.94),
      new THREE.Vector2(0.0, innerH),
    ];
    const innerDomeGeo = new THREE.LatheGeometry(innerPts, 24);
    const innerDome = new THREE.Mesh(innerDomeGeo, vaultMat);
    innerDome.position.y = h * 0.84;
    innerDome.castShadow = true;
    innerDome.receiveShadow = true;
    domeGroup.add(innerDome);

    // Structural radial masonry ribs inside the double-shell cavity
    for (let r = 0; r < 8; r++) {
      const ang = (r / 8) * Math.PI * 2;
      const rib = new THREE.Mesh(new THREE.BoxGeometry(0.18, innerH * 0.9, innerR * 0.22), inlayMat);
      rib.position.set(Math.cos(ang) * innerR * 0.84, h * 0.84 + innerH * 0.45, Math.sin(ang) * innerR * 0.84);
      rib.rotation.y = -ang;
      domeGroup.add(rib);
    }

    // Hanging Mughal Brass Chandelier descending from the inner dome apex into the Central Chamber
    const chainTopY = h * 0.84 + innerH * 0.95;
    const lampY = h * 0.58;
    const chainH = chainTopY - lampY;
    const chain = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, chainH, 6), goldMat);
    chain.position.y = lampY + chainH * 0.5;
    domeGroup.add(chain);

    const lantern = new THREE.Mesh(new THREE.OctahedronGeometry(0.42, 0), goldMat);
    lantern.scale.set(0.8, 1.35, 0.8);
    lantern.position.y = lampY;
    domeGroup.add(lantern);

    group.add(domeGroup);
  }

  // 4. Carved Octagonal Marble Jali Screen & Twin Cenotaphs (Mumtaz Mahal & Shah Jahan)
  if (interior.show_cenotaphs !== false) {
    const jaliGroup = new THREE.Group();
    const jaliR = minSpan * 0.145;
    const jaliH = 1.65;

    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2;
      // Corner post
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.09, jaliH + 0.25, 8), marbleMat);
      post.position.set(Math.cos(ang) * jaliR, (jaliH + 0.25) * 0.5 + 0.16, Math.sin(ang) * jaliR);
      jaliGroup.add(post);

      // Leave front (+Z) south entrance panel open for visitors
      const midAng = ang + Math.PI / 8;
      if (Math.sin(midAng) > 0.85) continue;

      const panelLen = 2 * jaliR * Math.sin(Math.PI / 8) * 0.9;
      const panel = new THREE.Mesh(new THREE.BoxGeometry(panelLen, jaliH * 0.85, 0.1), jaliMat);
      panel.position.set(Math.cos(midAng) * jaliR, jaliH * 0.45 + 0.16, Math.sin(midAng) * jaliR);
      panel.rotation.y = -midAng + Math.PI / 2;
      jaliGroup.add(panel);
    }

    // Mumtaz Mahal's Cenotaph (exact geometric center!)
    const mumtaz = buildCenotaph(0.75, 0.95, 1.55, marbleMat, inlayMat);
    mumtaz.position.set(0.25, 0.18, 0);
    jaliGroup.add(mumtaz);

    // Shah Jahan's Cenotaph (slightly larger & elevated to the west!)
    const shahJahan = buildCenotaph(0.92, 1.2, 1.85, marbleMat, inlayMat);
    shahJahan.position.set(-0.78, 0.18, 0);
    jaliGroup.add(shahJahan);

    group.add(jaliGroup);
  }

  // 5. Underground Crypt Chamber (inside the Marble Plinth below!) + Descending Staircase
  if (interior.show_crypt !== false) {
    const cryptGroup = new THREE.Group();
    const cryptH = Math.max(2.1, (spec.elevation_y || 2.6) - 0.25);
    const cryptW = minSpan * 0.36;
    const cryptD = minSpan * 0.36;
    const cryptFloorY = -cryptH;

    // Crypt floor
    const cFloor = new THREE.Mesh(new THREE.BoxGeometry(cryptW, 0.16, cryptD), darkTileMat);
    cFloor.position.y = cryptFloorY + 0.08;
    cFloor.receiveShadow = true;
    cryptGroup.add(cFloor);

    // Crypt back & side walls (open at front in cutaway!)
    const backWall = new THREE.Mesh(new THREE.BoxGeometry(cryptW, cryptH, 0.28), vaultMat);
    backWall.position.set(0, cryptFloorY + cryptH * 0.5, -cryptD * 0.5);
    const leftWall = new THREE.Mesh(new THREE.BoxGeometry(0.28, cryptH, cryptD), vaultMat);
    leftWall.position.set(-cryptW * 0.5, cryptFloorY + cryptH * 0.5, 0);
    const rightWall = leftWall.clone();
    rightWall.position.x = cryptW * 0.5;
    cryptGroup.add(backWall, leftWall, rightWall);

    // Vaulted crypt ceiling arch
    const cVault = new THREE.Mesh(
      new THREE.CylinderGeometry(cryptW * 0.42, cryptW * 0.48, 0.25, 8),
      inlayMat
    );
    cVault.position.y = -0.18;
    cryptGroup.add(cVault);

    // Lower Real Tombs directly beneath the upper cenotaphs!
    const lowerMumtaz = buildCenotaph(0.68, 0.72, 1.38, marbleMat, inlayMat);
    lowerMumtaz.position.set(0.25, cryptFloorY + 0.16, 0);
    const lowerShah = buildCenotaph(0.82, 0.9, 1.62, marbleMat, inlayMat);
    lowerShah.position.set(-0.72, cryptFloorY + 0.16, 0);
    cryptGroup.add(lowerMumtaz, lowerShah);

    // Descending Marble Staircase leading down from the front into the Crypt
    const numSteps = 8;
    for (let s = 0; s < numSteps; s++) {
      const frac = s / (numSteps - 1);
      const step = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.22, 0.48), marbleMat);
      step.position.set(
        cryptW * 0.28,
        THREE.MathUtils.lerp(-0.22, cryptFloorY + 0.25, frac),
        THREE.MathUtils.lerp(cryptD * 0.5 + 2.4, cryptD * 0.42, frac)
      );
      cryptGroup.add(step);
    }

    group.add(cryptGroup);
  }

  // 6. Warm Interior Architectural Lighting
  if (interior.show_lights !== false) {
    const chamberLight = new THREE.PointLight('#ffcf75', 22, minSpan * 1.4, 1.4);
    chamberLight.position.set(0, h * 0.54, 0);
    group.add(chamberLight);

    const domeCavityLight = new THREE.PointLight('#ffdca3', 14, minSpan, 1.5);
    domeCavityLight.position.set(0, h * 1.15, 0);
    group.add(domeCavityLight);

    if (interior.show_crypt !== false) {
      const cryptLight = new THREE.PointLight('#ffaa44', 12, minSpan * 0.8, 1.5);
      cryptLight.position.set(0, -1.1, 0);
      group.add(cryptLight);
    }
  }

  return group;
}

/**
 * Mosque Prayer Hall Interior (Colonnade + Mihrab Niche + Minbar + Prayer Carpet)
 */
export function buildMosqueInterior(spec, interior) {
  const group = new THREE.Group();
  const w = spec.width || 15.0;
  const h = spec.height || 7.2;
  const d = spec.depth || 7.8;

  const marbleMat = new THREE.MeshStandardMaterial({ color: interior.marble_color || '#efe9dc', roughness: 0.45 });
  const carpetMat = new THREE.MeshStandardMaterial({ color: '#991b1b', roughness: 0.9 });
  const goldMat = new THREE.MeshStandardMaterial({ color: '#eab308', metalness: 0.75, roughness: 0.3 });

  // Woven prayer carpet
  const carpet = new THREE.Mesh(new THREE.BoxGeometry(w * 0.88, 0.08, d * 0.82), carpetMat);
  carpet.position.y = 0.94;
  carpet.receiveShadow = true;
  group.add(carpet);

  // Interior colonnade piers
  for (const px of [-w * 0.28, 0, w * 0.28]) {
    for (const pz of [-d * 0.22, d * 0.22]) {
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.28, h * 0.88, 12), marbleMat);
      col.position.set(px, 0.9 + h * 0.44, pz);
      col.castShadow = true;
      group.add(col);
    }
  }

  // Ornate Mihrab prayer niche on back wall + stepped Minbar pulpit
  const mihrab = new THREE.Mesh(new THREE.BoxGeometry(2.2, h * 0.62, 0.45), marbleMat);
  mihrab.position.set(0, 0.9 + h * 0.31, -d * 0.44);
  const mihrabArch = new THREE.Mesh(new THREE.BoxGeometry(1.4, h * 0.48, 0.5), goldMat);
  mihrabArch.position.set(0, 0.9 + h * 0.24, -d * 0.42);
  group.add(mihrab, mihrabArch);

  if (interior.show_lights !== false) {
    const light = new THREE.PointLight('#ffd27d', 18, w * 1.3, 1.4);
    light.position.set(0, 0.9 + h * 0.7, 0);
    group.add(light);
  }

  return group;
}

/**
 * House / Cabin Interior (Hardwood Floor, Partition Wall, Table, Sofa, Warm Lamp)
 */
export function buildHouseInterior(spec, interior) {
  const group = new THREE.Group();
  const w = spec.width || 7.2;
  const h = spec.height || 4.8;
  const d = spec.depth || 6.0;

  const woodMat = new THREE.MeshStandardMaterial({ color: '#8b5a2b', roughness: 0.78 });
  const wallMat = new THREE.MeshStandardMaterial({ color: interior.marble_color || '#f5efe6', roughness: 0.85 });
  const sofaMat = new THREE.MeshStandardMaterial({ color: '#3b82f6', roughness: 0.85 });

  const floor = new THREE.Mesh(new THREE.BoxGeometry(w * 0.92, 0.12, d * 0.92), woodMat);
  floor.position.y = 0.42;
  floor.receiveShadow = true;
  group.add(floor);

  // Partition wall with open doorway
  const part = new THREE.Mesh(new THREE.BoxGeometry(0.18, h * 0.9, d * 0.55), wallMat);
  part.position.set(0, 0.42 + h * 0.45, -d * 0.16);
  group.add(part);

  // Table
  const tableTop = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.12, 1.1), woodMat);
  tableTop.position.set(w * 0.22, 1.35, 0);
  const tableLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 0.88, 8), woodMat);
  tableLeg.position.set(w * 0.22, 0.9, 0);
  group.add(tableTop, tableLeg);

  // Cozy sofa
  const sofaBase = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.55, 0.9), sofaMat);
  sofaBase.position.set(-w * 0.22, 0.72, -d * 0.24);
  const sofaBack = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.65, 0.24), sofaMat);
  sofaBack.position.set(-w * 0.22, 1.15, -d * 0.34);
  group.add(sofaBase, sofaBack);

  if (interior.show_lights !== false) {
    const lamp = new THREE.PointLight('#ffcf75', 14, w * 1.8, 1.5);
    lamp.position.set(0, h * 0.78, 0);
    group.add(lamp);
  }

  return group;
}

/**
 * Applies Cutaway Cross-Section, Floor Plan Slice, or X-Ray Ghost mode
 * cleanly to a building's exterior shell meshes!
 */
export function applyInteriorViewMode(exteriorGroup, spec, interior) {
  if (!interior || !interior.enabled) return null;

  const mode = interior.view_mode || 'cutaway';
  const ratio = interior.cutaway_ratio ?? 0.5;
  const w = spec.width || 14.6;
  const h = spec.height || 9.8;
  const d = spec.depth || 14.6;
  const elevY = spec.elevation_y || 0;

  let clipPlane = null;

  if (mode === 'cutaway') {
    // Vertical cross-section plane slicing from front (+Z) toward back (-Z)
    const sliceWorldZ = spec.z + (0.5 - ratio) * (d * 1.15);
    clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), sliceWorldZ);
  } else if (mode === 'floorplan') {
    // Horizontal floor plan slice cutting off dome & upper walls
    const sliceWorldY = elevY + h * (0.22 + (1.0 - ratio) * 0.58);
    clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), sliceWorldY);
  }

  exteriorGroup.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    // Clone material so clipping/xray doesn't affect other structures
    const mat = obj.material.clone();
    if (mode === 'xray') {
      mat.transparent = true;
      mat.opacity = 0.22;
      mat.depthWrite = false;
      mat.clippingPlanes = [];
    } else if (clipPlane) {
      mat.clippingPlanes = [clipPlane];
      mat.clipShadows = true;
      mat.side = THREE.DoubleSide;
    } else {
      mat.clippingPlanes = [];
    }
    obj.material = mat;
  });

  return { mode, clipPlane };
}

/**
 * Helper: Creates a crisp floating 3D architectural label sprite
 */
function createCalloutSprite(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 384;
  canvas.height = 76;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(15, 21, 33, 0.82)';
  ctx.strokeStyle = 'rgba(251, 191, 36, 0.85)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(6, 6, 372, 64, 14);
  ctx.fill();
  ctx.stroke();

  ctx.font = 'bold 26px Inter, Segoe UI, sans-serif';
  ctx.fillStyle = '#fef3c7';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 192, 39);

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(4.6, 0.92, 1);
  sprite.renderOrder = 999;
  return sprite;
}

/**
 * Helper: Hollow 3D open-front architectural chamber (floor, back wall, left/right walls, roof)
 */
function createHollowChamber(cw, ch, cd, wallMat, floorMat, gabledRoof = false) {
  const cg = new THREE.Group();
  const t = 0.22;

  const floor = new THREE.Mesh(new THREE.BoxGeometry(cw, t, cd), floorMat);
  floor.position.y = -ch * 0.5;
  floor.receiveShadow = true;

  const back = new THREE.Mesh(new THREE.BoxGeometry(cw, ch, t), wallMat);
  back.position.z = -cd * 0.5;

  const left = new THREE.Mesh(new THREE.BoxGeometry(t, ch, cd), wallMat);
  left.position.x = -cw * 0.5;

  const right = new THREE.Mesh(new THREE.BoxGeometry(t, ch, cd), wallMat);
  right.position.x = cw * 0.5;

  cg.add(floor, back, left, right);

  if (gabledRoof) {
    const roofL = new THREE.Mesh(new THREE.BoxGeometry(cw * 0.62, t, cd), wallMat);
    roofL.position.set(-cw * 0.24, ch * 0.62, 0);
    roofL.rotation.z = 0.55;
    const roofR = new THREE.Mesh(new THREE.BoxGeometry(cw * 0.62, t, cd), wallMat);
    roofR.position.set(cw * 0.24, ch * 0.62, 0);
    roofR.rotation.z = -0.55;
    cg.add(roofL, roofR);
  } else {
    const ceiling = new THREE.Mesh(new THREE.BoxGeometry(cw, t, cd), wallMat);
    ceiling.position.y = ch * 0.5;
    cg.add(ceiling);
  }
  return cg;
}

/**
 * Great Pyramid Complete Internal Architecture (Museum-Grade Cutaway):
 * - King's Chamber + Granite Sarcophagus + 5 Relieving Chambers + Gabled Cap
 * - Soaring Corbelled Grand Gallery
 * - Queen's Chamber (gabled ceiling + horizontal passage)
 * - Well Shaft (vertical escape shaft connecting Grand Gallery to Descending Passage)
 * - Descending Entrance Passage -> Bedrock Subterranean Chamber
 * - Twin Air / Star Shafts + Volumetric Golden Light Beams + 3D Callout Labels
 */
export function buildPyramidInterior(spec, interior) {
  const group = new THREE.Group();
  const w = spec.width || 19.5;
  const h = spec.height || 14.8;
  const d = spec.depth || 19.5;

  const stoneMat = new THREE.MeshStandardMaterial({
    color: interior.marble_color || '#d9bd8c',
    roughness: 0.72,
    side: THREE.DoubleSide,
  });
  const chamberMat = new THREE.MeshStandardMaterial({
    color: interior.vault_color || '#9e7447',
    roughness: 0.62,
    side: THREE.DoubleSide,
  });
  const darkBedrockMat = new THREE.MeshStandardMaterial({
    color: '#3c2e21',
    roughness: 0.92,
    side: THREE.DoubleSide,
  });
  const graniteMat = new THREE.MeshStandardMaterial({
    color: '#6b4230',
    roughness: 0.4,
    metalness: 0.15,
  });
  const passageGlowMat = new THREE.MeshStandardMaterial({
    color: '#eab308',
    emissive: '#f59e0b',
    emissiveIntensity: 0.55,
    roughness: 0.45,
  });
  const beamMat = new THREE.MeshBasicMaterial({
    color: '#ffe08a',
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const addPassage = (p1, p2, pw, ph, mat) => {
    const dir = new THREE.Vector3().subVectors(p2, p1);
    const len = dir.length();
    const mid = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(pw, ph, len), mat);
    mesh.position.copy(mid);
    mesh.lookAt(p2);
    mesh.castShadow = true;
    group.add(mesh);
  };

  const addLightBeam = (origin, targetOffset, radiusTop, radiusBot) => {
    const dir = targetOffset.clone();
    const len = dir.length();
    const cone = new THREE.Mesh(new THREE.CylinderGeometry(radiusTop, radiusBot, len, 14, 1, true), beamMat);
    cone.position.copy(origin).addScaledVector(dir, 0.5);
    cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir.normalize());
    group.add(cone);
  };

  // Key 3D coordinates inside the Pyramid cross-section (spread along X so front cutaway shows full profile!)
  const entrance = new THREE.Vector3(w * 0.38, h * 0.17, 0);
  const junction = new THREE.Vector3(w * 0.18, h * 0.11, 0);
  const subPos = new THREE.Vector3(-w * 0.08, -1.3, 0);
  const galleryStart = new THREE.Vector3(w * 0.09, h * 0.25, 0);
  const galleryEnd = new THREE.Vector3(-w * 0.05, h * 0.46, 0);
  const queensPos = new THREE.Vector3(-w * 0.06, h * 0.25, 0);
  const kingsPos = new THREE.Vector3(-w * 0.14, h * 0.48, 0);
  const wellBottom = new THREE.Vector3(w * 0.04, -0.55, 0);

  // 1. Descending Entrance Passage -> Bedrock Subterranean Chamber
  addPassage(entrance, junction, 0.55, 0.55, chamberMat);
  if (interior.show_crypt !== false) {
    addPassage(junction, subPos, 0.5, 0.5, darkBedrockMat);
    const subChamber = createHollowChamber(w * 0.24, 1.9, d * 0.18, darkBedrockMat, darkBedrockMat, false);
    subChamber.position.copy(subPos);
    group.add(subChamber);

    if (interior.show_lights !== false) {
      addLightBeam(subPos, new THREE.Vector3(1.8, -0.4, 2.2), 0.35, 1.6);
    }
    const lblSub = createCalloutSprite('Subterranean Chamber');
    lblSub.position.set(subPos.x - 2.4, subPos.y - 0.5, 2.2);
    group.add(lblSub);
  }

  // 2. Ascending Passage -> Horizontal Passage -> Queen's Chamber (gabled roof!)
  addPassage(junction, galleryStart, 0.58, 0.62, stoneMat);
  if (interior.show_rooms !== false) {
    addPassage(galleryStart, queensPos, 0.52, 0.55, stoneMat);
    const qChamber = createHollowChamber(w * 0.17, h * 0.13, d * 0.16, chamberMat, stoneMat, true);
    qChamber.position.copy(queensPos);
    group.add(qChamber);

    if (interior.show_lights !== false) {
      addLightBeam(queensPos, new THREE.Vector3(2.4, -0.6, 2.0), 0.35, 1.7);
    }
    const lblQ = createCalloutSprite("Queen's Chamber");
    lblQ.position.set(queensPos.x - 3.6, queensPos.y + 0.3, 1.8);
    group.add(lblQ);
  }

  // 3. Well Shaft (Vertical / Curved Escape Shaft from Grand Gallery to Descending Passage!)
  addPassage(galleryStart, new THREE.Vector3(w * 0.07, h * 0.11, 0), 0.34, 0.34, passageGlowMat);
  addPassage(new THREE.Vector3(w * 0.07, h * 0.11, 0), wellBottom, 0.34, 0.34, passageGlowMat);
  const lblShaft = createCalloutSprite('Well Shaft');
  lblShaft.position.set(w * 0.11, h * 0.11, 2.0);
  group.add(lblShaft);

  // 4. Soaring Corbelled Grand Gallery (stepped high ceiling!)
  addPassage(galleryStart, galleryEnd, 1.05, 1.65, stoneMat);
  // Subtle golden inner glow strip along Grand Gallery floor
  addPassage(
    galleryStart.clone().add(new THREE.Vector3(0, -0.5, 0.15)),
    galleryEnd.clone().add(new THREE.Vector3(0, -0.5, 0.15)),
    0.35,
    0.12,
    passageGlowMat
  );
  const lblGG = createCalloutSprite('Grand Gallery');
  lblGG.position.set(w * 0.16, h * 0.44, 1.8);
  group.add(lblGG);

  // 5. King's Chamber + Granite Sarcophagus + 5 Relieving Chambers + Gabled Cap
  const kW = w * 0.21;
  const kH = h * 0.15;
  const kD = d * 0.16;
  const kChamber = createHollowChamber(kW, kH, kD, graniteMat, graniteMat, false);
  kChamber.position.copy(kingsPos);
  group.add(kChamber);

  if (interior.show_cenotaphs !== false) {
    const sarcophagus = new THREE.Mesh(new THREE.BoxGeometry(kW * 0.42, kH * 0.38, kD * 0.42), graniteMat);
    sarcophagus.position.set(kingsPos.x - kW * 0.14, kingsPos.y - kH * 0.26, kingsPos.z);
    sarcophagus.castShadow = true;
    group.add(sarcophagus);
  }

  if (interior.show_lights !== false) {
    addLightBeam(kingsPos, new THREE.Vector3(2.8, -1.0, 2.4), 0.4, 2.0);
  }
  const lblK = createCalloutSprite("King's Chamber");
  lblK.position.set(kingsPos.x - 3.6, kingsPos.y + 1.8, 1.8);
  group.add(lblK);

  // 5 Relieving Chambers stacked above King's Chamber + Air/Star Shafts
  if (interior.show_double_dome !== false) {
    for (let r = 0; r < 4; r++) {
      const rel = new THREE.Mesh(new THREE.BoxGeometry(kW * 0.92, kH * 0.22, kD * 0.85), stoneMat);
      rel.position.set(kingsPos.x, kingsPos.y + kH * 0.65 + r * (kH * 0.28), kingsPos.z);
      group.add(rel);
    }
    // Air / Star Shafts from King's Chamber & Queen's Chamber angling to outer pyramid faces
    addPassage(kingsPos, new THREE.Vector3(w * 0.16, h * 0.72, 0), 0.16, 0.16, passageGlowMat);
    addPassage(kingsPos, new THREE.Vector3(-w * 0.34, h * 0.70, 0), 0.16, 0.16, passageGlowMat);
    addPassage(queensPos, new THREE.Vector3(w * 0.22, h * 0.48, 0), 0.14, 0.14, passageGlowMat);
    addPassage(queensPos, new THREE.Vector3(-w * 0.30, h * 0.46, 0), 0.14, 0.14, passageGlowMat);
  }

  // 6. Warm Interior Torchlight PointLights
  if (interior.show_lights !== false) {
    const kLight = new THREE.PointLight('#ffcc66', 28, w * 1.1, 1.3);
    kLight.position.set(kingsPos.x, kingsPos.y, kingsPos.z + 0.5);
    const qLight = new THREE.PointLight('#ffaa44', 20, w * 0.8, 1.4);
    qLight.position.set(queensPos.x, queensPos.y, queensPos.z + 0.5);
    const sLight = new THREE.PointLight('#ff9933', 16, w * 0.6, 1.5);
    sLight.position.set(subPos.x, subPos.y + 0.3, subPos.z + 0.8);
    group.add(kLight, qLight, sLight);
  }

  return group;
}

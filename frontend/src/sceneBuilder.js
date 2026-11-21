import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import {
  createMausoleum,
  createMinaret,
  createMosque,
  createPlinth,
  createPyramid,
  createRuins,
  createSphinx,
} from './architecturalBuilders.js';
import {
  applyInteriorViewMode,
  buildHashtBihishtInterior,
  buildHouseInterior,
  buildMosqueInterior,
  buildPyramidInterior,
} from './interiorBuilders.js';

const MAX_RIPPLES = 6;

function project2DTo3D(u, v, depthZ) {
  const depthScale = 1.0 + Math.max(-0.35, -depthZ * 0.015);
  const x = (u - 0.5) * 50.0 * depthScale;
  const y = Math.max(1.2, (0.64 - v) * 34.0 + 3.2);
  return new THREE.Vector3(x, y, depthZ);
}

function createSkyDome(topHex, bottomHex) {
  const geo = new THREE.SphereGeometry(185, 36, 24);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTopColor: { value: new THREE.Color(topHex) },
      uBottomColor: { value: new THREE.Color(bottomHex) },
      uSunDir: { value: new THREE.Vector3(0.4, 0.5, -0.7).normalize() },
      uSunColor: { value: new THREE.Color('#ffe87c') },
    },
    vertexShader: `
      varying vec3 vWorldPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform vec3 uTopColor;
      uniform vec3 uBottomColor;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      varying vec3 vWorldPos;
      void main() {
        vec3 dir = normalize(vWorldPos);
        float h = clamp(dir.y * 1.45 + 0.08, 0.0, 1.0);
        vec3 col = mix(uBottomColor, uTopColor, pow(h, 0.72));
        float sunDot = max(dot(dir, normalize(uSunDir)), 0.0);
        col += uSunColor * pow(sunDot, 28.0) * 0.38;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  return { mesh: new THREE.Mesh(geo, mat), mat };
}

/**
 * 3D Volumetric Pond with carved bank, shoreline pebbles, submerged bed,
 * and custom GLSL animated rippling water surface
 */
function createWaterMesh(spec) {
  const group = new THREE.Group();
  group.position.set(spec.x, 0, spec.z);

  const rx = spec.radius_x || 8;
  const rz = spec.radius_z || 5;
  const isRect = spec.shape === 'rectangle';
  const fountainJets = [];

  if (isRect) {
    // Formal rectangular marble reflecting pool basin
    const marbleRimMat = new THREE.MeshStandardMaterial({
      color: spec.shore_color || '#f3efe6',
      roughness: 0.45,
    });
    const bed = new THREE.Mesh(
      new THREE.BoxGeometry(rx * 2, 0.25, rz * 2),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(spec.water_color || '#4a89a8').multiplyScalar(0.5),
        roughness: 0.9,
      })
    );
    bed.position.y = -0.05;
    bed.receiveShadow = true;
    group.add(bed);

    const rimThick = 0.42;
    const rimH = 0.28;
    const leftRim = new THREE.Mesh(new THREE.BoxGeometry(rimThick, rimH, rz * 2 + rimThick * 2), marbleRimMat);
    leftRim.position.set(-rx - rimThick * 0.5, rimH * 0.5, 0);
    const rightRim = leftRim.clone();
    rightRim.position.x = rx + rimThick * 0.5;
    const topRim = new THREE.Mesh(new THREE.BoxGeometry(rx * 2, rimH, rimThick), marbleRimMat);
    topRim.position.set(0, rimH * 0.5, -rz - rimThick * 0.5);
    const botRim = topRim.clone();
    botRim.position.z = rz + rimThick * 0.5;
    for (const r of [leftRim, rightRim, topRim, botRim]) {
      r.castShadow = true;
      r.receiveShadow = true;
      group.add(r);
    }

    // Animated 3D Fountain Jets down the centerline
    if (spec.has_fountains) {
      const count = Math.max(1, spec.fountain_count || 7);
      const jetMat = new THREE.MeshStandardMaterial({
        color: '#e0f4ff',
        emissive: '#93c5fd',
        emissiveIntensity: 0.2,
        transparent: true,
        opacity: 0.72,
        roughness: 0.15,
      });
      const sprayMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.8 });
      const nozzleMat = new THREE.MeshStandardMaterial({ color: '#d8cbb5', roughness: 0.5 });

      for (let i = 0; i < count; i++) {
        const fz = -rz * 0.82 + (i / Math.max(1, count - 1)) * (rz * 1.64);
        const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, 0.24, 10), nozzleMat);
        nozzle.position.set(0, 0.14, fz);
        group.add(nozzle);

        const plume = new THREE.Mesh(new THREE.ConeGeometry(0.28, 1.5, 10), jetMat);
        plume.rotation.x = Math.PI;
        plume.position.set(0, 1.0, fz);
        group.add(plume);

        const crown = new THREE.Mesh(new THREE.SphereGeometry(0.32, 10, 8), sprayMat);
        crown.position.set(0, 1.8, fz);
        group.add(crown);

        fountainJets.push({ plume, crown, baseZ: fz, phase: i * 0.9 });
      }
    }
  } else {
    // Submerged dark pond bed
    const bedGeo = new THREE.CylinderGeometry(0.98, 0.78, 0.45, 48);
    const bedMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(spec.water_color || '#4f94c4').multiplyScalar(0.45),
      roughness: 0.95,
    });
    const bed = new THREE.Mesh(bedGeo, bedMat);
    bed.scale.set(rx, 1, rz);
    bed.position.y = -0.18;
    bed.receiveShadow = true;
    group.add(bed);

    // 3D raised grassy/earthen shoreline torus bank
    const bankGeo = new THREE.TorusGeometry(1.01, 0.055, 10, 56);
    bankGeo.rotateX(Math.PI / 2);
    const bankMat = new THREE.MeshStandardMaterial({
      color: '#486e3b',
      roughness: 0.92,
    });
    const bank = new THREE.Mesh(bankGeo, bankMat);
    bank.scale.set(rx, 1.6, rz);
    bank.position.y = 0.06;
    bank.castShadow = true;
    bank.receiveShadow = true;
    group.add(bank);

    // 3D shoreline stones / pebbles around the pond perimeter
    const stoneMat = new THREE.MeshStandardMaterial({ color: '#8d99a6', roughness: 0.88, flatShading: true });
    const stoneCount = 14;
    for (let i = 0; i < stoneCount; i++) {
      const angle = (i / stoneCount) * Math.PI * 2 + (i % 3) * 0.14;
      const stone = new THREE.Mesh(new THREE.DodecahedronGeometry(0.28 + (i % 3) * 0.1, 0), stoneMat);
      stone.scale.set(1.2, 0.65, 1.0);
      stone.position.set(Math.cos(angle) * rx * 1.02, 0.12, Math.sin(angle) * rz * 1.02);
      stone.rotation.y = angle;
      stone.castShadow = true;
      stone.receiveShadow = true;
      group.add(stone);
    }
  }

  // Animated GLSL water surface
  const geo = isRect ? new THREE.PlaneGeometry(2, 2, 24, 48) : new THREE.CircleGeometry(0.99, 64);
  geo.rotateX(-Math.PI / 2);

  const rippleOrigins = [];
  const rippleTimes = [];
  for (let i = 0; i < MAX_RIPPLES; i++) {
    rippleOrigins.push(new THREE.Vector2(999, 999));
    rippleTimes.push(-99.0);
  }

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    uniforms: {
      uTime: { value: 0 },
      uWind: { value: 0.7 },
      uRippleAmp: { value: spec.ripple_intensity ?? 0.65 },
      uWaterColor: { value: new THREE.Color(spec.water_color || '#4f94c4') },
      uShoreColor: { value: new THREE.Color(spec.shore_color || '#d9ecfa') },
      uSunDir: { value: new THREE.Vector3(0.4, 0.6, -0.6).normalize() },
      uRippleOrigins: { value: rippleOrigins },
      uRippleTimes: { value: rippleTimes },
    },
    vertexShader: `
      uniform float uTime;
      uniform float uWind;
      uniform float uRippleAmp;
      varying vec2 vLocalPos;
      void main() {
        vLocalPos = position.xz;
        float dist = length(position.xz);
        float wave = sin(dist * 14.0 - uTime * (2.2 + uWind * 1.5)) * 0.055 * uRippleAmp * (1.0 - smoothstep(0.75, 1.0, dist));
        wave += cos(position.x * 10.0 + uTime * 1.8) * 0.025 * uWind * uRippleAmp;
        vec3 pos = position;
        pos.y += wave;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uWind;
      uniform float uRippleAmp;
      uniform vec3 uWaterColor;
      uniform vec3 uShoreColor;
      uniform vec3 uSunDir;
      uniform vec2 uRippleOrigins[${MAX_RIPPLES}];
      uniform float uRippleTimes[${MAX_RIPPLES}];
      varying vec2 vLocalPos;

      void main() {
        float dist = length(vLocalPos);
        vec3 col = mix(uWaterColor * 0.84, uWaterColor * 1.12, smoothstep(0.0, 0.92, dist));

        float r1 = sin(vLocalPos.x * 18.0 + uTime * 2.1 + sin(vLocalPos.y * 12.0 + uTime)) * 0.5 + 0.5;
        float r2 = sin(dist * 22.0 - uTime * (2.6 + uWind)) * 0.5 + 0.5;
        float shimmer = smoothstep(0.70, 0.98, r1 * r2) * (0.16 + 0.16 * uWind) * uRippleAmp;
        col += vec3(0.76, 0.92, 1.0) * shimmer;

        float clickRipple = 0.0;
        for (int i = 0; i < ${MAX_RIPPLES}; i++) {
          float age = uTime - uRippleTimes[i];
          if (age > 0.0 && age < 3.2) {
            float d = length(vLocalPos - uRippleOrigins[i]);
            float radius = age * 0.48;
            float ring = exp(-pow((d - radius) * 26.0, 2.0)) * (1.0 - age / 3.2);
            float ring2 = exp(-pow((d - radius * 0.72) * 32.0, 2.0)) * (1.0 - age / 3.2) * 0.6;
            clickRipple += (ring + ring2);
          }
        }
        col = mix(col, vec3(0.93, 0.98, 1.0), clamp(clickRipple * 0.85, 0.0, 0.9));

        float shoreOuter = smoothstep(0.90, 0.95, dist) * (1.0 - smoothstep(0.97, 1.0, dist));
        float shoreInner = smoothstep(0.83, 0.86, dist + sin(atan(vLocalPos.y, vLocalPos.x) * 8.0 + uTime * 1.4) * 0.014)
                         * (1.0 - smoothstep(0.86, 0.89, dist));
        col = mix(col, uShoreColor, clamp(shoreOuter * 0.85 + shoreInner * 0.28, 0.0, 1.0));

        float glint = smoothstep(0.82, 0.99, sin(vLocalPos.x * 26.0 + vLocalPos.y * 14.0 + uTime * 3.2) * 0.5 + 0.5);
        col += vec3(1.0, 0.96, 0.82) * glint * 0.16 * max(uSunDir.y, 0.1);

        gl_FragColor = vec4(col, 0.90);
      }
    `,
  });

  const waterMesh = new THREE.Mesh(geo, mat);
  waterMesh.scale.set(rx, 1, rz);
  waterMesh.position.y = isRect ? 0.16 : 0.11;
  waterMesh.receiveShadow = true;
  waterMesh.userData = { isWater: true, nextRippleIdx: 0, spec };
  group.add(waterMesh);

  return { group, mesh: waterMesh, mat, fountainJets };
}

/**
 * 3D Sculpted Mountain Peak with secondary foothills + optional snow cap
 */
function createMountain(spec) {
  const group = new THREE.Group();
  group.position.set(spec.x, 0, spec.z);

  const h = spec.height || 12;
  const r = spec.radius || 12;

  const geo = new THREE.ConeGeometry(r, h, 8, 4);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y > -h * 0.45 && y < h * 0.44) {
      const jitter = Math.sin(pos.getX(i) * 0.65 + pos.getZ(i) * 0.85) * r * 0.07;
      pos.setX(i, pos.getX(i) + jitter);
      pos.setZ(i, pos.getZ(i) - jitter * 0.75);
    }
  }
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    color: spec.color || '#6d9886',
    roughness: 0.9,
    metalness: 0.02,
    flatShading: true,
  });

  const peak = new THREE.Mesh(geo, mat);
  peak.position.y = h * 0.5 - 0.2;
  peak.castShadow = true;
  peak.receiveShadow = true;
  group.add(peak);

  // Secondary rocky shoulder for richer 3D silhouette
  const shoulder = new THREE.Mesh(
    new THREE.ConeGeometry(r * 0.58, h * 0.55, 7, 2),
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(spec.color || '#6d9886').multiplyScalar(0.9),
      roughness: 0.92,
      flatShading: true,
    })
  );
  shoulder.position.set(r * 0.36, h * 0.25, r * 0.22);
  shoulder.castShadow = true;
  shoulder.receiveShadow = true;
  group.add(shoulder);

  if (spec.snow_cap) {
    const capGeo = new THREE.ConeGeometry(r * 0.36, h * 0.36, 8);
    const capMat = new THREE.MeshStandardMaterial({ color: '#f1f7fb', roughness: 0.7, flatShading: true });
    const cap = new THREE.Mesh(capGeo, capMat);
    cap.position.y = h * 0.81;
    cap.castShadow = true;
    group.add(cap);
  }

  return group;
}

/**
 * 3D Raised Extruded Ground Path with subtle thickness & border stones
 */
function createPath(spec) {
  if (!spec.points || spec.points.length < 2) return null;
  const group = new THREE.Group();
  const pts = spec.points.map((p) => new THREE.Vector3(p.x, 0.08, p.z));
  const curve = new THREE.CatmullRomCurve3(pts);
  const samples = curve.getPoints(36);

  const halfW = (spec.width || 3.2) * 0.5;
  const thickness = 0.14;
  const positions = [];
  const indices = [];

  // Build 3D prism ribbon (top + left side + right side)
  for (let i = 0; i < samples.length; i++) {
    const p = samples[i];
    const next = samples[Math.min(samples.length - 1, i + 1)];
    const prev = samples[Math.max(0, i - 1)];
    const tangent = new THREE.Vector3().subVectors(next, prev).normalize();
    const perp = new THREE.Vector3(-tangent.z, 0, tangent.x).multiplyScalar(halfW);

    // 4 vertices per cross-section: left-bottom, left-top, right-top, right-bottom
    positions.push(p.x - perp.x * 1.06, 0.0, p.z - perp.z * 1.06);
    positions.push(p.x - perp.x, thickness, p.z - perp.z);
    positions.push(p.x + perp.x, thickness, p.z + perp.z);
    positions.push(p.x + perp.x * 1.06, 0.0, p.z + perp.z * 1.06);

    if (i < samples.length - 1) {
      const a = i * 4;
      const b = (i + 1) * 4;
      // Left bevel
      indices.push(a + 0, b + 0, a + 1, a + 1, b + 0, b + 1);
      // Top surface
      indices.push(a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
      // Right bevel
      indices.push(a + 2, b + 2, a + 3, a + 3, b + 2, b + 3);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    color: spec.color || '#c9b38c',
    roughness: 0.94,
    metalness: 0.0,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return group;
}

/**
 * Richly Detailed 3D House / Structure with stone plinth, gable overhang,
 * recessed door, framed mullion windows, and chimney
 */
function createStructure(spec) {
  if (spec.kind === 'plinth') return createPlinth(spec);
  if (spec.kind === 'mausoleum' || spec.kind === 'palace') return createMausoleum(spec);
  if (spec.kind === 'minaret' || spec.kind === 'tower') return createMinaret(spec);
  if (spec.kind === 'mosque' || spec.kind === 'pavilion') return createMosque(spec);
  if (spec.kind === 'pyramid') return createPyramid(spec);
  if (spec.kind === 'sphinx') return createSphinx(spec);
  if (spec.kind === 'ruins') return createRuins(spec);

  const group = new THREE.Group();
  const w = spec.width || 7.2;
  const h = spec.height || 4.8;
  const d = spec.depth || 6.0;

  // Stone foundation plinth
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(w * 1.05, 0.42, d * 1.05),
    new THREE.MeshStandardMaterial({ color: '#7a7d82', roughness: 0.95 })
  );
  base.position.y = 0.21;
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);

  // Main walls
  const wallMat = new THREE.MeshStandardMaterial({
    color: spec.wall_color || '#f0deb4',
    roughness: 0.84,
  });
  const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
  wall.position.y = h * 0.5 + 0.35;
  wall.castShadow = true;
  wall.receiveShadow = true;
  group.add(wall);

  // Roof
  const roofMat = new THREE.MeshStandardMaterial({
    color: spec.roof_color || '#b84b39',
    roughness: 0.76,
    flatShading: true,
  });
  const roofH = h * 0.68;
  const roofY = h + 0.32;

  if (spec.roof_style === 'flat') {
    const roof = new THREE.Mesh(new THREE.BoxGeometry(w * 1.1, 0.55, d * 1.1), roofMat);
    roof.position.y = roofY + 0.25;
    roof.castShadow = true;
    group.add(roof);
  } else if (spec.roof_style === 'pyramid') {
    const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.84, roofH, 4), roofMat);
    roof.rotation.y = Math.PI / 4;
    roof.position.y = roofY + roofH * 0.5;
    roof.castShadow = true;
    group.add(roof);
  } else {
    const shape = new THREE.Shape();
    const hw = w * 0.6;
    shape.moveTo(-hw, 0);
    shape.lineTo(0, roofH);
    shape.lineTo(hw, 0);
    shape.closePath();

    const roofGeo = new THREE.ExtrudeGeometry(shape, {
      depth: d * 1.14,
      bevelEnabled: true,
      bevelThickness: 0.08,
      bevelSize: 0.06,
      bevelSegments: 2,
    });
    roofGeo.translate(0, 0, -d * 0.57);
    const roof = new THREE.Mesh(roofGeo, roofMat);
    roof.position.y = roofY - 0.04;
    roof.castShadow = true;
    roof.receiveShadow = true;
    group.add(roof);
  }

  // Front Door + frame + brass knob + doorstep
  const doorW = w * 0.24;
  const doorH = h * 0.52;
  const frameMat = new THREE.MeshStandardMaterial({ color: '#4c3a2b', roughness: 0.9 });
  const doorMat = new THREE.MeshStandardMaterial({ color: spec.door_color || '#6e442c', roughness: 0.78 });

  const doorFrame = new THREE.Mesh(new THREE.BoxGeometry(doorW + 0.28, doorH + 0.16, 0.22), frameMat);
  doorFrame.position.set(w * 0.14, doorH * 0.5 + 0.35, d * 0.5 + 0.04);
  group.add(doorFrame);

  const door = new THREE.Mesh(new THREE.BoxGeometry(doorW, doorH, 0.26), doorMat);
  door.position.set(w * 0.14, doorH * 0.5 + 0.35, d * 0.5 + 0.06);
  door.castShadow = true;
  group.add(door);

  const knob = new THREE.Mesh(
    new THREE.SphereGeometry(0.08, 10, 8),
    new THREE.MeshStandardMaterial({ color: '#eab308', metalness: 0.7, roughness: 0.3 })
  );
  knob.position.set(w * 0.14 + doorW * 0.32, doorH * 0.48 + 0.35, d * 0.5 + 0.22);
  group.add(knob);

  const step = new THREE.Mesh(
    new THREE.BoxGeometry(doorW + 0.7, 0.25, 0.8),
    new THREE.MeshStandardMaterial({ color: '#94989e', roughness: 0.92 })
  );
  step.position.set(w * 0.14, 0.125, d * 0.5 + 0.45);
  step.receiveShadow = true;
  group.add(step);

  // 3D Framed Windows with crossbars + warm emissive glow at dusk/night
  const windowMat = new THREE.MeshStandardMaterial({
    color: spec.window_color || '#8fd3f4',
    emissive: new THREE.Color('#ffba52'),
    emissiveIntensity: 0.0,
    roughness: 0.2,
    metalness: 0.15,
  });

  const winW = w * 0.24;
  const winH = h * 0.28;

  const addWindow = (px, py, pz, ry = 0) => {
    const wg = new THREE.Group();
    const frame = new THREE.Mesh(new THREE.BoxGeometry(winW + 0.28, winH + 0.28, 0.18), frameMat);
    const sill = new THREE.Mesh(new THREE.BoxGeometry(winW + 0.42, 0.12, 0.32), frameMat);
    sill.position.set(0, -winH * 0.5 - 0.12, 0.08);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(winW, winH, 0.22), windowMat);
    const barV = new THREE.Mesh(new THREE.BoxGeometry(0.07, winH, 0.25), frameMat);
    const barH = new THREE.Mesh(new THREE.BoxGeometry(winW, 0.07, 0.25), frameMat);
    wg.add(frame, sill, glass, barV, barH);
    wg.position.set(px, py, pz);
    wg.rotation.y = ry;
    group.add(wg);
  };

  addWindow(-w * 0.22, h * 0.56 + 0.35, d * 0.5 + 0.05, 0);
  addWindow(w * 0.5 + 0.05, h * 0.56 + 0.35, 0, Math.PI / 2);
  addWindow(-w * 0.5 - 0.05, h * 0.56 + 0.35, 0, -Math.PI / 2);

  // Chimney
  let chimneyTop = null;
  if (spec.has_chimney) {
    const chimW = w * 0.15;
    const chim = new THREE.Mesh(
      new THREE.BoxGeometry(chimW, roofH * 0.92, chimW),
      new THREE.MeshStandardMaterial({ color: '#7a4538', roughness: 0.9 })
    );
    chim.position.set(-w * 0.25, roofY + roofH * 0.55, -d * 0.15);
    chim.castShadow = true;
    const cap = new THREE.Mesh(
      new THREE.BoxGeometry(chimW * 1.25, 0.18, chimW * 1.25),
      new THREE.MeshStandardMaterial({ color: '#5c3329', roughness: 0.9 })
    );
    cap.position.set(-w * 0.25, roofY + roofH * 1.02, -d * 0.15);
    group.add(chim, cap);
    chimneyTop = new THREE.Vector3(spec.x - w * 0.25, roofY + roofH * 1.15, spec.z - d * 0.15);
  }

  group.position.set(spec.x, 0, spec.z);
  group.rotation.y = spec.rotation_y || 0;

  return { group, windowMat, chimneyTop };
}

/**
 * 3D Swaying Tree / Bush / Rock
 */
function createVegetation(spec, seedIdx) {
  const root = new THREE.Group();
  root.position.set(spec.x, 0, spec.z);
  const s = spec.scale || 1.0;

  if (spec.kind === 'rock') {
    const rock = new THREE.Mesh(
      new THREE.DodecahedronGeometry(1.15 * s, 0),
      new THREE.MeshStandardMaterial({ color: spec.foliage_color || '#7c858c', roughness: 0.94, flatShading: true })
    );
    rock.scale.set(1.25, 0.78, 1.05);
    rock.position.y = 0.52 * s;
    rock.castShadow = true;
    rock.receiveShadow = true;
    root.add(rock);
    return { root, swayPivot: null, phase: seedIdx * 1.3, intensity: 0 };
  }

  const swayPivot = new THREE.Group();
  root.add(swayPivot);

  if (spec.kind === 'bush') {
    const mat = new THREE.MeshStandardMaterial({ color: spec.foliage_color || '#3c8040', roughness: 0.86 });
    const accent = new THREE.MeshStandardMaterial({ color: spec.foliage_accent_color || '#529c4e', roughness: 0.86 });
    const offsets = [
      [0, 0.72, 0, 1.02, mat],
      [-0.72, 0.56, 0.32, 0.78, accent],
      [0.72, 0.56, -0.22, 0.82, mat],
      [0.15, 0.95, 0.35, 0.68, accent],
    ];
    for (const [ox, oy, oz, r, m] of offsets) {
      const puff = new THREE.Mesh(new THREE.SphereGeometry(r * s, 14, 12), m);
      puff.position.set(ox * s, oy * s, oz * s);
      puff.castShadow = true;
      puff.receiveShadow = true;
      swayPivot.add(puff);
    }
    return { root, swayPivot, phase: seedIdx * 1.7, intensity: (spec.sway_intensity ?? 0.6) * 0.5 };
  }

  const trunkH = 3.2 * s;
  const trunkMat = new THREE.MeshStandardMaterial({ color: spec.trunk_color || '#6e472b', roughness: 0.92 });
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.26 * s, 0.48 * s, trunkH, 10), trunkMat);
  trunk.position.y = trunkH * 0.5;
  trunk.castShadow = true;
  trunk.receiveShadow = true;
  swayPivot.add(trunk);

  // Subtle 3D branch stubs
  for (let b = 0; b < 2; b++) {
    const br = new THREE.Mesh(new THREE.CylinderGeometry(0.1 * s, 0.16 * s, 1.1 * s, 6), trunkMat);
    br.position.set((b === 0 ? -0.45 : 0.45) * s, trunkH * 0.78, 0);
    br.rotation.z = b === 0 ? 0.65 : -0.65;
    br.castShadow = true;
    swayPivot.add(br);
  }

  const canopyMat = new THREE.MeshStandardMaterial({ color: spec.foliage_color || '#387a3d', roughness: 0.82 });
  const accentMat = new THREE.MeshStandardMaterial({
    color: spec.foliage_accent_color || '#4d944c',
    roughness: 0.82,
  });

  if (spec.kind === 'cypress') {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14 * s, 0.22 * s, 1.1 * s, 8), trunkMat);
    trunk.position.y = 0.55 * s;
    trunk.castShadow = true;
    swayPivot.add(trunk);

    const lower = new THREE.Mesh(new THREE.CylinderGeometry(0.45 * s, 0.58 * s, 2.6 * s, 10), canopyMat);
    lower.position.y = 2.1 * s;
    lower.castShadow = true;
    lower.receiveShadow = true;
    const upper = new THREE.Mesh(new THREE.ConeGeometry(0.48 * s, 2.4 * s, 10), accentMat);
    upper.position.y = 4.5 * s;
    upper.castShadow = true;
    swayPivot.add(lower, upper);
    return {
      root,
      swayPivot,
      phase: seedIdx * 1.37 + spec.x * 0.2,
      intensity: spec.sway_intensity ?? 0.45,
    };
  }

  if (spec.kind === 'pine_tree') {
    const tiers = [
      [trunkH + 0.6 * s, 2.05 * s, 2.65 * s, canopyMat],
      [trunkH + 2.0 * s, 1.58 * s, 2.25 * s, accentMat],
      [trunkH + 3.25 * s, 1.05 * s, 1.85 * s, canopyMat],
    ];
    for (const [ty, tr, th, mat] of tiers) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(tr, th, 9), mat);
      cone.position.y = ty;
      cone.castShadow = true;
      cone.receiveShadow = true;
      swayPivot.add(cone);
    }
  } else {
    const puffs = [
      [0, trunkH + 1.55 * s, 0, 1.78 * s, canopyMat],
      [-1.08 * s, trunkH + 0.96 * s, 0.46 * s, 1.32 * s, accentMat],
      [1.08 * s, trunkH + 0.92 * s, -0.36 * s, 1.34 * s, canopyMat],
      [0.26 * s, trunkH + 2.4 * s, 0.24 * s, 1.26 * s, accentMat],
      [-0.46 * s, trunkH + 1.12 * s, -0.86 * s, 1.22 * s, canopyMat],
    ];
    for (const [px, py, pz, pr, mat] of puffs) {
      const puff = new THREE.Mesh(new THREE.SphereGeometry(pr, 16, 14), mat);
      puff.position.set(px, py, pz);
      puff.castShadow = true;
      puff.receiveShadow = true;
      swayPivot.add(puff);
    }
  }

  return {
    root,
    swayPivot,
    phase: seedIdx * 1.37 + spec.x * 0.2,
    intensity: spec.sway_intensity ?? 0.75,
  };
}

/**
 * Articulated 3D Bird (head, beak, body, tail, flapping wings)
 */
function createBirdMesh(spec) {
  const group = new THREE.Group();
  const s = (spec.scale || 1.0) * 0.98;

  const bodyMat = new THREE.MeshStandardMaterial({
    color: spec.color || '#1f2428',
    roughness: 0.62,
    metalness: 0.1,
  });
  const wingMat = new THREE.MeshStandardMaterial({
    color: spec.accent_color || spec.color || '#2c333a',
    roughness: 0.58,
    side: THREE.DoubleSide,
  });

  const body = new THREE.Mesh(new THREE.ConeGeometry(0.25 * s, 1.28 * s, 8), bodyMat);
  body.rotation.x = Math.PI / 2;
  body.castShadow = true;
  group.add(body);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.18 * s, 10, 8), bodyMat);
  head.position.set(0, 0.08 * s, 0.62 * s);
  group.add(head);

  const beak = new THREE.Mesh(
    new THREE.ConeGeometry(0.06 * s, 0.24 * s, 6),
    new THREE.MeshStandardMaterial({ color: '#f59e0b', roughness: 0.5 })
  );
  beak.rotation.x = Math.PI / 2;
  beak.position.set(0, 0.06 * s, 0.84 * s);
  group.add(beak);

  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.48 * s, 0.05 * s, 0.46 * s), wingMat);
  tail.position.set(0, 0.04 * s, -0.68 * s);
  tail.castShadow = true;
  group.add(tail);

  const wingShape = new THREE.Shape();
  wingShape.moveTo(0, 0.22 * s);
  wingShape.lineTo(1.28 * s, 0.06 * s);
  wingShape.lineTo(1.06 * s, -0.26 * s);
  wingShape.lineTo(0, -0.18 * s);
  wingShape.closePath();

  const wingGeo = new THREE.ExtrudeGeometry(wingShape, { depth: 0.05 * s, bevelEnabled: false });
  wingGeo.rotateX(Math.PI / 2);

  const leftWingPivot = new THREE.Group();
  const leftWing = new THREE.Mesh(wingGeo, wingMat);
  leftWing.castShadow = true;
  leftWingPivot.add(leftWing);
  group.add(leftWingPivot);

  const rightWingPivot = new THREE.Group();
  const rightWing = new THREE.Mesh(wingGeo, wingMat);
  rightWing.scale.x = -1;
  rightWing.castShadow = true;
  rightWingPivot.add(rightWing);
  group.add(rightWingPivot);

  return { group, leftWingPivot, rightWingPivot };
}

function createGenericEntityMesh(spec) {
  const group = new THREE.Group();
  const s = spec.scale || 1.0;
  const mat = new THREE.MeshStandardMaterial({ color: spec.color || '#ffffff', roughness: 0.7 });

  if (spec.kind === 'cloud') {
    for (const [ox, oy, oz, r] of [
      [0, 0, 0, 1.5],
      [-1.3, -0.2, 0.2, 1.1],
      [1.3, -0.2, -0.1, 1.15],
      [0.4, 0.6, 0.1, 1.0],
    ]) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r * s, 14, 12), mat);
      m.position.set(ox * s, oy * s, oz * s);
      group.add(m);
    }
  } else if (spec.kind === 'car') {
    const base = new THREE.Mesh(new THREE.BoxGeometry(2.2 * s, 0.7 * s, 1.2 * s), mat);
    base.position.y = 0.5 * s;
    base.castShadow = true;
    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(1.1 * s, 0.6 * s, 1.05 * s),
      new THREE.MeshStandardMaterial({ color: spec.accent_color || '#cbd5e1', roughness: 0.4 })
    );
    cabin.position.set(0, 1.05 * s, 0);
    cabin.castShadow = true;
    group.add(base, cabin);
  } else if (spec.kind === 'person') {
    const legMat = new THREE.MeshStandardMaterial({ color: spec.accent_color || '#1e293b', roughness: 0.85 });
    const legs = new THREE.Mesh(new THREE.CylinderGeometry(0.18 * s, 0.22 * s, 0.72 * s, 8), legMat);
    legs.position.y = 0.36 * s;
    legs.castShadow = true;
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.22 * s, 0.2 * s, 0.65 * s, 8), mat);
    torso.position.y = 1.02 * s;
    torso.castShadow = true;
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.18 * s, 10, 8),
      new THREE.MeshStandardMaterial({ color: '#e5b899', roughness: 0.7 })
    );
    head.position.y = 1.52 * s;
    head.castShadow = true;
    group.add(legs, torso, head);
  } else {
    const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.65 * s, 1), mat);
    orb.castShadow = true;
    group.add(orb);
  }
  return { group, leftWingPivot: null, rightWingPivot: null };
}

function tagSelectable(object3d, category, id) {
  object3d.userData.selectable = { category, id };
  object3d.traverse((child) => {
    child.userData.selectable = { category, id };
  });
}

export class SimulationEngine {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.localClippingEnabled = true;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(44, 1, 0.5, 450);
    this.camera.position.set(0, 11.5, 33.5);

    this.worldGroup = new THREE.Group();
    this.scene.add(this.worldGroup);

    // Selection highlight box
    this.selectionHelper = new THREE.BoxHelper(new THREE.Object3D(), 0x38bdf8);
    this.selectionHelper.visible = false;
    this.scene.add(this.selectionHelper);

    // Lighting
    this.hemiLight = new THREE.HemisphereLight('#bfe6ff', '#4b733e', 0.88);
    this.scene.add(this.hemiLight);

    this.sunLight = new THREE.DirectionalLight('#fff5db', 1.65);
    this.sunLight.position.set(24, 28, 16);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.near = 2;
    this.sunLight.shadow.camera.far = 120;
    const d = 40;
    this.sunLight.shadow.camera.left = -d;
    this.sunLight.shadow.camera.right = d;
    this.sunLight.shadow.camera.top = d;
    this.sunLight.shadow.camera.bottom = -d;
    this.sunLight.shadow.bias = -0.0005;
    this.scene.add(this.sunLight);

    // Live editable state
    this.sceneGraph = null;
    this.trajectories = [];
    this.videoDuration = 6.0;

    this.skyDome = null;
    this.groundMesh = null;
    this.sunMesh = null;
    this.sunBasePos = new THREE.Vector3(24, 22, -38);
    this.waterList = [];
    this.swayTrees = [];
    this.windowMats = [];
    this.chimneySmoke = [];
    this.dynamicActors = [];
    this.flightRibbons = [];
    this.ambientMotes = null;
    this.objectRegistry = new Map(); // key: `${category}:${id}` -> { category, id, spec, root }
    this.selectedKey = null;

    this.baseSkyTop = new THREE.Color('#5aaae6');
    this.baseSkyBot = new THREE.Color('#a8daf5');
    this.windStrength = 0.7;
    this.timeOfDay = 13.0;
    this.simTime = 0;
    this.showFlightPaths = false;
    this.wireframe = false;

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();

    this._buildDefaultWelcomeScene();
  }

  _clearWorld() {
    while (this.worldGroup.children.length > 0) {
      this.worldGroup.remove(this.worldGroup.children[0]);
    }
    this.waterList = [];
    this.swayTrees = [];
    this.windowMats = [];
    this.chimneySmoke = [];
    this.dynamicActors = [];
    this.flightRibbons = [];
    this.objectRegistry.clear();
    this.skyDome = null;
    this.groundMesh = null;
    this.sunMesh = null;
    this.ambientMotes = null;
    this.selectionHelper.visible = false;
  }

  _buildDefaultWelcomeScene() {
    this.loadSceneGraph(
      {
        title: 'Ready for 2D Video',
        environment: {
          sky_top_color: '#2b6cb0',
          sky_bottom_color: '#90cdf4',
          ground_color: '#4c8244',
          fog_color: '#90cdf4',
          fog_density: 0.005,
          sun: { enabled: true, position: { x: 20, y: 20, z: -38 }, color: '#ffe58f', radius: 3.2 },
          wind_strength: 0.65,
          time_of_day: 'day',
        },
        mountains: [
          { id: 'mountain_1', x: -12, z: -24, height: 14, radius: 14, color: '#5f8b7d', snow_cap: false },
          { id: 'mountain_2', x: 10, z: -26, height: 12, radius: 13, color: '#689485', snow_cap: false },
        ],
        water_bodies: [
          {
            id: 'water_1',
            shape: 'ellipse',
            x: 1,
            z: 6,
            radius_x: 9,
            radius_z: 5.2,
            water_color: '#4689b8',
            shore_color: '#d9ecfa',
            ripple_intensity: 0.65,
          },
        ],
        paths: [],
        structures: [
          {
            id: 'house_1',
            kind: 'house',
            x: -13,
            z: 1,
            width: 7.0,
            height: 4.8,
            depth: 6.0,
            rotation_y: 0.12,
            wall_color: '#f0deb4',
            roof_color: '#b84b39',
            roof_style: 'gable',
            door_color: '#6e442c',
            window_color: '#8fd3f4',
            has_chimney: true,
          },
        ],
        vegetation: [
          {
            id: 'tree_1',
            kind: 'round_tree',
            x: -20,
            z: 3,
            scale: 1.05,
            trunk_color: '#6e472b',
            foliage_color: '#347339',
            foliage_accent_color: '#478c49',
            sway_intensity: 0.75,
          },
          {
            id: 'tree_2',
            kind: 'round_tree',
            x: 15,
            z: 3,
            scale: 1.0,
            trunk_color: '#6e472b',
            foliage_color: '#347339',
            foliage_accent_color: '#478c49',
            sway_intensity: 0.75,
          },
        ],
        dynamic_entities: [
          {
            id: 'entity_1',
            kind: 'bird',
            color: '#1e293b',
            accent_color: '#334155',
            scale: 1.0,
            depth_z: -2,
            altitude_offset: 0,
            flap_speed: 8.0,
            fallback_path: [
              { x: -18, y: 12, z: -4 },
              { x: 0, y: 14, z: 2 },
              { x: 18, y: 11, z: -5 },
              { x: 0, y: 13, z: -12 },
            ],
          },
        ],
      },
      [],
      6.0
    );
  }

  loadSceneGraph(sceneGraph, trajectories = [], videoDuration = 6.0) {
    this.sceneGraph = JSON.parse(JSON.stringify(sceneGraph));
    this.trajectories = trajectories || [];
    this.videoDuration = Math.max(videoDuration || 6.0, 1.0);
    this.rebuildAll(this.selectedKey);
  }

  rebuildAll(preserveSelectedKey = null) {
    this._clearWorld();
    const sg = this.sceneGraph;
    if (!sg) return;

    const env = sg.environment || {};
    this.baseSkyTop = new THREE.Color(env.sky_top_color || '#5aaae6');
    this.baseSkyBot = new THREE.Color(env.sky_bottom_color || '#a8daf5');
    this.scene.fog = new THREE.FogExp2(env.fog_color || env.sky_bottom_color || '#9ecce8', env.fog_density ?? 0.0055);

    // Sky Dome
    this.skyDome = createSkyDome(this.baseSkyTop, this.baseSkyBot);
    this.worldGroup.add(this.skyDome.mesh);

    // 3D Subtle Rolling Ground Terrain (flat in the center play-area, gentle hills in the far distance)
    const groundGeo = new THREE.PlaneGeometry(320, 320, 72, 72);
    groundGeo.rotateX(-Math.PI / 2);
    const gPos = groundGeo.attributes.position;
    for (let i = 0; i < gPos.count; i++) {
      const gx = gPos.getX(i);
      const gz = gPos.getZ(i);
      const dist = Math.hypot(gx, gz);
      if (dist > 34) {
        const factor = Math.min(1, (dist - 34) / 55);
        const h = (Math.sin(gx * 0.05) * Math.cos(gz * 0.05) * 4.5 + Math.sin(gx * 0.11 + gz * 0.09) * 1.5) * factor;
        gPos.setY(i, Math.max(-0.4, h));
      }
    }
    groundGeo.computeVertexNormals();
    const groundMat = new THREE.MeshStandardMaterial({
      color: env.ground_color || '#5a8c49',
      roughness: 0.95,
      metalness: 0.0,
    });
    this.groundMesh = new THREE.Mesh(groundGeo, groundMat);
    this.groundMesh.receiveShadow = true;
    this.worldGroup.add(this.groundMesh);

    // Sun mesh + glowing halo
    const sunSpec = env.sun || { enabled: true };
    if (sunSpec.enabled !== false) {
      const sunGroup = new THREE.Group();
      const sPos = sunSpec.position || { x: 24, y: 22, z: -38 };
      this.sunBasePos.set(sPos.x, sPos.y, sPos.z);

      const sunCore = new THREE.Mesh(
        new THREE.SphereGeometry(sunSpec.radius || 3.2, 24, 20),
        new THREE.MeshBasicMaterial({ color: sunSpec.color || '#ffe87c' })
      );
      const sunHalo = new THREE.Mesh(
        new THREE.SphereGeometry((sunSpec.radius || 3.2) * 1.45, 24, 20),
        new THREE.MeshBasicMaterial({
          color: sunSpec.color || '#ffe87c',
          transparent: true,
          opacity: 0.22,
          depthWrite: false,
        })
      );
      sunGroup.add(sunCore, sunHalo);
      sunGroup.position.copy(this.sunBasePos);
      this.worldGroup.add(sunGroup);
      this.sunMesh = sunGroup;
    }

    // Mountains
    for (const m of sg.mountains || []) {
      const obj = createMountain(m);
      tagSelectable(obj, 'mountains', m.id);
      this.worldGroup.add(obj);
      this.objectRegistry.set(`mountains:${m.id}`, { category: 'mountains', id: m.id, spec: m, root: obj });
    }

    // Paths
    for (const p of sg.paths || []) {
      const obj = createPath(p);
      if (obj) {
        tagSelectable(obj, 'paths', p.id);
        this.worldGroup.add(obj);
        this.objectRegistry.set(`paths:${p.id}`, { category: 'paths', id: p.id, spec: p, root: obj });
      }
    }

    // Water bodies
    for (const w of sg.water_bodies || []) {
      const waterObj = createWaterMesh(w);
      tagSelectable(waterObj.group, 'water_bodies', w.id);
      this.worldGroup.add(waterObj.group);
      this.waterList.push(waterObj);
      this.objectRegistry.set(`water_bodies:${w.id}`, { category: 'water_bodies', id: w.id, spec: w, root: waterObj.group });
    }

    // Structures (+ Optional Complete 3D Internal Architecture!)
    const activeCryptClipPlanes = [];
    const builtPlinthGroups = [];

    for (const s of sg.structures || []) {
      const st = createStructure(s);

      if (s.interior && s.interior.enabled) {
        const viewRes = applyInteriorViewMode(st.group, s, s.interior);

        let interiorGroup = null;
        const preset =
          s.interior.preset ||
          (s.kind === 'pyramid'
            ? 'pyramid_chambers'
            : s.kind === 'mosque' || s.kind === 'pavilion'
            ? 'mosque_hall'
            : s.kind === 'house' || s.kind === 'cabin'
            ? 'house_rooms'
            : 'hasht_bihisht');

        if (preset === 'pyramid_chambers') {
          interiorGroup = buildPyramidInterior(s, s.interior);
        } else if (preset === 'mosque_hall') {
          interiorGroup = buildMosqueInterior(s, s.interior);
        } else if (preset === 'house_rooms') {
          interiorGroup = buildHouseInterior(s, s.interior);
        } else {
          interiorGroup = buildHashtBihishtInterior(s, s.interior);
        }

        // In Floor Plan mode, also slice interior ceiling/dome horizontally so the 9-room plan is crystal clear
        if (viewRes?.mode === 'floorplan' && viewRes.clipPlane && interiorGroup) {
          interiorGroup.traverse((obj) => {
            if (obj.isMesh && obj.material) {
              const m = obj.material.clone();
              m.clippingPlanes = [viewRes.clipPlane];
              obj.material = m;
            }
          });
        }

        // In Cutaway mode with crypt enabled, record clip plane so any supporting plinth opens to show the crypt!
        if (viewRes?.mode === 'cutaway' && viewRes.clipPlane && s.interior.show_crypt !== false) {
          activeCryptClipPlanes.push(viewRes.clipPlane);
        }

        if (interiorGroup) st.group.add(interiorGroup);
      }

      if (s.kind === 'plinth') {
        builtPlinthGroups.push(st.group);
      }

      tagSelectable(st.group, 'structures', s.id);
      this.worldGroup.add(st.group);
      if (st.windowMat) this.windowMats.push(st.windowMat);
      this.objectRegistry.set(`structures:${s.id}`, { category: 'structures', id: s.id, spec: s, root: st.group });

      if (st.chimneyTop) {
        for (let i = 0; i < 6; i++) {
          const puff = new THREE.Mesh(
            new THREE.SphereGeometry(0.32, 10, 8),
            new THREE.MeshStandardMaterial({ color: '#e2e8f0', transparent: true, opacity: 0.45, roughness: 1.0 })
          );
          this.worldGroup.add(puff);
          this.chimneySmoke.push({ mesh: puff, origin: st.chimneyTop.clone(), phase: i / 6.0 });
        }
      }
    }

    // Slice supporting marble plinths cleanly when a mausoleum cutaway crypt is active!
    if (activeCryptClipPlanes.length > 0) {
      for (const pg of builtPlinthGroups) {
        pg.traverse((obj) => {
          if (obj.isMesh && obj.material) {
            const m = obj.material.clone();
            m.clippingPlanes = activeCryptClipPlanes;
            m.clipShadows = true;
            m.side = THREE.DoubleSide;
            obj.material = m;
          }
        });
      }
    }

    // Vegetation
    (sg.vegetation || []).forEach((v, idx) => {
      const veg = createVegetation(v, idx);
      tagSelectable(veg.root, 'vegetation', v.id);
      this.worldGroup.add(veg.root);
      if (veg.swayPivot) this.swayTrees.push(veg);
      this.objectRegistry.set(`vegetation:${v.id}`, { category: 'vegetation', id: v.id, spec: v, root: veg.root });
    });

    // Dynamic Entities + optional 3D flight path ribbons
    const trajMap = new Map();
    for (const tr of this.trajectories) trajMap.set(tr.id, tr);

    (sg.dynamic_entities || []).forEach((ent, idx) => {
      const built = ent.kind === 'bird' ? createBirdMesh(ent) : createGenericEntityMesh(ent);
      tagSelectable(built.group, 'dynamic_entities', ent.id);
      this.worldGroup.add(built.group);
      this.objectRegistry.set(`dynamic_entities:${ent.id}`, {
        category: 'dynamic_entities',
        id: ent.id,
        spec: ent,
        root: built.group,
      });

      const tracked = ent.trajectory_id ? trajMap.get(ent.trajectory_id) : null;
      let curve = null;
      let trackPoints = null;

      if (tracked && tracked.points && tracked.points.length >= 2) {
        trackPoints = tracked.points.map((pt) => {
          const pos3 = project2DTo3D(pt.u, pt.v, ent.depth_z ?? -2.0);
          pos3.y += ent.altitude_offset || 0;
          return { t: pt.t, pos: pos3 };
        });
      } else if (ent.fallback_path && ent.fallback_path.length >= 2) {
        const pts = ent.fallback_path.map((p) => new THREE.Vector3(p.x, p.y + (ent.altitude_offset || 0), p.z));
        curve = new THREE.CatmullRomCurve3(pts, true);
      } else {
        const r = 10 + idx * 3;
        const h = 11 + (idx % 3) * 2.5 + (ent.altitude_offset || 0);
        curve = new THREE.CatmullRomCurve3(
          [
            new THREE.Vector3(-r, h, ent.depth_z ?? -4),
            new THREE.Vector3(0, h + 2, (ent.depth_z ?? -4) + 6),
            new THREE.Vector3(r, h - 1, ent.depth_z ?? -4),
            new THREE.Vector3(0, h + 1, (ent.depth_z ?? -4) - 6),
          ],
          true
        );
      }

      // Build 3D Flight Path Line visualization
      const linePts = trackPoints
        ? trackPoints.filter((_, i) => i % 3 === 0).map((p) => p.pos)
        : curve
        ? curve.getPoints(48)
        : [];
      if (linePts.length >= 2) {
        const lineGeo = new THREE.BufferGeometry().setFromPoints(linePts);
        const lineMat = new THREE.LineBasicMaterial({ color: '#38bdf8', transparent: true, opacity: 0.7 });
        const line = new THREE.Line(lineGeo, lineMat);
        line.visible = this.showFlightPaths;
        this.worldGroup.add(line);
        this.flightRibbons.push(line);
      }

      this.dynamicActors.push({
        spec: ent,
        group: built.group,
        leftWing: built.leftWingPivot,
        rightWing: built.rightWingPivot,
        trackPoints,
        curve,
        phase: idx * 2.1,
        prevPos: new THREE.Vector3(),
      });
    });

    // Ambient floating motes
    const moteCount = 90;
    const motePos = new Float32Array(moteCount * 3);
    for (let i = 0; i < moteCount; i++) {
      motePos[i * 3] = (Math.random() - 0.5) * 65;
      motePos[i * 3 + 1] = 0.8 + Math.random() * 18;
      motePos[i * 3 + 2] = (Math.random() - 0.5) * 55;
    }
    const moteGeo = new THREE.BufferGeometry();
    moteGeo.setAttribute('position', new THREE.BufferAttribute(motePos, 3));
    const moteMat = new THREE.PointsMaterial({
      color: '#fff8d6',
      size: 0.22,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    this.ambientMotes = new THREE.Points(moteGeo, moteMat);
    this.worldGroup.add(this.ambientMotes);

    this.setWireframe(this.wireframe);
    this.applyTimeOfDay(this.timeOfDay);

    if (preserveSelectedKey && this.objectRegistry.has(preserveSelectedKey)) {
      this.selectObjectByKey(preserveSelectedKey);
    } else {
      this.selectObjectByKey(null);
    }
  }

  getAllObjectsList() {
    return Array.from(this.objectRegistry.entries()).map(([key, entry]) => ({
      key,
      category: entry.category,
      id: entry.id,
      spec: entry.spec,
    }));
  }

  selectObjectByKey(key) {
    this.selectedKey = key && this.objectRegistry.has(key) ? key : null;
    if (!this.selectedKey) {
      this.selectionHelper.visible = false;
      return null;
    }
    const entry = this.objectRegistry.get(this.selectedKey);
    this.selectionHelper.setFromObject(entry.root);
    this.selectionHelper.visible = true;
    return entry;
  }

  getSelectedEntry() {
    return this.selectedKey ? this.objectRegistry.get(this.selectedKey) || null : null;
  }

  /**
   * Syncs 3D Gizmo drag back into the underlying SceneGraph spec
   */
  syncGizmoToSpec() {
    const entry = this.getSelectedEntry();
    if (!entry) return null;
    const { category, spec, root } = entry;

    if (category === 'mountains' || category === 'water_bodies' || category === 'structures' || category === 'vegetation') {
      spec.x = Number(root.position.x.toFixed(2));
      spec.z = Number(root.position.z.toFixed(2));
      if (category === 'structures') {
        spec.rotation_y = Number(root.rotation.y.toFixed(2));
      }
      if (category === 'vegetation') {
        const avgScale = (root.scale.x + root.scale.y + root.scale.z) / 3;
        if (Math.abs(avgScale - 1) > 0.01) {
          spec.scale = Number(Math.max(0.25, (spec.scale || 1) * avgScale).toFixed(2));
          root.scale.set(1, 1, 1);
          this.rebuildAll(this.selectedKey);
        }
      }
    }
    this.selectionHelper.setFromObject(entry.root);
    return entry;
  }

  addObject(category) {
    if (!this.sceneGraph) return null;
    const arr = this.sceneGraph[category] || (this.sceneGraph[category] = []);
    const n = arr.length + 1;
    const jitterX = Number(((Math.random() - 0.5) * 14).toFixed(1));
    const jitterZ = Number(((Math.random() - 0.5) * 10).toFixed(1));
    let spec = null;

    if (category === 'vegetation') {
      spec = {
        id: `tree_${Date.now().toString().slice(-4)}`,
        kind: 'round_tree',
        x: jitterX,
        z: jitterZ,
        scale: 1.0,
        trunk_color: '#6e472b',
        foliage_color: '#387a3d',
        foliage_accent_color: '#4d944c',
        sway_intensity: 0.75,
      };
    } else if (category === 'structures') {
      spec = {
        id: `house_${Date.now().toString().slice(-4)}`,
        kind: 'house',
        x: jitterX,
        z: jitterZ,
        width: 7.0,
        height: 4.8,
        depth: 6.0,
        rotation_y: 0,
        wall_color: '#f0deb4',
        roof_color: '#b84b39',
        roof_style: 'gable',
        door_color: '#6e442c',
        window_color: '#8fd3f4',
        has_chimney: true,
      };
    } else if (category === 'mountains') {
      spec = {
        id: `mountain_${Date.now().toString().slice(-4)}`,
        x: jitterX,
        z: -24,
        height: 13.0,
        radius: 13.0,
        color: '#629289',
        snow_cap: false,
      };
    } else if (category === 'water_bodies') {
      spec = {
        id: `water_${Date.now().toString().slice(-4)}`,
        shape: 'ellipse',
        x: jitterX,
        z: jitterZ + 4,
        radius_x: 7.0,
        radius_z: 4.5,
        water_color: '#4398bb',
        shore_color: '#d9ecfa',
        ripple_intensity: 0.65,
      };
    } else if (category === 'dynamic_entities') {
      spec = {
        id: `bird_${Date.now().toString().slice(-4)}`,
        kind: 'bird',
        color: '#222b35',
        accent_color: '#3c4856',
        scale: 1.0,
        trajectory_id: null,
        depth_z: jitterZ,
        altitude_offset: 0,
        flap_speed: 8.5,
      };
    }

    if (!spec) return null;
    arr.push(spec);
    const key = `${category}:${spec.id}`;
    this.rebuildAll(key);
    return key;
  }

  duplicateSelected() {
    const entry = this.getSelectedEntry();
    if (!entry) return null;
    const { category, spec } = entry;
    const clone = JSON.parse(JSON.stringify(spec));
    clone.id = `${spec.id}_copy_${Date.now().toString().slice(-3)}`;
    if (typeof clone.x === 'number') clone.x = Number((clone.x + 3.5).toFixed(2));
    if (typeof clone.z === 'number') clone.z = Number((clone.z + 2.0).toFixed(2));
    if (typeof clone.depth_z === 'number') clone.depth_z = Number((clone.depth_z + 2.5).toFixed(2));
    this.sceneGraph[category].push(clone);
    const key = `${category}:${clone.id}`;
    this.rebuildAll(key);
    return key;
  }

  deleteSelected() {
    const entry = this.getSelectedEntry();
    if (!entry) return false;
    const { category, id } = entry;
    const arr = this.sceneGraph[category];
    if (!Array.isArray(arr)) return false;
    this.sceneGraph[category] = arr.filter((item) => item.id !== id);
    this.rebuildAll(null);
    return true;
  }

  setShowFlightPaths(show) {
    this.showFlightPaths = show;
    for (const line of this.flightRibbons) line.visible = show;
  }

  setWireframe(enabled) {
    this.wireframe = enabled;
    this.worldGroup.traverse((obj) => {
      if (obj.isMesh && obj.material && !obj.material.isShaderMaterial) {
        obj.material.wireframe = enabled;
      }
    });
  }

  exportGLB() {
    return new Promise((resolve, reject) => {
      const exporter = new GLTFExporter();
      exporter.parse(
        this.worldGroup,
        (result) => resolve(result),
        (err) => reject(err),
        { binary: true }
      );
    });
  }

  applyTimeOfDay(hours) {
    this.timeOfDay = hours;
    const dayAngle = ((hours - 6) / 12) * Math.PI;
    const sunElev = Math.sin(dayAngle);
    const sunAzim = Math.cos(dayAngle);

    const sunDir = new THREE.Vector3(-sunAzim * 32, Math.max(-12, sunElev * 30), -26).normalize();
    this.sunLight.position.copy(sunDir).multiplyScalar(48);

    if (this.sunMesh) {
      this.sunMesh.position.set(-sunAzim * 36, Math.max(-16, sunElev * 28 + 3), -40);
      this.sunMesh.visible = sunElev > -0.15;
    }

    const nightTop = new THREE.Color('#091024');
    const nightBot = new THREE.Color('#192847');
    const sunsetTop = new THREE.Color('#3b4880');
    const sunsetBot = new THREE.Color('#f48c60');

    let topCol = this.baseSkyTop.clone();
    let botCol = this.baseSkyBot.clone();
    let lightCol = new THREE.Color('#fff5db');
    let lightInt = 1.65;
    let hemiInt = 0.88;
    let windowGlow = 0.0;

    if (sunElev < 0.0) {
      const t = THREE.MathUtils.clamp(-sunElev * 3.0, 0, 1);
      topCol.copy(sunsetTop).lerp(nightTop, t);
      botCol.copy(sunsetBot).lerp(nightBot, t);
      lightCol.set('#7aa2e3');
      lightInt = 0.34;
      hemiInt = 0.3;
      windowGlow = THREE.MathUtils.lerp(0.6, 1.4, t);
    } else if (sunElev < 0.35) {
      const t = sunElev / 0.35;
      topCol.copy(sunsetTop).lerp(this.baseSkyTop, t);
      botCol.copy(sunsetBot).lerp(this.baseSkyBot, t);
      lightCol.set('#ffaa66').lerp(new THREE.Color('#fff5db'), t);
      lightInt = THREE.MathUtils.lerp(0.85, 1.65, t);
      hemiInt = THREE.MathUtils.lerp(0.5, 0.88, t);
      windowGlow = (1.0 - t) * 0.65;
    }

    this.sunLight.color.copy(lightCol);
    this.sunLight.intensity = lightInt;
    this.hemiLight.intensity = hemiInt;

    if (this.skyDome) {
      this.skyDome.mat.uniforms.uTopColor.value.copy(topCol);
      this.skyDome.mat.uniforms.uBottomColor.value.copy(botCol);
      this.skyDome.mat.uniforms.uSunDir.value.copy(sunDir);
    }
    if (this.scene.fog) {
      this.scene.fog.color.copy(botCol);
    }
    for (const w of this.waterList) {
      w.mat.uniforms.uSunDir.value.copy(sunDir);
    }
    for (const wm of this.windowMats) {
      wm.emissiveIntensity = windowGlow;
    }
  }

  /**
   * Handles viewport clicks: triggers water ripples AND selects clicked 3D object
   */
  handlePointerClick(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    // Check water ripple first
    const waterMeshes = this.waterList.map((w) => w.mesh);
    const waterHits = this.raycaster.intersectObjects(waterMeshes, false);
    if (waterHits.length > 0) {
      const hit = waterHits[0];
      const mesh = hit.object;
      const localPt = mesh.worldToLocal(hit.point.clone());
      const mat = mesh.material;
      const idx = mesh.userData.nextRippleIdx % MAX_RIPPLES;
      mesh.userData.nextRippleIdx = idx + 1;
      mat.uniforms.uRippleOrigins.value[idx].set(localPt.x, localPt.z);
      mat.uniforms.uRippleTimes.value[idx] = this.simTime;
    }

    // Raycast selectable 3D objects
    const selectableRoots = Array.from(this.objectRegistry.values()).map((e) => e.root);
    const hits = this.raycaster.intersectObjects(selectableRoots, true);
    if (hits.length > 0) {
      const meta = hits[0].object.userData.selectable;
      if (meta) {
        const key = `${meta.category}:${meta.id}`;
        this.selectObjectByKey(key);
        return key;
      }
    }

    this.selectObjectByKey(null);
    return null;
  }

  getFirstBirdPosition() {
    const bird = this.dynamicActors.find((a) => a.spec.kind === 'bird') || this.dynamicActors[0];
    return bird ? bird.group.position.clone() : null;
  }

  update(dt, videoTimeSec = null) {
    this.simTime += dt;
    const t = this.simTime;

    for (const w of this.waterList) {
      w.mat.uniforms.uTime.value = t;
      w.mat.uniforms.uWind.value = this.windStrength;
      if (w.fountainJets && w.fountainJets.length) {
        for (const jet of w.fountainJets) {
          const pulse = 0.85 + Math.sin(t * 5.2 + jet.phase) * 0.22;
          jet.plume.scale.set(0.95 + Math.sin(t * 7 + jet.phase) * 0.08, pulse, 0.95);
          jet.plume.position.y = 0.22 + 0.78 * pulse;
          jet.crown.position.y = 0.25 + 1.55 * pulse;
          jet.crown.scale.setScalar(0.8 + Math.cos(t * 6.5 + jet.phase) * 0.25);
        }
      }
    }

    for (const tree of this.swayTrees) {
      const amp = 0.045 * this.windStrength * tree.intensity;
      const w1 = Math.sin(t * 1.9 + tree.phase);
      const w2 = Math.cos(t * 3.1 + tree.phase * 1.7) * 0.4;
      tree.swayPivot.rotation.z = (w1 + w2) * amp;
      tree.swayPivot.rotation.x = Math.sin(t * 1.4 + tree.phase * 0.8) * amp * 0.55;
    }

    for (const puff of this.chimneySmoke) {
      const cycle = (t * 0.28 + puff.phase) % 1.0;
      puff.mesh.position.set(
        puff.origin.x + cycle * (1.2 + this.windStrength * 2.2) + Math.sin(t * 2 + puff.phase * 6) * 0.2,
        puff.origin.y + cycle * 4.5,
        puff.origin.z + Math.cos(t * 1.5 + puff.phase * 4) * 0.2
      );
      const sc = 0.6 + cycle * 2.1;
      puff.mesh.scale.setScalar(sc);
      puff.mesh.material.opacity = Math.sin(cycle * Math.PI) * 0.42;
    }

    const playbackT = videoTimeSec !== null ? videoTimeSec : t % this.videoDuration;

    for (const actor of this.dynamicActors) {
      actor.prevPos.copy(actor.group.position);
      let nextPos = null;

      if (actor.trackPoints && actor.trackPoints.length >= 2) {
        const pts = actor.trackPoints;
        const tStart = pts[0].t;
        const tEnd = pts[pts.length - 1].t;
        const span = Math.max(tEnd - tStart, 0.1);
        const localT = tStart + (((playbackT - tStart) % span) + span) % span;

        let i = 0;
        while (i < pts.length - 2 && pts[i + 1].t < localT) i++;
        const a = pts[i];
        const b = pts[i + 1];
        const alpha = THREE.MathUtils.clamp((localT - a.t) / Math.max(b.t - a.t, 0.001), 0, 1);
        nextPos = new THREE.Vector3().lerpVectors(a.pos, b.pos, alpha);
        nextPos.z += Math.sin(t * 1.2 + actor.phase) * 1.1;
      } else if (actor.curve) {
        const u = (playbackT / this.videoDuration + actor.phase * 0.1) % 1.0;
        nextPos = actor.curve.getPointAt(u);
      }

      if (nextPos) {
        actor.group.position.copy(nextPos);
        const vel = new THREE.Vector3().subVectors(nextPos, actor.prevPos);
        if (vel.lengthSq() > 0.00001) {
          actor.group.lookAt(nextPos.clone().add(vel));
          actor.group.rotateZ(THREE.MathUtils.clamp(-vel.x * 1.6, -0.45, 0.45));
        }
      }

      if (actor.leftWing && actor.rightWing) {
        const flapFreq = actor.spec.flap_speed || 8.5;
        const flap = Math.sin(t * flapFreq + actor.phase) * 0.68;
        actor.leftWing.rotation.z = flap;
        actor.rightWing.rotation.z = -flap;
      }
    }

    if (this.ambientMotes) {
      const posAttr = this.ambientMotes.geometry.attributes.position;
      const windDx = (0.4 + this.windStrength * 1.8) * dt;
      for (let i = 0; i < posAttr.count; i++) {
        let x = posAttr.getX(i) + windDx;
        let y = posAttr.getY(i) + Math.sin(t * 1.3 + i) * 0.008;
        if (x > 33) x = -33;
        posAttr.setXYZ(i, x, y, posAttr.getZ(i));
      }
      posAttr.needsUpdate = true;
    }

    // Keep selection highlight tracking moving/edited objects
    if (this.selectionHelper.visible) {
      const entry = this.getSelectedEntry();
      if (entry) this.selectionHelper.setFromObject(entry.root);
    }
  }

  resize(width, height) {
    if (width <= 0 || height <= 0) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}

import * as THREE from 'three';

const MAX_RIPPLES = 6;

/**
 * Projects a normalized 2D video point (u, v) into 3D world space at a given depthZ.
 */
function project2DTo3D(u, v, depthZ) {
  // u in [0, 1] -> x in [-26, 26], scaled slightly by depth for perspective feel
  const depthScale = 1.0 + Math.max(-0.35, (-depthZ) * 0.015);
  const x = (u - 0.5) * 50.0 * depthScale;
  // v in [0, 1] (0 top, 1 bottom) -> y above ground
  const y = Math.max(1.2, (0.64 - v) * 34.0 + 3.2);
  return new THREE.Vector3(x, y, depthZ);
}

/**
 * Custom GLSL Sky Dome with smooth vertical gradient + horizon glow
 */
function createSkyDome(topHex, bottomHex) {
  const geo = new THREE.SphereGeometry(180, 32, 20);
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
        col += uSunColor * pow(sunDot, 28.0) * 0.35;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  return { mesh, mat };
}

/**
 * Custom GLSL Animated Water Surface with ripples, shoreline foam, sun glints,
 * and interactive pebble-drop expanding shockwaves!
 */
function createWaterMesh(spec) {
  const geo = new THREE.CircleGeometry(1, 64);
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
      uWaterColor: { value: new THREE.Color(spec.water_color || '#4f94c4') },
      uShoreColor: { value: new THREE.Color(spec.shore_color || '#d9ecfa') },
      uSunDir: { value: new THREE.Vector3(0.4, 0.6, -0.6).normalize() },
      uRippleOrigins: { value: rippleOrigins },
      uRippleTimes: { value: rippleTimes },
    },
    vertexShader: `
      uniform float uTime;
      uniform float uWind;
      varying vec2 vUv;
      varying vec2 vLocalPos;
      varying float vWave;
      void main() {
        vUv = uv;
        vLocalPos = position.xz;
        float dist = length(position.xz);
        float wave = sin(dist * 14.0 - uTime * (2.2 + uWind * 1.5)) * 0.04 * (1.0 - smoothstep(0.75, 1.0, dist));
        wave += cos(position.x * 10.0 + uTime * 1.8) * 0.02 * uWind;
        vWave = wave;
        vec3 pos = position;
        pos.y += wave;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uWind;
      uniform vec3 uWaterColor;
      uniform vec3 uShoreColor;
      uniform vec3 uSunDir;
      uniform vec2 uRippleOrigins[${MAX_RIPPLES}];
      uniform float uRippleTimes[${MAX_RIPPLES}];
      varying vec2 vUv;
      varying vec2 vLocalPos;
      varying float vWave;

      void main() {
        float dist = length(vLocalPos);
        // Subtle depth gradient (deeper darker center, brighter edge)
        vec3 col = mix(uWaterColor * 0.86, uWaterColor * 1.12, smoothstep(0.0, 0.92, dist));

        // Ambient animated surface ripples
        float r1 = sin(vLocalPos.x * 18.0 + uTime * 2.1 + sin(vLocalPos.y * 12.0 + uTime)) * 0.5 + 0.5;
        float r2 = sin(dist * 22.0 - uTime * (2.6 + uWind)) * 0.5 + 0.5;
        float shimmer = smoothstep(0.72, 0.98, r1 * r2) * (0.18 + 0.14 * uWind);
        col += vec3(0.75, 0.9, 1.0) * shimmer;

        // Interactive click-drop pebble ripples
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
        col = mix(col, vec3(0.92, 0.98, 1.0), clamp(clickRipple * 0.85, 0.0, 0.9));

        // Crisp stylized shoreline foam ring (matching 2D pond outline)
        float shoreOuter = smoothstep(0.91, 0.96, dist) * (1.0 - smoothstep(0.97, 1.0, dist));
        float shoreInner = smoothstep(0.84, 0.87, dist + sin(atan(vLocalPos.y, vLocalPos.x) * 8.0 + uTime * 1.4) * 0.012)
                         * (1.0 - smoothstep(0.87, 0.90, dist));
        col = mix(col, uShoreColor, clamp(shoreOuter * 0.85 + shoreInner * 0.25, 0.0, 1.0));

        // Specular sun glint
        float glint = smoothstep(0.82, 0.99, sin(vLocalPos.x * 26.0 + vLocalPos.y * 14.0 + uTime * 3.2) * 0.5 + 0.5);
        col += vec3(1.0, 0.96, 0.82) * glint * 0.14 * max(uSunDir.y, 0.1);

        gl_FragColor = vec4(col, 0.94);
      }
    `,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.scale.set(spec.radius_x, 1, spec.radius_z);
  mesh.position.set(spec.x, 0.08, spec.z);
  mesh.receiveShadow = true;
  mesh.userData = { isWater: true, nextRippleIdx: 0, spec };

  // Subtle recessed earth rim around pond
  const rimGeo = new THREE.RingGeometry(0.98, 1.08, 64);
  rimGeo.rotateX(-Math.PI / 2);
  const rimMat = new THREE.MeshStandardMaterial({
    color: '#467038',
    roughness: 0.95,
    metalness: 0.0,
  });
  const rim = new THREE.Mesh(rimGeo, rimMat);
  rim.scale.set(spec.radius_x, 1, spec.radius_z);
  rim.position.set(spec.x, 0.03, spec.z);
  rim.receiveShadow = true;

  const group = new THREE.Group();
  group.add(rim, mesh);

  return { group, mesh, mat };
}

/**
 * Stylized 3D Mountain with subtle faceted geometry
 */
function createMountain(spec) {
  const geo = new THREE.ConeGeometry(spec.radius, spec.height, 7, 3);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y > -spec.height * 0.45 && y < spec.height * 0.45) {
      const jitter = Math.sin(pos.getX(i) * 0.7 + pos.getZ(i) * 0.9) * spec.radius * 0.06;
      pos.setX(i, pos.getX(i) + jitter);
      pos.setZ(i, pos.getZ(i) - jitter * 0.8);
    }
  }
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    color: spec.color || '#6d9886',
    roughness: 0.92,
    metalness: 0.02,
    flatShading: true,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(spec.x, spec.height * 0.5 - 0.15, spec.z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const group = new THREE.Group();
  group.add(mesh);

  if (spec.snow_cap) {
    const capGeo = new THREE.ConeGeometry(spec.radius * 0.34, spec.height * 0.34, 7);
    const capMat = new THREE.MeshStandardMaterial({ color: '#eef6fa', roughness: 0.75, flatShading: true });
    const cap = new THREE.Mesh(capGeo, capMat);
    cap.position.set(spec.x, spec.height * 0.82, spec.z);
    group.add(cap);
  }

  return group;
}

/**
 * Smooth extruded ground path along 2D waypoints
 */
function createPath(spec) {
  if (!spec.points || spec.points.length < 2) return null;
  const pts = spec.points.map((p) => new THREE.Vector3(p.x, 0.04, p.z));
  const curve = new THREE.CatmullRomCurve3(pts);
  const samples = curve.getPoints(36);

  const halfW = (spec.width || 3.2) * 0.5;
  const positions = [];
  const uvs = [];
  const indices = [];

  for (let i = 0; i < samples.length; i++) {
    const p = samples[i];
    const next = samples[Math.min(samples.length - 1, i + 1)];
    const prev = samples[Math.max(0, i - 1)];
    const tangent = new THREE.Vector3().subVectors(next, prev).normalize();
    const perp = new THREE.Vector3(-tangent.z, 0, tangent.x).multiplyScalar(halfW);

    positions.push(p.x - perp.x, 0.05, p.z - perp.z);
    positions.push(p.x + perp.x, 0.05, p.z + perp.z);

    const v = i / (samples.length - 1);
    uvs.push(0, v, 1, v);

    if (i < samples.length - 1) {
      const a = i * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    color: spec.color || '#c9b38c',
    roughness: 0.95,
    metalness: 0.0,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Detailed 3D House / Structure with warm glowing windows at night + optional chimney
 */
function createStructure(spec) {
  const group = new THREE.Group();
  const w = spec.width || 7.2;
  const h = spec.height || 4.8;
  const d = spec.depth || 6.0;

  // Main walls
  const wallMat = new THREE.MeshStandardMaterial({
    color: spec.wall_color || '#f0deb4',
    roughness: 0.85,
  });
  const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
  wall.position.y = h * 0.5;
  wall.castShadow = true;
  wall.receiveShadow = true;
  group.add(wall);

  // Roof
  const roofMat = new THREE.MeshStandardMaterial({
    color: spec.roof_color || '#b84b39',
    roughness: 0.78,
    flatShading: true,
  });

  const roofH = h * 0.68;
  if (spec.roof_style === 'flat') {
    const roof = new THREE.Mesh(new THREE.BoxGeometry(w * 1.08, 0.5, d * 1.08), roofMat);
    roof.position.y = h + 0.25;
    roof.castShadow = true;
    group.add(roof);
  } else if (spec.roof_style === 'pyramid') {
    const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.82, roofH, 4), roofMat);
    roof.rotation.y = Math.PI / 4;
    roof.position.y = h + roofH * 0.5;
    roof.castShadow = true;
    group.add(roof);
  } else {
    // Gable prism roof (matches classic 2D triangle roof!)
    const shape = new THREE.Shape();
    const hw = w * 0.58;
    shape.moveTo(-hw, 0);
    shape.lineTo(0, roofH);
    shape.lineTo(hw, 0);
    shape.closePath();

    const roofGeo = new THREE.ExtrudeGeometry(shape, {
      depth: d * 1.12,
      bevelEnabled: false,
    });
    roofGeo.translate(0, 0, -d * 0.56);
    const roof = new THREE.Mesh(roofGeo, roofMat);
    roof.position.y = h - 0.05;
    roof.castShadow = true;
    roof.receiveShadow = true;
    group.add(roof);
  }

  // Front Door
  const doorW = w * 0.24;
  const doorH = h * 0.52;
  const doorMat = new THREE.MeshStandardMaterial({
    color: spec.door_color || '#6e442c',
    roughness: 0.8,
  });
  const door = new THREE.Mesh(new THREE.BoxGeometry(doorW, doorH, 0.24), doorMat);
  door.position.set(w * 0.14, doorH * 0.5, d * 0.5 + 0.04);
  door.castShadow = true;
  group.add(door);

  // Glowing Window (front + side)
  const windowMat = new THREE.MeshStandardMaterial({
    color: spec.window_color || '#8fd3f4',
    emissive: new THREE.Color('#ffba52'),
    emissiveIntensity: 0.0,
    roughness: 0.22,
    metalness: 0.15,
  });

  const winW = w * 0.24;
  const winH = h * 0.28;
  const frameMat = new THREE.MeshStandardMaterial({ color: '#4c3a2b', roughness: 0.9 });

  const addWindow = (px, py, pz, ry = 0) => {
    const wg = new THREE.Group();
    const frame = new THREE.Mesh(new THREE.BoxGeometry(winW + 0.25, winH + 0.25, 0.16), frameMat);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(winW, winH, 0.22), windowMat);
    wg.add(frame, glass);
    wg.position.set(px, py, pz);
    wg.rotation.y = ry;
    group.add(wg);
  };

  addWindow(-w * 0.22, h * 0.54, d * 0.5 + 0.04, 0);
  addWindow(w * 0.5 + 0.04, h * 0.54, 0, Math.PI / 2);
  addWindow(-w * 0.5 - 0.04, h * 0.54, 0, -Math.PI / 2);

  // Chimney
  let chimneyTop = null;
  if (spec.has_chimney) {
    const chim = new THREE.Mesh(
      new THREE.BoxGeometry(w * 0.14, roofH * 0.9, w * 0.14),
      new THREE.MeshStandardMaterial({ color: '#7a4538', roughness: 0.9 })
    );
    chim.position.set(-w * 0.25, h + roofH * 0.55, -d * 0.15);
    chim.castShadow = true;
    group.add(chim);
    chimneyTop = new THREE.Vector3(spec.x - w * 0.25, h + roofH * 1.05, spec.z - d * 0.15);
  }

  group.position.set(spec.x, 0, spec.z);
  group.rotation.y = spec.rotation_y || 0;

  return { group, windowMat, chimneyTop };
}

/**
 * Stylized 3D Swaying Tree / Bush / Rock
 */
function createVegetation(spec, seedIdx) {
  const root = new THREE.Group();
  root.position.set(spec.x, 0, spec.z);
  const s = spec.scale || 1.0;

  if (spec.kind === 'rock') {
    const rock = new THREE.Mesh(
      new THREE.DodecahedronGeometry(1.1 * s, 0),
      new THREE.MeshStandardMaterial({ color: spec.foliage_color || '#7c858c', roughness: 0.95, flatShading: true })
    );
    rock.scale.set(1.2, 0.75, 1.0);
    rock.position.y = 0.5 * s;
    rock.castShadow = true;
    rock.receiveShadow = true;
    root.add(rock);
    return { root, swayPivot: null, phase: seedIdx * 1.3, intensity: 0 };
  }

  const swayPivot = new THREE.Group();
  root.add(swayPivot);

  if (spec.kind === 'bush') {
    const mat = new THREE.MeshStandardMaterial({ color: spec.foliage_color || '#3c8040', roughness: 0.88 });
    const offsets = [
      [0, 0.7, 0, 1.0],
      [-0.7, 0.55, 0.3, 0.75],
      [0.7, 0.55, -0.2, 0.8],
    ];
    for (const [ox, oy, oz, r] of offsets) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r * s, 14, 12), mat);
      m.position.set(ox * s, oy * s, oz * s);
      m.castShadow = true;
      m.receiveShadow = true;
      swayPivot.add(m);
    }
    return { root, swayPivot, phase: seedIdx * 1.7, intensity: (spec.sway_intensity || 0.6) * 0.5 };
  }

  // Trunk
  const trunkH = 3.2 * s;
  const trunkMat = new THREE.MeshStandardMaterial({ color: spec.trunk_color || '#6e472b', roughness: 0.92 });
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.28 * s, 0.45 * s, trunkH, 9), trunkMat);
  trunk.position.y = trunkH * 0.5;
  trunk.castShadow = true;
  trunk.receiveShadow = true;
  swayPivot.add(trunk);

  const canopyMat = new THREE.MeshStandardMaterial({ color: spec.foliage_color || '#387a3d', roughness: 0.82 });
  const accentMat = new THREE.MeshStandardMaterial({
    color: spec.foliage_accent_color || '#4d944c',
    roughness: 0.82,
  });

  if (spec.kind === 'pine_tree') {
    const tiers = [
      [trunkH + 0.6 * s, 2.0 * s, 2.6 * s, canopyMat],
      [trunkH + 2.0 * s, 1.55 * s, 2.2 * s, accentMat],
      [trunkH + 3.2 * s, 1.05 * s, 1.8 * s, canopyMat],
    ];
    for (const [ty, tr, th, mat] of tiers) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(tr, th, 8), mat);
      cone.position.y = ty;
      cone.castShadow = true;
      cone.receiveShadow = true;
      swayPivot.add(cone);
    }
  } else {
    // Stylized multi-sphere clustered canopy (matches the lush 2D trees!)
    const puffs = [
      [0, trunkH + 1.5 * s, 0, 1.75 * s, canopyMat],
      [-1.05 * s, trunkH + 0.95 * s, 0.45 * s, 1.3 * s, accentMat],
      [1.05 * s, trunkH + 0.9 * s, -0.35 * s, 1.32 * s, canopyMat],
      [0.25 * s, trunkH + 2.35 * s, 0.25 * s, 1.25 * s, accentMat],
      [-0.45 * s, trunkH + 1.1 * s, -0.85 * s, 1.2 * s, canopyMat],
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
 * Articulated 3D Bird (body + tail + flapping left & right wings)
 */
function createBirdMesh(spec) {
  const group = new THREE.Group();
  const s = (spec.scale || 1.0) * 0.95;

  const bodyMat = new THREE.MeshStandardMaterial({
    color: spec.color || '#1f2428',
    roughness: 0.65,
    metalness: 0.1,
  });
  const wingMat = new THREE.MeshStandardMaterial({
    color: spec.accent_color || spec.color || '#2c333a',
    roughness: 0.6,
    side: THREE.DoubleSide,
  });

  // Streamlined body aligned along +Z (forward)
  const body = new THREE.Mesh(new THREE.ConeGeometry(0.24 * s, 1.25 * s, 8), bodyMat);
  body.rotation.x = Math.PI / 2;
  body.castShadow = true;
  group.add(body);

  // Tail wedge
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.45 * s, 0.05 * s, 0.45 * s), wingMat);
  tail.position.set(0, 0.04 * s, -0.68 * s);
  tail.castShadow = true;
  group.add(tail);

  // Articulated Left & Right Wings
  const wingShape = new THREE.Shape();
  wingShape.moveTo(0, 0.22 * s);
  wingShape.lineTo(1.25 * s, 0.05 * s);
  wingShape.lineTo(1.05 * s, -0.26 * s);
  wingShape.lineTo(0, -0.18 * s);
  wingShape.closePath();

  const wingGeo = new THREE.ExtrudeGeometry(wingShape, { depth: 0.045 * s, bevelEnabled: false });
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

/**
 * Generic fallback dynamic entity (cloud, boat, car, floating_orb, etc.)
 */
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
  } else {
    const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.65 * s, 1), mat);
    orb.castShadow = true;
    group.add(orb);
  }
  return { group, leftWingPivot: null, rightWingPivot: null };
}

/**
 * Main Scene Builder & Live Simulation Controller
 */
export class SimulationEngine {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(44, 1, 0.5, 400);
    this.camera.position.set(0, 11.5, 33.5);

    this.worldGroup = new THREE.Group();
    this.scene.add(this.worldGroup);

    // Lighting
    this.hemiLight = new THREE.HemisphereLight('#bfe6ff', '#4b733e', 0.85);
    this.scene.add(this.hemiLight);

    this.sunLight = new THREE.DirectionalLight('#fff5db', 1.65);
    this.sunLight.position.set(24, 28, 16);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.near = 2;
    this.sunLight.shadow.camera.far = 120;
    const d = 38;
    this.sunLight.shadow.camera.left = -d;
    this.sunLight.shadow.camera.right = d;
    this.sunLight.shadow.camera.top = d;
    this.sunLight.shadow.camera.bottom = -d;
    this.sunLight.shadow.bias = -0.0005;
    this.scene.add(this.sunLight);

    // Simulation state
    this.skyDome = null;
    this.sunMesh = null;
    this.sunBasePos = new THREE.Vector3(24, 22, -38);
    this.waterList = [];
    this.swayTrees = [];
    this.windowMats = [];
    this.chimneySmoke = [];
    this.dynamicActors = [];
    this.ambientMotes = null;
    this.baseSkyTop = new THREE.Color('#5aaae6');
    this.baseSkyBot = new THREE.Color('#a8daf5');

    this.windStrength = 0.7;
    this.timeOfDay = 13.0;
    this.simTime = 0;
    this.videoDuration = 6.0;

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();

    this._buildDefaultWelcomeScene();
  }

  _clearWorld() {
    while (this.worldGroup.children.length > 0) {
      const child = this.worldGroup.children[0];
      this.worldGroup.remove(child);
    }
    this.waterList = [];
    this.swayTrees = [];
    this.windowMats = [];
    this.chimneySmoke = [];
    this.dynamicActors = [];
    this.skyDome = null;
    this.sunMesh = null;
    this.ambientMotes = null;
  }

  _buildDefaultWelcomeScene() {
    // Minimal atmospheric placeholder before first analysis
    this.loadSceneGraph(
      {
        title: 'Ready for 2D Video',
        environment: {
          sky_top_color: '#1e3a5f',
          sky_bottom_color: '#64a6bd',
          ground_color: '#3f6a3c',
          fog_color: '#5a94ab',
          fog_density: 0.006,
          sun: { enabled: true, position: { x: 20, y: 18, z: -36 }, color: '#ffe58f', radius: 3.0 },
          wind_strength: 0.6,
          time_of_day: 'day',
        },
        mountains: [
          { id: 'm1', x: -12, z: -24, height: 14, radius: 15, color: '#557d72', snow_cap: false },
          { id: 'm2', x: 10, z: -26, height: 11, radius: 14, color: '#5f877b', snow_cap: false },
        ],
        water_bodies: [
          { id: 'w1', shape: 'ellipse', x: 1, z: 6, radius_x: 9, radius_z: 5.5, water_color: '#4689b8', shore_color: '#d9ecfa' },
        ],
        paths: [],
        structures: [],
        vegetation: [
          { id: 't1', kind: 'round_tree', x: -14, z: 2, scale: 1.1, trunk_color: '#6e472b', foliage_color: '#347339', foliage_accent_color: '#478c49' },
          { id: 't2', kind: 'round_tree', x: 15, z: 3, scale: 1.0, trunk_color: '#6e472b', foliage_color: '#347339', foliage_accent_color: '#478c49' },
        ],
        dynamic_entities: [
          {
            id: 'demo_bird',
            kind: 'bird',
            color: '#1e293b',
            accent_color: '#334155',
            scale: 1.0,
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
    this._clearWorld();
    this.videoDuration = Math.max(videoDuration || 6.0, 1.0);

    const env = sceneGraph.environment || {};
    this.baseSkyTop = new THREE.Color(env.sky_top_color || '#5aaae6');
    this.baseSkyBot = new THREE.Color(env.sky_bottom_color || '#a8daf5');
    this.scene.fog = new THREE.FogExp2(env.fog_color || env.sky_bottom_color || '#9ecce8', env.fog_density ?? 0.0055);

    // Sky Dome
    this.skyDome = createSkyDome(this.baseSkyTop, this.baseSkyBot);
    this.worldGroup.add(this.skyDome.mesh);

    // Infinite Ground Plane with subtle grass variation
    const groundGeo = new THREE.CircleGeometry(170, 64);
    groundGeo.rotateX(-Math.PI / 2);
    const groundMat = new THREE.MeshStandardMaterial({
      color: env.ground_color || '#5a8c49',
      roughness: 0.96,
      metalness: 0.0,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.receiveShadow = true;
    this.worldGroup.add(ground);

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
        new THREE.SphereGeometry((sunSpec.radius || 3.2) * 1.42, 24, 20),
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
    for (const m of sceneGraph.mountains || []) {
      this.worldGroup.add(createMountain(m));
    }

    // Paths
    for (const p of sceneGraph.paths || []) {
      const pathMesh = createPath(p);
      if (pathMesh) this.worldGroup.add(pathMesh);
    }

    // Water bodies
    for (const w of sceneGraph.water_bodies || []) {
      const waterObj = createWaterMesh(w);
      this.worldGroup.add(waterObj.group);
      this.waterList.push(waterObj);
    }

    // Structures
    for (const s of sceneGraph.structures || []) {
      const st = createStructure(s);
      this.worldGroup.add(st.group);
      this.windowMats.push(st.windowMat);

      // Gentle rising chimney smoke puffs
      if (st.chimneyTop) {
        for (let i = 0; i < 6; i++) {
          const puff = new THREE.Mesh(
            new THREE.SphereGeometry(0.32, 10, 8),
            new THREE.MeshStandardMaterial({ color: '#e2e8f0', transparent: true, opacity: 0.45, roughness: 1.0 })
          );
          this.worldGroup.add(puff);
          this.chimneySmoke.push({
            mesh: puff,
            origin: st.chimneyTop.clone(),
            phase: i / 6.0,
          });
        }
      }
    }

    // Vegetation
    (sceneGraph.vegetation || []).forEach((v, idx) => {
      const veg = createVegetation(v, idx);
      this.worldGroup.add(veg.root);
      if (veg.swayPivot) this.swayTrees.push(veg);
    });

    // Dynamic Entities + OpenCV Trajectories
    const trajMap = new Map();
    for (const tr of trajectories || []) {
      trajMap.set(tr.id, tr);
    }

    (sceneGraph.dynamic_entities || []).forEach((ent, idx) => {
      const built = ent.kind === 'bird' ? createBirdMesh(ent) : createGenericEntityMesh(ent);
      this.worldGroup.add(built.group);

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
        const pts = ent.fallback_path.map((p) => new THREE.Vector3(p.x, p.y, p.z));
        curve = new THREE.CatmullRomCurve3(pts, true);
      } else {
        // Default gentle soaring loop
        const r = 10 + idx * 3;
        const h = 11 + (idx % 3) * 2.5;
        curve = new THREE.CatmullRomCurve3(
          [
            new THREE.Vector3(-r, h, -4),
            new THREE.Vector3(0, h + 2, 4),
            new THREE.Vector3(r, h - 1, -3),
            new THREE.Vector3(0, h + 1, -12),
          ],
          true
        );
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

    // Ambient floating pollen / wind motes
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

    this.applyTimeOfDay(this.timeOfDay);
  }

  applyTimeOfDay(hours) {
    this.timeOfDay = hours;
    // Map hours [6..18] -> sun elevation arc
    const dayAngle = ((hours - 6) / 12) * Math.PI;
    const sunElev = Math.sin(dayAngle); // >0 daytime, <=0 night
    const sunAzim = Math.cos(dayAngle);

    const sunDir = new THREE.Vector3(-sunAzim * 32, Math.max(-12, sunElev * 30), -26).normalize();
    this.sunLight.position.copy(sunDir).multiplyScalar(48);

    if (this.sunMesh) {
      this.sunMesh.position.set(-sunAzim * 36, Math.max(-16, sunElev * 28 + 3), -40);
      this.sunMesh.visible = sunElev > -0.15;
    }

    // Color blending: Night -> Dawn/Sunset -> Day
    const nightTop = new THREE.Color('#091024');
    const nightBot = new THREE.Color('#192847');
    const sunsetTop = new THREE.Color('#3b4880');
    const sunsetBot = new THREE.Color('#f48c60');

    let topCol = this.baseSkyTop.clone();
    let botCol = this.baseSkyBot.clone();
    let lightCol = new THREE.Color('#fff5db');
    let lightInt = 1.65;
    let hemiInt = 0.85;
    let windowGlow = 0.0;

    if (sunElev < 0.0) {
      const t = THREE.MathUtils.clamp(-sunElev * 3.0, 0, 1);
      topCol.copy(sunsetTop).lerp(nightTop, t);
      botCol.copy(sunsetBot).lerp(nightBot, t);
      lightCol.set('#7aa2e3');
      lightInt = 0.32;
      hemiInt = 0.28;
      windowGlow = THREE.MathUtils.lerp(0.6, 1.35, t);
    } else if (sunElev < 0.35) {
      const t = sunElev / 0.35;
      topCol.copy(sunsetTop).lerp(this.baseSkyTop, t);
      botCol.copy(sunsetBot).lerp(this.baseSkyBot, t);
      lightCol.set('#ffaa66').lerp(new THREE.Color('#fff5db'), t);
      lightInt = THREE.MathUtils.lerp(0.85, 1.65, t);
      hemiInt = THREE.MathUtils.lerp(0.5, 0.85, t);
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
   * Drop an interactive ripple on any water body clicked by the user!
   */
  handlePointerClick(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const waterMeshes = this.waterList.map((w) => w.mesh);
    const hits = this.raycaster.intersectObjects(waterMeshes, false);
    if (hits.length > 0) {
      const hit = hits[0];
      const mesh = hit.object;
      const localPt = mesh.worldToLocal(hit.point.clone());
      const mat = mesh.material;
      const idx = mesh.userData.nextRippleIdx % MAX_RIPPLES;
      mesh.userData.nextRippleIdx = idx + 1;
      mat.uniforms.uRippleOrigins.value[idx].set(localPt.x, localPt.z);
      mat.uniforms.uRippleTimes.value[idx] = this.simTime;
      return true;
    }
    return false;
  }

  getFirstBirdPosition() {
    const bird = this.dynamicActors.find((a) => a.spec.kind === 'bird') || this.dynamicActors[0];
    return bird ? bird.group.position.clone() : null;
  }

  update(dt, videoTimeSec = null) {
    this.simTime += dt;
    const t = this.simTime;

    // 1. Update water shaders
    for (const w of this.waterList) {
      w.mat.uniforms.uTime.value = t;
      w.mat.uniforms.uWind.value = this.windStrength;
    }

    // 2. Sway trees with dual-frequency wind turbulence
    for (const tree of this.swayTrees) {
      const amp = 0.045 * this.windStrength * tree.intensity;
      const w1 = Math.sin(t * 1.9 + tree.phase);
      const w2 = Math.cos(t * 3.1 + tree.phase * 1.7) * 0.4;
      tree.swayPivot.rotation.z = (w1 + w2) * amp;
      tree.swayPivot.rotation.x = Math.sin(t * 1.4 + tree.phase * 0.8) * amp * 0.55;
    }

    // 3. Chimney smoke rising & drifting with wind
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

    // 4. Animate dynamic entities (birds along OpenCV trajectories!)
    const playbackT = videoTimeSec !== null ? videoTimeSec : (t % this.videoDuration);

    for (const actor of this.dynamicActors) {
      actor.prevPos.copy(actor.group.position);
      let nextPos = null;

      if (actor.trackPoints && actor.trackPoints.length >= 2) {
        const pts = actor.trackPoints;
        const tStart = pts[0].t;
        const tEnd = pts[pts.length - 1].t;
        const span = Math.max(tEnd - tStart, 0.1);
        const localT = tStart + (((playbackT - tStart) % span) + span) % span;

        // Find enclosing keyframe segment
        let i = 0;
        while (i < pts.length - 2 && pts[i + 1].t < localT) {
          i++;
        }
        const a = pts[i];
        const b = pts[i + 1];
        const alpha = THREE.MathUtils.clamp((localT - a.t) / Math.max(b.t - a.t, 0.001), 0, 1);
        nextPos = new THREE.Vector3().lerpVectors(a.pos, b.pos, alpha);
        // Subtle 3D figure-8 depth bob so flight feels alive
        nextPos.z += Math.sin(t * 1.2 + actor.phase) * 1.1;
      } else if (actor.curve) {
        const u = ((playbackT / this.videoDuration) + actor.phase * 0.1) % 1.0;
        nextPos = actor.curve.getPointAt(u);
      }

      if (nextPos) {
        actor.group.position.copy(nextPos);
        const vel = new THREE.Vector3().subVectors(nextPos, actor.prevPos);
        if (vel.lengthSq() > 0.00001) {
          const lookTarget = nextPos.clone().add(vel);
          actor.group.lookAt(lookTarget);
          // Subtle banking angle
          actor.group.rotateZ(THREE.MathUtils.clamp(-vel.x * 1.6, -0.45, 0.45));
        }
      }

      // Wing flapping physics
      if (actor.leftWing && actor.rightWing) {
        const flapFreq = actor.spec.flap_speed || 8.5;
        const flap = Math.sin(t * flapFreq + actor.phase) * 0.68;
        actor.leftWing.rotation.z = flap;
        actor.rightWing.rotation.z = -flap;
      }
    }

    // 5. Ambient wind motes drift
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

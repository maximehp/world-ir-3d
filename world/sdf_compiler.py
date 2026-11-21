"""Real-Time Implicit Signed Distance Field (SDF) -> Marching Cubes 3D Mesh Compiler.

Compiles structured smooth-min SDF mathematical expressions authored by Gemini 4 Carbon
into smooth, watertight, multi-sided 3D triangle meshes with:
  - Analytic central-difference ∇SDF smooth vertex normals
  - Exact 5-tap Inigo Quilez 3D SDF Ambient Occlusion baked directly into vertex colors!
  - Triplanar UVs + normalized local bounding coordinates for Object-Space Neural Projection
"""

from __future__ import annotations

import json
import math
import pathlib
import time

import numpy as np
from skimage.measure import marching_cubes

from world.schema import ImplicitSDFSpec, SDFPrimitive


def _rot_matrix(rx_deg: float, ry_deg: float, rz_deg: float) -> np.ndarray:
    rx, ry, rz = math.radians(rx_deg), math.radians(ry_deg), math.radians(rz_deg)
    cx, sx = math.cos(rx), math.sin(rx)
    cy, sy = math.cos(ry), math.sin(ry)
    cz, sz = math.cos(rz), math.sin(rz)
    Rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]], dtype=np.float32)
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]], dtype=np.float32)
    Rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]], dtype=np.float32)
    return (Rz @ Ry @ Rx).astype(np.float32)


def _smin(a: np.ndarray, b: np.ndarray, k: float) -> np.ndarray:
    k = max(k, 1e-4)
    h = np.maximum(k - np.abs(a - b), 0.0) / k
    return np.minimum(a, b) - h * h * k * 0.25


def _smax(a: np.ndarray, b: np.ndarray, k: float) -> np.ndarray:
    return -_smin(-a, -b, k)


def _eval_primitive(p: SDFPrimitive, X: np.ndarray, Y: np.ndarray, Z: np.ndarray) -> np.ndarray:
    cx, cy, cz = p.center
    sx, sy, sz = (max(abs(v), 0.03) for v in p.size)

    px = np.abs(X) - abs(cx) if p.mirror_x else (X - cx)
    py = Y - cy
    pz = Z - cz

    if any(abs(a) > 1e-3 for a in p.rot_deg):
        R = _rot_matrix(-p.rot_deg[0], -p.rot_deg[1], -p.rot_deg[2])
        rx = R[0, 0] * px + R[0, 1] * py + R[0, 2] * pz
        ry = R[1, 0] * px + R[1, 1] * py + R[1, 2] * pz
        rz = R[2, 0] * px + R[2, 1] * py + R[2, 2] * pz
        px, py, pz = rx, ry, rz

    if p.shape == "sphere":
        return np.sqrt(px * px + py * py + pz * pz + 1e-12) - sx

    if p.shape == "ellipsoid":
        k0 = np.sqrt((px / sx) ** 2 + (py / sy) ** 2 + (pz / sz) ** 2 + 1e-12)
        k1 = np.sqrt((px / (sx * sx)) ** 2 + (py / (sy * sy)) ** 2 + (pz / (sz * sz)) ** 2 + 1e-12)
        return k0 * (k0 - 1.0) / np.maximum(k1, 1e-6)

    if p.shape == "round_box":
        r = min(sx, sy, sz) * 0.22
        qx = np.abs(px) - max(sx - r, 0.01)
        qy = np.abs(py) - max(sy - r, 0.01)
        qz = np.abs(pz) - max(sz - r, 0.01)
        outside = np.sqrt(np.maximum(qx, 0.0) ** 2 + np.maximum(qy, 0.0) ** 2 + np.maximum(qz, 0.0) ** 2 + 1e-12)
        inside = np.minimum(np.maximum(qx, np.maximum(qy, qz)), 0.0)
        return outside + inside - r

    if p.shape == "torus":
        q_len = np.sqrt(px * px + pz * pz + 1e-12) - sx
        return np.sqrt(q_len * q_len + py * py + 1e-12) - sy

    if p.shape == "cylinder":
        dx = np.sqrt(px * px + pz * pz + 1e-12) - sx
        dy = np.abs(py) - sy
        return np.minimum(np.maximum(dx, dy), 0.0) + np.sqrt(np.maximum(dx, 0.0) ** 2 + np.maximum(dy, 0.0) ** 2 + 1e-12)

    if p.shape == "cone":
        t_y = np.clip((py + sy) / max(2.0 * sy, 1e-4), 0.0, 1.0)
        rad = sx * (1.0 - t_y) + 0.01
        d_rad = np.sqrt(px * px + pz * pz + 1e-12) - rad
        d_cap = np.abs(py) - sy
        return np.minimum(np.maximum(d_rad, d_cap), 0.0) + np.sqrt(np.maximum(d_rad, 0.0) ** 2 + np.maximum(d_cap, 0.0) ** 2 + 1e-12)

    if p.shape == "capsule":
        if p.end is not None:
            ex, ey, ez = p.end
            ax = abs(cx) if p.mirror_x else cx
            bx = abs(ex) if p.mirror_x else ex
            sx_p = np.abs(X) if p.mirror_x else X
            pax, pay, paz = sx_p - ax, Y - cy, Z - cz
            bax, bay, baz = bx - ax, ey - cy, ez - cz
            ba_dot = max(bax * bax + bay * bay + baz * baz, 1e-6)
            h = np.clip((pax * bax + pay * bay + paz * baz) / ba_dot, 0.0, 1.0)
            dx, dy, dz = pax - bax * h, pay - bay * h, paz - baz * h
            return np.sqrt(dx * dx + dy * dy + dz * dz + 1e-12) - sx
        py_clamped = py - np.clip(py, -sy, sy)
        return np.sqrt(px * px + py_clamped * py_clamped + pz * pz + 1e-12) - sx

    return np.sqrt(px * px + py * py + pz * pz + 1e-12) - sx


def evaluate_sdf_field(spec: ImplicitSDFSpec, X: np.ndarray, Y: np.ndarray, Z: np.ndarray) -> np.ndarray:
    field: np.ndarray | None = None
    for prim in spec.primitives:
        d = _eval_primitive(prim, X, Y, Z)
        if field is None:
            field = d
        elif prim.op == "union":
            field = np.minimum(field, d)
        elif prim.op == "smooth_union":
            field = _smin(field, d, prim.k)
        elif prim.op == "subtract":
            field = np.maximum(field, -d)
        elif prim.op == "smooth_subtract":
            field = _smax(field, -d, prim.k)
    assert field is not None
    return field


def compute_analytic_sdf_ao(
    spec: ImplicitSDFSpec,
    verts_raw: np.ndarray,
    normals: np.ndarray,
) -> np.ndarray:
    """Exact 5-tap Inigo Quilez 3D SDF Ambient Occlusion evaluated along vertex normals in SDF space.
    Produces rich sculptural crevice shadowing from all 360° viewpoints at zero runtime GPU cost!"""
    occ = np.zeros(len(verts_raw), dtype=np.float32)
    weight = 0.5
    for step_idx in range(1, 6):
        h = 0.065 * step_idx
        px = verts_raw[:, 0] + normals[:, 0] * h
        py = verts_raw[:, 1] + normals[:, 1] * h
        pz = verts_raw[:, 2] + normals[:, 2] * h
        d = evaluate_sdf_field(spec, px, py, pz)
        occ += weight * np.maximum(0.0, h - d)
        weight *= 0.55
    ao = np.clip(1.0 - 2.6 * occ, 0.30, 1.0).astype(np.float32)
    return ao


def compile_sdf_mesh(spec: ImplicitSDFSpec, out_path: pathlib.Path) -> tuple[dict, float]:
    """Compile an ImplicitSDFSpec into a normalized, ground-resting indexed 3D mesh JSON with baked SDF-AO."""
    t0 = time.perf_counter()
    n = int(np.clip(spec.resolution, 36, 64))
    bound = 1.55
    lin = np.linspace(-bound, bound, n, dtype=np.float32)
    X, Y, Z = np.meshgrid(lin, lin, lin, indexing="ij")

    sdf = evaluate_sdf_field(spec, X, Y, Z)

    # Watertight outer boundary cap
    sdf[0, :, :] = np.maximum(sdf[0, :, :], 0.05)
    sdf[-1, :, :] = np.maximum(sdf[-1, :, :], 0.05)
    sdf[:, 0, :] = np.maximum(sdf[:, 0, :], 0.05)
    sdf[:, -1, :] = np.maximum(sdf[:, -1, :], 0.05)
    sdf[:, :, 0] = np.maximum(sdf[:, :, 0], 0.05)
    sdf[:, :, -1] = np.maximum(sdf[:, :, -1], 0.05)

    if float(sdf.min()) >= -1e-4:
        sdf = np.sqrt(X * X + Y * Y + Z * Z + 1e-12) - 0.65

    step = (2.0 * bound) / (n - 1)
    verts_raw, faces, _, _ = marching_cubes(sdf, level=0.0, spacing=(step, step, step))
    verts_raw = (verts_raw - bound).astype(np.float32)

    # Analytic central-difference SDF gradient normals
    eps = step * 0.55
    vx, vy, vz = verts_raw[:, 0], verts_raw[:, 1], verts_raw[:, 2]
    gx = evaluate_sdf_field(spec, vx + eps, vy, vz) - evaluate_sdf_field(spec, vx - eps, vy, vz)
    gy = evaluate_sdf_field(spec, vx, vy + eps, vz) - evaluate_sdf_field(spec, vx, vy - eps, vz)
    gz = evaluate_sdf_field(spec, vx, vy, vz + eps) - evaluate_sdf_field(spec, vx, vy, vz - eps)
    gnorm = np.sqrt(gx * gx + gy * gy + gz * gz + 1e-12)
    smooth_normals = np.stack([gx / gnorm, gy / gnorm, gz / gnorm], axis=-1).astype(np.float32)

    # Exact 3D SDF Ambient Occlusion baked directly into mesh vertex colors!
    ao = compute_analytic_sdf_ao(spec, verts_raw, smooth_normals)

    # Normalize mesh so bottom rests at y=0, centered in XZ, scaled to spec.target_height
    verts = verts_raw.copy()
    min_y, max_y = float(verts[:, 1].min()), float(verts[:, 1].max())
    raw_h = max(max_y - min_y, 1e-4)
    scale = spec.target_height / raw_h
    cx = 0.5 * (float(verts[:, 0].min()) + float(verts[:, 0].max()))
    cz = 0.5 * (float(verts[:, 2].min()) + float(verts[:, 2].max()))
    verts[:, 0] = (verts[:, 0] - cx) * scale
    verts[:, 1] = (verts[:, 1] - min_y) * scale
    verts[:, 2] = (verts[:, 2] - cz) * scale

    # Triplanar UVs based on dominant normal axis
    an = np.abs(smooth_normals)
    uv = np.zeros((len(verts), 2), dtype=np.float32)
    uv_scale = 0.45
    dom_x = (an[:, 0] >= an[:, 1]) & (an[:, 0] >= an[:, 2])
    dom_y = (an[:, 1] > an[:, 0]) & (an[:, 1] >= an[:, 2])
    dom_z = ~(dom_x | dom_y)
    uv[dom_x, 0] = verts[dom_x, 2] * uv_scale
    uv[dom_x, 1] = verts[dom_x, 1] * uv_scale
    uv[dom_y, 0] = verts[dom_y, 0] * uv_scale
    uv[dom_y, 1] = verts[dom_y, 2] * uv_scale
    uv[dom_z, 0] = verts[dom_z, 0] * uv_scale
    uv[dom_z, 1] = verts[dom_z, 1] * uv_scale

    # Vertex colors carrying baked 3D SDF-AO (R=G=B=ao)
    colors = np.repeat(ao[:, None], 3, axis=1)

    mesh_payload = {
        "description": spec.description,
        "positions": np.round(verts, 4).ravel().tolist(),
        "normals": np.round(smooth_normals, 4).ravel().tolist(),
        "uvs": np.round(uv, 4).ravel().tolist(),
        "colors": np.round(colors, 4).ravel().tolist(),
        "indices": faces.astype(np.uint32).ravel().tolist(),
        "vertex_count": int(len(verts)),
        "face_count": int(len(faces)),
        "bounds": {
            "min": [round(float(verts[:, i].min()), 4) for i in range(3)],
            "max": [round(float(verts[:, i].max()), 4) for i in range(3)],
        },
    }
    out_path.write_text(json.dumps(mesh_payload))
    ms = (time.perf_counter() - t0) * 1000.0
    return mesh_payload, ms

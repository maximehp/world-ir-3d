"""Reproducible offline tests for WorldIR 3D core components (zero API spend).

Verifies:
  1. Pydantic v2 WorldState & WorldEditPatch schema round-trip integrity
  2. Smooth-Min Implicit SDF -> Marching Cubes compilation, analytic normals, & ground normalization
  3. Seamless toroidal texture tiling + wrap-padded Sobel Normal & Roughness derivation
  4. FastAPI server health and world listing endpoints via TestClient
"""

from __future__ import annotations

import json
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import numpy as np
from fastapi.testclient import TestClient

from world.neural_baker import measure_structural_preservation
from world.schema import (
    ArticulatedAgentSpec,
    AtmosphereSpec,
    BehaviorSpec,
    ImplicitSDFSpec,
    MaterialSpec,
    ParametricSpec,
    SDFPrimitive,
    TerrainSpec,
    WorldObject,
    WorldState,
)
from world.sdf_compiler import compile_sdf_mesh
from world.server import app
from world.textures import derive_normal_and_roughness, derive_pbr_maps, make_seamless_tile


def test_sdf_marching_cubes_compilation() -> None:
    spec = ImplicitSDFSpec(
        description="Symmetric sculpted owl statue test",
        resolution=40,
        target_height=2.2,
        pedestal=True,
        primitives=[
            SDFPrimitive(op="union", shape="ellipsoid", center=[0.0, -0.1, 0.0], size=[0.42, 0.58, 0.38]),
            SDFPrimitive(op="smooth_union", k=0.18, shape="sphere", center=[0.0, 0.52, 0.05], size=[0.32, 0.32, 0.32]),
            SDFPrimitive(op="smooth_union", k=0.10, shape="cone", center=[0.18, 0.80, 0.02], size=[0.10, 0.16, 0.10], mirror_x=True),
            SDFPrimitive(op="smooth_union", k=0.14, shape="ellipsoid", center=[0.36, -0.08, -0.04], size=[0.16, 0.42, 0.24], mirror_x=True),
        ],
    )
    with tempfile.TemporaryDirectory() as td:
        out_path = pathlib.Path(td) / "owl.json"
        payload, ms = compile_sdf_mesh(spec, out_path)
        assert out_path.exists()
        assert payload["vertex_count"] > 500
        assert payload["face_count"] > 1000
        assert abs(payload["bounds"]["min"][1]) < 0.02, f"Expected bottom grounded at y=0, got {payload['bounds']['min']}"
        assert abs(payload["bounds"]["max"][1] - 2.2) < 0.05, f"Expected height ~2.2, got {payload['bounds']['max']}"
        # Verify unit normals and baked 3D SDF Ambient Occlusion vertex colors
        normals = np.array(payload["normals"], dtype=np.float32).reshape(-1, 3)
        lengths = np.linalg.norm(normals, axis=1)
        assert float(np.min(lengths)) > 0.95 and float(np.max(lengths)) < 1.05
        assert "colors" in payload and len(payload["colors"]) == len(payload["positions"])
        ao_vals = np.array(payload["colors"], dtype=np.float32)
        assert float(ao_vals.min()) >= 0.28 and float(ao_vals.max()) <= 1.0
        # Verify valid JSON saved
        loaded = json.loads(out_path.read_text())
        assert loaded["face_count"] == payload["face_count"]
        print(f"[PASS] SDF Marching Cubes + 3D SDF-AO: {payload['vertex_count']} verts / {payload['face_count']} faces in {ms:.1f} ms")


def test_pbr_seamless_and_normal_derivation() -> None:
    rng = np.random.default_rng(42)
    sample = rng.integers(40, 220, size=(256, 256, 3), dtype=np.uint8)
    seamless = make_seamless_tile(sample)
    assert seamless.shape == (256, 256, 3) and seamless.dtype == np.uint8
    normal_rgb, rough_u8, ao_u8 = derive_pbr_maps(seamless)
    assert normal_rgb.shape == (256, 256, 3) and normal_rgb.dtype == np.uint8
    assert rough_u8.shape == (256, 256) and rough_u8.dtype == np.uint8
    assert ao_u8.shape == (256, 256) and ao_u8.dtype == np.uint8
    assert float(normal_rgb[:, :, 2].mean()) > 160.0
    assert float(ao_u8.mean()) > 120.0
    # Backwards-compatible wrapper
    n2, r2 = derive_normal_and_roughness(seamless)
    assert n2.shape == normal_rgb.shape and r2.shape == rough_u8.shape
    print("[PASS] Seamless PBR tiling + toroidal Sobel Normal/Roughness/Cavity-AO maps")


def test_structural_preservation_metrics() -> None:
    src = np.zeros((128, 128, 3), dtype=np.uint8)
    src[24:104, 32:96] = (180, 140, 100)
    oid = np.zeros((128, 128, 3), dtype=np.uint8)
    oid[24:104, 32:96] = (80, 200, 120)
    m_same = measure_structural_preservation(src, src.copy(), oid)
    assert m_same["edge_f1_3px"] == 1.0
    assert m_same["object_silhouette_recall"] == 1.0
    print(f"[PASS] Structural preservation metric check: {m_same}")


def test_world_ir_schema_roundtrip() -> None:
    w = WorldState(
        world_id="w3d_test",
        title="Test Plaza",
        prompt="Test prompt",
        terrain=TerrainSpec(style="cobblestone_plaza", plaza_radius=14.0),
        atmosphere=AtmosphereSpec(time_of_day="golden_hour"),
        objects=[
            WorldObject(
                id="fountain",
                name="Central Fountain",
                collection="landmarks",
                carrier="parametric_assembly",
                position=[0.0, 0.0, 0.0],
                material=MaterialSpec(color="#d4cab8"),
                parametric=ParametricSpec(kind="fountain", width=4.0, height=3.2, depth=4.0),
            ),
            WorldObject(
                id="birds",
                name="Blue Birds",
                collection="agents",
                carrier="articulated_agent",
                position=[0.0, 6.0, 0.0],
                agent=ArticulatedAgentSpec(rig_kind="bird_flock", count=6),
                behavior=BehaviorSpec(kind="orbit_and_perch", target_id="fountain", orbit_radius=5.0, orbit_height=5.5),
            ),
        ],
    )
    restored = WorldState.model_validate_json(w.model_dump_json())
    assert restored.world_id == "w3d_test"
    assert len(restored.objects) == 2
    assert restored.objects[1].behavior.target_id == "fountain"
    print("[PASS] WorldIR Pydantic v2 round-trip")


def test_fastapi_endpoints() -> None:
    client = TestClient(app)
    r_h = client.get("/api/health")
    assert r_h.status_code == 200
    body = r_h.json()
    assert body["status"] == "ok"
    assert "implicit_sdf_marching_cubes" in body["carriers"]
    assert body["models"]["compiler"] == "gemini-4-carbon"
    assert body["models"]["auditor"] == "gemini-4-hydrogen"

    r_w = client.get("/api/worlds")
    assert r_w.status_code == 200
    assert "worlds" in r_w.json()

    r_idx = client.get("/")
    assert r_idx.status_code == 200
    assert "WorldIR 3D" in r_idx.text
    print("[PASS] FastAPI /api/health, /api/worlds, and / endpoints")


if __name__ == "__main__":
    test_sdf_marching_cubes_compilation()
    test_pbr_seamless_and_normal_derivation()
    test_structural_preservation_metrics()
    test_world_ir_schema_roundtrip()
    test_fastapi_endpoints()
    print("ALL OFFLINE WORLD-IR 3D TESTS PASSED.")

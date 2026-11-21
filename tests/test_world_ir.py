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

from world.coordinator import WorldCoordinator
from world.neural_baker import measure_structural_preservation
from world.schema import (
    ArticulatedAgentSpec,
    AssemblyPart,
    AtmosphereSpec,
    BehaviorSpec,
    CameraKeyframe,
    CameraTrack,
    ImplicitSDFSpec,
    MaterialSpec,
    ParametricSpec,
    PBRTextureAsset,
    ProceduralAssemblySpec,
    SDFPrimitive,
    TerrainSpec,
    WorldObject,
    WorldState,
)
from world.sdf_compiler import compile_sdf_mesh
from world.server import app
from world.stream_pipeline import _iter_stream_json_objects
from world.textures import derive_normal_and_roughness, derive_pbr_maps, make_seamless_tile
from world.video_pipeline import (
    compute_entity_appearance_hash,
    compute_scene_appearance_hash,
    decode_mp4_frames,
    encode_frames_to_mp4,
    evaluate_decoded_video,
    interpolate_keyframes_bidirectional_flow,
)


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

    # Also verify general-purpose procedural_assembly + space_bridge interior roundtrip
    ship = WorldState(
        world_id="w3d_ship_test",
        title="Starship Bridge",
        prompt="Spaceship interior",
        terrain=TerrainSpec(style="interior_deck", ground_kind="interior_deck", enclosure="space_bridge", enclosure_size=[20.0, 7.5, 24.0], space_stars=True, plaza_radius=0.0, hill_height=0.0),
        atmosphere=AtmosphereSpec(time_of_day="night", cloud_count=0),
        objects=[
            WorldObject(
                id="holo_table",
                name="Holographic Command Table",
                collection="structures",
                carrier="procedural_assembly",
                position=[0.0, 0.0, -2.0],
                procedural=ProceduralAssemblySpec(
                    description="Curved holographic tactical table with spinning cyan projection ring",
                    parts=[
                        AssemblyPart(shape="cylinder", pos=[0, 0.45, 0], size=[1.4, 1.6, 0.9], color="#2a3444", metalness=0.8),
                        AssemblyPart(shape="torus", pos=[0, 1.3, 0], size=[1.1, 0.05, 360], color="#38e8ff", emissive="#38e8ff", emissive_intensity=3.0, opacity=0.6, anim="spin_y"),
                    ],
                    light_color="#38e8ff",
                    light_intensity=12.0,
                ),
            ),
        ],
    )
    ship_rt = WorldState.model_validate_json(ship.model_dump_json())
    assert ship_rt.terrain.enclosure == "space_bridge"
    assert ship_rt.objects[0].carrier == "procedural_assembly"
    assert len(ship_rt.objects[0].procedural.parts) == 2
    print("[PASS] WorldIR Pydantic v2 round-trip (village + procedural_assembly space_bridge)")


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

    r_wed = client.post("/api/worlds/wedding-benchmark")
    assert r_wed.status_code == 200
    wed = r_wed.json()
    assert wed["world_id"] == "w3d_wedding_bench"
    assert len(wed["cameras"]) >= 3
    ids = {o["id"] for o in wed["objects"]}
    assert "bride" in ids and "groom" in ids and "ceremony_archway" in ids
    print("[PASS] FastAPI /api/health, /api/worlds, /api/worlds/wedding-benchmark, and / endpoints")


def test_coordinator_determinism_collision_and_locks() -> None:
    shell = WorldState(
        world_id="w3d_coord_test",
        title="Coord Test",
        prompt="test",
        terrain=TerrainSpec(),
        atmosphere=AtmosphereSpec(),
    )
    coord = WorldCoordinator(shell)
    op1 = coord.commit_op(domain="init", payload={"title": "Streamed Test", "terrain": TerrainSpec().model_dump(), "atmosphere": AtmosphereSpec().model_dump()}, phase="scaffold")
    assert op1 and op1.seq == 1

    # Two parallel workers try placing two buildings on exact same (10, 0, 0) coordinate
    b1 = WorldObject(id="villa_a", name="Villa A", collection="architecture", carrier="parametric_assembly", position=[10.0, 0.0, 0.0], parametric=ParametricSpec(kind="building", width=4.5, depth=4.5))
    b2 = WorldObject(id="villa_b", name="Villa B", collection="architecture", carrier="parametric_assembly", position=[10.0, 0.0, 0.0], parametric=ParametricSpec(kind="building", width=4.5, depth=4.5))
    o_a = coord.commit_op(domain="object", action="upsert", target_id="villa_a", payload=b1.model_dump(), phase="geometry", resolve_collisions=True)
    o_b = coord.commit_op(domain="object", action="upsert", target_id="villa_b", payload=b2.model_dump(), phase="geometry", resolve_collisions=True)
    assert o_a and o_b and o_b.seq == 3
    dist = ((o_a.payload["position"][0] - o_b.payload["position"][0]) ** 2 + (o_a.payload["position"][2] - o_b.payload["position"][2]) ** 2) ** 0.5
    assert dist > 4.0, f"Coordinator failed to de-collide overlapping worker buildings (dist={dist})"

    # User edits villa_a during streaming -> late generation op cannot overwrite it
    coord.commit_op(domain="object", action="patch", target_id="villa_a", payload={"scale": 1.8}, phase="edit")
    late = coord.commit_op(domain="object", action="upsert", target_id="villa_a", payload=b1.model_dump(), phase="geometry")
    assert late is None, "User-locked object was overwritten by stale background worker!"
    assert next(o for o in coord.world.objects if o.id == "villa_a").scale == 1.8

    # Monotonic texture tier invariant: refined cannot be downgraded by late provisional
    t_ref = PBRTextureAsset(id="wall_pbr", prompt="stone", albedo_url="/a.jpg", normal_url="/n.jpg", roughness_url="/r.jpg", tier="refined")
    t_prov = PBRTextureAsset(id="wall_pbr", prompt="stone", albedo_url="/p.jpg", normal_url="/pn.jpg", roughness_url="/pr.jpg", tier="provisional")
    assert coord.commit_op(domain="texture", action="upsert", target_id="wall_pbr", payload=t_ref.model_dump(), phase="texture_refined") is not None
    assert coord.commit_op(domain="texture", action="upsert", target_id="wall_pbr", payload=t_prov.model_dump(), phase="texture_provisional") is None
    assert coord.world.textures["wall_pbr"].tier == "refined"
    print(f"[PASS] WorldCoordinator determinism: de-collision dist={dist:.2f}m, user-edit lock, monotonic PBR tier")


def test_stream_json_extractor() -> None:
    class FakeChunk:
        def __init__(self, text: str) -> None:
            self.text = text

    chunks = [
        FakeChunk('```json\n{"id": "a", "val": '),
        FakeChunk('1}\n{"id": "b", "nested": {"x": "}brace"}}\n'),
        FakeChunk('{"id": "c"}\n```'),
    ]
    objs = list(_iter_stream_json_objects(chunks))
    assert [o["id"] for o in objs] == ["a", "b", "c"], f"Unexpected parsed stream objs: {objs}"

    from world.stream_pipeline import _sanitize_world_object_dict
    coerced = _sanitize_world_object_dict({
        "id": "holo_console",
        "carrier": "procedural_assembly",
        "position": [0, 0, -2],
        "procedural_assembly": {
            "description": "Starship helm",
            "parts": [{"shape": "box", "pos": [0, 0.5, 0], "size": [2, 1, 0.8], "color": "#223344"}],
        },
    })
    assert coerced["name"] == "Holo Console"
    assert coerced["procedural"]["parts"][0]["shape"] == "box"
    print("[PASS] Incremental balanced-JSON stream parser & procedural_assembly sanitizer")


def test_appearance_hashing_and_flow_mp4_roundtrip() -> None:
    bride = WorldObject(
        id="bride", name="Bride", collection="agents", carrier="articulated_agent",
        position=[0.0, 0.0, 4.0],
        material=MaterialSpec(color="#fbf6ee"),
        agent=ArticulatedAgentSpec(rig_kind="human_character", count=1, role="bride", garment_style="gown_aline", has_veil=True),
        behavior=BehaviorSpec(kind="walk_path", waypoints_xz=[[0, 4], [0, -5]]),
    )
    h1 = compute_entity_appearance_hash(bride)
    # Moving position or editing behavior MUST NOT invalidate persistent appearance ref cache!
    bride_moved = bride.model_copy(deep=True)
    bride_moved.position = [1.0, 0.0, -2.0]
    bride_moved.behavior.speed = 2.0
    assert compute_entity_appearance_hash(bride_moved) == h1
    # Changing dress color MUST invalidate appearance ref cache!
    bride_redress = bride.model_copy(deep=True)
    bride_redress.material.color = "#f2b8c6"
    assert compute_entity_appearance_hash(bride_redress) != h1

    # Verify bidirectional DIS optical flow interpolation + real ffmpeg MP4 encode/decode + metrics
    f0 = np.zeros((160, 256, 3), dtype=np.uint8)
    f1 = np.zeros((160, 256, 3), dtype=np.uint8)
    f0[50:110, 40:90] = (230, 180, 120)
    f1[50:110, 70:120] = (230, 180, 120)
    dense = interpolate_keyframes_bidirectional_flow([f0, f1], subframes_per_interval=8)
    assert len(dense) == 9
    with tempfile.TemporaryDirectory() as td:
        mp4 = pathlib.Path(td) / "test.mp4"
        encode_frames_to_mp4(dense, mp4, fps=24)
        assert mp4.exists() and mp4.stat().st_size > 1000
        decoded = decode_mp4_frames(mp4)
        assert len(decoded) == 9
        metrics = evaluate_decoded_video(decoded, [f0, f1], [None, None], [0, 8])
        assert metrics["temporal_warp_psnr_db"] > 20.0
    print(f"[PASS] Appearance hash locality & DIS flow -> H.264 MP4 roundtrip (PSNR={metrics['temporal_warp_psnr_db']} dB)")


if __name__ == "__main__":
    test_sdf_marching_cubes_compilation()
    test_pbr_seamless_and_normal_derivation()
    test_structural_preservation_metrics()
    test_world_ir_schema_roundtrip()
    test_coordinator_determinism_collision_and_locks()
    test_stream_json_extractor()
    test_appearance_hashing_and_flow_mp4_roundtrip()
    test_fastapi_endpoints()
    print("ALL OFFLINE WORLD-IR 3D TESTS PASSED.")

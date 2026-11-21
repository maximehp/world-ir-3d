"""Persistent 3D World Engine:
- Orchestrates Gemini 4 Carbon compilation, Nano Banana PBR synthesis, and Marching Cubes SDF compilation
- Maintains immutable revision snapshots with 0-call Undo
- Executes surgical diffs without regenerating unrelated 3D objects
- Runs independent 4-viewpoint Gemini 4 Hydrogen visual auditing & bounded spatial auto-repair
"""

from __future__ import annotations

import base64
import concurrent.futures
import io
import pathlib
import threading
import time
import uuid

from PIL import Image

from world.coordinator import WorldCoordinator
from world.gemini_3d import (
    carbon_compile_world,
    carbon_compile_world_edit,
    hydrogen_audit_multiview,
)
from world.neural_baker import bake_sdf_dual_projection, neural_enhance_gbuffer_view
from world.schema import (
    ArticulatedAgentSpec,
    AtmosphereSpec,
    BehaviorSpec,
    CameraKeyframe,
    CameraTrack,
    ImplicitSDFSpec,
    MaterialSpec,
    MultiViewAuditVerdict,
    ParametricSpec,
    PBRTextureAsset,
    RegionSpec,
    SDFPrimitive,
    TerrainSpec,
    TextureRequest,
    WorldCosts,
    WorldObject,
    WorldRevision,
    WorldState,
    WorldTimings,
)
from world.sdf_compiler import compile_sdf_mesh
from world.stream_pipeline import (
    run_streamed_edit,
    run_streamed_region_expansion,
    run_streamed_world_creation,
)
from world.textures import ensure_ao_for_existing_albedo, synthesize_pbr_texture
from world.video_pipeline import (
    ensure_appearance_references_parallel,
    probe_video_model_support,
    run_video_generation_experiment,
)


DATA_ROOT = pathlib.Path(__file__).resolve().parent / "data"
WORLDS_ROOT = DATA_ROOT / "worlds"
WORLDS_ROOT.mkdir(parents=True, exist_ok=True)


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


def _add_costs(a: WorldCosts, b: WorldCosts) -> WorldCosts:
    return WorldCosts(
        flash_lite_calls=a.flash_lite_calls + b.flash_lite_calls,
        carbon_calls=a.carbon_calls + b.carbon_calls,
        hydrogen_calls=a.hydrogen_calls + b.hydrogen_calls,
        nano_banana_texture_calls=a.nano_banana_texture_calls + b.nano_banana_texture_calls,
        provisional_texture_calls=a.provisional_texture_calls + b.provisional_texture_calls,
        sdf_meshes_compiled=a.sdf_meshes_compiled + b.sdf_meshes_compiled,
    )


class WorldManager:
    def __init__(self) -> None:
        self._worlds: dict[str, WorldState] = {}
        self._snapshots: dict[str, list[WorldState]] = {}
        self._coordinators: dict[str, WorldCoordinator] = {}
        self._load_existing()

    def _wdir(self, world_id: str) -> pathlib.Path:
        d = WORLDS_ROOT / world_id
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _asset_url(self, world_id: str, filename: str) -> str:
        return f"/world-assets/worlds/{world_id}/{filename}"

    def _persist(self, world: WorldState) -> None:
        wdir = self._wdir(world.world_id)
        tmp = wdir / "world.json.tmp"
        tmp.write_text(world.model_dump_json(indent=2))
        tmp.replace(wdir / "world.json")
        self._worlds[world.world_id] = world

    def _load_existing(self) -> None:
        for p in sorted(WORLDS_ROOT.glob("*/world.json")):
            try:
                w = WorldState.model_validate_json(p.read_text())
                self._worlds[w.world_id] = w
                self._snapshots[w.world_id] = [w.model_copy(deep=True)]
                self._coordinators[w.world_id] = WorldCoordinator(w, persist_cb=self._persist)
            except Exception:
                pass

    def get_coordinator(self, world_id: str) -> WorldCoordinator:
        if world_id not in self._coordinators:
            w = self.get_world(world_id)
            self._coordinators[world_id] = WorldCoordinator(w, persist_cb=self._persist)
        return self._coordinators[world_id]

    def list_worlds(self) -> list[dict]:
        return [
            {
                "world_id": w.world_id,
                "title": w.title,
                "prompt": w.prompt,
                "revision": w.revision,
                "object_count": len([o for o in w.objects if o.visible]),
                "sdf_count": len([o for o in w.objects if o.visible and o.carrier == "implicit_sdf"]),
                "agent_count": len([o for o in w.objects if o.visible and o.carrier == "articulated_agent"]),
                "costs": w.cumulative_costs.model_dump(),
            }
            for w in reversed(list(self._worlds.values()))
        ]

    def get_world(self, world_id: str) -> WorldState:
        if world_id not in self._worlds:
            raise KeyError(f"World {world_id} not found")
        return self._worlds[world_id]

    def _compile_textures_parallel(
        self,
        world_id: str,
        requests: list[TextureRequest],
        costs: WorldCosts,
        timings: WorldTimings,
    ) -> dict[str, PBRTextureAsset]:
        if not requests:
            return {}
        wdir = self._wdir(world_id)
        assets: dict[str, PBRTextureAsset] = {}
        t0 = time.perf_counter()
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            futs = {
                pool.submit(synthesize_pbr_texture, tr.id, tr.prompt, wdir, 512): tr
                for tr in requests
            }
            for fut in concurrent.futures.as_completed(futs):
                tr = futs[fut]
                try:
                    files, _ = fut.result()
                    costs.nano_banana_texture_calls += 1
                    assets[tr.id] = PBRTextureAsset(
                        id=tr.id,
                        prompt=tr.prompt,
                        albedo_url=self._asset_url(world_id, files["albedo_name"]),
                        normal_url=self._asset_url(world_id, files["normal_name"]),
                        roughness_url=self._asset_url(world_id, files["rough_name"]),
                        ao_url=self._asset_url(world_id, files["ao_name"]),
                        source="nano_banana_pbr",
                    )
                except Exception as exc:
                    print(f"[WARN] Texture {tr.id} synthesis failed: {exc}")
        timings.nano_banana_ms += round((time.perf_counter() - t0) * 1000.0, 1)
        return assets

    def _compile_sdf_objects(
        self,
        world_id: str,
        objects: list[WorldObject],
        costs: WorldCosts,
        timings: WorldTimings,
    ) -> None:
        wdir = self._wdir(world_id)
        for obj in objects:
            if obj.carrier == "implicit_sdf" and obj.implicit_sdf is not None:
                fname = f"sdf_{obj.id}_v{obj.version}_{uuid.uuid4().hex[:5]}.json"
                payload, ms = compile_sdf_mesh(obj.implicit_sdf, wdir / fname)
                obj.implicit_sdf.mesh_url = self._asset_url(world_id, fname)
                obj.implicit_sdf.vertex_count = payload["vertex_count"]
                obj.implicit_sdf.face_count = payload["face_count"]
                costs.sdf_meshes_compiled += 1
                timings.sdf_compile_ms += round(ms, 1)

    @staticmethod
    def _sanitize_object_ids(objects: list[WorldObject], existing_ids: set[str] | None = None) -> None:
        seen = set(existing_ids or set())
        for obj in objects:
            base = obj.id.strip().lower().replace(" ", "_") or "obj"
            cand = base
            idx = 2
            while cand in seen:
                cand = f"{base}_{idx}"
                idx += 1
            obj.id = cand
            seen.add(cand)

    def create_world(self, prompt: str) -> WorldState:
        """Compile an unseen natural-language prompt into a full multi-carrier 3D world."""
        t0 = time.perf_counter()
        world_id = _new_id("w3d")
        costs = WorldCosts()
        timings = WorldTimings()

        # 1. Gemini 4 Carbon compiles structured multi-carrier 3D WorldDraft
        draft, c_ms = carbon_compile_world(prompt)
        costs.carbon_calls += 1
        timings.carbon_ms += round(c_ms, 1)

        self._sanitize_object_ids(draft.objects)

        # 2. Synthesize Nano Banana PBR textures (parallel) + compile Marching Cubes SDF meshes (~9ms each)
        textures = self._compile_textures_parallel(world_id, draft.texture_requests, costs, timings)
        self._compile_sdf_objects(world_id, draft.objects, costs, timings)

        # Validate texture_id references so missing failed textures fall back cleanly to procedural shading
        valid_tex = set(textures.keys())
        if draft.terrain.texture_id and draft.terrain.texture_id not in valid_tex:
            draft.terrain.texture_id = None
        for obj in draft.objects:
            if obj.material.texture_id and obj.material.texture_id not in valid_tex:
                obj.material.texture_id = None

        timings.total_ms = round((time.perf_counter() - t0) * 1000.0, 1)

        world = WorldState(
            world_id=world_id,
            title=draft.title,
            prompt=prompt,
            terrain=draft.terrain,
            atmosphere=draft.atmosphere,
            textures=textures,
            objects=draft.objects,
            revision=1,
            cumulative_costs=costs,
            camera_spawn=draft.camera_spawn,
            camera_look_at=draft.camera_look_at,
        )
        world.history.append(
            WorldRevision(
                revision=1,
                action="create_world",
                instruction=prompt,
                carbon_summary=draft.summary,
                changed_object_ids=[o.id for o in world.objects],
                unchanged_object_ids=[],
                rebuilt_entire_world=True,
                costs=costs,
                timings=timings,
            )
        )

        self._snapshots[world_id] = [world.model_copy(deep=True)]
        self._persist(world)
        return world

    def apply_edit(
        self,
        world_id: str,
        instruction: str,
        selected_object_id: str | None = None,
    ) -> tuple[WorldState, dict]:
        """Apply a surgical natural-language edit, returning updated WorldState and delta summary for hot-patching."""
        t0 = time.perf_counter()
        prev = self.get_world(world_id)
        world = prev.model_copy(deep=True)
        costs = WorldCosts()
        timings = WorldTimings()

        # 1. Gemini 4 Carbon compiles minimal surgical diff
        patch, c_ms = carbon_compile_world_edit(world, instruction, selected_object_id=selected_object_id)
        costs.carbon_calls += 1
        timings.carbon_ms += round(c_ms, 1)

        # 2. Synthesize ONLY newly requested Nano Banana PBR textures (0 calls if none needed!)
        new_tex = self._compile_textures_parallel(world_id, patch.new_texture_requests, costs, timings)
        world.textures.update(new_tex)
        valid_tex = set(world.textures.keys())

        changed_ids: list[str] = []
        behavior_only_ids: list[str] = []
        obj_map = {o.id: o for o in world.objects}

        # 3. Apply targeted object mutations (leaving unrelated objects bit-exact untouched!)
        sdf_to_compile: list[WorldObject] = []
        for mut in patch.mutations:
            target = obj_map.get(mut.object_id)
            if target is None:
                continue
            geom_changed = False
            if mut.new_position is not None:
                target.position = mut.new_position
            if mut.new_rotation_y_deg is not None:
                target.rotation_y_deg = mut.new_rotation_y_deg
            if mut.new_scale is not None:
                target.scale = mut.new_scale
            if mut.new_material is not None:
                if mut.new_material.texture_id and mut.new_material.texture_id not in valid_tex:
                    mut.new_material.texture_id = target.material.texture_id
                target.material = mut.new_material
            if mut.new_parametric is not None:
                target.parametric = mut.new_parametric
                geom_changed = True
            if mut.new_implicit_sdf is not None:
                target.implicit_sdf = mut.new_implicit_sdf
                target.carrier = "implicit_sdf"
                geom_changed = True
                sdf_to_compile.append(target)
            if mut.new_behavior is not None:
                target.behavior = mut.new_behavior
            if mut.visible is not None:
                target.visible = mut.visible

            is_behavior_only = (
                mut.new_behavior is not None
                and mut.new_position is None
                and mut.new_rotation_y_deg is None
                and mut.new_scale is None
                and mut.new_material is None
                and not geom_changed
                and mut.visible is None
            )
            if is_behavior_only:
                behavior_only_ids.append(target.id)
            target.version += 1
            if target.id not in changed_ids:
                changed_ids.append(target.id)

        # 4. Add new objects
        if patch.add_objects:
            self._sanitize_object_ids(patch.add_objects, existing_ids=set(obj_map.keys()))
            for obj in patch.add_objects:
                if obj.material.texture_id and obj.material.texture_id not in valid_tex:
                    obj.material.texture_id = None
                if obj.carrier == "implicit_sdf" and obj.implicit_sdf is not None:
                    sdf_to_compile.append(obj)
                world.objects.append(obj)
                changed_ids.append(obj.id)

        # Compile any added or mutated SDF meshes via Marching Cubes
        if sdf_to_compile:
            self._compile_sdf_objects(world_id, sdf_to_compile, costs, timings)

        # 5. Remove objects (soft-delete preserves immutable history + Undo!)
        removed_ids: list[str] = []
        for rid in patch.remove_object_ids:
            target = obj_map.get(rid)
            if target is not None:
                target.visible = False
                removed_ids.append(rid)
                if rid not in changed_ids:
                    changed_ids.append(rid)

        # 6. Atmosphere / Terrain surgical updates
        atmosphere_changed = False
        if patch.new_atmosphere is not None:
            world.atmosphere = patch.new_atmosphere
            atmosphere_changed = True
        terrain_changed = False
        if patch.new_terrain is not None:
            if patch.new_terrain.texture_id and patch.new_terrain.texture_id not in valid_tex:
                patch.new_terrain.texture_id = world.terrain.texture_id
            world.terrain = patch.new_terrain
            terrain_changed = True

        unchanged_ids = [o.id for o in world.objects if o.visible and o.id not in changed_ids]

        world.revision += 1
        timings.total_ms = round((time.perf_counter() - t0) * 1000.0, 1)
        world.cumulative_costs = _add_costs(world.cumulative_costs, costs)
        world.history.append(
            WorldRevision(
                revision=world.revision,
                action=patch.action,
                instruction=instruction,
                carbon_summary=patch.summary,
                changed_object_ids=changed_ids,
                unchanged_object_ids=unchanged_ids,
                rebuilt_entire_world=False,
                costs=costs,
                timings=timings,
            )
        )

        self._snapshots.setdefault(world_id, []).append(world.model_copy(deep=True))
        self._persist(world)

        delta = {
            "action": patch.action,
            "changed_object_ids": changed_ids,
            "behavior_only_ids": behavior_only_ids,
            "removed_ids": removed_ids,
            "unchanged_object_ids": unchanged_ids,
            "atmosphere_changed": atmosphere_changed,
            "terrain_changed": terrain_changed,
            "new_texture_ids": list(new_tex.keys()),
        }
        return world, delta

    def audit_multiview_plate(
        self,
        world_id: str,
        plate_base64_jpeg: str,
        allow_repair: bool = True,
    ) -> tuple[WorldState, MultiViewAuditVerdict, list[str]]:
        """Run independent Gemini 4 Hydrogen audit on a live 4-viewpoint 3D WebGL render plate."""
        world = self.get_world(world_id).model_copy(deep=True)
        wdir = self._wdir(world_id)

        # Strip optional data URL prefix
        raw_b64 = plate_base64_jpeg.split(",", 1)[-1]
        img = Image.open(io.BytesIO(base64.b64decode(raw_b64))).convert("RGB")
        plate_name = f"audit_rev{world.revision}_{uuid.uuid4().hex[:5]}.jpg"
        img.save(wdir / plate_name, quality=88)
        plate_url = self._asset_url(world_id, plate_name)

        latest_intent = world.history[-1].instruction if world.history else world.prompt
        h_resp, h_ms = hydrogen_audit_multiview(world, img, latest_intent, allow_repair=allow_repair)

        repaired_ids: list[str] = []
        if allow_repair and h_resp.status == "REPAIR_SPATIAL" and h_resp.fixes:
            obj_map = {o.id: o for o in world.objects}
            for fx in h_resp.fixes[:3]:
                t = obj_map.get(fx.object_id)
                if t is None:
                    continue
                if fx.new_position is not None:
                    t.position = fx.new_position
                if fx.new_rotation_y_deg is not None:
                    t.rotation_y_deg = fx.new_rotation_y_deg
                if abs(fx.scale_multiplier - 1.0) > 1e-3:
                    t.scale = round(max(0.2, min(4.0, t.scale * fx.scale_multiplier)), 3)
                t.version += 1
                repaired_ids.append(t.id)

        verdict = MultiViewAuditVerdict(
            status=h_resp.status,
            geometry_3d_score=h_resp.geometry_3d_score,
            spatial_coherence_score=h_resp.spatial_coherence_score,
            lighting_material_score=h_resp.lighting_material_score,
            prompt_coverage_score=h_resp.prompt_coverage_score,
            matched_elements=h_resp.matched_elements,
            missing_elements=h_resp.missing_elements,
            summary=h_resp.summary,
            defects=h_resp.defects,
            fixes=h_resp.fixes,
            multiview_plate_url=plate_url,
        )

        world.cumulative_costs.hydrogen_calls += 1
        if world.history:
            world.history[-1].audit = verdict
            world.history[-1].costs.hydrogen_calls += 1
            world.history[-1].timings.hydrogen_ms = round(world.history[-1].timings.hydrogen_ms + h_ms, 1)

        if repaired_ids:
            self._snapshots.setdefault(world_id, []).append(world.model_copy(deep=True))
        self._persist(world)
        return world, verdict, repaired_ids

    def undo(self, world_id: str) -> WorldState:
        snaps = self._snapshots.get(world_id, [])
        if len(snaps) <= 1:
            return self.get_world(world_id)
        snaps.pop()
        restored = snaps[-1].model_copy(deep=True)
        if world_id in self._coordinators:
            self._coordinators[world_id].replace_world(restored)
        else:
            self._persist(restored)
        return restored

    # -----------------------------------------------------------------------
    # Parallel Streamed World Creation, Fast Surgical Editing & Region Expansion
    # -----------------------------------------------------------------------

    def start_world_stream(
        self,
        prompt: str,
        enable_provisional_textures: bool = True,
    ) -> tuple[str, WorldCoordinator, str]:
        """Register a new live world immediately and launch massively parallel streamed creation in the background."""
        world_id = _new_id("w3d")
        stream_id = _new_id("str")
        shell = WorldState(
            world_id=world_id,
            title="Compiling 3D World...",
            prompt=prompt,
            terrain=TerrainSpec(),
            atmosphere=AtmosphereSpec(),
            generation_status="streaming",
        )
        self._worlds[world_id] = shell
        self._snapshots[world_id] = [shell.model_copy(deep=True)]
        coord = WorldCoordinator(shell, persist_cb=self._persist)
        self._coordinators[world_id] = coord

        wdir = self._wdir(world_id)
        asset_fn = lambda fname: self._asset_url(world_id, fname)

        def _runner() -> None:
            try:
                final_world, _, _ = run_streamed_world_creation(
                    prompt, coord, wdir, asset_fn,
                    enable_provisional_textures=enable_provisional_textures,
                    stream_id=stream_id,
                )
                self._snapshots[world_id] = [final_world.model_copy(deep=True)]
            except Exception as exc:
                print(f"[ERROR] Streamed world creation failed for {world_id}: {exc}")
                coord.commit_op(
                    domain="status",
                    action="complete",
                    target_id=world_id,
                    payload={"stream_id": stream_id, "generation_status": "complete", "error": str(exc)},
                    phase="complete",
                    worker="coordinator",
                    persist=True,
                )

        threading.Thread(target=_runner, name=f"gen_{world_id}", daemon=True).start()
        return world_id, coord, stream_id

    def start_edit_stream(
        self,
        world_id: str,
        instruction: str,
        selected_object_id: str | None = None,
        enable_provisional_textures: bool = True,
    ) -> tuple[WorldCoordinator, int, str]:
        """Launch sub-second two-phase streamed edit on the world's coordinator (works even while generation runs!)."""
        coord = self.get_coordinator(world_id)
        since_seq = coord.world.seq
        stream_id = _new_id("edt")
        self._snapshots.setdefault(world_id, []).append(coord.snapshot())
        wdir = self._wdir(world_id)
        asset_fn = lambda fname: self._asset_url(world_id, fname)

        def _runner() -> None:
            try:
                updated, _, _, _ = run_streamed_edit(
                    instruction,
                    selected_object_id,
                    coord,
                    wdir,
                    asset_fn,
                    enable_provisional_textures=enable_provisional_textures,
                    stream_id=stream_id,
                )
                self._snapshots.setdefault(world_id, []).append(updated.model_copy(deep=True))
            except Exception as exc:
                print(f"[ERROR] Streamed edit failed for {world_id}: {exc}")
                coord.commit_op(
                    domain="status",
                    action="complete",
                    target_id=world_id,
                    payload={"stream_id": stream_id, "generation_status": "complete", "error": str(exc)},
                    phase="complete",
                    worker="coordinator",
                )

        threading.Thread(target=_runner, name=f"edit_{world_id}", daemon=True).start()
        return coord, since_seq, stream_id

    def start_region_expansion_stream(
        self,
        world_id: str,
        rx: int,
        rz: int,
        direction_hint: str | None = None,
    ) -> tuple[WorldCoordinator, int, str]:
        """Launch seamless persistent adjacent-region expansion (0-call cache hit if already generated)."""
        coord = self.get_coordinator(world_id)
        since_seq = coord.world.seq
        stream_id = _new_id("reg")
        wdir = self._wdir(world_id)
        asset_fn = lambda fname: self._asset_url(world_id, fname)

        def _runner() -> None:
            try:
                updated, _ = run_streamed_region_expansion(
                    rx, rz, direction_hint, coord, wdir, asset_fn, stream_id=stream_id
                )
                self._snapshots.setdefault(world_id, []).append(updated.model_copy(deep=True))
            except Exception as exc:
                print(f"[ERROR] Region expansion failed for {world_id}: {exc}")
                coord.commit_op(
                    domain="status",
                    action="complete",
                    target_id=f"r_{rx}_{rz}",
                    payload={"stream_id": stream_id, "generation_status": "complete", "error": str(exc)},
                    phase="complete",
                    worker="coordinator",
                )

        threading.Thread(target=_runner, name=f"reg_{world_id}_{rx}_{rz}", daemon=True).start()
        return coord, since_seq, stream_id

    def apply_edit_fast(
        self,
        world_id: str,
        instruction: str,
        selected_object_id: str | None = None,
    ) -> tuple[WorldState, dict]:
        """Synchronous fast two-phase edit wrapper returning updated WorldState + delta + separate TTFC/refined timings."""
        coord = self.get_coordinator(world_id)
        self._snapshots.setdefault(world_id, []).append(coord.snapshot())
        wdir = self._wdir(world_id)
        asset_fn = lambda fname: self._asset_url(world_id, fname)
        updated, delta, _, _ = run_streamed_edit(instruction, selected_object_id, coord, wdir, asset_fn)
        self._snapshots.setdefault(world_id, []).append(updated.model_copy(deep=True))
        return updated, delta

    # -----------------------------------------------------------------------
    # Appearance-Anchored Generative Video + Wedding Benchmark Scene
    # -----------------------------------------------------------------------

    def ensure_appearance_references(
        self,
        world_id: str,
        scene_guide: dict,
        entity_guides: dict[str, dict],
        force: bool = False,
    ) -> tuple[WorldState, dict]:
        """Generate or reuse cached persistent scene + canonical entity turnaround references in parallel."""
        coord = self.get_coordinator(world_id)
        world = coord.snapshot()
        wdir = self._wdir(world_id)
        asset_fn = lambda fname: self._asset_url(world_id, fname)

        refs, info = ensure_appearance_references_parallel(
            world, scene_guide, entity_guides, wdir, asset_fn, force=force
        )
        with coord._lock:
            coord.world.appearance_refs.update(refs)
            coord.world.cumulative_costs.nano_banana_texture_calls += info["nano_banana_calls"]
            self._persist(coord.world)
        return coord.snapshot(), info

    def generate_anchored_video(
        self,
        world_id: str,
        keyframes: list[dict],
        shot_description: str,
        mode: str = "appearance_anchored",
        hero_entity_ids: list[str] | None = None,
        fps: int = 24,
        subframes_per_interval: int = 16,
    ) -> dict:
        """Generate a real playable 24 FPS H.264 MP4 from World IR keyframes + optional persistent appearance refs."""
        world = self.get_world(world_id)
        wdir = self._wdir(world_id)
        asset_fn = lambda fname: self._asset_url(world_id, fname)
        return run_video_generation_experiment(
            world=world,
            keyframes_data=keyframes,
            shot_description=shot_description,
            out_dir=wdir,
            asset_url_fn=asset_fn,
            mode="appearance_anchored" if mode == "appearance_anchored" else "structural_only",
            hero_entity_ids=hero_entity_ids,
            fps=fps,
            subframes_per_interval=subframes_per_interval,
        )

    def create_wedding_benchmark_world(self, world_id: str = "w3d_wedding_bench") -> WorldState:
        """Create a deterministic, rich scripted 3D Courtyard Wedding World IR for the wedding video benchmark.
        Features: Bride walking down cobblestone floral aisle toward Groom waiting beneath stone wedding archway,
        Officiant, seated Guests turning gaze, circling white doves, tiered fountain, sculpted twin-swan SDF,
        and independently editable cinematic camera trajectories!"""
        wdir = self._wdir(world_id)
        asset_fn = lambda fname: self._asset_url(world_id, fname)

        # Reuse existing cached PBR textures from w3d_bench_med if available so setup is instant (0 wasted calls!)
        textures: dict[str, PBRTextureAsset] = {}
        med_dir = WORLDS_ROOT / "w3d_bench_med"
        if med_dir.exists() and (med_dir / "world.json").exists():
            try:
                med_w = WorldState.model_validate_json((med_dir / "world.json").read_text())
                for tid in ("travertine_cobble", "mediterranean_stucco", "carved_carrara_marble", "roof_tiles_pbr", "hill_terrain_pbr"):
                    if tid in med_w.textures:
                        textures[tid] = med_w.textures[tid].model_copy(deep=True)
            except Exception:
                pass

        # Sculpted Carrara Marble Twin-Heart Arch Finial / Wedding Fountain Sculpture via real Implicit SDF Marching Cubes
        sdf_spec = ImplicitSDFSpec(
            description="Carved white Carrara marble romantic twin-swan wedding sculpture on an octagonal stone pedestal",
            resolution=50,
            target_height=2.2,
            pedestal=True,
            primitives=[
                SDFPrimitive(op="union", shape="ellipsoid", center=[0.32, -0.22, 0.0], size=[0.28, 0.24, 0.42], mirror_x=True),
                SDFPrimitive(op="smooth_union", k=0.14, shape="capsule", center=[0.24, 0.0, 0.14], end=[0.14, 0.62, 0.08], size=[0.09, 0.09, 0.09], mirror_x=True),
                SDFPrimitive(op="smooth_union", k=0.12, shape="sphere", center=[0.08, 0.66, 0.06], size=[0.14, 0.13, 0.15], mirror_x=True),
                SDFPrimitive(op="smooth_union", k=0.16, shape="ellipsoid", center=[0.46, 0.02, -0.10], size=[0.12, 0.36, 0.34], rot_deg=[12.0, 0.0, -24.0], mirror_x=True),
                SDFPrimitive(op="smooth_union", k=0.16, shape="cylinder", center=[0.0, -0.52, 0.0], size=[0.56, 0.14, 0.56]),
            ],
        )
        sdf_fname = f"sdf_wedding_swan_sculpture_v1.json"
        payload, sdf_ms = compile_sdf_mesh(sdf_spec, wdir / sdf_fname)
        sdf_spec.mesh_url = asset_fn(sdf_fname)
        sdf_spec.vertex_count = payload["vertex_count"]
        sdf_spec.face_count = payload["face_count"]

        ground_tid = "travertine_cobble" if "travertine_cobble" in textures else None
        wall_tid = "mediterranean_stucco" if "mediterranean_stucco" in textures else None
        marble_tid = "carved_carrara_marble" if "carved_carrara_marble" in textures else None
        roof_tid = "roof_tiles_pbr" if "roof_tiles_pbr" in textures else None
        hill_tid = "hill_terrain_pbr" if "hill_terrain_pbr" in textures else None

        objects = [
            # Focal ceremony floral stone archway at north end of aisle (z = -7.5)
            WorldObject(
                id="ceremony_archway",
                name="Stone Floral Wedding Archway",
                collection="landmarks",
                carrier="parametric_assembly",
                position=[0.0, 0.0, -7.8],
                rotation_y_deg=0.0,
                material=MaterialSpec(color="#e5dccb", secondary_color="#b8a894", texture_id=wall_tid),
                parametric=ParametricSpec(kind="archway", width=5.6, height=5.2, depth=1.5),
            ),
            # Groom standing beneath the wedding archway facing the approaching bride
            WorldObject(
                id="groom",
                name="Groom (Classic Black Tuxedo)",
                collection="agents",
                carrier="articulated_agent",
                position=[0.78, 0.0, -5.6],
                rotation_y_deg=0.0,
                scale=1.0,
                material=MaterialSpec(color="#1a1d24", secondary_color="#f5f3ef", accent_color="#c89d5c", roughness=0.55),
                agent=ArticulatedAgentSpec(
                    rig_kind="human_character",
                    count=1,
                    entity_scale=1.04,
                    role="groom",
                    garment_style="tuxedo",
                    hair_color="#2a1f18",
                    skin_tone="#e2b494",
                    appearance_prompt="handsome 30-year-old groom with neat short dark brown hair, warm joyful smile, tailored black shawl-lapel tuxedo with crisp white dress shirt, black bow tie, and white rose boutonniere",
                ),
                behavior=BehaviorSpec(kind="stand_and_face", target_id="bride"),
            ),
            # Bride walking gracefully down the cobblestone aisle toward the groom over t=0..4.5s!
            WorldObject(
                id="bride",
                name="Bride (Ivory Silk Lace Gown & Veil)",
                collection="agents",
                carrier="articulated_agent",
                position=[-0.4, 0.0, 2.8],
                rotation_y_deg=180.0,
                scale=1.0,
                material=MaterialSpec(color="#fbf6ee", secondary_color="#e8dcc8", accent_color="#f4c2c2", roughness=0.42),
                agent=ArticulatedAgentSpec(
                    rig_kind="human_character",
                    count=1,
                    entity_scale=0.98,
                    role="bride",
                    garment_style="gown_aline",
                    hair_color="#4a2e1e",
                    skin_tone="#eabca0",
                    has_veil=True,
                    has_bouquet=True,
                    appearance_prompt="radiant 29-year-old bride with soft chestnut brown hair in a romantic half-updo, natural joyful smile, elegant ivory silk A-line wedding gown with delicate Chantilly lace bodice and sheer cathedral veil, holding a white and blush rose bouquet",
                ),
                behavior=BehaviorSpec(
                    kind="walk_path",
                    target_id="groom",
                    waypoints_xz=[[-0.4, 2.8], [-0.45, 0.3], [-0.50, -2.2], [-0.52, -4.6]],
                    start_time_s=0.0,
                    duration_s=4.5,
                    speed=1.0,
                ),
            ),
            # Officiant under the arch center
            WorldObject(
                id="officiant",
                name="Ceremony Officiant",
                collection="agents",
                carrier="articulated_agent",
                position=[-0.05, 0.0, -7.0],
                rotation_y_deg=0.0,
                material=MaterialSpec(color="#3a4556", secondary_color="#d9cbb8", accent_color="#c49a52"),
                agent=ArticulatedAgentSpec(
                    rig_kind="human_character",
                    count=1,
                    entity_scale=1.0,
                    role="officiant",
                    garment_style="suit",
                    hair_color="#7c7d82",
                    skin_tone="#dfb091",
                    appearance_prompt="distinguished silver-haired officiant in tailored charcoal suit holding ceremony book",
                ),
                behavior=BehaviorSpec(kind="stand_and_face", target_id="bride"),
            ),
            # Guests lining both sides of the aisle turning gaze toward the bride
            WorldObject(
                id="guest_left_1",
                name="Wedding Guest (Sage Dress)",
                collection="agents",
                carrier="articulated_agent",
                position=[-3.8, 0.0, -2.0],
                material=MaterialSpec(color="#6e8c74", secondary_color="#dce4dc"),
                agent=ArticulatedAgentSpec(rig_kind="human_character", count=1, entity_scale=0.95, role="guest", garment_style="dress_cocktail", hair_color="#5c3b24", skin_tone="#e4b898"),
                behavior=BehaviorSpec(kind="stand_and_face", target_id="bride"),
            ),
            WorldObject(
                id="guest_left_2",
                name="Wedding Guest (Navy Suit)",
                collection="agents",
                carrier="articulated_agent",
                position=[-4.0, 0.0, 1.0],
                material=MaterialSpec(color="#293b56", secondary_color="#f0eee9"),
                agent=ArticulatedAgentSpec(rig_kind="human_character", count=1, entity_scale=1.01, role="guest", garment_style="suit", hair_color="#2a221c", skin_tone="#d4a07d"),
                behavior=BehaviorSpec(kind="stand_and_face", target_id="bride"),
            ),
            WorldObject(
                id="guest_right_1",
                name="Wedding Guest (Blush Gown)",
                collection="agents",
                carrier="articulated_agent",
                position=[4.3, 0.0, -2.2],
                material=MaterialSpec(color="#d49aa0", secondary_color="#f5e6e8"),
                agent=ArticulatedAgentSpec(rig_kind="human_character", count=1, entity_scale=0.94, role="guest", garment_style="dress_cocktail", hair_color="#a37a4c", skin_tone="#ecc2a6"),
                behavior=BehaviorSpec(kind="stand_and_face", target_id="bride"),
            ),
            WorldObject(
                id="guest_right_2",
                name="Wedding Guest (Tan Linen Suit)",
                collection="agents",
                carrier="articulated_agent",
                position=[4.5, 0.0, 0.8],
                material=MaterialSpec(color="#b29d82", secondary_color="#faf7f0"),
                agent=ArticulatedAgentSpec(rig_kind="human_character", count=1, entity_scale=1.0, role="guest", garment_style="suit", hair_color="#3b281e", skin_tone="#c9916d"),
                behavior=BehaviorSpec(kind="stand_and_face", target_id="bride"),
            ),
            # Aisle benches
            WorldObject(
                id="aisle_bench_left",
                name="Aisle Wooden Bench Left",
                collection="props",
                carrier="parametric_assembly",
                position=[-4.5, 0.0, -0.3],
                rotation_y_deg=90.0,
                material=MaterialSpec(color="#7c5638"),
                parametric=ParametricSpec(kind="bench"),
            ),
            WorldObject(
                id="aisle_bench_right",
                name="Aisle Wooden Bench Right",
                collection="props",
                carrier="parametric_assembly",
                position=[4.5, 0.0, -0.3],
                rotation_y_deg=-90.0,
                material=MaterialSpec(color="#7c5638"),
                parametric=ParametricSpec(kind="bench"),
            ),
            # Sculpted marble twin-swan SDF centerpiece beside the courtyard
            WorldObject(
                id="marble_swan_sculpture",
                name="Carved Marble Twin-Swan Sculpture",
                collection="landmarks",
                carrier="implicit_sdf",
                position=[6.2, 0.0, -5.8],
                rotation_y_deg=-35.0,
                material=MaterialSpec(color="#ece7df", secondary_color="#b8afa2", texture_id=marble_tid, roughness=0.42),
                implicit_sdf=sdf_spec,
            ),
            # Tiered stone courtyard fountain on west flank
            WorldObject(
                id="courtyard_fountain",
                name="Courtyard Stone Fountain",
                collection="landmarks",
                carrier="parametric_assembly",
                position=[-8.2, 0.0, -6.5],
                material=MaterialSpec(color="#d8cfbe", texture_id=wall_tid),
                parametric=ParametricSpec(kind="fountain", width=4.0, height=3.2, depth=4.0),
            ),
            # Tuscan stone villa backdrop framing the courtyard
            WorldObject(
                id="villa_west",
                name="Tuscan Courtyard Villa West",
                collection="architecture",
                carrier="parametric_assembly",
                position=[-14.5, 0.0, -10.5],
                rotation_y_deg=35.0,
                material=MaterialSpec(color="#dfcbb0", secondary_color="#a3513a", texture_id=wall_tid, roof_texture_id=roof_tid),
                parametric=ParametricSpec(kind="building", width=6.4, height=5.8, depth=5.0, floors=2, roof_style="gable", has_balcony=True),
            ),
            WorldObject(
                id="villa_east",
                name="Tuscan Courtyard Villa East",
                collection="architecture",
                carrier="parametric_assembly",
                position=[14.5, 0.0, -10.5],
                rotation_y_deg=-35.0,
                material=MaterialSpec(color="#d9c1a3", secondary_color="#9d4d38", texture_id=wall_tid, roof_texture_id=roof_tid),
                parametric=ParametricSpec(kind="building", width=6.4, height=5.8, depth=5.0, floors=2, roof_style="gable", has_balcony=True),
            ),
            WorldObject(
                id="chapel_bell_tower",
                name="Chapel Bell Tower",
                collection="architecture",
                carrier="parametric_assembly",
                position=[0.0, 0.0, -18.5],
                rotation_y_deg=0.0,
                material=MaterialSpec(color="#d8ccb9", secondary_color="#9e4d38", texture_id=wall_tid, roof_texture_id=roof_tid),
                parametric=ParametricSpec(kind="tower", width=4.0, height=13.0, depth=4.0),
            ),
            # Cypress & blossom trees + warm iron lampposts
            WorldObject(
                id="cypress_1", name="Tuscan Cypress NW", collection="nature", carrier="parametric_assembly",
                position=[-8.5, 0.0, -14.0], material=MaterialSpec(color="#305232"),
                parametric=ParametricSpec(kind="tree", height=7.4, tree_style="cypress", seed=11),
            ),
            WorldObject(
                id="cypress_2", name="Tuscan Cypress NE", collection="nature", carrier="parametric_assembly",
                position=[8.5, 0.0, -14.0], material=MaterialSpec(color="#355836"),
                parametric=ParametricSpec(kind="tree", height=7.8, tree_style="cypress", seed=23),
            ),
            WorldObject(
                id="blossom_left", name="White Blossom Tree Left", collection="nature", carrier="parametric_assembly",
                position=[-10.5, 0.0, 3.5], material=MaterialSpec(color="#f6d8e0"),
                parametric=ParametricSpec(kind="tree", height=5.6, tree_style="blossom", seed=37),
            ),
            WorldObject(
                id="blossom_right", name="White Blossom Tree Right", collection="nature", carrier="parametric_assembly",
                position=[10.5, 0.0, 3.5], material=MaterialSpec(color="#f5d2dc"),
                parametric=ParametricSpec(kind="tree", height=5.8, tree_style="blossom", seed=51),
            ),
            WorldObject(
                id="lamp_left", name="Courtyard Lantern Left", collection="lighting", carrier="parametric_assembly",
                position=[-5.5, 0.0, -6.2], material=MaterialSpec(color="#23262c", accent_color="#ffc971"),
                parametric=ParametricSpec(kind="lamp_post", height=3.8, light_on=True),
            ),
            WorldObject(
                id="lamp_right", name="Courtyard Lantern Right", collection="lighting", carrier="parametric_assembly",
                position=[5.5, 0.0, -6.2], material=MaterialSpec(color="#23262c", accent_color="#ffc971"),
                parametric=ParametricSpec(kind="lamp_post", height=3.8, light_on=True),
            ),
            # White doves circling above the wedding archway
            WorldObject(
                id="wedding_doves",
                name="White Wedding Doves",
                collection="agents",
                carrier="articulated_agent",
                position=[0.0, 7.0, -7.8],
                material=MaterialSpec(color="#f7f5f0", accent_color="#e8b85c"),
                agent=ArticulatedAgentSpec(rig_kind="bird_flock", count=6, entity_scale=0.9),
                behavior=BehaviorSpec(kind="orbit_target", target_id="ceremony_archway", orbit_radius=5.2, orbit_height=6.8, speed=0.62),
            ),
        ]

        cameras = [
            CameraTrack(
                id="wedding_dolly_arc",
                name="Wedding Processional Dolly Arc",
                kind="spline",
                duration_s=4.5,
                keyframes=[
                    CameraKeyframe(t=0.0, pos=[1.6, 2.0, 7.6], look_at=[-0.05, 1.25, 0.2], fov_deg=48.0),
                    CameraKeyframe(t=1.5, pos=[2.5, 1.9, 4.6], look_at=[-0.05, 1.28, -1.8], fov_deg=46.0),
                    CameraKeyframe(t=3.0, pos=[2.7, 1.85, 1.5], look_at=[0.05, 1.32, -3.7], fov_deg=44.0),
                    CameraKeyframe(t=4.5, pos=[2.1, 1.75, -0.6], look_at=[0.12, 1.35, -5.0], fov_deg=42.0),
                ],
            ),
            CameraTrack(
                id="over_groom_shoulder",
                name="Over-Groom-Shoulder Reveal",
                kind="spline",
                duration_s=4.5,
                keyframes=[
                    CameraKeyframe(t=0.0, pos=[1.9, 1.75, -7.2], look_at=[0.0, 1.4, 2.2], fov_deg=42.0),
                    CameraKeyframe(t=2.25, pos=[2.2, 1.72, -6.8], look_at=[-0.2, 1.42, -1.0], fov_deg=40.0),
                    CameraKeyframe(t=4.5, pos=[2.5, 1.68, -6.2], look_at=[-0.4, 1.45, -4.5], fov_deg=38.0),
                ],
            ),
            CameraTrack(
                id="crane_ceremony_wide",
                name="Golden Hour Crane Sweep",
                kind="spline",
                duration_s=8.0,
                keyframes=[
                    CameraKeyframe(t=0.0, pos=[-11.0, 7.5, 10.5], look_at=[0.0, 1.8, -3.5], fov_deg=48.0),
                    CameraKeyframe(t=4.0, pos=[0.0, 5.2, 11.0], look_at=[0.0, 1.8, -4.5], fov_deg=46.0),
                    CameraKeyframe(t=8.0, pos=[11.0, 7.0, 8.0], look_at=[0.0, 1.8, -4.5], fov_deg=48.0),
                ],
            ),
        ]

        world = WorldState(
            world_id=world_id,
            title="Tuscan Golden-Hour Courtyard Wedding",
            prompt=(
                "A sunlit golden-hour Tuscan stone courtyard wedding ceremony: a radiant bride in an ivory silk lace A-line gown "
                "and flowing veil walks gracefully down the cobblestone aisle toward her smiling groom in a classic black tuxedo "
                "waiting beneath a stone floral archway, watched by wedding guests, surrounded by cypress trees, blossom trees, "
                "a tiered stone fountain, a carved marble twin-swan sculpture, and white doves circling above."
            ),
            terrain=TerrainSpec(
                size=76.0,
                style="cobblestone_plaza",
                ground_color="#9d9282",
                hill_color="#587344",
                plaza_radius=16.0,
                hill_height=3.4,
                texture_id=ground_tid,
                hill_texture_id=hill_tid,
            ),
            atmosphere=AtmosphereSpec(
                time_of_day="golden_hour",
                sky_zenith="#2b5d96",
                sky_horizon="#f5be84",
                sun_color="#ffebd0",
                sun_intensity=3.0,
                sun_elevation_deg=26.0,
                sun_azimuth_deg=54.0,
                fog_color="#e4cbb0",
                fog_density=0.0065,
                ambient_intensity=0.82,
                cloud_count=8,
                wind_strength=0.45,
            ),
            textures=textures,
            objects=objects,
            cameras=cameras,
            regions=[
                RegionSpec(
                    region_id="r_0_0",
                    rx=0,
                    rz=0,
                    center_xz=[0.0, 0.0],
                    radius=20.0,
                    biome_summary="Tuscan Golden-Hour Courtyard Wedding",
                    object_ids=[o.id for o in objects],
                )
            ],
            revision=1,
            camera_spawn=[2.8, 1.85, 6.2],
            camera_look_at=[0.0, 1.45, -1.8],
            cumulative_costs=WorldCosts(sdf_meshes_compiled=1),
            history=[
                WorldRevision(
                    revision=1,
                    action="create_wedding_benchmark",
                    instruction="Scripted Golden-Hour Courtyard Wedding Benchmark (Bride walking toward Groom + Moving Camera)",
                    carbon_summary=f"Initialized 22-object persistent 3D wedding courtyard with articulated Bride/Groom/Guests, twin-swan SDF ({sdf_ms:.1f}ms), and 3 independent CameraTracks.",
                    changed_object_ids=[o.id for o in objects],
                    unchanged_object_ids=[],
                    rebuilt_entire_world=True,
                    costs=WorldCosts(sdf_meshes_compiled=1),
                    timings=WorldTimings(sdf_compile_ms=round(sdf_ms, 1), total_ms=round(sdf_ms, 1)),
                )
            ],
        )
        coord = WorldCoordinator(world, persist_cb=self._persist)
        self._coordinators[world_id] = coord
        self._snapshots[world_id] = [world.model_copy(deep=True)]
        self._persist(world)
        return world

    def enhance_world_materials(self, world_id: str) -> tuple[WorldState, dict]:
        """Approach A persistent upgrade:
        1. Derive missing cavity AO maps for all existing PBR textures (0 API calls)
        2. Synthesize missing biome roof-tile + outer-hill PBR sets via Nano Banana (1-2 calls, cached forever)
        3. Recompile implicit_sdf meshes with exact 3D Inigo Quilez SDF Ambient Occlusion vertex colors (~35 ms)
        """
        t0 = time.perf_counter()
        world = self.get_world(world_id).model_copy(deep=True)
        wdir = self._wdir(world_id)
        costs = WorldCosts()
        timings = WorldTimings()

        # 1. Backfill AO maps on existing textures (0 API calls)
        ao_backfilled = 0
        for tid, tex in world.textures.items():
            if not tex.ao_url:
                alb_name = pathlib.Path(tex.albedo_url).name
                ao_name = f"tex_{tid}_ao.jpg"
                alb_path = wdir / alb_name
                if alb_path.exists():
                    ensure_ao_for_existing_albedo(alb_path, wdir / ao_name)
                    tex.ao_url = self._asset_url(world_id, ao_name)
                    ao_backfilled += 1

        # 2. Generate missing persistent roof tile & outer hill biome PBR sets (2 Nano Banana calls, persisted!)
        to_gen: list[TextureRequest] = []
        style = world.terrain.style
        roof_tex_id = "roof_tiles_pbr"
        hill_tex_id = "hill_terrain_pbr"

        if roof_tex_id not in world.textures:
            if style == "coastal_harbor":
                r_prompt = "weathered dark Nordic slate roof shingles with subtle sea-salt lichen and crisp tile overlaps"
            elif style == "snowy_valley":
                r_prompt = "weathered alpine cedar wood roof shakes dusted with crisp frost"
            else:
                r_prompt = "weathered Mediterranean hand-laid curved terracotta clay roof tiles with warm orange ochre variations and subtle aged moss in crevices"
            to_gen.append(TextureRequest(id=roof_tex_id, prompt=r_prompt))

        if hill_tex_id not in world.textures:
            if style == "coastal_harbor":
                h_prompt = "Nordic coastal mossy granite turf, windswept highland grass, and dark wet pebbles"
            elif style == "snowy_valley":
                h_prompt = "natural wind-rippled alpine snowpack with subtle exposed slate rock and pine needles"
            elif style == "desert_oasis":
                h_prompt = "warm wind-rippled desert sand and arid ochre rocky scrub earth"
            else:
                h_prompt = "natural sunlit Mediterranean hillside grass, dry olive-green meadow turf, small limestone pebbles, and warm terracotta soil"
            to_gen.append(TextureRequest(id=hill_tex_id, prompt=h_prompt))

        new_tex = self._compile_textures_parallel(world_id, to_gen, costs, timings)
        world.textures.update(new_tex)

        # Bind roof & hill PBR sets persistently across terrain + buildings/towers
        if hill_tex_id in world.textures:
            world.terrain.hill_texture_id = hill_tex_id
        for obj in world.objects:
            if obj.visible and obj.carrier == "parametric_assembly" and obj.parametric and obj.parametric.kind in ("building", "tower", "gazebo"):
                if roof_tex_id in world.textures:
                    obj.material.roof_texture_id = roof_tex_id

        # 3. Recompile SDF meshes with exact 3D analytic SDF-AO vertex colors (~35 ms)
        sdf_objs = [o for o in world.objects if o.visible and o.carrier == "implicit_sdf" and o.implicit_sdf is not None]
        self._compile_sdf_objects(world_id, sdf_objs, costs, timings)

        world.revision += 1
        timings.total_ms = round((time.perf_counter() - t0) * 1000.0, 1)
        world.cumulative_costs = _add_costs(world.cumulative_costs, costs)
        world.history.append(
            WorldRevision(
                revision=world.revision,
                action="enhance_persistent_pbr",
                instruction="Upgrade persistent PBR materials (roof tiles, hill biome splat, cavity AO) + 3D SDF-AO",
                carbon_summary=f"Synthesized {len(new_tex)} persistent PBR sets, backfilled {ao_backfilled} AO maps, baked 3D SDF-AO on {len(sdf_objs)} SDF meshes.",
                changed_object_ids=[o.id for o in sdf_objs],
                unchanged_object_ids=[o.id for o in world.objects if o.visible and o not in sdf_objs],
                rebuilt_entire_world=False,
                costs=costs,
                timings=timings,
            )
        )
        self._snapshots.setdefault(world_id, []).append(world.model_copy(deep=True))
        self._persist(world)
        return world, {
            "new_textures": list(new_tex.keys()),
            "ao_backfilled": ao_backfilled,
            "sdf_recompiled": len(sdf_objs),
            "costs": costs.model_dump(),
            "timings": timings.model_dump(),
        }

    def bake_sdf_object_neural(
        self,
        world_id: str,
        object_id: str,
        front_b64: str,
        back_b64: str,
        style_hint: str | None = None,
    ) -> tuple[WorldState, dict]:
        """Approach B: Spend 1 Nano Banana call ONCE in object space to bake persistent
        360-degree dual-projected carved surface detail + normal maps onto a single 3D SDF object."""
        t0 = time.perf_counter()
        world = self.get_world(world_id).model_copy(deep=True)
        wdir = self._wdir(world_id)
        target = next((o for o in world.objects if o.id == object_id and o.visible), None)
        if target is None or target.carrier != "implicit_sdf" or target.implicit_sdf is None:
            raise ValueError(f"Object {object_id} is not a visible implicit_sdf carrier")

        mat_style = style_hint or (
            world.textures[target.material.texture_id].prompt
            if target.material.texture_id and target.material.texture_id in world.textures
            else f"carved weathered stone ({target.material.color})"
        )
        res, nb_ms = bake_sdf_dual_projection(
            obj_id=target.id,
            description=target.implicit_sdf.description,
            material_style=mat_style,
            front_b64=front_b64,
            back_b64=back_b64,
            out_dir=wdir,
        )
        target.implicit_sdf.baked_front_url = self._asset_url(world_id, res["front_albedo"])
        target.implicit_sdf.baked_back_url = self._asset_url(world_id, res["back_albedo"])
        target.implicit_sdf.baked_front_normal_url = self._asset_url(world_id, res["front_normal"])
        target.implicit_sdf.baked_back_normal_url = self._asset_url(world_id, res["back_normal"])
        target.implicit_sdf.baked_prompt = mat_style
        target.version += 1

        costs = WorldCosts(nano_banana_texture_calls=1)
        timings = WorldTimings(nano_banana_ms=round(nb_ms, 1), total_ms=round((time.perf_counter() - t0) * 1000.0, 1))
        world.revision += 1
        world.cumulative_costs = _add_costs(world.cumulative_costs, costs)
        world.history.append(
            WorldRevision(
                revision=world.revision,
                action="object_space_neural_bake",
                instruction=f"Bake persistent dual-projection neural detail onto {target.id}",
                carbon_summary=f"1 Nano Banana object-space bake -> front/back albedo + normal maps permanently bound to {target.id}.",
                changed_object_ids=[target.id],
                unchanged_object_ids=[o.id for o in world.objects if o.visible and o.id != target.id],
                rebuilt_entire_world=False,
                costs=costs,
                timings=timings,
            )
        )
        self._snapshots.setdefault(world_id, []).append(world.model_copy(deep=True))
        self._persist(world)

        return world, {
            "object_id": target.id,
            "baked_front_url": target.implicit_sdf.baked_front_url,
            "baked_back_url": target.implicit_sdf.baked_back_url,
            "ortho_input_url": self._asset_url(world_id, res["ortho_input"]),
            "ortho_painted_url": self._asset_url(world_id, res["ortho_painted"]),
            "inference_ms": round(nb_ms, 1),
        }

    def neural_render_view(
        self,
        world_id: str,
        tag: str,
        rgb_b64: str,
        mode: str = "gbuffer_conditioned",
        depth_b64: str | None = None,
        normal_b64: str | None = None,
        obj_id_b64: str | None = None,
        style_ref_b64: str | None = None,
    ) -> dict:
        """Approach C: Experimental geometry-conditioned still-frame neural enhancement."""
        world = self.get_world(world_id)
        wdir = self._wdir(world_id)
        scene_desc = f"{world.title} ({world.atmosphere.time_of_day}): {world.prompt}"
        res, ms = neural_enhance_gbuffer_view(
            scene_description=scene_desc,
            rgb_b64=rgb_b64,
            out_dir=wdir,
            tag=tag,
            mode=mode,
            depth_b64=depth_b64,
            normal_b64=normal_b64,
            obj_id_b64=obj_id_b64,
            style_ref_b64=style_ref_b64,
        )
        return {
            "world_id": world_id,
            "tag": tag,
            "mode": mode,
            "src_rgb_url": self._asset_url(world_id, res["src_rgb"]),
            "gbuffer_url": self._asset_url(world_id, res["gbuffer"]) if res["gbuffer"] else None,
            "enhanced_rgb_url": self._asset_url(world_id, res["enhanced_rgb"]),
            "metrics": res["metrics"],
            "inference_ms": round(ms, 1),
        }


world_manager = WorldManager()

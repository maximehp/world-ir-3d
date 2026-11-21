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
import time
import uuid

from PIL import Image

from world.gemini_3d import (
    carbon_compile_world,
    carbon_compile_world_edit,
    hydrogen_audit_multiview,
)
from world.schema import (
    MultiViewAuditVerdict,
    PBRTextureAsset,
    TextureRequest,
    WorldCosts,
    WorldObject,
    WorldRevision,
    WorldState,
    WorldTimings,
)
from world.sdf_compiler import compile_sdf_mesh
from world.textures import synthesize_pbr_texture


DATA_ROOT = pathlib.Path(__file__).resolve().parent / "data"
WORLDS_ROOT = DATA_ROOT / "worlds"
WORLDS_ROOT.mkdir(parents=True, exist_ok=True)


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


def _add_costs(a: WorldCosts, b: WorldCosts) -> WorldCosts:
    return WorldCosts(
        carbon_calls=a.carbon_calls + b.carbon_calls,
        hydrogen_calls=a.hydrogen_calls + b.hydrogen_calls,
        nano_banana_texture_calls=a.nano_banana_texture_calls + b.nano_banana_texture_calls,
        sdf_meshes_compiled=a.sdf_meshes_compiled + b.sdf_meshes_compiled,
    )


class WorldManager:
    def __init__(self) -> None:
        self._worlds: dict[str, WorldState] = {}
        self._snapshots: dict[str, list[WorldState]] = {}
        self._load_existing()

    def _wdir(self, world_id: str) -> pathlib.Path:
        d = WORLDS_ROOT / world_id
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _asset_url(self, world_id: str, filename: str) -> str:
        return f"/world-assets/worlds/{world_id}/{filename}"

    def _persist(self, world: WorldState) -> None:
        wdir = self._wdir(world.world_id)
        (wdir / "world.json").write_text(world.model_dump_json(indent=2))
        self._worlds[world.world_id] = world

    def _load_existing(self) -> None:
        for p in sorted(WORLDS_ROOT.glob("*/world.json")):
            try:
                w = WorldState.model_validate_json(p.read_text())
                self._worlds[w.world_id] = w
                self._snapshots[w.world_id] = [w.model_copy(deep=True)]
            except Exception:
                pass

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
        self._persist(restored)
        return restored


world_manager = WorldManager()

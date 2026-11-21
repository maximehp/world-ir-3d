"""Deterministic Single-Writer Coordinator for Parallel Streamed World IR.

Guarantees:
  - Strict Pydantic v2 validation of every individually streamed WorldOp
  - Monotonic sequence numbers (`seq`) and thread-safe state transitions
  - Deterministic 2D footprint collision avoidance across concurrent cloud workers
  - User-edit lock protection so concurrent generation never clobbers live user edits
  - Monotonic texture refinement (provisional never downgrades refined PBR)
  - Live pub/sub fanout to SSE streaming clients
"""

from __future__ import annotations

import math
import queue
import threading
import time
import uuid
from typing import Callable

from world.schema import (
    AtmosphereSpec,
    CameraTrack,
    PBRTextureAsset,
    RegionSpec,
    TerrainSpec,
    WorldObject,
    WorldOp,
    WorldState,
)


def estimate_footprint_radius(obj: WorldObject) -> float:
    """Estimate conservative 2D ground footprint radius in meters for static de-collision."""
    if not obj.visible:
        return 0.0
    if obj.carrier == "articulated_agent":
        if obj.agent and obj.agent.rig_kind == "human_character":
            return 0.55 * obj.scale
        return 0.0
    if obj.carrier == "implicit_sdf":
        return 1.55 * obj.scale
    if obj.carrier == "procedural_assembly" and obj.procedural is not None:
        return max(0.35, min(6.0, float(obj.procedural.contact_ao_radius) * 0.85 * obj.scale))
    p = obj.parametric
    if p is None:
        return 1.2 * obj.scale
    if p.kind == "building":
        return (0.5 * math.hypot(p.width, p.depth) + 0.55) * obj.scale
    if p.kind in ("tower", "windmill", "lighthouse", "gazebo", "fountain"):
        return (0.54 * max(p.width, p.depth) + 0.45) * obj.scale
    if p.kind in ("archway", "bridge"):
        return (0.48 * max(p.width, p.depth)) * obj.scale
    if p.kind == "market_stall":
        return (0.5 * math.hypot(p.width, p.depth) + 0.3) * obj.scale
    if p.kind == "tree":
        return 1.25 * obj.scale
    if p.kind in ("car", "boat", "scooter"):
        return 1.3 * obj.scale
    return 0.75 * obj.scale


class WorldCoordinator:
    """Single-writer deterministic state coordinator for one persistent 3D WorldState."""

    def __init__(self, world: WorldState, persist_cb: Callable[[WorldState], None] | None = None) -> None:
        self._lock = threading.RLock()
        self.world: WorldState = world
        self._persist_cb = persist_cb
        self._subscribers: list[queue.Queue[WorldOp | None]] = []
        self._op_log: list[WorldOp] = []
        self._user_locked_ids: set[str] = set()
        self._footprints: dict[str, tuple[float, float, float]] = {}
        self._t0: float = time.perf_counter()
        self._rebuild_footprints()

    def reset_clock(self) -> None:
        with self._lock:
            self._t0 = time.perf_counter()

    def elapsed_ms(self) -> float:
        return round((time.perf_counter() - self._t0) * 1000.0, 1)

    def _rebuild_footprints(self) -> None:
        self._footprints.clear()
        for o in self.world.objects:
            r = estimate_footprint_radius(o)
            if o.visible and r > 0.0:
                self._footprints[o.id] = (float(o.position[0]), float(o.position[2]), r)

    def _resolve_collision(
        self,
        x: float,
        z: float,
        radius: float,
        exclude_id: str | None = None,
        clearance: float = 0.75,
    ) -> tuple[float, float]:
        if radius <= 0.0:
            return x, z

        def overlaps(cx: float, cz: float) -> bool:
            for oid, (ox, oz, orad) in self._footprints.items():
                if oid == exclude_id:
                    continue
                if math.hypot(cx - ox, cz - oz) < (radius + orad + clearance):
                    return True
            return False

        if not overlaps(x, z):
            return x, z

        # Deterministic outward spiral search preserving closest clear coordinates
        for step in (1.6, 3.0, 4.6, 6.2, 8.0, 10.0):
            for k in range(12):
                ang = (k / 12.0) * math.tau
                cx = round(x + math.cos(ang) * step, 2)
                cz = round(z + math.sin(ang) * step, 2)
                if not overlaps(cx, cz):
                    return cx, cz
        return x, z

    def subscribe(self, since_seq: int = 0) -> tuple[list[WorldOp], queue.Queue[WorldOp | None]]:
        q: queue.Queue[WorldOp | None] = queue.Queue(maxsize=256)
        with self._lock:
            missed = [op for op in self._op_log if op.seq > since_seq]
            self._subscribers.append(q)
        return missed, q

    def unsubscribe(self, q: queue.Queue[WorldOp | None]) -> None:
        with self._lock:
            if q in self._subscribers:
                self._subscribers.remove(q)

    def _broadcast(self, op: WorldOp) -> None:
        dead: list[queue.Queue[WorldOp | None]] = []
        for q in list(self._subscribers):
            try:
                q.put_nowait(op)
            except queue.Full:
                dead.append(q)
        for q in dead:
            if q in self._subscribers:
                self._subscribers.remove(q)

    def snapshot(self) -> WorldState:
        with self._lock:
            return self.world.model_copy(deep=True)

    def replace_world(self, new_world: WorldState) -> None:
        """Replace authoritative state (e.g. Undo) cleanly under the single-writer lock."""
        with self._lock:
            self.world = new_world.model_copy(deep=True)
            self._user_locked_ids.clear()
            self._rebuild_footprints()
            if self._persist_cb:
                self._persist_cb(self.world)

    def commit_op(
        self,
        *,
        domain: str,
        action: str = "upsert",
        target_id: str = "",
        payload: dict | None = None,
        phase: str = "geometry",
        worker: str = "coordinator",
        resolve_collisions: bool = False,
        persist: bool = False,
        region_id: str | None = None,
    ) -> WorldOp | None:
        """Validate, deterministically apply, sequence, and broadcast a single WorldOp."""
        payload = payload or {}
        with self._lock:
            w = self.world
            out_payload = payload

            if domain == "init":
                if "title" in payload:
                    w.title = str(payload["title"])
                if "terrain" in payload:
                    w.terrain = TerrainSpec.model_validate(payload["terrain"])
                if "atmosphere" in payload:
                    w.atmosphere = AtmosphereSpec.model_validate(payload["atmosphere"])
                if "camera_spawn" in payload and len(payload["camera_spawn"]) == 3:
                    w.camera_spawn = [float(v) for v in payload["camera_spawn"]]
                if "camera_look_at" in payload and len(payload["camera_look_at"]) == 3:
                    w.camera_look_at = [float(v) for v in payload["camera_look_at"]]
                w.generation_status = "streaming"
                if not any(r.region_id == "r_0_0" for r in w.regions):
                    w.regions.append(
                        RegionSpec(
                            region_id="r_0_0",
                            rx=0,
                            rz=0,
                            center_xz=[0.0, 0.0],
                            radius=max(20.0, float(w.terrain.plaza_radius) + 6.0),
                            biome_summary=f"{w.title} ({w.terrain.style})",
                            object_ids=[],
                        )
                    )
                out_payload = {
                    "world_id": w.world_id,
                    "title": w.title,
                    "prompt": w.prompt,
                    "terrain": w.terrain.model_dump(),
                    "atmosphere": w.atmosphere.model_dump(),
                    "camera_spawn": w.camera_spawn,
                    "camera_look_at": w.camera_look_at,
                    "regions": [r.model_dump() for r in w.regions],
                }

            elif domain == "terrain":
                w.terrain = TerrainSpec.model_validate(payload)
                out_payload = w.terrain.model_dump()

            elif domain == "atmosphere":
                w.atmosphere = AtmosphereSpec.model_validate(payload)
                out_payload = w.atmosphere.model_dump()

            elif domain == "texture":
                tex = PBRTextureAsset.model_validate(payload)
                existing = w.textures.get(tex.id)
                # Monotonic quality invariant: never downgrade a refined PBR texture with a late provisional one
                if existing is not None and existing.tier == "refined" and tex.tier == "provisional":
                    return None
                if existing is not None:
                    tex.version = existing.version + 1
                w.textures[tex.id] = tex
                target_id = tex.id
                out_payload = tex.model_dump()

            elif domain == "object":
                if action == "delete":
                    idx = next((i for i, o in enumerate(w.objects) if o.id == target_id), None)
                    if idx is None:
                        return None
                    w.objects[idx].visible = False
                    w.objects[idx].version += 1
                    self._footprints.pop(target_id, None)
                    if phase == "edit":
                        self._user_locked_ids.add(target_id)
                    out_payload = {"object_id": target_id, "visible": False}

                elif action == "upsert":
                    obj = WorldObject.model_validate(payload)
                    obj.id = obj.id.strip().lower().replace(" ", "_") or f"obj_{uuid.uuid4().hex[:5]}"
                    target_id = obj.id

                    # Protect user-edited objects from stale concurrent generation workers
                    if obj.id in self._user_locked_ids and phase != "edit":
                        return None

                    if obj.carrier in ("parametric_assembly", "implicit_sdf"):
                        obj.position[1] = 0.0
                    elif obj.carrier == "procedural_assembly":
                        # Allow elevated fixtures (chandeliers, ceiling lights, hanging banners) while grounding floor objects
                        if obj.position[1] < 0.0:
                            obj.position[1] = 0.0

                    existing_idx = next((i for i, o in enumerate(w.objects) if o.id == obj.id), None)
                    rad = estimate_footprint_radius(obj)
                    if resolve_collisions and existing_idx is None and rad > 0.0:
                        nx, nz = self._resolve_collision(
                            float(obj.position[0]),
                            float(obj.position[2]),
                            rad,
                            exclude_id=obj.id,
                        )
                        obj.position[0] = nx
                        obj.position[2] = nz

                    if existing_idx is not None:
                        obj.version = w.objects[existing_idx].version + 1
                        w.objects[existing_idx] = obj
                    else:
                        w.objects.append(obj)

                    if obj.visible and rad > 0.0:
                        self._footprints[obj.id] = (float(obj.position[0]), float(obj.position[2]), rad)
                    else:
                        self._footprints.pop(obj.id, None)

                    if phase == "edit":
                        self._user_locked_ids.add(obj.id)

                    if region_id:
                        reg = next((r for r in w.regions if r.region_id == region_id), None)
                        if reg and obj.id not in reg.object_ids:
                            reg.object_ids.append(obj.id)
                    elif phase in ("geometry", "agent") and w.regions:
                        if obj.id not in w.regions[0].object_ids:
                            w.regions[0].object_ids.append(obj.id)

                    out_payload = obj.model_dump()

                elif action == "patch":
                    idx = next((i for i, o in enumerate(w.objects) if o.id == target_id), None)
                    if idx is None:
                        return None
                    obj = w.objects[idx]
                    if phase == "edit":
                        self._user_locked_ids.add(obj.id)
                    if "position" in payload and payload["position"] is not None:
                        obj.position = [float(v) for v in payload["position"]]
                    if "rotation_y_deg" in payload and payload["rotation_y_deg"] is not None:
                        obj.rotation_y_deg = float(payload["rotation_y_deg"])
                    if "scale" in payload and payload["scale"] is not None:
                        obj.scale = float(payload["scale"])
                    if "material" in payload and payload["material"] is not None:
                        obj.material = obj.material.model_validate(payload["material"])
                    if "behavior" in payload and payload["behavior"] is not None:
                        obj.behavior = obj.behavior.model_validate(payload["behavior"])
                    if "parametric" in payload and payload["parametric"] is not None:
                        obj.parametric = obj.parametric.model_validate(payload["parametric"]) if obj.parametric else None
                    if "procedural" in payload and payload["procedural"] is not None:
                        from world.schema import ProceduralAssemblySpec
                        obj.procedural = ProceduralAssemblySpec.model_validate(payload["procedural"])
                        obj.carrier = "procedural_assembly"
                    if "visible" in payload and payload["visible"] is not None:
                        obj.visible = bool(payload["visible"])
                    obj.version += 1
                    rad = estimate_footprint_radius(obj)
                    if obj.visible and rad > 0.0:
                        self._footprints[obj.id] = (float(obj.position[0]), float(obj.position[2]), rad)
                    else:
                        self._footprints.pop(obj.id, None)
                    out_payload = obj.model_dump()

            elif domain == "camera":
                cam = CameraTrack.model_validate(payload)
                target_id = cam.id
                idx = next((i for i, c in enumerate(w.cameras) if c.id == cam.id), None)
                if idx is not None:
                    w.cameras[idx] = cam
                else:
                    w.cameras.append(cam)
                out_payload = cam.model_dump()

            elif domain == "region":
                reg = RegionSpec.model_validate(payload)
                target_id = reg.region_id
                idx = next((i for i, r in enumerate(w.regions) if r.region_id == reg.region_id), None)
                if idx is not None:
                    w.regions[idx] = reg
                else:
                    w.regions.append(reg)
                # Ensure continuous terrain mesh spans all generated regions
                max_extent = max(
                    (max(abs(r.center_xz[0]), abs(r.center_xz[1])) + r.radius + 12.0) * 2.0
                    for r in w.regions
                )
                if max_extent > w.terrain.size:
                    w.terrain.size = min(140.0, round(max_extent, 1))
                out_payload = {"region": reg.model_dump(), "terrain": w.terrain.model_dump()}

            elif domain == "status":
                st = payload.get("generation_status")
                if st in ("idle", "streaming", "complete"):
                    w.generation_status = st
                out_payload = payload

            w.seq += 1
            op = WorldOp(
                op_id=f"op_{uuid.uuid4().hex[:8]}",
                world_id=w.world_id,
                seq=w.seq,
                phase=phase,
                worker=worker,
                domain=domain,
                action=action,
                target_id=target_id,
                payload=out_payload,
                elapsed_ms=self.elapsed_ms(),
            )
            self._op_log.append(op)
            if len(self._op_log) > 400:
                self._op_log = self._op_log[-400:]
            if persist and self._persist_cb:
                self._persist_cb(w)
            self._broadcast(op)
            return op

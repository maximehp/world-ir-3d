"""FastAPI server for the Full 3D Persistent Generative World & Cinematic Video Studio."""

from __future__ import annotations

import json
import pathlib
import queue
from typing import Iterator

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from world.coordinator import WorldCoordinator
from world.engine import DATA_ROOT, world_manager
from world.video_pipeline import probe_video_model_support

STATIC_DIR = pathlib.Path(__file__).resolve().parent / "static"
STATIC_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="WorldIR 3D — Streamed Parallel Persistent 3D Worlds & Cinematic Video")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/world-assets", StaticFiles(directory=str(DATA_ROOT)), name="world-assets")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


class CreateWorldReq(BaseModel):
    prompt: str
    enable_provisional_textures: bool = True


class EditWorldReq(BaseModel):
    instruction: str
    selected_object_id: str | None = None
    enable_provisional_textures: bool = True


class ExpandRegionReq(BaseModel):
    rx: int
    rz: int
    direction_hint: str | None = None


class MultiViewAuditReq(BaseModel):
    plate_base64: str
    allow_repair: bool = True


class BakeSDFReq(BaseModel):
    front_b64: str
    back_b64: str
    style_hint: str | None = None


class NeuralRenderReq(BaseModel):
    tag: str = "view"
    mode: str = "gbuffer_conditioned"
    rgb_b64: str
    depth_b64: str | None = None
    normal_b64: str | None = None
    obj_id_b64: str | None = None
    style_ref_b64: str | None = None


class AppearanceRefsReq(BaseModel):
    scene_guide: dict
    entity_guides: dict[str, dict] = {}
    force: bool = False


class GenerateVideoReq(BaseModel):
    keyframes: list[dict]
    shot_description: str
    mode: str = "appearance_anchored"
    hero_entity_ids: list[str] = []
    fps: int = 24
    subframes_per_interval: int = 16


def _sse_stream_ops(
    coord: WorldCoordinator,
    since_seq: int = 0,
    stop_on_complete: bool = True,
    stream_id: str | None = None,
) -> Iterator[str]:
    """Stream validated WorldOps as Server-Sent Events (`text/event-stream`), isolated per stream_id."""
    def _is_my_complete(op) -> bool:
        if not stop_on_complete or op.domain != "status" or op.action != "complete":
            return False
        if stream_id:
            return op.payload.get("stream_id") == stream_id
        return True

    missed, q = coord.subscribe(since_seq=since_seq)
    try:
        for op in missed:
            yield f"data: {op.model_dump_json()}\n\n"
            if _is_my_complete(op):
                return
        while True:
            try:
                op = q.get(timeout=20.0)
            except queue.Empty:
                yield ": keepalive\n\n"
                continue
            if op is None:
                break
            yield f"data: {op.model_dump_json()}\n\n"
            if _is_my_complete(op):
                return
    finally:
        coord.unsubscribe(q)


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/health")
@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "architecture": "Streamed Parallel Multi-Carrier Persistent WorldIR + Appearance-Anchored Cinema Video",
        "carriers": ["heightfield_terrain", "procedural_assembly", "parametric_assembly", "implicit_sdf_marching_cubes", "articulated_agent"],
        "models": {
            "scaffold_and_fast_edit": "gemini-3.5-flash-lite",
            "compiler": "gemini-4-carbon",
            "auditor": "gemini-4-hydrogen",
            "pbr_provisional": "gemini-3.1-flash-lite-image",
            "pbr_textures": "gemini-nano-banana-2.1",
        },
        "streaming": True,
        "worlds_count": len(world_manager.list_worlds()),
    }


@app.get("/api/worlds")
def list_worlds():
    return {"worlds": world_manager.list_worlds()}


@app.get("/api/worlds/{world_id}")
def get_world(world_id: str):
    try:
        return world_manager.get_world(world_id).model_dump()
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.post("/api/worlds")
def create_world(req: CreateWorldReq):
    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="Prompt cannot be empty")
    try:
        world = world_manager.create_world(req.prompt.strip())
        return world.model_dump()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"World generation failed: {exc}")


@app.post("/api/worlds/stream")
def create_world_stream(req: CreateWorldReq):
    """Stream individually validated WorldOps as parallel cloud workers build the 3D world progressively."""
    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="Prompt cannot be empty")
    world_id, coord, stream_id = world_manager.start_world_stream(
        req.prompt.strip(),
        enable_provisional_textures=req.enable_provisional_textures,
    )
    headers = {"X-World-Id": world_id, "X-Stream-Id": stream_id, "Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    return StreamingResponse(
        _sse_stream_ops(coord, since_seq=0, stop_on_complete=True, stream_id=stream_id),
        media_type="text/event-stream",
        headers=headers,
    )


@app.post("/api/worlds/wedding-benchmark")
def create_wedding_benchmark():
    """Instantiate or reset the scripted 3D Golden-Hour Courtyard Wedding Benchmark scene."""
    world = world_manager.create_wedding_benchmark_world()
    return world.model_dump()


@app.get("/api/worlds/{world_id}/events")
def world_events(world_id: str, since_seq: int = Query(default=0, ge=0)):
    try:
        coord = world_manager.get_coordinator(world_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return StreamingResponse(
        _sse_stream_ops(coord, since_seq=since_seq, stop_on_complete=False),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/worlds/{world_id}/edit")
def edit_world(world_id: str, req: EditWorldReq):
    if not req.instruction.strip():
        raise HTTPException(status_code=400, detail="Instruction cannot be empty")
    try:
        world, delta = world_manager.apply_edit_fast(
            world_id, req.instruction.strip(), selected_object_id=req.selected_object_id
        )
        return {"world": world.model_dump(), "delta": delta}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"World edit failed: {exc}")


@app.post("/api/worlds/{world_id}/edit/stream")
def edit_world_stream(world_id: str, req: EditWorldReq):
    """Two-phase fast streamed surgical edit: ~1-2s Time to First Visible Change, parallel async refinement."""
    if not req.instruction.strip():
        raise HTTPException(status_code=400, detail="Instruction cannot be empty")
    try:
        coord, since_seq, stream_id = world_manager.start_edit_stream(
            world_id,
            req.instruction.strip(),
            selected_object_id=req.selected_object_id,
            enable_provisional_textures=req.enable_provisional_textures,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return StreamingResponse(
        _sse_stream_ops(coord, since_seq=since_seq, stop_on_complete=True, stream_id=stream_id),
        media_type="text/event-stream",
        headers={"X-Stream-Id": stream_id, "Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/worlds/{world_id}/expand-region/stream")
def expand_region_stream(world_id: str, req: ExpandRegionReq):
    """Expand persistent adjacent 3D region at stable world coordinates (0-call cache hit on revisit)."""
    try:
        coord, since_seq, stream_id = world_manager.start_region_expansion_stream(
            world_id, req.rx, req.rz, direction_hint=req.direction_hint
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return StreamingResponse(
        _sse_stream_ops(coord, since_seq=since_seq, stop_on_complete=True, stream_id=stream_id),
        media_type="text/event-stream",
        headers={"X-Stream-Id": stream_id, "Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/worlds/{world_id}/audit")
def audit_world(world_id: str, req: MultiViewAuditReq):
    try:
        world, verdict, repaired_ids = world_manager.audit_multiview_plate(
            world_id, req.plate_base64, allow_repair=req.allow_repair
        )
        return {
            "world": world.model_dump(),
            "verdict": verdict.model_dump(),
            "repaired_ids": repaired_ids,
        }
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"3D audit failed: {exc}")


@app.post("/api/worlds/{world_id}/undo")
def undo_world(world_id: str):
    try:
        world = world_manager.undo(world_id)
        return world.model_dump()
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.post("/api/worlds/{world_id}/enhance-materials")
def enhance_materials(world_id: str):
    """Approach A: Upgrade persistent PBR textures (roofs, hill splat, cavity AO) + 3D SDF-AO."""
    try:
        world, info = world_manager.enhance_world_materials(world_id)
        return {"world": world.model_dump(), "enhancement": info}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Material enhancement failed: {exc}")


@app.post("/api/worlds/{world_id}/objects/{object_id}/bake-neural")
def bake_object_neural(world_id: str, object_id: str, req: BakeSDFReq):
    """Approach B: Spend 1 Nano Banana call in object space to bake persistent 360° dual-projected SDF detail."""
    try:
        world, info = world_manager.bake_sdf_object_neural(
            world_id, object_id, req.front_b64, req.back_b64, style_hint=req.style_hint
        )
        return {"world": world.model_dump(), "bake": info}
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Neural object bake failed: {exc}")


@app.post("/api/worlds/{world_id}/neural-render")
def neural_render_still(world_id: str, req: NeuralRenderReq):
    """Approach C: Experimental G-Buffer-conditioned neural still enhancement."""
    try:
        return world_manager.neural_render_view(
            world_id=world_id,
            tag=req.tag,
            rgb_b64=req.rgb_b64,
            mode=req.mode,
            depth_b64=req.depth_b64,
            normal_b64=req.normal_b64,
            obj_id_b64=req.obj_id_b64,
            style_ref_b64=req.style_ref_b64,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Neural render failed: {exc}")


@app.get("/api/video/capabilities")
def video_capabilities():
    """Empirically verify native video model availability vs appearance-anchored neural video fallback."""
    return probe_video_model_support()


@app.post("/api/worlds/{world_id}/appearance-refs")
def build_appearance_refs(world_id: str, req: AppearanceRefsReq):
    """Generate/cache persistent photorealistic scene + multi-view canonical entity references in parallel."""
    try:
        world, info = world_manager.ensure_appearance_references(
            world_id, req.scene_guide, req.entity_guides, force=req.force
        )
        return {"world": world.model_dump(), "refs_info": info}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Appearance reference generation failed: {exc}")


@app.post("/api/worlds/{world_id}/generate-video")
def generate_video(world_id: str, req: GenerateVideoReq):
    """Generate a real 24 FPS H.264 MP4 video conditioned on World IR + persistent appearance references."""
    try:
        return world_manager.generate_anchored_video(
            world_id=world_id,
            keyframes=req.keyframes,
            shot_description=req.shot_description,
            mode=req.mode,
            hero_entity_ids=req.hero_entity_ids,
            fps=req.fps,
            subframes_per_interval=req.subframes_per_interval,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Video generation failed: {exc}")

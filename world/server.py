"""FastAPI server for the Full 3D Persistent Generative World Studio."""

from __future__ import annotations

import pathlib

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from world.engine import DATA_ROOT, world_manager

STATIC_DIR = pathlib.Path(__file__).resolve().parent / "static"
STATIC_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="WorldIR 3D — Persistent Multi-Carrier Generative 3D Worlds")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Video2Sim 3D (merged from the Harsh branch): video -> 3D simulation, served at /video2sim/
from fastapi.responses import RedirectResponse  # noqa: E402

from video2sim.backend.main import app as video2sim_app  # noqa: E402


@app.get("/video2sim", include_in_schema=False)
def video2sim_redirect():
    return RedirectResponse("/video2sim/")


app.mount("/video2sim", video2sim_app, name="video2sim")
app.mount("/world-assets", StaticFiles(directory=str(DATA_ROOT)), name="world-assets")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


class CreateWorldReq(BaseModel):
    prompt: str


class EditWorldReq(BaseModel):
    instruction: str
    selected_object_id: str | None = None


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


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/health")
@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "architecture": "Full-3D Multi-Carrier Persistent WorldIR",
        "carriers": ["heightfield_terrain", "parametric_assembly", "implicit_sdf_marching_cubes", "articulated_agent"],
        "models": {
            "compiler": "gemini-4-carbon",
            "auditor": "gemini-4-hydrogen",
            "pbr_textures": "gemini-nano-banana-2.1",
        },
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


@app.post("/api/worlds/{world_id}/edit")
def edit_world(world_id: str, req: EditWorldReq):
    if not req.instruction.strip():
        raise HTTPException(status_code=400, detail="Instruction cannot be empty")
    try:
        world, delta = world_manager.apply_edit(
            world_id, req.instruction.strip(), selected_object_id=req.selected_object_id
        )
        return {"world": world.model_dump(), "delta": delta}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"World edit failed: {exc}")


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

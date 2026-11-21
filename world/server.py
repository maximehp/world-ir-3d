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

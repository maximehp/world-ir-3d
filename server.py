from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from engine.pipeline import StructuredVideoPipeline
from engine.references import DEFAULT_IMAGE_MODEL, HIGH_FIDELITY_IMAGE_MODEL

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

DATA_DIR = ROOT / "data"
WEB_DIR = ROOT / "web"

pipeline = StructuredVideoPipeline(DATA_DIR)

app = FastAPI(title="Structured Generative Video Studio")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount media directory for serving generated MP4s and Nano Banana reference images
DATA_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/media", StaticFiles(directory=str(DATA_DIR)), name="media")


class CreateProjectRequest(BaseModel):
    prompt: str
    fidelity: str = "fast"  # "fast" -> gemini-3.1-flash-lite-image, "high" -> gemini-nano-banana-2.1
    resolution: str = "720p"
    run_eval: bool = True


class EditProjectRequest(BaseModel):
    edit_instruction: str
    parent_version_id: Optional[str] = None
    fidelity: str = "fast"
    resolution: str = "720p"
    run_eval: bool = True


def _resolve_image_model(fidelity: str) -> str:
    return HIGH_FIDELITY_IMAGE_MODEL if fidelity == "high" else DEFAULT_IMAGE_MODEL


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


@app.get("/")
async def index():
    return FileResponse(WEB_DIR / "index.html")


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "has_api_key": bool(os.environ.get("GEMINI_API_KEY")),
        "models": {
            "compiler": "gemini-4-carbon",
            "references_fast": DEFAULT_IMAGE_MODEL,
            "references_high": HIGH_FIDELITY_IMAGE_MODEL,
            "video": "gemini-omni-1.2-flash",
            "evaluator": "gemini-4-hydrogen",
        },
    }


@app.get("/api/projects")
async def list_projects():
    return [p.model_dump() for p in pipeline.list_projects()]


@app.get("/api/projects/{project_id}")
async def get_project(project_id: str):
    try:
        return pipeline.load_project(project_id).model_dump()
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Project not found")


@app.get("/api/benchmark")
async def get_benchmark():
    bench_path = DATA_DIR / "benchmark_results.json"
    if not bench_path.exists():
        return JSONResponse({"available": False, "results": None})
    return JSONResponse({"available": True, "results": json.loads(bench_path.read_text("utf-8"))})


@app.post("/api/projects/stream")
async def create_project_stream(req: CreateProjectRequest):
    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="Prompt cannot be empty.")

    async def gen():
        try:
            async for event in pipeline.create_project_stream(
                prompt=req.prompt,
                image_model=_resolve_image_model(req.fidelity),
                resolution=req.resolution,
                run_eval=req.run_eval,
            ):
                yield _sse(event)
        except Exception as e:
            yield _sse({"stage": "error", "message": f"{type(e).__name__}: {e}"})

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.post("/api/projects/{project_id}/edit/stream")
async def edit_project_stream(project_id: str, req: EditProjectRequest):
    if not req.edit_instruction.strip():
        raise HTTPException(status_code=400, detail="Edit instruction cannot be empty.")

    async def gen():
        try:
            async for event in pipeline.edit_project_stream(
                project_id=project_id,
                edit_instruction=req.edit_instruction,
                parent_version_id=req.parent_version_id,
                image_model=_resolve_image_model(req.fidelity),
                resolution=req.resolution,
                run_eval=req.run_eval,
            ):
                yield _sse(event)
        except Exception as e:
            yield _sse({"stage": "error", "message": f"{type(e).__name__}: {e}"})

    return StreamingResponse(gen(), media_type="text/event-stream")


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8010"))
    uvicorn.run("server:app", host="127.0.0.1", port=port, reload=False)

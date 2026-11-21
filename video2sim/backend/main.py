from __future__ import annotations

import os
import shutil
import uuid
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .gemini_scene import build_scene_with_gemini
from .models import AnalysisResponse
from .opencv_fallback import build_scene_with_opencv
from .video_analyzer import analyze_video_opencv

ROOT_DIR = Path(__file__).resolve().parent.parent
SAMPLES_DIR = ROOT_DIR / "samples"
UPLOADS_DIR = ROOT_DIR / "uploads"
FRONTEND_DIST = ROOT_DIR / "frontend" / "dist"
SAMPLE_VIDEO = SAMPLES_DIR / "sample_landscape_birds.mp4"

UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
SAMPLES_DIR.mkdir(parents=True, exist_ok=True)

load_dotenv(Path(__file__).resolve().parent / ".env")
load_dotenv(ROOT_DIR.parent / ".env")  # fall back to the repo-root .env shared with WorldIR

app = FastAPI(title="Video2Sim 3D Backend", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/media/samples", StaticFiles(directory=str(SAMPLES_DIR)), name="samples")
app.mount("/media/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "gemini_env_configured": bool((os.getenv("GEMINI_API_KEY") or "").strip()),
        "sample_available": SAMPLE_VIDEO.exists(),
        "sample_filename": SAMPLE_VIDEO.name if SAMPLE_VIDEO.exists() else None,
        "sample_url": f"media/samples/{SAMPLE_VIDEO.name}" if SAMPLE_VIDEO.exists() else None,
    }


@app.post("/api/analyze", response_model=AnalysisResponse)
async def analyze_video(
    file: Optional[UploadFile] = File(default=None),
    use_sample: bool = Form(default=False),
    mode: str = Form(default="auto"),
    api_key: Optional[str] = Form(default=None),
    model: str = Form(default="gemini-4-hydrogen"),
):
    if use_sample:
        if not SAMPLE_VIDEO.exists():
            raise HTTPException(status_code=404, detail="Sample video not found on server.")
        video_path = SAMPLE_VIDEO
        filename = SAMPLE_VIDEO.name
        video_url = f"media/samples/{SAMPLE_VIDEO.name}"
    elif file is not None:
        ext = Path(file.filename or "upload.mp4").suffix.lower() or ".mp4"
        if ext not in {".mp4", ".webm", ".mov", ".avi", ".mkv"}:
            raise HTTPException(status_code=400, detail=f"Unsupported video format: {ext}")
        unique_name = f"{uuid.uuid4().hex[:10]}{ext}"
        video_path = UPLOADS_DIR / unique_name
        with video_path.open("wb") as out_f:
            shutil.copyfileobj(file.file, out_f)
        filename = file.filename or unique_name
        video_url = f"media/uploads/{unique_name}"
    else:
        raise HTTPException(status_code=400, detail="Provide a video file or set use_sample=true.")

    try:
        artifacts = analyze_video_opencv(
            video_path=str(video_path),
            filename=filename,
            video_url=video_url,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"OpenCV video analysis failed: {exc}")

    resolved_key = (api_key or os.getenv("GEMINI_API_KEY") or "").strip()
    mode_clean = mode.lower().strip()
    warning: Optional[str] = None

    if mode_clean == "gemini" and not resolved_key:
        raise HTTPException(
            status_code=400,
            detail="Gemini mode selected, but no GEMINI_API_KEY was provided in the UI or backend/.env.",
        )

    if mode_clean in {"auto", "gemini"} and resolved_key:
        try:
            scene = build_scene_with_gemini(
                artifacts=artifacts,
                api_key=resolved_key,
                model=model or "gemini-4-hydrogen",
            )
            return AnalysisResponse(
                mode_used="gemini",
                model_used=model or "gemini-4-hydrogen",
                warning=None,
                metadata=artifacts.metadata,
                scene=scene,
                trajectories=artifacts.trajectories,
            )
        except Exception as exc:
            if mode_clean == "gemini":
                raise HTTPException(status_code=502, detail=f"Gemini scene reconstruction failed: {exc}")
            warning = f"Gemini unavailable ({exc}); fell back to local OpenCV scene reconstruction."

    if mode_clean == "auto" and not resolved_key:
        warning = "No Gemini API key set — used local OpenCV reconstruction. Add a Gemini API key for AI Vision understanding of arbitrary videos."

    scene = build_scene_with_opencv(artifacts)
    return AnalysisResponse(
        mode_used="opencv",
        model_used=None,
        warning=warning,
        metadata=artifacts.metadata,
        scene=scene,
        trajectories=artifacts.trajectories,
    )


if FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIST), html=True), name="frontend")


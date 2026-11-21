# Video2Sim 3D

Convert a 2D video into a live, interactive **3D simulation** using a **Python OpenCV + Gemini Vision** backend and a **Three.js** frontend.

## How It Works
1. **OpenCV Video Analysis (`backend/video_analyzer.py`)**:
   - Computes a temporal median background frame (removing moving subjects cleanly).
   - Tracks moving objects across the video (e.g., flying birds) into smooth 2D `(t, u, v)` motion trajectories.
   - Extracts representative keyframes.
2. **AI Vision Scene Graph (`backend/gemini_scene.py`)**:
   - Sends the clean background, keyframes, and OpenCV trajectories to **Gemini Vision (`gemini-2.5-flash`)** with Pydantic Structured Outputs to generate a complete 3D `SceneGraph` (sky, sun, mountains, water bodies, paths, houses, trees, and animated entities linked to tracked trajectories).
   - Includes a **Local OpenCV Fallback (`backend/opencv_fallback.py`)** so stylized 2D videos work immediately even without an API key.
3. **Interactive Three.js 3D Simulation (`frontend/src/sceneBuilder.js`)**:
   - Custom GLSL animated water shader with shoreline foam, sun glints, and **click-to-drop-pebble ripples**.
   - Wind-driven swaying 3D trees and floating ambient wind motes.
   - Articulated 3D birds flapping and banking along the exact OpenCV-tracked trajectories, synced to the 2D video timeline.
   - Dynamic `PCFSoftShadowMap` shadows, 24-hour Time-of-Day lighting (with warm glowing house windows at sunset/night), and camera presets (*2D Match*, *Isometric*, *Bird's Eye*, *Follow Bird*).

## Quick Start

### Option 1: One-Command Launch (PowerShell)
```powershell
.\start.ps1
```
Then open **http://localhost:5173** in your browser. Your sample video (`samples/sample_landscape_birds.mp4`) loads automatically!

### Option 2: Manual Start
**Backend:**
```powershell
cd backend
.\.venv\Scripts\uvicorn.exe main:app --host 127.0.0.1 --port 8000 --reload
```
**Frontend:**
```powershell
cd frontend
npm run dev
```

### Adding a Gemini API Key
- Paste your Gemini API key directly into the **Gemini API Key** box in the top bar (saved in `localStorage`), **or**
- Copy `backend/.env.example` to `backend/.env` and set `GEMINI_API_KEY=your_key_here`.

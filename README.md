# WorldIR 3D — Persistent Multi-Carrier Generative 3D World Engine

A full-3D generative world representation and live WebGL2 studio where worlds are compiled into persistent, Blender-style object collections rather than flat 2D/2.5D pixel sequences. Every viewpoint, camera path, and surgical chat edit operates directly on persistent 3D state.

## Architecture Overview

- **Authoritative World IR (`world/schema.py`):** Typed Pydantic v2 scene graph organized into collections (`architecture`, `landmarks`, `nature`, `vehicles`, `agents`, `props`, `lighting`) with immutable revision snapshots and 0-call Undo.
- **Four Hybrid 3D Geometry Carriers:**
  1. **Analytic Heightfield Terrain & Water (`world/static/builders.js`):** Continuous $h(x, z)$ heightfield with automatic plaza flattening and reflective water planes.
  2. **Parametric Multi-Part 3D Assemblies (`world/static/builders.js`):** 360°-detailed architectural, natural, and vehicle structures (recessed glowing windows on all sides, pitched roofs, tiered fountains with animated 3D water jets, walkable vaulted arches, branching trees, windmills, lighthouses, lamps with real `PointLight`s).
  3. **Implicit Smooth-Min SDF -> Marching Cubes (`world/sdf_compiler.py`):** Custom organic/sculptural 3D geometry mathematically synthesized live by Gemini 4 Carbon (`smooth_union`, `smooth_subtract`, `mirror_x`) and compiled into watertight smooth meshes with analytic $\nabla\text{SDF}$ normals and triplanar UVs (`~36 ms`).
  4. **Articulated Autonomous Agents (`world/static/builders.js`, `world/static/studio.js`):** Multi-part animated rigs (flapping/banking/perching bird flocks, trotting foxes, patrolling vehicles/boats, floating lanterns) with target-referencing behavior state machines preserved across edits.
- **Seamless PBR Material Synthesis (`world/textures.py`):** Nano Banana 2.1 generates tileable albedo textures; toroidal crossfade + wrap-padded Sobel filtering deterministically derives matching tangent-space normal and roughness maps.
- **Dual Gemini 4 Roles (`world/gemini_3d.py`):**
  - **Gemini 4 Carbon (`gemini-4-carbon`):** Compiles unseen natural-language prompts into multi-carrier 3D worlds and compiles chat edits into minimal surgical diffs without rebuilding unrelated objects.
  - **Gemini 4 Hydrogen (`gemini-4-hydrogen`):** Independently audits a live 4-viewpoint 3D WebGL render plate (Elevated 3/4 Overview, Eye-Level Front, Opposite 180° Back, Hero Close-Up) and can emit bounded spatial fixes.
- **Real-Time WebGL2 Studio (`world/static/`):** Vendored Three.js `0.170.0`, ACESFilmic tone mapping, 2048px `PCFSoftShadowMap`, dynamic sky-dome PMREM reflections, free **WASD + Mouse Look** walking/flying, 360° orbit + click-to-select, and surgical live hot-patching.

## 2D Video → 3D World (Video2Sim merged into WorldIR)

In the studio, card **1b. 2D Video → 3D World** takes an uploaded video (or the bundled sample) and reconstructs it as a normal persistent WorldIR world:

1. **OpenCV** (`video2sim/backend/video_analyzer.py`) computes a clean temporal-median background, keyframes, and tracked 2D trajectories of every moving object.
2. **Gemini 4 Carbon** (`world/video_world.py`) sees the background + keyframes and compiles a multi-carrier world matching the video, estimates the original camera, and binds each trajectory to an articulated agent (`behavior.kind = "follow_video_path"`).
3. Each trajectory is **unprojected through the matched camera** into a timed 3D path (`world.source_video.tracks`). The studio replays the paths in sync with a picture-in-picture of the source video; **Video Camera** snaps to the original viewpoint.

The result supports everything else: walk mode, surgical chat edits (tracked agents keep their paths), undo, and the Hydrogen audit. API: `POST /api/worlds/from-video` (multipart `file` or `use_sample=true`, optional `hint`).

## Quick Start (merged prototype)

```bash
cp .env.example .env   # add GEMINI_API_KEY
./start.sh             # syncs deps, builds the Video2Sim frontend once, starts the server
```

- **WorldIR 3D studio** (prompt → persistent 3D world, chat edits): http://127.0.0.1:8000/
- **Video2Sim 3D** (video → OpenCV tracking + Gemini Vision → Three.js sim, merged from the `Harsh` branch): http://127.0.0.1:8000/video2sim/

Both run in one FastAPI process; Video2Sim's backend (`video2sim/backend`) is mounted as a sub-app at `/video2sim`.
Run `REBUILD=1 ./start.sh` after editing `video2sim/frontend/src`, or use `cd video2sim/frontend && npm run dev` (Vite on :5173 proxies to :8000) for hot reload.

## Quick Start (WorldIR only)

```bash
cp .env.example .env
# Add your GEMINI_API_KEY to .env

uv sync
uv run uvicorn world.server:app --host 127.0.0.1 --port 8000
```

Open `http://127.0.0.1:8000` in your browser. Press `F` (or click **Walk Mode**) for WASD + mouse-look navigation, or drag/scroll in **Orbit Camera** and click objects to select them for targeted chat edits.

## Running Reproducible Local Tests (No API Spend)

```bash
uv run python tests/test_world_ir.py
```

See `RESULTS.md` for measured timings, multi-turn surgical edit logs, and honest technical limitations.

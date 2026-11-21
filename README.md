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

## Quick Start

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

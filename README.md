# WorldIR 3D — Streamed Parallel Multi-Carrier 3D World & Appearance-Anchored Cinema Video Engine

A real-time, persistent 3D World IR and appearance-anchored cinematic video architecture where natural-language prompts compile into genuinely distinct, independently editable 3D worlds (weddings, spaceship interiors, primeval forests, architectural courtyards, etc.) rather than flat 2D pixel sequences or hardcoded village templates.

## Architecture Overview

- **Authoritative Persistent World IR (`world/schema.py`, `world/coordinator.py`):**
  - Typed Pydantic v2 scene graph with a **Single-Writer Deterministic Coordinator** enforcing monotonic operation sequencing (`seq`), 2D footprint de-collision across parallel workers, user-edit lock protection during live streaming, monotonic PBR refinement, immutable snapshots, and 0-call Undo.
- **Five General-Purpose 3D Carriers (`world/static/builders.js`, `world/sdf_compiler.py`):**
  1. **General Environment Floor, Terrain & Architectural Enclosures:** Outdoor heightfields, continuous forest floors with canopy/sunbeams, flat architectural floors, and full 3D interiors (`space_bridge` with 3D deep-space starfield & ringed planet viewport, `sci_fi_corridor`, `interior_room`, `cathedral_hall`).
  2. **Composable 3D Part-Tree Grammar (`procedural_assembly`):** Expressive validated assembly grammar (11 primitive shapes, bilateral `mirror_x`, linear & radial `repeat_count`, glass/hologram translucency, emissive glow, attached `PointLight`s, and deterministic part animation) enabling arbitrary scenes without a giant hardcoded asset library.
  3. **Implicit Smooth-Min SDF -> Marching Cubes (`implicit_sdf`):** Watertight organic/sculptural 3D meshes with analytic $\nabla\text{SDF}$ normals and baked 5-tap 3D SDF Ambient Occlusion (`~10–35 ms`).
  4. **Articulated Human Characters & Autonomous Agents (`articulated_agent`):** Multi-part `human_character` rigs (bride with gown/veil/bouquet, groom, officiant, guests, bridge crew) with coordinated deterministic performances (`walk_path`, `stand_and_face`) plus optional wildlife/vehicles evaluated purely at timestamp `t` (`evaluateWorldAt(t)`).
  5. **Optional Reusable Parametric Builders (`parametric_assembly`):** Reusable architectural/natural components used only when they genuinely match the user's intent.
- **Massively Parallel Cloud Streaming & Sub-Second Editing (`world/stream_pipeline.py`):**
  - **Gemini 3.5 Flash Lite:** Intent-driven scaffold manifest (`~1.5–3s` TTFV) + sub-second surgical diff compiler (`~0.8–1.4s` Time to First Visible Change).
  - **Gemini 4 Carbon:** Parallel NDJSON Hero Assembly, Spatial Structure, and Implicit SDF workers.
  - **Gemini 4 Hydrogen:** Parallel Environment Detail, Characters/Cameras workers, Adjacent-Region Expansion, and Independent 4-View Prompt-Coverage Visual Auditor.
  - **Nano Banana 2 Lite + Nano Banana 2.1:** Parallel two-stage progressive seamless PBR synthesis hot-swapped in place onto live 3D materials without resetting object identities or interrupting navigation/editing.
- **Appearance-Anchored Generative Video Pipeline (`world/video_pipeline.py`):**
  - Caches photorealistic **Scene References** and 3-view **Canonical Entity Turnaround Sheets** (`Front / 3/4 Side / Back`) in parallel by persistent `(entity_id, appearance_hash)` so edits regenerate only affected entities.
  - Synthesizes synchronized 24 FPS H.264 MP4 cinema shots conditioned on deterministic 3D RGB + G-Buffer (`Depth | World Normals | Object-ID`) + persistent appearance references + temporal window anchors + bidirectional occlusion-aware DIS optical flow interpolation.

## Quick Start

```bash
cp .env.example .env
# Add your GEMINI_API_KEY to .env

uv sync
uv run uvicorn world.server:app --host 127.0.0.1 --port 8000
```

Open `http://127.0.0.1:8000` in your browser. Click **Wedding Ceremony**, **Spaceship Interior**, or **Dense Forest** -> **Stream 3D World** to watch validated 3D objects stream live while orbiting, walking (`F` + WASD), scrubbing deterministic time `t`, switching independent camera trajectories, or applying live 1-second surgical edits.

## Running Reproducible Local Tests (No API Spend)

```bash
uv run python tests/test_world_ir.py
```

See `RESULTS.md` for full empirical profiling, streamed latency tables, three-domain prompt-coverage audits, adjacent-region persistence tests, the Appearance-Anchored Wedding Video A/B experiment, and our next concrete research plan toward real-time photorealistic human performances.

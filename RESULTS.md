# WorldIR 3D — Full-3D Persistent Multi-Carrier Generative World Studio

**Live Studio:** `http://127.0.0.1:8000` (`uv run uvicorn world.server:app --host 127.0.0.1 --port 8000`)  
**Hardware & Runtime:** Apple M1 Pro (16 GB RAM), macOS 26.4.1 (`arm64`), Python 3.12.9 (`uv`), Three.js `0.170.0` WebGL2 (`ACESFilmic`, `2048px PCFSoftShadowMap`, dynamic PMREM sky reflections).

---

## 1. Architecture: Blender-Style Persistent Collections + 4 Hybrid 3D Geometry Carriers

Instead of generating flat 2D/2.5D video frames and trying to fake depth, **WorldIR 3D** compiles prompts into a genuine, persistent 3D world organized into independently addressable collections (`architecture`, `landmarks`, `nature`, `vehicles`, `agents`, `props`, `lighting`). Every viewpoint and video frame is rendered continuously in real time from the live 3D world state.

### Transparency: What Is Generated vs. Parametric
| Component | Representation / Carrier | Generated Live vs. Parametric |
|---|---|---|
| **World layout, hierarchy, transforms, materials, lighting & behaviors** | Typed `WorldState` JSON IR (`world/schema.py`) | **100% generated live** per unseen prompt by **Gemini 4 Carbon** |
| **Custom organic & sculptural 3D geometry** (e.g. carved marble owl statue, coiled mossy sea-serpent monument) | **`implicit_sdf`** (`world/sdf_compiler.py`) — smooth-min CSG Signed Distance Field (`smooth_union`, `smooth_subtract`, `mirror_x`) evaluated on a 3D voxel grid -> `skimage.measure.marching_cubes` + analytic $\nabla \text{SDF}$ smooth normals + triplanar UVs (`~35 ms`) | **100% mathematically synthesized live** from scratch by **Gemini 4 Carbon** (no prebuilt statue library!) |
| **Surface appearance (albedo, normal & roughness maps)** | **Seamless Tileable PBR** (`world/textures.py`) — cosine-feathered toroidal seamless blending + OpenCV wrap-padded Sobel tangent-space Normal & Roughness derivation | **100% generated live** by **Nano Banana 2.1** (`gemini-nano-banana-2.1`) |
| **Architectural, natural & vehicle structures** (buildings, clock towers, fountains w/ animated 3D water jets, vaulted arches, branching trees, windmills, lighthouses, lamps, vehicles) | **`parametric_assembly`** (`world/static/builders.js`) — multi-part 360°-detailed 3D generators with recessed glowing windows on all 4 sides, extruded roofs, real PointLights, spinning sails/wheels | **Parametric 3D generators** parameterized and textured live by **Gemini 4 Carbon** + **Nano Banana 2.1** |
| **Terrain & water** | **`heightfield_terrain`** — analytic multi-octave heightfield $h(x, z)$ with automatic flat central plaza + reflective animated water plane | **Analytic procedural field** parameterized & textured live |
| **Autonomous moving entities** (flapping/banking/perching bird flocks, patrolling vehicles, boats, foxes, floating lanterns) | **`articulated_agent`** — multi-part articulated 3D rigs + persistent target-referencing behavior state machines (`orbit_and_perch`, `orbit_target`, `patrol_ring`) | **Parametric articulated rigs** driven by **Carbon-authored target behaviors** preserved across edits |

### Dual Gemini 4 Model Separation (Mandatory Hackathon Requirement)
1. **Gemini 4 Carbon (`gemini-4-carbon`) — 3D World & Surgical Diff Compiler (`world/gemini_3d.py`):**
   - Compiles unseen prompts into full multi-carrier 3D worlds (including explicit SDF mathematical programs and Nano Banana PBR texture specs).
   - Compiles chat edits into minimal surgical `CarbonWorldEditPatch` diffs (`update_behavior`, `restyle_material`, `add_objects`, `remove_objects`, `update_atmosphere`) so unrelated 3D objects keep their exact IDs, meshes, textures, and live runtime state.
2. **Gemini 4 Hydrogen (`gemini-4-hydrogen`) — Independent 4-Viewpoint 3D Visual Auditor (`world/gemini_3d.py`):**
   - Receives a live 2×2 WebGL render plate snapped from **4 genuinely distinct 3D camera angles**: (1) Elevated 3/4 Overview, (2) Eye-Level Front, (3) Opposite 180° Back View (proving real back-side 3D geometry), and (4) Hero Close-Up.
   - Scores 3D geometry coherence, spatial layout, and lighting/materials, checks for collisions/floating objects or missed edits, and can emit bounded spatial repairs (`REPAIR_SPATIAL`) hot-applied directly into the live 3D scene.

---

## 2. Verified Live Experimental Results

### World 1: Sunlit Mediterranean Hill Village Plaza (`w3d_6c0bfb1b`) — Full Multi-Turn Surgical Edit Sequence
Initial prompt: *"A sunlit Mediterranean hill village plaza with a central tiered stone fountain, a tall stone clock tower, four cozy terracotta cottages with balconies, cypress trees, a carved marble owl statue on a pedestal, a red vintage scooter patrolling the plaza, and a flock of blue birds circling and landing on the clock tower roof."*

- **Rev 1 (`create_world`):**
  - Compiled **22 persistent 3D objects** across 6 collections (`landmarks`, `architecture`, `nature`, `lighting`, `props`, `agents`).
  - Synthesized **3 seamless Nano Banana PBR texture sets** (`carved_carrara_marble`, `travertine_cobble`, `mediterranean_stucco`) in `38.2 s` parallel.
  - Compiled `marble_owl_statue` via **Implicit SDF Marching Cubes** (`2,002 verts / 4,000 tris`) in **`36.0 ms`**.
  - **Gemini 4 Hydrogen 4-View Audit (`audit_rev1_8fb5e.jpg`):** `PASS` (`3D Geo 8.0 / Spatial 8.5 / Lighting 7.8`), zero collisions or floating objects; Hydrogen also spotted that the initial View-3 back camera sat too close to the clock tower wall, prompting us to pull the back camera to `(-15, 7.5, -22)`.

- **Rev 2 — Surgical Behavior Edit (`"Make the blue birds circle and land on the central fountain instead of the clock tower."`):**
  - `action = update_behavior`, `changed = ['clock_tower_blue_birds']`, **`behavior_only = ['clock_tower_blue_birds']`**, **`21/22` objects untouched**.
  - **0 Nano Banana calls, 0 SDF recompilations, `6.1 s` total.**
  - Live WebGL hot-patch mutated ONLY `behavior.target_id -> "central_fountain"` without destroying or recreating the 9 birds; the existing birds smoothly steered mid-flight from the clock tower to circle and perch on the fountain.

- **Rev 3 — Surgical Material Edit (`"Change the clock tower walls to weathered dark mossy obsidian stone brick with bright warm amber glowing clock faces."`):**
  - `action = restyle_material`, `changed = ['clock_tower']`, **`21/22` objects untouched**.
  - **1 Nano Banana PBR texture call** (`mossy_obsidian_brick`, `23.9 s`), hot-swapped exclusively onto `clock_tower` while all 4 cottages kept their original stucco PBR walls.

- **Rev 4 — Live Atmosphere Edit (`"Switch the atmosphere to dramatic moonlit night with deep indigo sky, warm glowing cottage windows, and bright golden lampposts."`):**
  - `atmosphere_changed = True`, **0 Nano Banana calls, 0 SDF recompilations, `16.8 s` total.**
  - Updated sky dome shader, moon directional shadow light, PMREM reflections, fog, glowing cottage windows, and warm lamppost PointLights — while preserving the mossy obsidian clock tower, marble owl statue, patrolling red scooter, and 9 blue birds actively casting flying shadows across the cobblestones around the fountain.
  - **Gemini 4 Hydrogen 4-View Post-Edit Audit (`audit_rev4_02fd7.jpg`):** `PASS` (`3D Geo 8.5 / Spatial 8.8 / Lighting 8.6`), zero console errors, all 4 camera angles verified including unobstructed 180° back view.

### World 2: Unseen Second Biome — Skagenfjord Misty Harbor Cove (`w3d_45d7d627`)
Prompt: *"A misty Nordic coastal harbor cove at golden hour with a tall red-and-white lighthouse, cozy timber fishing cottages along the quay, a stone archway, pine trees on the rocky hills, a wooden windmill with spinning sails, a carved mossy stone sea-serpent monument on a pedestal, a sailboat cruising the bay water, and white seabirds circling the lighthouse."*
- Compiled **20 persistent 3D objects**, **3 Nano Banana PBR texture sets** (Nordic red timber planks, mossy harbor stone, cobblestone), reflective bay water, sweeping lighthouse beam, spinning windmill sails, walkable stone archway framing the central plaza, and a live **Implicit SDF carved mossy stone sea-serpent monument** (coiled hollow loop + fin + horned head!).
- **Gemini 4 Hydrogen 4-View Audit (`audit_rev1_39d11.jpg`):** `PASS` (`3D Geo 8.0 / Spatial 8.5 / Lighting 7.8`) across all 4 viewpoints including full 180° back view.

---

## 3. Honest Technical Limitations

1. **Stylized / architectural geometry rather than photogrammetry:** Parametric buildings/trees/vehicles and `52³` Marching Cubes SDF sculptures produce crisp, clean, 360°-walkable stylized 3D worlds with tactile Nano Banana PBR surfaces — not photorealistic scanned meshes or neural radiance fields.
2. **SDF complexity ceiling:** Smooth-min SDF programs (`5–14` primitives) excel at statues, arches, monoliths, stylized animals, vessels, and organic landmarks, but struggle to represent ultra-fine articulated human faces, hands, or intricate machinery from scratch.
3. **Compilation latency:** Initial world compilation currently takes ~60–110 s (driven primarily by Carbon's large JSON generation + 3 parallel Nano Banana texture syntheses), whereas localized behavior/atmosphere chat edits complete in `6–17 s` and Undo is instant (`0` calls).
4. **Approximate collision & navigation:** Agents avoid static ground collisions via terrain heightfield sampling and target bounding-box radii rather than a full 3D navmesh or rigid-body physics engine.

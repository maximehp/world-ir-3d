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

## 3. Controlled Visual Fidelity Study (Approaches A, B, and C on Fixed World `w3d_bench_med`)

To separate geometry, persistent material/lighting quality, object-space neural detail, and view-dependent neural rendering without losing the authoritative World IR, we evaluated four configurations on the **exact same 22-object Mediterranean village (`w3d_bench_med`)** across identical locked camera angles (`Eye-Level Front`, `Elevated 3/4 Overview`, `Opposite 180° Back`, and `Hero Close-Up: marble_owl_statue`).

### Root-Cause Audit of Baseline (`main` `226d618`) Limitations
- **Geometry vs. Material Gap:** Flat untextured roofs, smooth stacked Play-Doh cypress ovals, opaque flat fountain water, green-tinted cobblestone outer hills, harsh 90° ground contact lines (no Contact AO), and washed-out white SDF marble without cavity shadowing.

### Controlled Quantitative Comparison (`w3d_bench_med`, Retina `988×1608` Synchronized `gl.finish()`)

| Approach | Where Neural Compute Runs | One-Time Cost | Per-Frame Render Time (`gl.finish()`) | Multi-View Consistency (Front / 3/4 / 180° Back) | Edit Locality & Camera Freedom |
|---|---|---|---|---|---|
| **0. Baseline (`main` `226d618`)** | 3 world-space PBR textures | ~38 s | ~15 ms/view (incl. JPEG readback) | **100% geometric** (stylized / flat roofs & trees) | Full 360° WASD & surgical edits |
| **A. Persistent Multi-Channel PBR + SDF-AO + Atmospheric Lighting** | +2 persistent Nano Banana PBR sets (`roof_tiles_pbr`, `hill_terrain_pbr`) + cavity AO maps + 5-tap 3D SDF-AO (`32.5 ms`) | **23.9 s once** (`2` NB calls, cached forever) | **`4.63 ms` mean** (`4.6 ms` median, `215.9 FPS` sync GPU) | **100% consistent** across all 360° viewpoints; terracotta tile roofs, meadow hills splat, sparkling water ripples, organic cypress clusters, Contact AO | Full 360° WASD & surgical edits; 0 neural calls on camera/behavior changes |
| **B. Approach A + Object-Space Dual-Projection Neural Baking (`marble_owl_statue`)** | **1 Nano Banana call ONCE in object space** on exact orthographic Front+Back SDF render -> normal-weighted `+Z/-Z` PBR shader + derived normal maps | **22.8 s once** (`1` NB call per hero SDF) | **`5.53 ms` mean** (`4.6 ms` median, `180.9 FPS` sync GPU) | **100% view-consistent Front & Back** (chiseled owl face/feathers in front, matching folded back wings behind, zero Janus flip, responds dynamically to sun/moon shadows) | **100% persistent** — moves, scales, and relights with the 3D object; 21/22 objects untouched |
| **C. Geometry-Conditioned Neural Still Rendering (Experimental)** | Per-camera view-dependent Nano Banana pass conditioned on deterministic 3D G-Buffer (`Depth + World Normals + Object-ID`) + cross-view style ref | **~16–22 s per frame** (`1` NB call/frame) | **Not real-time** (~0.05 FPS) | **Dramatically photorealistic stills, but imperfect 3D consistency:** G-Buffer beat RGB-only on Front (`Edge F1: 0.9582 vs 0.9493`, `Obj-Silhouette Recall: 0.8475 vs 0.8282`), Overview reached `0.9317` Obj-Recall, Back 180° reached `0.8966` — **however Back 180° exhibited a Janus face-flip** (repainting the front owl face onto the back view!) | View-dependent image output; cannot replace World IR for free camera or temporal video |

### Architectural Conclusion: Where Generative Computation Belongs
1. **Persistent Object-Space & World-Space Generation (Approaches A + B) is the right authoritative backbone.** Spending neural compute **once** on multi-channel PBR surfaces (roofs, walls, dual-biome terrain, cavity AO) plus **1-call Object-Space Dual-Projection Baking** on `implicit_sdf` hero geometry converts stylized procedural geometry into richly carved, multi-view-consistent 3D assets rendered at **>180 FPS synchronized GPU throughput** with zero temporal flicker and full independent editability.
2. **G-Buffer-Conditioned Neural Rendering (Approach C) belongs strictly as an optional, non-authoritative final still/cinema render pass.** Conditioning on deterministic Depth, Normals, and Object-ID masks measurably tightens geometric fidelity over RGB-only image-to-image, and starting from our upgraded Approach A+B render yields dramatic cinema-grade stills — while honestly revealing per-view latency and back-view Janus drift as open research limits.

---

## 4. Honest Technical Limitations & Next Research Questions

1. **Dual-projection grazing seams (Approach B):** Front/Back (`+Z/-Z`) orthographic projection covers most sculptural statues cleanly, but extreme lateral grazing profiles (`|n_x| ≈ 1`) soften slightly — motivating a 4-view (`±Z, ±X`) or UV-atlas neural baking pass next.
2. **Parametric building facade weathering:** Extending Approach B's object-space neural baking to architectural facades (orthographic elevation bake per building) would add bespoke plaster weathering, vines, and stained eaves at 60 FPS with 1 call per hero building.
3. **SDF complexity ceiling:** Smooth-min SDF programs (`5–14` primitives) excel at statues, arches, monoliths, and stylized creatures, but do not replace rigged skeletal characters for close-up articulated humans.
4. **Compilation latency:** Initial world compilation takes ~60–110 s (Carbon JSON + parallel Nano Banana textures), whereas localized behavior/atmosphere chat edits complete in `6–17 s`, persistent PBR enhancement takes `23.9 s` once, and Undo is instant (`0` calls).
5. **View-dependent temporal video consistency (Approach C):** Extending G-Buffer-conditioned neural stills to temporally flicker-free moving video requires cross-frame optical-flow/3D-reprojection warping (deferred to future work rather than regenerating independent frames).

---

## 5. Pass 2: Empirical Pipeline Profiling, Parallel Streamed World IR & Sub-Second Editing

### 5.1 Root-Cause Bottleneck Profile of Pass 1 (`dcf3979`)
Inspecting historical world logs and live cloud API latency across all available Gemini models revealed four structural bottlenecks:
1. **Monolithic blocking compilation (`106–198 s` TTFV):** `w3d_6c0bfb1b` took `106.0 s` (`Carbon = 67.7 s`, sequentially followed by `Nano Banana = 38.2 s`), `w3d_45d7d627` took `190.7 s`, and `w3d_51e44cf8` took `198.7 s`. Zero pixels appeared until the entire JSON + all textures completed.
2. **Thinking-token overhead + oversized edit schema (`6.1–30.0 s` edits):** Sending the full 3D WorldState JSON schema + `gemini-4-carbon` caused `6.1 s` for simple behavior edits, `16.8 s` for atmosphere swaps, `30.0 s` blocking wait for material edits (`6.1 s` Carbon + `23.9 s` NB), and `129.1 s` for multi-SDF additions.
3. **Per-call client recreation:** `_get_client()` recreated `genai.Client()` (new TLS handshake) on every single request.
4. **Hardcoded village template bias:** `ParametricSpec`'s 15-item catalog and `carbon_compile_world`'s prompt forced a central circular plaza, building ring, trees, lampposts, and an SDF statue on every world regardless of prompt intent.

### 5.2 Empirical Cloud Model Latency Matrix (Live Measured)
| Role / Test | Model & Config | Measured Latency | Notes |
|---|---|---|---|
| **Surgical Edit (5-edit suite)** | `gemini-3.5-flash-lite` | **`978 ms` mean** (`672–1,119 ms`) | Selected for sub-second surgical diff & fast world scaffold |
| **Surgical Edit (5-edit suite)** | `gemini-3.1-flash-lite` (`tb=0`) | `1,426 ms` mean | Clean runner-up |
| **Surgical Edit (5-edit suite)** | `gemini-4-hydrogen` (`tb=0`) | `2,394 ms` median (`1,700–8,985 ms`) | Emits ~150–280 thought tokens; strong for parallel streaming workers & 4-view auditing |
| **Surgical Edit (5-edit suite)** | `gemini-4-carbon` (`tb=0`) | `4,212 ms` median (`2,755–11,564 ms`) | Strongest 3D spatial/part-tree & SDF math; used in parallel hero/structure workers |
| **PBR Albedo (512px)** | `gemini-3.1-flash-lite-image` | **`5,290 ms`** | Used for Stage-1 provisional PBR hot-swap (`~8 s` from prompt!) |
| **PBR Albedo (512px)** | `gemini-nano-banana-2.1` | `13,503 ms` | Used for Stage-2 master PBR upgrade + canonical appearance references |
| **Native Video (`veo-*`)** | `veo-3.1 / 3.0 / 2.0` | **Unavailable (`404 NOT_FOUND`)** | Explicitly verified via `models.list()` (28 models) & `models.get()` |

### 5.3 Upgraded Architecture: Streamed Parallel World IR + General-Purpose 3D Part-Tree Grammar
1. **General-Purpose Representation (Fixing the Village Bias):**
   - Replaced mandatory plaza/village templates with **Carrier 5 (`procedural_assembly`)** (`world/schema.py`, `world/static/builders.js`): a strictly Pydantic-validated composable 3D part-tree grammar (`11` primitive shapes, bilateral `mirror_x`, linear & radial `repeat_count`, glass/hologram `opacity`, emissive glow, attached real `PointLight`s, and deterministic part animations `spin_y / spin_z / bob_y / pulse_emissive / sway`).
   - Added general **`ground_kind`** (`outdoor_hills`, `flat_floor`, `forest_floor`, `interior_deck`, `none`) and **`enclosure`** (`open_sky`, `space_bridge` with 3D deep-space starfield & ringed planet viewport, `sci_fi_corridor`, `interior_room`, `cathedral_hall`, `forest_canopy`). Existing `parametric_assembly` builders remain strictly optional.
   - Added articulated **`human_character`** rigs (`bride` with A-line gown/veil/bouquet, `groom` in tuxedo, `officiant`, `guest`, bridge crew) with coordinated deterministic performances (`walk_path`, `stand_and_face`).
2. **Deterministic Single-Writer Coordinator (`world/coordinator.py`):**
   - Validates every streamed `WorldOp` individually via Pydantic v2, assigns monotonic `seq`, resolves 2D static footprint collisions across concurrent workers via deterministic outward spiral search, protects live user edits via `user_locked_ids`, enforces monotonic PBR quality (`provisional` never downgrades `refined`), and isolates concurrent SSE streams by `stream_id`.
3. **Deterministic Timestamp Evaluator & Independent Camera Trajectories (`world/static/studio.js`):**
   - Replaced stateful `dt` accumulation with pure `evaluateWorldAt(t)` (verified **byte-for-byte identical** across random timestamp seeks and camera switches) + first-class editable `CameraTrack`s (`spline` Catmull-Rom + `orbit_entity`).
4. **Two-Stage In-Place PBR Refinement (`upgradeMaterialsWithTexture`):**
   - Procedural materials render immediately (`TTFV ~3.2–3.8 s`); Stage-1 provisional neural PBR (`gemini-3.1-flash-lite-image`) hot-swaps in place at `~7.9–8.5 s`; Stage-2 master PBR (`gemini-nano-banana-2.1`) hot-swaps in place at `~14–20 s` — with zero mesh destruction or camera interruption.

---

## 6. Three Fundamentally Different Prompts Test (Prompt-Coverage & Diversity Validation)

To verify the representation genuinely eliminated the Mediterranean village template bias, we streamed three radically different unseen prompts sequentially through `POST /api/worlds/stream`, measured **real-time GPU rendering** (`gl.finish()`) and **streamed generation latencies** independently, and ran **Gemini 4 Hydrogen 4-View Visual & Prompt-Coverage Audits** (`tests/run_three_worlds_eval.py`):

| Prompt / Domain | World ID | Ground / Enclosure / `plaza_r` | Objects & Carriers | TTFV (Terrain+Sky) | 1st Valid 3D Obj | 1st Prov / Master PBR | Geo Complete | Real-Time GPU (`gl.finish()`) | Hydrogen 4-View Audit (`Geo / Spatial / Light / PromptCov`) |
|---|---|---|---|---|---|---|---|---|---|
| **1. Wedding Ceremony** | `w3d_4da68832` | `outdoor_hills` / `open_sky` / `0.0 m` | **25 objs**: `17 procedural_assembly`, `8 articulated_agent` (**7 humans**: Bride, Groom, Officiant, 4 Guests + Doves) | **`3.79 s`** | **`9.09 s`** | `7.94 s` / `15.80 s` | `78.3 s` | **`3.46 ms` (`289.0 FPS`)** | **`PASS`** (`8.5 / 8.5 / 8.0` / **`9.5/10`** · `Missing: []`) |
| **2. Spaceship Interior** | `w3d_8d21a5c0` | `interior_deck` / `space_bridge` / `0.0 m` (`stars=True`) | **19 objs**: `16 procedural_assembly`, `3 articulated_agent` (**3 uniformed bridge crew**) | **`3.61 s`** | **`8.12 s`** | `8.54 s` / `20.14 s` | `59.3 s` | **`2.93 ms` (`341.3 FPS`)** | **`PASS`** (`8.5 / 8.5 / 8.0` / **`9.5/10`** · `Missing: []`) |
| **3. Dense Forest** | `w3d_1c5a37a7` | `forest_floor` / `forest_canopy` / `0.0 m` | **17 objs**: `12 procedural_assembly`, `3 parametric_assembly`, `2 articulated_agent` (Red Fox + Forest Birds) | **`3.20 s`** | **`5.20 s`** | `8.00 s` / `14.06 s` | `47.6 s` | **`1.41 ms` (`711.7 FPS`)** | **`PASS`** (`8.2 / 8.4 / 7.8` / **`8.8/10`**) |
| *Pass 1 Baseline (`dcf3979`)* | *`w3d_6c0bfb1b`..`51e44cf8`* | *Always `cobblestone_plaza` (`r=15m`)* | *Parametric village ring + 1 SDF* | *`106–198 s` (monolithic)* | *`106–198 s`* | *`106–198 s`* | *`106–198 s`* | *`4.63 ms` (`215.9 FPS`)* | *Village template forced on all scenes* |

- **Speedup:** **28×–55× faster Time to First Visible World (`3.2–3.8 s` vs `106–198 s`)**, **12×–38× faster Time to First 3D Object (`5.2–9.1 s`)**, and **100% distinct scene semantics** (Wedding: rose-covered arch, petal aisle runner, 5-row guest pews, fairy-light strings, 7 human characters; Spaceship: enclosed bridge deck with ringed planet/nebula viewport, spinning cyan holographic star-map table, captain chair, helm consoles, pulsing warp core, 3 crew; Dense Forest: misty god-rays, gnarled mossy giant trees, winding brook, granite boulders, giant ferns, glowing turquoise mushrooms, red fox — zero village cottages or cobblestone curbs in any of the three!).

---

## 7. Low-Latency Surgical Editing (`0.8–1.3 s` TTFC) & Seamless Adjacent-Region Persistence

### 7.1 Fast Two-Phase Streamed Edits (Measured Separately from Generation & Rendering)
| Edit Category | Target World | Time to First Visible Change (**TTFC**) | Time to Fully Refined | Objects Mutated / Preserved | Pass 1 Baseline Comparison |
|---|---|---|---|---|---|
| **Transform + Scale** (Captain chair) | `w3d_e9c64194` (Spaceship) | **`0.83 s`** (`829.5 ms`) | **`0.83 s`** | `1Δ / 5 kept` | ~6.1 s (**7.3× faster**) |
| **Camera Trajectory Add** (Low-angle aisle shot) | `w3d_c5a1f600` (Wedding) | **`0.97 s`** (`969.0 ms`) | **`0.97 s`** | `0Δ / 10 kept` (+1 `CameraTrack`) | Unsupported in Pass 1 |
| **Bride Dress Color Edit** (Blush rose silk) | `w3d_c5a1f600` (Wedding) | **`1.03 s`** (`1,034.2 ms`) | **`1.04 s`** | `1Δ / 9 kept` | ~6.1–30.0 s (**6–29× faster**) |
| **Material + New PBR Texture** (Copper holo-table) | `w3d_e9c64194` (Spaceship) | **`1.09 s`** (`1,086.9 ms`) | `26.48 s` (Provisional + NB 2.1 PBR) | `1Δ / 5 kept` | `30.0 s` TTFC (**27.6× faster TTFC**) |
| **Complex Add SDF Sculpture** (Mossy owl totem) | `w3d_6033f31d` (Dense Forest) | **`1.34 s`** (`1,344.0 ms` placeholder) | `32.58 s` (Carbon SDF + NB PBR) | `1Δ / 7 kept` | `129.1 s` (**96× faster TTFC / 4× refined**) |
| **Concurrent Mid-Stream Edit** (Dusk glow during gen) | `w3d_c5a1f600` (Wedding) | **`1.62 s`** (`1,622.9 ms`) | **`1.62 s`** | Non-blocking during active stream | Impossible in Pass 1 |
| **Undo** | Any World | **`< 0.05 s`** | **`< 0.05 s`** | `0` model calls | Instant |

### 7.2 Seamless Persistent Adjacent-Region Expansion (`w3d_6033f31d`, Dense Forest)
- **1st Visit to adjacent grid cell `r_1_0` at stable world coordinates `(40.0, 0.0)`:** Streamed **4 new neighbor-consistent persistent primeval forest objects** (`r_1_0_ancient_redwood_monarch`, `r_1_0_mossy_granite_arch_outcrop`, `r_1_0_giant_primeval_fern_glade`, `r_1_0_sunken_mossy_totem_spring`) with 1st object at `9.38 s`, total `33.45 s`, seamlessly extending continuous terrain.
- **Revisit to `r_1_0`:** Completed in **`25.6 ms`**, **`cached = True`**, **`0` model calls**, returning the exact 4 persisted objects.
- **Persistence invariant:** All **`8/8`** original `r_0_0` objects remained **bit-exact untouched (`True`)**.

---

## 8. Appearance-Anchored Generative Wedding Video A/B Experiment (Real 24 FPS MP4s)

### 8.1 Explicit Video API Capability Verification
Probing our `GEMINI_API_KEY` empirically (`probe_video_model_support()`, `GET /api/video/capabilities`) established that **zero native video models (`veo-3.1-generate-preview`, `veo-3.0-generate-001`, `veo-2.0-generate-001`) are provisioned (`404 NOT_FOUND`)** across all 28 accessible models.

Accordingly, we implemented and empirically validated the strongest compatible conditioning architecture (`world/video_pipeline.py`):
1. **Stage 1 — Parallel Persistent Appearance Reference Layer (`POST /api/worlds/{id}/appearance-refs`):**
   - Synthesizes a photorealistic **Scene Reference** (`scene_ref_v1`) from the deterministic 3D establishing shot + G-Buffer, AND **3-View Canonical Entity Turnaround Sheets** (`[Front 0° | 3/4 Side 50° | Back 180°]`) for **`bride`** and **`groom`** in parallel (`27.8 s` total wall-clock: `bride 11.3 s`, `groom 12.9 s`, `scene 27.8 s`).
   - Cached by persistent `(entity_id, appearance_hash)` — ignoring position/behavior edits and invalidating only when appearance/garment attributes change.
2. **Stage 2 — Joint Multi-Frame Synchronized 2×2 Keyframe Windows + Temporal Anchor Chaining + Bidirectional DIS Optical Flow -> 24 FPS H.264 MP4:**
   - Generates 7 sequential timestamps (`t = 0.0..4.5 s`) via two overlapping `2×2` Nano Banana 2.1 contact sheets (`[0,1,2,3]` and `[3,4,5,6]`), where Window 2 locks the rendered photorealistic `frame[3]` as an explicit visual anchor alongside the cached Scene, Bride, and Groom references + deterministic 3D RGB & G-Buffer (`Depth | Normals | Object-ID`) grids.
   - Interpolates between consecutive photorealistic keyframes using occlusion-aware bidirectional DIS optical flow (`~540 ms`) and encodes browser-playable `H.264 / yuv420p` 24 FPS MP4s via `ffmpeg` (`~380 ms`).

### 8.2 Controlled A/B Comparison on Scripted Wedding Shot (`w3d_wedding_bench`, `wedding_dolly_arc`)
*Scripted scene:* Bride walking gracefully down the cobblestone aisle toward Groom beneath the stone archway as the camera glides along a smooth curved right-side dolly arc (`t = 0.0..4.5 s`, deterministic timestamp check `identical = True`, real-time 3D guide render `3.65 ms / 273.7 FPS` at `1630×1434`).

| Metric (Measured on Actual Decoded 24 FPS H.264 MP4s — 97 Frames, `4.04 s`) | **Video A: Structural Guidance Alone** (`structural_only.mp4`) | **Video B: + Persistent Appearance Refs & Temporal Anchor** (`appearance_anchored.mp4`) | Delta (B vs A) |
|---|---|---|---|
| **Video Synthesis Latency** (2×2 NB 2.1 + DIS Flow + ffmpeg) | `52.34 s` (`flow 510 ms`, `enc 271 ms`) | **`46.81 s`** (`flow 544 ms`, `enc 402 ms`) | **-5.5 s** (+ `27.8 s` cached refs once) |
| **Cross-Keyframe Exposure Drift (RGB Std, lower = steadier)** | `8.12` (visible window seam jump!) | **`2.95`** | **-63.7% drift** |
| **Object-Silhouette Recall vs 3D World IR** | `0.7640` | **`0.7984`** | **+0.0344** |
| **Decoded Temporal Warp PSNR / L1** | `28.50 dB` / `0.0243` | `24.76 dB` / `0.0367` | Higher micro-texture detail in B increases pixel L1 slightly |
| **Hydrogen Audit — Photorealism (0–10)** | `6.5` | **`7.0`** | **+0.5** |
| **Hydrogen Audit — Identity & Attire Consistency (0–10)** | `6.0` (bride sleeves morphed; arch lost florals) | **`7.0`** (consistent sleeveless lace gown, veil, floral arch) | **+1.0** |
| **Hydrogen Audit — Motion Fidelity (0–10)** | `7.0` | **`7.0`** | Parity |
| **Hydrogen Audit — Temporal Stability (0–10)** | `6.5` | **`7.0`** | **+0.5** |
| **Independent Gemini 4 Hydrogen Winner** | — | **`appearance_anchored` (2/2 runs)** | Clear win |

### 8.3 Verified Incremental Edit Cache Locality (Bride Dress Swap)
Executing *"Change the bride's wedding dress color to romantic blush rose pink silk with delicate champagne gold accents"* on `w3d_wedding_bench`:
- **Surgical 3D Edit TTFC:** **`1.30 s`** (`changed=['bride']` only; `21/22` objects untouched).
- **Incremental Appearance Reference Refresh (`force=False`):**
  - `scene`: **CACHE HIT (`0.0 ms`, `0` calls)**
  - `groom`: **CACHE HIT (`0.0 ms`, `0` calls)**
  - `bride`: **REGENERATED (`21.06 s`, `1` call)** — visual inspection of `ref_bride_v2_16defccc76fc.jpg` confirms the exact same bride's face, hairstyle, lace bodice, veil, and bouquet now paired with a blush rose silk A-line skirt and champagne gold waist sash!

---

## 9. Next Smallest Concrete Experiment Toward Real-Time Photorealistic Human Performance (`exp_human_ir_v1`)

Independent architectural evaluation of four candidate 3D human representations (monolithic rigged UV bake, animatable 3D Gaussian avatars on WebGL2, screen-space/keyframe neural refinement, and a **Layered Authoritative Human IR**) established **Candidate D — Layered Authoritative Human IR** as the decisive real-time backbone for the wedding benchmark on Apple M1 Pro WebGL2 + Gemini 4 / Nano Banana 2.1:

- **Why not pure 3DGS on WebGL2?** WebGL2 lacks GPU compute sorting (`gl.dispatchCompute`); CPU radix sorting + Retina alpha overdraw for a full wedding party (~480k splats) drops WebGL2 to ~10–20 FPS, and standard SH splats bake lighting and fail live day-to-dusk relighting.
- **Why Layered Authoritative Human IR?** Decouples a character into 4 independently editable layers sharing one skeletal rig: (1) **Persistent Identity Head & Base Body** (dedicated 2K face UV + ARKit blendshapes + separate wet eyeballs + wrapped-diffuse SSS), (2) **Swappable Sewing-Pattern Garment Meshes** (`gown_aline`, `gown_sheath`, `tuxedo`, `veil` with lace alpha cutouts + ~0.2 ms JS XPBD skirt/veil physics), (3) **Alpha-Hashed Anisotropic Hair Cards**, and (4) **Deterministic Coordinated Social Choreography** (`walk_path`, gaze IK, hand-contact IK).
- **Next Smallest Falsifiable Experiment (`exp_human_ir_v1`, ~450 LOC):**
  1. Take 1 CC0 articulated humanoid rig split into `head_mesh` (with 10 ARKit smile/blink blendshapes) + swappable `dress_satin_sheath` vs `dress_ivory_lace_aline` + `veil_mesh`.
  2. Build `world/human_baker.py`: capture 4-view (`0°, ±55°, 180°`) depth-tested sheets -> parallel Nano Banana 2.1 bake -> depth-tested UV back-projection + **4-term Spherical Harmonics intrinsic delighting** + **UV expression wrinkle normal deltas** (`Smile - Neutral`).
  3. **Pass/Fail Gates:** `0/8` Janus flips across 8 turntable angles; profile seam Sobel ratio `< 1.25` (vs `> 2.2` under existing `±Z` Approach B); `>= +0.20` relighting Pearson correlation over non-delighted bake; **`L1 = 0.0000` head/groom pixel drift** on surgical dress swap (`silhouette 1-IoU >= 0.15`); and **`< 10 ms` (`>= 100 FPS`)** synchronized GPU frame time for Bride + Groom on M1 Pro Retina.

---

## 10. Honest Remaining Technical Limitations

1. **No native video model (`veo-*`) provisioned on this API key:** Our strongest compatible alternative (Nano Banana 2.1 joint `2×2` temporal contact sheets + bidirectional DIS optical flow) produces genuinely photorealistic, identity-anchored 24 FPS MP4s (`~47 s` for 4 s video), but is **not yet real-time video synthesis** and DIS optical flow introduces mild ghosting/blur during large disocclusions (e.g., bride's veil sweeping across background columns).
2. **Tail latency on full geometry completion (`47–78 s`):** While Time to First Visible World (`3.2–3.8 s`), First Object (`5.2–9.1 s`), and Stage-1 Provisional PBR (`7.9–8.5 s`) are dramatically faster than Pass 1 (`106–198 s`), `gemini-4-carbon` streaming 10–15 detailed `procedural_assembly` objects (each with 10–20 typed parts) still drives a `47–78 s` geometry completion tail; sharding `carbon_heroes` and `carbon_structures` into smaller per-anchor parallel workers (e.g. 1 worker per 2 anchors) will cut full geometry completion under `15–20 s`.
3. **Raw WebGL2 humanoid visual ceiling:** Our procedural articulated `human_character` rig is expressive and deterministic as a 3D structural & motion guide, but still stylized in raw WebGL2 prior to implementing `exp_human_ir_v1` (skinned glTF + 4-view depth-tested UV neural baking + expression wrinkle deltas).
4. **Interior audit camera occlusion:** In enclosed scenes (`w3d_8d21a5c0`, Spaceship Interior), fixed interior audit viewpoints can still land behind a newly generated interior pillar (Hydrogen honestly flagged the Aft Warp Core occluding View 2); adding raycasted clearance nudging for interior cameras will prevent occluded views automatically.

"""Massively Parallel, Streamed, Intent-Driven General-Purpose 3D World IR Pipeline.

Zero hardcoded village/plaza templates: every world's floor/terrain, enclosure, spatial
layout, textures, 3D assemblies, human performances, and camera trajectories are compiled
directly from the user's actual prompt via a composable 3D part-tree grammar
(`procedural_assembly`), smooth-min `implicit_sdf`, articulated `human_character` / agents,
and optional reusable `parametric_assembly` builders.

Model Responsibility Split (Empirically Profiled):
  1. Gemini 3.5 Flash Lite (`gemini-3.5-flash-lite`):
       - Sub-second surgical diff interpreter (~0.8-1.4 s TTFC)
       - Fast intent-driven World Scaffold / Manifest Director (~1.4-2.5 s TTFV)
  2. Gemini 4 Carbon (`gemini-4-carbon`):
       - Parallel Hero `procedural_assembly` & `implicit_sdf` 3D geometry workers
       - Parallel Spatial Framing & Secondary Structure workers
       - Parallel complex-geometry edit refinement workers
  3. Gemini 4 Hydrogen (`gemini-4-hydrogen`):
       - Parallel Environment Detail & Scene-Specific Props workers
       - Parallel Human Characters, Coordinated Performances, Agents & Camera Track workers
       - Adjacent-region expansion & Independent 4-View Prompt-Coverage Visual Auditor
  4. Nano Banana 2 Lite (`gemini-3.1-flash-lite-image`) + Nano Banana 2.1 (`gemini-nano-banana-2.1`):
       - Two-stage parallel progressive PBR synthesis (provisional ~5 s -> master ~13 s)
       - Hot-swapped in place onto live 3D materials without changing object identities
"""

from __future__ import annotations

import concurrent.futures
import json
import pathlib
import time
import uuid
from typing import Iterator

from google.genai import types

from world.coordinator import WorldCoordinator
from world.gemini_3d import CARBON_MODEL, FLASH_LITE_MODEL, HYDROGEN_MODEL, _extract_json_text, _get_client
from world.schema import (
    CameraKeyframe,
    CameraTrack,
    ComplexObjectBrief,
    FastEditPatch,
    ImplicitSDFSpec,
    MaterialSpec,
    PBRTextureAsset,
    ProceduralAssemblySpec,
    RegionSpec,
    SDFPrimitive,
    TextureRequest,
    WorldCosts,
    WorldObject,
    WorldRevision,
    WorldScaffoldManifest,
    WorldState,
    WorldTimings,
)
from world.sdf_compiler import compile_sdf_mesh
from world.textures import NANO_BANANA_MODEL, PROVISIONAL_TEXTURE_MODEL, synthesize_pbr_texture


# ---------------------------------------------------------------------------
# Incremental Balanced-JSON Stream Parser (Handles NDJSON, Multi-Line, or Arrays)
# ---------------------------------------------------------------------------

def _iter_stream_json_objects(response_stream) -> Iterator[dict]:
    """Yield every complete top-level JSON object `{...}` the instant its closing brace arrives."""
    buf = ""
    depth = 0
    in_str = False
    esc = False
    start_idx = -1

    for chunk in response_stream:
        text = getattr(chunk, "text", None)
        if not text:
            continue
        base_len = len(buf)
        buf += text
        for i in range(base_len, len(buf)):
            ch = buf[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == "{":
                if depth == 0:
                    start_idx = i
                depth += 1
            elif ch == "}":
                if depth > 0:
                    depth -= 1
                    if depth == 0 and start_idx != -1:
                        raw_obj = buf[start_idx : i + 1]
                        start_idx = -1
                        try:
                            parsed = json.loads(raw_obj)
                            if isinstance(parsed, dict):
                                yield parsed
                        except Exception:
                            pass
        if depth == 0 and start_idx == -1 and len(buf) > 4096:
            buf = ""


def _sanitize_sdf_spec_dict(raw_dict: dict) -> dict:
    sdf = dict(raw_dict)
    prims = sdf.get("primitives") or []
    clean_prims = []
    valid_ops = {"union", "smooth_union", "subtract", "smooth_subtract"}
    valid_shapes = {"sphere", "ellipsoid", "capsule", "round_box", "torus", "cone", "cylinder"}
    for pr in prims[:16]:
        if not isinstance(pr, dict):
            continue
        cpr = dict(pr)
        if cpr.get("op") not in valid_ops:
            cpr["op"] = "smooth_union"
        if cpr.get("shape") not in valid_shapes:
            cpr["shape"] = "ellipsoid"
        cpr["k"] = max(0.01, min(0.65, float(cpr.get("k") or 0.16)))
        if not isinstance(cpr.get("center"), list) or len(cpr["center"]) != 3:
            cpr["center"] = [0.0, 0.0, 0.0]
        if not isinstance(cpr.get("size"), list) or len(cpr["size"]) != 3:
            cpr["size"] = [0.35, 0.35, 0.35]
        if not isinstance(cpr.get("rot_deg"), list) or len(cpr["rot_deg"]) != 3:
            cpr["rot_deg"] = [0.0, 0.0, 0.0]
        clean_prims.append(cpr)
    if len(clean_prims) >= 2:
        sdf["primitives"] = clean_prims
    sdf["resolution"] = max(36, min(64, int(sdf.get("resolution", 48))))
    sdf["target_height"] = max(0.4, min(12.0, float(sdf.get("target_height", 2.4))))
    return sdf


def _sanitize_procedural_dict(raw_dict: dict) -> dict:
    proc = dict(raw_dict)
    parts = proc.get("parts") or []
    valid_shapes = {
        "box", "cylinder", "cone", "sphere", "capsule", "torus",
        "arch_segment", "plane", "ring", "icosahedron", "dodecahedron",
    }
    valid_anims = {"none", "spin_y", "spin_z", "bob_y", "pulse_emissive", "sway"}
    clean_parts = []
    for p in parts[:28]:
        if not isinstance(p, dict):
            continue
        cp = dict(p)
        if cp.get("shape") not in valid_shapes:
            cp["shape"] = "box"
        for vec_k, default_v in (("pos", [0.0, 0.0, 0.0]), ("rot_deg", [0.0, 0.0, 0.0]), ("size", [1.0, 1.0, 1.0]), ("repeat_offset", [0.0, 0.0, 0.0])):
            v = cp.get(vec_k)
            if not isinstance(v, list) or len(v) != 3:
                cp[vec_k] = list(default_v)
            else:
                cp[vec_k] = [float(x) for x in v]
        if cp.get("roughness") is not None:
            cp["roughness"] = max(0.02, min(1.0, float(cp["roughness"])))
        if cp.get("metalness") is not None:
            cp["metalness"] = max(0.0, min(1.0, float(cp["metalness"])))
        cp["emissive_intensity"] = max(0.0, min(6.0, float(cp.get("emissive_intensity") or 0.0)))
        cp["opacity"] = max(0.05, min(1.0, float(cp.get("opacity") if cp.get("opacity") is not None else 1.0)))
        cp["repeat_count"] = max(1, min(16, int(cp.get("repeat_count") or 1)))
        cp["repeat_rot_y_deg"] = max(-360.0, min(360.0, float(cp.get("repeat_rot_y_deg") or 0.0)))
        if cp.get("anim") not in valid_anims:
            cp["anim"] = "none"
        clean_parts.append(cp)
    if clean_parts:
        proc["parts"] = clean_parts
    proc["description"] = str(proc.get("description") or "Procedural 3D assembly")
    proc["light_intensity"] = max(0.0, min(40.0, float(proc.get("light_intensity") or 0.0)))
    proc["light_distance"] = max(1.0, min(45.0, float(proc.get("light_distance") or 14.0)))
    proc["contact_ao_radius"] = max(0.0, min(12.0, float(proc.get("contact_ao_radius") if proc.get("contact_ao_radius") is not None else 1.2)))
    if not isinstance(proc.get("light_pos"), list) or len(proc["light_pos"]) != 3:
        proc["light_pos"] = [0.0, 2.0, 0.0]
    return proc


def _sanitize_world_object_dict(d: dict) -> dict:
    """Coerce minor LLM formatting quirks before strict Pydantic v2 WorldObject validation."""
    out = dict(d)
    if "object" in out and isinstance(out["object"], dict):
        out = dict(out["object"])
    out.pop("op", None)
    out.pop("type", None)

    if not out.get("id"):
        out["id"] = f"obj_{uuid.uuid4().hex[:6]}"
    if not out.get("name"):
        out["name"] = str(out["id"]).replace("_", " ").title()

    if isinstance(out.get("material"), str):
        tex_ref = out["material"]
        out["material"] = {"texture_id": tex_ref} if not tex_ref.startswith("#") else {"color": tex_ref}
    if isinstance(out.get("behavior"), str):
        b_str = out["behavior"].lower()
        out["behavior"] = {"kind": "patrol_ring" if "patrol" in b_str else ("orbit_and_perch" if "perch" in b_str else ("orbit_target" if "orbit" in b_str else "none"))}

    if "procedural_assembly" in out and isinstance(out["procedural_assembly"], dict) and not out.get("procedural"):
        out["procedural"] = out.pop("procedural_assembly")
    if "assembly" in out and isinstance(out["assembly"], dict) and not out.get("procedural"):
        out["procedural"] = out.pop("assembly")
    if "parts" in out and isinstance(out["parts"], list) and not out.get("procedural"):
        out["procedural"] = {"description": str(out.get("name") or out.get("id") or "assembly"), "parts": out.pop("parts")}

    carrier = out.get("carrier")
    if carrier not in ("parametric_assembly", "procedural_assembly", "implicit_sdf", "articulated_agent"):
        if out.get("procedural"):
            carrier = "procedural_assembly"
        elif out.get("implicit_sdf"):
            carrier = "implicit_sdf"
        elif out.get("agent"):
            carrier = "articulated_agent"
        else:
            carrier = "parametric_assembly"
        out["carrier"] = carrier

    valid_cols = {"architecture", "landmarks", "nature", "vehicles", "agents", "props", "lighting", "structures", "characters"}
    if out.get("collection") not in valid_cols:
        if carrier == "articulated_agent":
            out["collection"] = "characters" if (out.get("agent") or {}).get("rig_kind") == "human_character" else "agents"
        elif carrier == "procedural_assembly":
            out["collection"] = "structures"
        elif carrier == "implicit_sdf":
            out["collection"] = "landmarks"
        else:
            out["collection"] = "props"

    pos = out.get("position")
    if not isinstance(pos, list) or len(pos) != 3:
        out["position"] = [0.0, 0.0, 0.0]
    else:
        out["position"] = [float(pos[0]), float(pos[1]), float(pos[2])]

    if "scale" in out:
        try:
            out["scale"] = max(0.2, min(4.0, float(out["scale"])))
        except Exception:
            out["scale"] = 1.0

    if isinstance(out.get("parametric"), dict):
        p = dict(out["parametric"])
        valid_kinds = {
            "building", "tower", "fountain", "tree", "archway", "bridge", "lamp_post",
            "market_stall", "bench", "gazebo", "windmill", "lighthouse", "scooter", "car", "boat",
        }
        if p.get("kind") not in valid_kinds:
            p["kind"] = "building"
        if p.get("roof_style") not in ("gable", "hip", "cone", "dome", "flat"):
            p["roof_style"] = "gable"
        if p.get("tree_style") not in ("oak", "pine", "cypress", "blossom", "palm"):
            p["tree_style"] = "oak"
        for fk, lo, hi in (("width", 0.4, 18.0), ("height", 0.4, 24.0), ("depth", 0.4, 18.0)):
            if fk in p:
                p[fk] = max(lo, min(hi, float(p[fk])))
        if "floors" in p:
            p["floors"] = max(1, min(6, int(p["floors"])))
        out["parametric"] = p

    if isinstance(out.get("procedural"), dict):
        out["procedural"] = _sanitize_procedural_dict(out["procedural"])

    if isinstance(out.get("agent"), dict):
        ag = dict(out["agent"])
        valid_rigs = {"bird_flock", "fox", "scooter_rider", "boat_cruiser", "floating_lanterns", "human_character"}
        if ag.get("rig_kind") not in valid_rigs:
            ag["rig_kind"] = "human_character" if ag.get("role") else "bird_flock"
        if "count" in ag:
            ag["count"] = max(1, min(14, int(ag["count"])))
        if "entity_scale" in ag:
            ag["entity_scale"] = max(0.3, min(3.0, float(ag["entity_scale"])))
        if ag.get("role") not in (None, "bride", "groom", "officiant", "guest", "villager"):
            ag["role"] = "guest"
        if ag.get("garment_style") not in (None, "gown_aline", "gown_sheath", "tuxedo", "suit", "dress_cocktail", "robe", "casual"):
            ag["garment_style"] = "suit"
        out["agent"] = ag

    if isinstance(out.get("behavior"), dict):
        b = dict(out["behavior"])
        valid_beh = {
            "none", "orbit_target", "orbit_and_perch", "patrol_ring", "patrol_waypoints",
            "walk_path", "stand_and_face", "sway_wind", "rotate_continuous", "bob_water",
        }
        if b.get("kind") not in valid_beh:
            b["kind"] = "none"
        if "orbit_radius" in b and b["orbit_radius"] is not None:
            b["orbit_radius"] = max(1.2, min(28.0, float(b["orbit_radius"])))
        if "orbit_height" in b and b["orbit_height"] is not None:
            b["orbit_height"] = max(0.5, min(20.0, float(b["orbit_height"])))
        if "speed" in b and b["speed"] is not None:
            b["speed"] = max(0.05, min(4.0, float(b["speed"])))
        if "duration_s" in b and b["duration_s"] is not None:
            b["duration_s"] = max(0.5, min(120.0, float(b["duration_s"])))
        out["behavior"] = b

    if isinstance(out.get("implicit_sdf"), dict):
        out["implicit_sdf"] = _sanitize_sdf_spec_dict(out["implicit_sdf"])

    return out


def _default_cameras_for_world(world: WorldState) -> list[CameraTrack]:
    """Enclosure-aware fallback cinematic shots decoupled from scene content."""
    enc = world.terrain.enclosure
    is_interior = enc in ("space_bridge", "sci_fi_corridor", "interior_room", "cathedral_hall")
    if is_interior:
        W, H, D = world.terrain.enclosure_size
        hw, hd, ch = W * 0.34, D * 0.36, min(H - 1.2, max(3.2, H * 0.58))
        return [
            CameraTrack(
                id="hero_dolly", name="Interior Tracking Dolly", kind="spline", duration_s=10.0,
                keyframes=[
                    CameraKeyframe(t=0.0, pos=[hw * 0.5, 1.9, hd], look_at=[0.0, 1.6, -hd * 0.7], fov_deg=50.0),
                    CameraKeyframe(t=5.0, pos=[0.0, 1.85, hd * 0.3], look_at=[0.0, 1.6, -hd * 0.9], fov_deg=46.0),
                    CameraKeyframe(t=10.0, pos=[-hw * 0.5, 2.0, -hd * 0.1], look_at=[0.0, 1.7, -hd], fov_deg=48.0),
                ],
            ),
            CameraTrack(
                id="reverse_sweep", name="180° Reverse Interior Shot", kind="spline", duration_s=10.0,
                keyframes=[
                    CameraKeyframe(t=0.0, pos=[-hw * 0.6, 2.2, -hd * 0.75], look_at=[0.0, 1.5, hd * 0.4], fov_deg=50.0),
                    CameraKeyframe(t=10.0, pos=[hw * 0.6, 2.6, -hd * 0.65], look_at=[0.0, 1.5, hd * 0.4], fov_deg=48.0),
                ],
            ),
            CameraTrack(
                id="high_corner", name="High Corner Crane", kind="spline", duration_s=10.0,
                keyframes=[
                    CameraKeyframe(t=0.0, pos=[hw, ch, hd * 0.85], look_at=[0.0, 1.4, -hd * 0.3], fov_deg=52.0),
                    CameraKeyframe(t=10.0, pos=[-hw, ch, hd * 0.85], look_at=[0.0, 1.4, -hd * 0.3], fov_deg=52.0),
                ],
            ),
        ]

    sp = world.camera_spawn or [0.0, 3.8, 18.0]
    lk = world.camera_look_at or [0.0, 2.0, -1.0]
    hero = next((o for o in world.objects if o.visible and o.carrier in ("procedural_assembly", "implicit_sdf")), None)
    hero_id = hero.id if hero else (world.objects[0].id if world.objects else None)
    return [
        CameraTrack(
            id="hero_dolly", name="Establishing Dolly", kind="spline", duration_s=12.0,
            keyframes=[
                CameraKeyframe(t=0.0, pos=[sp[0] - 6.0, max(2.2, sp[1]), sp[2]], look_at=lk, fov_deg=48.0),
                CameraKeyframe(t=6.0, pos=[0.0, 2.4, max(6.0, sp[2] * 0.65)], look_at=lk, fov_deg=44.0),
                CameraKeyframe(t=12.0, pos=[sp[0] + 6.5, 3.0, sp[2] * 0.75], look_at=lk, fov_deg=46.0),
            ],
        ),
        CameraTrack(
            id="aerial_crane", name="Aerial Crane Sweep", kind="spline", duration_s=12.0,
            keyframes=[
                CameraKeyframe(t=0.0, pos=[16.0, 11.5, 16.0], look_at=[0.0, 2.0, 0.0], fov_deg=50.0),
                CameraKeyframe(t=6.0, pos=[18.0, 9.5, -5.0], look_at=[0.0, 2.0, 0.0], fov_deg=48.0),
                CameraKeyframe(t=12.0, pos=[-14.0, 10.5, -16.0], look_at=[0.0, 2.2, 0.0], fov_deg=50.0),
            ],
        ),
        CameraTrack(
            id="hero_orbit", name="Hero Orbit", kind="orbit_entity", duration_s=12.0,
            look_at_id=hero_id, orbit_radius=7.5, orbit_height=3.0,
        ),
    ]


# ---------------------------------------------------------------------------
# Stage 0: Intent-Driven General World Scaffold Director (Gemini 3.5 Flash Lite)
# ---------------------------------------------------------------------------

def generate_world_scaffold(user_prompt: str) -> tuple[WorldScaffoldManifest, float]:
    """Analyze the user's ACTUAL prompt (interior, forest, wedding, city, sci-fi, landscape, etc.)
    and emit an authentic, non-templated spatial manifest in ~1.5-2.5 s."""
    client = _get_client()
    system = (
        "You are the Intent-Driven 3D World Director for a general-purpose cinematic 3D engine.\n"
        "DO NOT default to a Mediterranean village or circular plaza unless the prompt explicitly asks for a village plaza!\n"
        "Choose the EXACT ground_kind, enclosure, scene_layout, textures, anchors, and camera framing required by the user's prompt!\n\n"
        "Output ONLY valid compact JSON matching:\n"
        "{\"title\":str,\"summary\":str,\"scene_layout\":str,"
        "\"terrain\":{\"size\":72,\"style\":\"cobblestone_plaza|meadow_hills|coastal_harbor|snowy_valley|desert_oasis|forest_clearing|interior_deck|stone_hall\","
        "\"ground_kind\":\"outdoor_hills|flat_floor|forest_floor|water_surface|interior_deck|none\","
        "\"enclosure\":\"open_sky|interior_room|sci_fi_corridor|space_bridge|forest_canopy|cathedral_hall\","
        "\"enclosure_size\":[W,H,D],\"enclosure_color\":\"#hex\",\"enclosure_accent\":\"#hex\",\"space_stars\":bool,"
        "\"ground_color\":\"#hex\",\"hill_color\":\"#hex\",\"plaza_radius\":0.0,\"hill_height\":0.0,"
        "\"has_water\":bool,\"water_level\":-0.3,\"water_color\":\"#hex\",\"texture_id\":\"floor_pbr\",\"hill_texture_id\":null},"
        "\"atmosphere\":{\"time_of_day\":\"morning|noon|golden_hour|dusk|night\",\"sky_zenith\":\"#hex\",\"sky_horizon\":\"#hex\","
        "\"sun_color\":\"#hex\",\"sun_intensity\":2.6,\"sun_elevation_deg\":30,\"sun_azimuth_deg\":45,\"fog_color\":\"#hex\","
        "\"fog_density\":0.008,\"ambient_intensity\":0.75,\"cloud_count\":6,\"wind_strength\":0.4},"
        "\"texture_requests\":[{\"id\":\"snake_id\",\"prompt\":\"prompt-authentic seamless PBR surface\"}],"
        "\"anchors\":[{\"id\":\"snake_id\",\"name\":str,\"role\":\"hero_procedural|hero_sdf|structure|environment|character|agent\",\"position\":[x,0,z],\"radius\":2.2,\"brief\":\"detailed visual & functional spec\"}],"
        "\"camera_spawn\":[x,y,z],\"camera_look_at\":[x,y,z]}\n\n"
        "CRITICAL ENVIRONMENT MATCHING RULES:\n"
        "- SPACESHIP / SCI-FI INTERIOR: ground_kind='interior_deck', enclosure='space_bridge' (or 'sci_fi_corridor'), enclosure_size=[20,7.5,24], space_stars=true, plaza_radius=0, hill_height=0, style='interior_deck', cloud_count=0! "
        "Place ALL anchors STRICTLY INSIDE x in [-8.5, 8.5], z in [-9.5, 9.0]! Camera inside bridge e.g. [0, 2.3, 8.5] looking at [0, 1.7, -7.0]. "
        "Textures: brushed dark titanium deck, sci-fi hull paneling, metallic grating. Anchors: holographic_command_table, captain_chair, helm_console_left, helm_console_right, warp_core_pillar, tactical_wall_displays, bridge crew characters!\n"
        "- DENSE FOREST / WOODS / JUNGLE: ground_kind='forest_floor', enclosure='forest_canopy', plaza_radius=0, hill_height=2.2, style='forest_clearing', fog_density=0.016! "
        "NO buildings, NO cobblestones, NO lampposts! Textures: mossy forest earth, ancient furrowed tree bark, damp moss granite. Anchors: towering ancient_mother_tree, mossy_fallen_log, granite_boulder_outcrop, fern_hollow, glowing_mushroom_ring, woodland stream/brook if mentioned, forest wildlife!\n"
        "- WEDDING CEREMONY: ground_kind='flat_floor' (or 'outdoor_hills' for garden), enclosure='open_sky' (or 'cathedral_hall' if indoor!), style='meadow_hills' or 'stone_hall', plaza_radius=0 or 12! "
        "Organize linearly along a CEREMONY AISLE (Z axis): floral_wedding_arch at (0,0,-8), aisle_runner along z=-6..6, ceremony guest pew rows flanking x=-4 and x=+4, floral_altar_pedestals, reception/cake_gazebo, AND role='character' anchors for bride (walking aisle), groom (waiting under arch), officiant, and wedding guests!\n"
        "- Emit 3 to 4 prompt-specific texture_requests (only materials that genuinely exist in THIS scene!) and 8 to 11 well-spaced anchors!"
    )
    t0 = time.perf_counter()
    resp = client.models.generate_content(
        model=FLASH_LITE_MODEL,
        contents=f"Design the authentic 3D environment & spatial manifest for:\n{user_prompt}",
        config=types.GenerateContentConfig(
            system_instruction=system,
            response_mime_type="application/json",
        ),
    )
    raw = _extract_json_text(resp.text or "")
    manifest = WorldScaffoldManifest.model_validate_json(raw)
    ms = (time.perf_counter() - t0) * 1000.0
    return manifest, ms


# ---------------------------------------------------------------------------
# Parallel Cloud Workers (100% Prompt-Driven via Procedural Assembly Grammar!)
# ---------------------------------------------------------------------------

PROCEDURAL_GRAMMAR_BRIEF = (
    "COMPOSABLE 3D PART-TREE GRAMMAR (`carrier`: \"procedural_assembly\"):\n"
    "Compose rich, recognizable multi-part 3D objects from 5..20 parts in local meters (bottom resting on y=0):\n"
    "  `shapes`: 'box' [w,h,d], 'cylinder' [rTop,rBot,h], 'cone' [r,h,1], 'sphere' [rx,ry,rz], 'capsule' [r,len,1], "
    "'torus' [R,tube,arc_deg], 'arch_segment' [innerR,outerR,depth], 'plane' [w,h,1], 'ring' [innerR,outerR,1], 'icosahedron' [rx,ry,rz], 'dodecahedron' [rx,ry,rz].\n"
    "  Per-part options: `pos:[x,y,z]`, `rot_deg:[rx,ry,rz]`, `size:[a,b,c]`, `color:'#hex'`, `roughness`, `metalness`, "
    "`emissive:'#hex'`, `emissive_intensity:0..5`, `opacity:0.05..1.0` (<1 for glass/holograms/water/silk!), `texture_id`, "
    "`mirror_x:bool` (bilateral symmetry!), `repeat_count:1..16`, `repeat_offset:[dx,dy,dz]` (rows of chairs/pews/ribs/panels!), "
    "`repeat_rot_y_deg` (radial arrays for flower petals/fern fronds/hologram rings!), `anim:'none|spin_y|spin_z|bob_y|pulse_emissive|sway'`.\n"
    "  Optional attached real PointLight: `light_color`, `light_intensity`, `light_pos`, `light_distance`, `contact_ao_radius`.\n"
)


def _clamp_inside_enclosure(pos: list[float], manifest: WorldScaffoldManifest) -> list[float]:
    enc = manifest.terrain.enclosure
    if enc in ("space_bridge", "sci_fi_corridor", "interior_room", "cathedral_hall"):
        W, _, D = manifest.terrain.enclosure_size
        hw, hd = W * 0.42, D * 0.42
        return [
            round(max(-hw, min(hw, float(pos[0]))), 2),
            max(0.0, float(pos[1])),
            round(max(-hd, min(hd, float(pos[2]))), 2),
        ]
    return [float(pos[0]), float(pos[1]), float(pos[2])]


def _worker_carbon_heroes(
    user_prompt: str,
    manifest: WorldScaffoldManifest,
    coord: WorldCoordinator,
    wdir: pathlib.Path,
    asset_url_fn,
    costs: WorldCosts,
    timings: WorldTimings,
    region_id: str | None = None,
) -> None:
    """Gemini 4 Carbon Worker 1: Authors Hero Focal 3D Assemblies (`procedural_assembly` and optional `implicit_sdf`)."""
    client = _get_client()
    hero_anchors = [a.model_dump() for a in manifest.anchors if a.role in ("hero_procedural", "hero_sdf")]
    if not hero_anchors:
        hero_anchors = [a.model_dump() for a in manifest.anchors[:3]]
    tex_ids = [t.id for t in manifest.texture_requests]

    system = (
        "You are Gemini 4 Carbon, a General-Purpose 3D Hero Assembly & Sculpture Compiler.\n"
        "Stream ONE compact valid JSON WorldObject per line (NDJSON, NO array wrapper, NO markdown) for each hero anchor.\n"
        f"{PROCEDURAL_GRAMMAR_BRIEF}\n"
        "For role='hero_procedural': use `carrier:'procedural_assembly'` with `procedural:{description, parts:[...], light_color, light_intensity, light_pos, contact_ao_radius}` — craft intricate, unmistakable 3D geometry (e.g. holographic tactical table with glowing spinning rings & floating planet; rose-covered wedding ceremony arch with draped fabric & clustered blooms; gnarled ancient mother tree with buttress roots, twisted boughs & layered canopy)!\n"
        "For role='hero_sdf': use `carrier:'implicit_sdf'` with 6..12 smooth_union primitives (k in [0.08, 0.30]).\n"
        "Output schema per line:\n"
        "{\"id\":str,\"name\":str,\"collection\":\"landmarks|structures|nature\",\"carrier\":\"procedural_assembly|implicit_sdf\","
        "\"position\":[x,0,z],\"rotation_y_deg\":deg,\"scale\":1.0,"
        "\"material\":{\"color\":\"#hex\",\"secondary_color\":\"#hex\",\"accent_color\":\"#hex\",\"roughness\":0.5,\"metalness\":0.2,\"texture_id\":str|null},"
        "\"procedural\":{...} | null, \"implicit_sdf\":{...} | null}\n"
        "Match the exact anchor `id` and `position`! NEVER invent village cottages or statues unrelated to the prompt."
    )
    prompt = (
        f"Prompt: {user_prompt}\n"
        f"Scene layout: {manifest.scene_layout} | Enclosure: {manifest.terrain.enclosure} {manifest.terrain.enclosure_size}\n"
        f"Available texture IDs: {tex_ids}\n"
        f"Hero anchors to build:\n{json.dumps(hero_anchors, separators=(',', ':'))}"
    )
    t0 = time.perf_counter()
    try:
        stream = client.models.generate_content_stream(
            model=CARBON_MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=system,
                thinking_config=types.ThinkingConfig(thinking_budget=0),
            ),
        )
        for raw_obj in _iter_stream_json_objects(stream):
            try:
                clean = _sanitize_world_object_dict(raw_obj)
                clean["position"] = _clamp_inside_enclosure(clean["position"], manifest)
                obj = WorldObject.model_validate(clean)
                if obj.carrier == "implicit_sdf" and obj.implicit_sdf is not None:
                    fname = f"sdf_{obj.id}_v1_{uuid.uuid4().hex[:5]}.json"
                    payload, sdf_ms = compile_sdf_mesh(obj.implicit_sdf, wdir / fname)
                    obj.implicit_sdf.mesh_url = asset_url_fn(fname)
                    obj.implicit_sdf.vertex_count = payload["vertex_count"]
                    obj.implicit_sdf.face_count = payload["face_count"]
                    costs.sdf_meshes_compiled += 1
                    timings.sdf_compile_ms = round(timings.sdf_compile_ms + sdf_ms, 1)
                elif obj.carrier == "procedural_assembly" and not obj.procedural:
                    continue
                coord.commit_op(
                    domain="object",
                    action="upsert",
                    target_id=obj.id,
                    payload=obj.model_dump(),
                    phase="geometry",
                    worker="carbon_heroes",
                    resolve_collisions=True,
                    region_id=region_id,
                )
            except Exception as exc:
                print(f"[WARN] carbon_heroes dropped invalid obj: {exc}")
        costs.carbon_calls += 1
        timings.carbon_ms = max(timings.carbon_ms, round((time.perf_counter() - t0) * 1000.0, 1))
    except Exception as exc:
        print(f"[WARN] carbon_heroes worker failed: {exc}")


def _worker_carbon_structures(
    user_prompt: str,
    manifest: WorldScaffoldManifest,
    coord: WorldCoordinator,
    costs: WorldCosts,
    timings: WorldTimings,
    region_id: str | None = None,
) -> None:
    """Gemini 4 Carbon Worker 2: Authors Spatial Framing & Secondary Functional Structures strictly matching the prompt."""
    client = _get_client()
    struct_anchors = [a.model_dump() for a in manifest.anchors if a.role == "structure"]
    tex_ids = [t.id for t in manifest.texture_requests]

    system = (
        "You are Gemini 4 Carbon, the 3D Spatial Structures & Framing Compiler.\n"
        "Stream 4 to 7 compact valid JSON WorldObjects (NDJSON, one per line, NO array wrapper, NO markdown) matching the user's EXACT scene!\n"
        f"{PROCEDURAL_GRAMMAR_BRIEF}\n"
        "PREFER `carrier:'procedural_assembly'` to build authentic scene-specific structures (e.g., curved starship helm consoles with glowing screens, captain chair, cryo pods, ribbed wall servers; wedding aisle pew rows using repeat_count=5, silk floral aisle runner, tiered wedding cake table; towering gnarled ancient forest trees, mossy fallen logs, granite rock outcrops).\n"
        "EXACT JSON LINE FORMAT:\n"
        "{\"id\":str,\"name\":str,\"collection\":\"structures|landmarks|nature\",\"carrier\":\"procedural_assembly\","
        "\"position\":[x,0,z],\"rotation_y_deg\":deg,\"scale\":1.0,"
        "\"material\":{\"color\":\"#hex\",\"secondary_color\":\"#hex\",\"roughness\":0.5,\"metalness\":0.3,\"texture_id\":str|null},"
        "\"procedural\":{\"description\":str,\"parts\":[{\"shape\":\"box|cylinder|cone|sphere|capsule|torus|arch_segment|plane|ring|icosahedron|dodecahedron\",\"pos\":[x,y,z],\"rot_deg\":[rx,ry,rz],\"size\":[a,b,c],\"color\":\"#hex\",\"emissive\":null,\"emissive_intensity\":0,\"opacity\":1.0,\"mirror_x\":false,\"repeat_count\":1,\"repeat_offset\":[0,0,0],\"repeat_rot_y_deg\":0,\"anim\":\"none\"}],\"light_color\":null,\"light_intensity\":0,\"contact_ao_radius\":1.4}}\n"
        "ONLY use optional `carrier:'parametric_assembly'` (`building|tower|fountain|tree|archway|bridge|gazebo|windmill|lighthouse|bench|market_stall|lamp_post`) if those specific architectural/natural items genuinely belong in THIS prompt (NEVER place buildings or lampposts in a spaceship or primeval forest!).\n"
        "Keep every object strictly inside enclosure_size if enclosed! Match anchor IDs & positions where provided."
    )
    prompt = (
        f"Prompt: {user_prompt}\n"
        f"Scene layout: {manifest.scene_layout} | Enclosure: {manifest.terrain.enclosure} {manifest.terrain.enclosure_size}\n"
        f"Available texture IDs: {tex_ids}\n"
        f"Structure anchors:\n{json.dumps(struct_anchors, separators=(',', ':'))}\n"
        f"All anchors (avoid overlaps):\n{json.dumps([{'id': a.id, 'pos': a.position, 'r': a.radius} for a in manifest.anchors], separators=(',', ':'))}"
    )
    t0 = time.perf_counter()
    try:
        stream = client.models.generate_content_stream(
            model=CARBON_MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=system,
                thinking_config=types.ThinkingConfig(thinking_budget=0),
            ),
        )
        for raw_obj in _iter_stream_json_objects(stream):
            try:
                clean = _sanitize_world_object_dict(raw_obj)
                clean["position"] = _clamp_inside_enclosure(clean["position"], manifest)
                obj = WorldObject.model_validate(clean)
                if obj.carrier == "procedural_assembly" and not obj.procedural:
                    continue
                coord.commit_op(
                    domain="object",
                    action="upsert",
                    target_id=obj.id,
                    payload=obj.model_dump(),
                    phase="geometry",
                    worker="carbon_structures",
                    resolve_collisions=True,
                    region_id=region_id,
                )
            except Exception as exc:
                print(f"[WARN] carbon_structures dropped invalid obj: {exc}")
        costs.carbon_calls += 1
        timings.carbon_ms = max(timings.carbon_ms, round((time.perf_counter() - t0) * 1000.0, 1))
    except Exception as exc:
        print(f"[WARN] carbon_structures worker failed: {exc}")


def _worker_hydrogen_environment(
    user_prompt: str,
    manifest: WorldScaffoldManifest,
    coord: WorldCoordinator,
    costs: WorldCosts,
    timings: WorldTimings,
    region_id: str | None = None,
) -> None:
    """Gemini 4 Hydrogen Worker 3: Streams Scene-Specific Environment Detail, Foliage/Props & Accent Lighting."""
    client = _get_client()
    env_anchors = [a.model_dump() for a in manifest.anchors if a.role == "environment"]
    avoid = [{"id": a.id, "pos": a.position, "r": a.radius} for a in manifest.anchors]
    tex_ids = [t.id for t in manifest.texture_requests]

    system = (
        "You are Gemini 4 Hydrogen, the 3D Environment Detail & Props Compiler.\n"
        "Stream 6 to 9 compact valid JSON WorldObjects (NDJSON, one per line, NO array wrapper, NO markdown) that make the scene rich and authentic to the prompt!\n"
        f"{PROCEDURAL_GRAMMAR_BRIEF}\n"
        "EXACT JSON LINE FORMAT (use `procedural` key for procedural_assembly OR `parametric` key for parametric_assembly):\n"
        "{\"id\":str,\"name\":str,\"collection\":\"props|nature|lighting|structures\",\"carrier\":\"procedural_assembly\","
        "\"position\":[x,0,z],\"rotation_y_deg\":deg,\"scale\":1.0,\"material\":{\"color\":\"#hex\",\"roughness\":0.6,\"metalness\":0.2},"
        "\"procedural\":{\"description\":str,\"parts\":[{\"shape\":\"box|cylinder|cone|sphere|capsule|torus|arch_segment|plane|ring|icosahedron|dodecahedron\",\"pos\":[x,y,z],\"rot_deg\":[rx,ry,rz],\"size\":[a,b,c],\"color\":\"#hex\",\"emissive\":null,\"emissive_intensity\":0,\"opacity\":1.0,\"mirror_x\":false,\"repeat_count\":1,\"repeat_offset\":[0,0,0],\"repeat_rot_y_deg\":0,\"anim\":\"none\"}],\"light_color\":null,\"light_intensity\":0,\"contact_ao_radius\":1.0}}\n"
        "STRICT AUTHENTICITY RULES:\n"
        "- If SPACESHIP / SCI-FI INTERIOR: emit glowing vertical status pillars, auxiliary engineering stations, holo-display projectors, deck cargo crates, wall energy conduits (`carrier:'procedural_assembly'`) strictly inside enclosure_size! ZERO trees, ZERO lampposts, ZERO benches!\n"
        "- If DENSE FOREST: emit dense multi-scale towering trees (mix of `parametric_assembly` kind='tree' with oak/pine AND bespoke `procedural_assembly` ferns with repeat_rot_y_deg=45, mossy boulders, glowing mushroom clusters, fallen branches) distributed organically across the forest floor! ZERO buildings, ZERO lampposts!\n"
        "- If WEDDING CEREMONY: emit floral urn pedestals flanking the aisle, string fairy-light poles/garlands (warm emissive glow + PointLight), reception/gift tables, flower petal clusters, and garden blossom/cypress trees!\n"
        "- For ANY other prompt: craft domain-authentic `procedural_assembly` objects!"
    )
    prompt = (
        f"Prompt: {user_prompt}\n"
        f"Scene layout: {manifest.scene_layout} | Enclosure: {manifest.terrain.enclosure} {manifest.terrain.enclosure_size}\n"
        f"Available texture IDs: {tex_ids}\n"
        f"Environment anchors:\n{json.dumps(env_anchors, separators=(',', ':'))}\n"
        f"Occupied anchors to avoid:\n{json.dumps(avoid, separators=(',', ':'))}"
    )
    t0 = time.perf_counter()
    try:
        stream = client.models.generate_content_stream(
            model=HYDROGEN_MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=system,
                thinking_config=types.ThinkingConfig(thinking_budget=0),
            ),
        )
        for raw_obj in _iter_stream_json_objects(stream):
            try:
                clean = _sanitize_world_object_dict(raw_obj)
                clean["position"] = _clamp_inside_enclosure(clean["position"], manifest)
                obj = WorldObject.model_validate(clean)
                if obj.carrier == "procedural_assembly" and not obj.procedural:
                    continue
                coord.commit_op(
                    domain="object",
                    action="upsert",
                    target_id=obj.id,
                    payload=obj.model_dump(),
                    phase="geometry",
                    worker="hydrogen_environment",
                    resolve_collisions=True,
                    region_id=region_id,
                )
            except Exception as exc:
                print(f"[WARN] hydrogen_environment dropped invalid obj: {exc}")
        costs.hydrogen_calls += 1
        timings.hydrogen_ms = max(timings.hydrogen_ms, round((time.perf_counter() - t0) * 1000.0, 1))
    except Exception as exc:
        print(f"[WARN] hydrogen_environment worker failed: {exc}")


def _worker_hydrogen_characters_and_cameras(
    user_prompt: str,
    manifest: WorldScaffoldManifest,
    coord: WorldCoordinator,
    costs: WorldCosts,
    timings: WorldTimings,
    region_id: str | None = None,
) -> None:
    """Gemini 4 Hydrogen Worker 4: Streams Human Characters + Coordinated Performances + Wildlife (when relevant) + Independent CameraTracks."""
    client = _get_client()
    anchors = [a.model_dump() for a in manifest.anchors]
    enc = manifest.terrain.enclosure
    is_interior = enc in ("space_bridge", "sci_fi_corridor", "interior_room", "cathedral_hall")

    system = (
        "You are Gemini 4 Hydrogen, the 3D Characters, Performances & Cinematography Director.\n"
        "Stream ONE compact JSON item per line (NDJSON, NO array wrapper, NO markdown):\n"
        "1) HUMAN CHARACTERS & COORDINATED PERFORMANCES (`\"kind_type\":\"agent\"`, `carrier:\"articulated_agent\"`, `agent.rig_kind:\"human_character\"`):\n"
        "   - Prioritize rich human characters whenever the prompt depicts people (e.g. Wedding: bride with garment_style='gown_aline', has_veil=true, has_bouquet=true, behavior.kind='walk_path' with waypoints_xz walking down the aisle toward groom; groom with garment_style='tuxedo' & behavior.kind='stand_and_face' target_id='bride'; officiant; 4 guests lining the aisle with behavior.kind='stand_and_face' target_id='bride'!).\n"
        "   - For a spaceship bridge: emit 2-3 bridge crew officers (`rig_kind:'human_character'`, `garment_style:'suit'`, dark navy/silver uniforms) positioned at helm/command consoles facing forward!\n"
        "   - For a dense forest: emit authentic forest wildlife (`fox` patrolling forest path, `bird_flock` circling canopy) — NO random scooters or boats!\n"
        "   - NEVER put birds, foxes, or scooters inside an indoor spaceship bridge!\n"
        "   Agent schema:\n"
        "   {\"kind_type\":\"agent\",\"id\":str,\"name\":str,\"collection\":\"characters|agents\",\"carrier\":\"articulated_agent\","
        "\"position\":[x,0,z],\"rotation_y_deg\":deg,\"scale\":1.0,"
        "\"material\":{\"color\":\"#hex\",\"secondary_color\":\"#hex\",\"accent_color\":\"#hex\",\"roughness\":0.55,\"metalness\":0.05},"
        "\"agent\":{\"rig_kind\":\"human_character|bird_flock|fox|scooter_rider|boat_cruiser|floating_lanterns\",\"count\":1,\"entity_scale\":1.0,"
        "\"role\":\"bride|groom|officiant|guest|villager|null\",\"garment_style\":\"gown_aline|gown_sheath|tuxedo|suit|dress_cocktail|robe|casual|null\","
        "\"hair_color\":\"#hex\",\"skin_tone\":\"#hex\",\"has_veil\":bool,\"has_bouquet\":bool,\"appearance_prompt\":\"concise visual portrait spec\"},"
        "\"behavior\":{\"kind\":\"walk_path|stand_and_face|orbit_target|orbit_and_perch|patrol_ring|none\",\"target_id\":str|null,\"orbit_radius\":6.0,\"orbit_height\":6.0,\"speed\":0.7,\"waypoints_xz\":[[x1,z1],[x2,z2]],\"duration_s\":6.0}}\n"
        "2) INDEPENDENT CINEMATIC CAMERA TRACKS (`\"kind_type\":\"camera\"`, emit 3 distinct shots):\n"
        "   {\"kind_type\":\"camera\",\"id\":str,\"name\":str,\"kind\":\"spline|orbit_entity\",\"duration_s\":10.0,"
        "\"keyframes\":[{\"t\":0,\"pos\":[x,y,z],\"look_at\":[lx,ly,lz],\"fov_deg\":46},{\"t\":5,\"pos\":[...],\"look_at\":[...],\"fov_deg\":44},{\"t\":10,\"pos\":[...],\"look_at\":[...],\"fov_deg\":46}],"
        "\"look_at_id\":null,\"orbit_radius\":7.5,\"orbit_height\":3.0}\n"
        + ("CRITICAL: This is an ENCLOSED INTERIOR (" + str(manifest.terrain.enclosure_size) + ") — keep ALL character positions and ALL camera keyframe positions STRICTLY INSIDE the interior bounds!\n" if is_interior else "")
    )
    prompt = (
        f"Prompt: {user_prompt}\n"
        f"Scene layout: {manifest.scene_layout} | Enclosure: {enc} {manifest.terrain.enclosure_size}\n"
        f"Anchors:\n{json.dumps(anchors, separators=(',', ':'))}"
    )
    t0 = time.perf_counter()
    try:
        stream = client.models.generate_content_stream(
            model=HYDROGEN_MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=system,
                thinking_config=types.ThinkingConfig(thinking_budget=0),
            ),
        )
        for raw_item in _iter_stream_json_objects(stream):
            kt = raw_item.pop("kind_type", None)
            if kt == "camera" or ("keyframes" in raw_item and "carrier" not in raw_item):
                try:
                    if is_interior and isinstance(raw_item.get("keyframes"), list):
                        W, H, D = manifest.terrain.enclosure_size
                        for kf in raw_item["keyframes"]:
                            if isinstance(kf.get("pos"), list) and len(kf["pos"]) == 3:
                                kf["pos"] = [
                                    round(max(-W * 0.42, min(W * 0.42, float(kf["pos"][0]))), 2),
                                    round(max(1.2, min(H - 1.0, float(kf["pos"][1]))), 2),
                                    round(max(-D * 0.42, min(D * 0.42, float(kf["pos"][2]))), 2),
                                ]
                    cam = CameraTrack.model_validate(raw_item)
                    coord.commit_op(
                        domain="camera",
                        action="upsert",
                        target_id=cam.id,
                        payload=cam.model_dump(),
                        phase="camera",
                        worker="hydrogen_cameras",
                    )
                except Exception as exc:
                    print(f"[WARN] hydrogen_cameras dropped invalid cam: {exc}")
            else:
                try:
                    clean = _sanitize_world_object_dict(raw_item)
                    clean["carrier"] = "articulated_agent"
                    clean["position"] = _clamp_inside_enclosure(clean["position"], manifest)
                    obj = WorldObject.model_validate(clean)
                    coord.commit_op(
                        domain="object",
                        action="upsert",
                        target_id=obj.id,
                        payload=obj.model_dump(),
                        phase="agent",
                        worker="hydrogen_characters",
                        resolve_collisions=False,
                        region_id=region_id,
                    )
                except Exception as exc:
                    print(f"[WARN] hydrogen_characters dropped invalid agent: {exc}")
        costs.hydrogen_calls += 1
        timings.hydrogen_ms = max(timings.hydrogen_ms, round((time.perf_counter() - t0) * 1000.0, 1))
    except Exception as exc:
        print(f"[WARN] hydrogen_characters_and_cameras worker failed: {exc}")


# ---------------------------------------------------------------------------
# Parallel Two-Stage PBR Texture Worker (Provisional Lite -> Master NB 2.1)
# ---------------------------------------------------------------------------

def _worker_pbr_texture(
    tr: TextureRequest,
    wdir: pathlib.Path,
    asset_url_fn,
    coord: WorldCoordinator,
    costs: WorldCosts,
    timings: WorldTimings,
    *,
    tier: str,
) -> None:
    model = PROVISIONAL_TEXTURE_MODEL if tier == "provisional" else NANO_BANANA_MODEL
    tag = "prov" if tier == "provisional" else "v2"
    size = 384 if tier == "provisional" else 512
    try:
        files, ms = synthesize_pbr_texture(tr.id, tr.prompt, wdir, size=size, model=model, tag=tag)
        if tier == "provisional":
            costs.provisional_texture_calls += 1
        else:
            costs.nano_banana_texture_calls += 1
        timings.nano_banana_ms = max(timings.nano_banana_ms, round(ms, 1))
        tex = PBRTextureAsset(
            id=tr.id,
            prompt=tr.prompt,
            albedo_url=asset_url_fn(files["albedo_name"]),
            normal_url=asset_url_fn(files["normal_name"]),
            roughness_url=asset_url_fn(files["rough_name"]),
            ao_url=asset_url_fn(files["ao_name"]),
            source="flash_lite_provisional" if tier == "provisional" else "nano_banana_pbr",
            tier="provisional" if tier == "provisional" else "refined",
        )
        coord.commit_op(
            domain="texture",
            action="upsert",
            target_id=tex.id,
            payload=tex.model_dump(),
            phase="texture_provisional" if tier == "provisional" else "texture_refined",
            worker=f"tex_{tier}_{tr.id}",
        )
    except Exception as exc:
        print(f"[WARN] Texture worker ({tier}) {tr.id} failed: {exc}")


# ---------------------------------------------------------------------------
# Full Parallel Streamed World Creation Orchestrator
# ---------------------------------------------------------------------------

def run_streamed_world_creation(
    prompt: str,
    coord: WorldCoordinator,
    wdir: pathlib.Path,
    asset_url_fn,
    *,
    enable_provisional_textures: bool = True,
    stream_id: str = "",
) -> tuple[WorldState, WorldTimings, WorldCosts]:
    """Execute full parallel streamed World IR creation, committing validated WorldOps as they arrive."""
    coord.reset_clock()
    t0 = time.perf_counter()
    costs = WorldCosts()
    timings = WorldTimings()

    # 1. Stage 0: Fast Intent-Driven Scaffold (~1.5-2.5 s)
    manifest, fl_ms = generate_world_scaffold(prompt)
    costs.flash_lite_calls += 1
    timings.flash_lite_ms = round(fl_ms, 1)

    coord.commit_op(
        domain="init",
        action="upsert",
        target_id=coord.world.world_id,
        payload={
            "title": manifest.title,
            "terrain": manifest.terrain.model_dump(),
            "atmosphere": manifest.atmosphere.model_dump(),
            "camera_spawn": manifest.camera_spawn,
            "camera_look_at": manifest.camera_look_at,
        },
        phase="scaffold",
        worker="flash_lite_scaffold",
        persist=True,
    )
    timings.time_to_first_visible_ms = round((time.perf_counter() - t0) * 1000.0, 1)

    def _track_milestones() -> None:
        first_obj_ms = next((op.elapsed_ms for op in coord._op_log if op.domain == "object"), 0.0)
        if first_obj_ms > 0 and timings.time_to_first_object_ms == 0:
            timings.time_to_first_object_ms = first_obj_ms

    # 2. Fan out ALL Geometry, Structure, Environment, Characters/Cameras & 2-Stage PBR Workers IN PARALLEL!
    tex_reqs = list(manifest.texture_requests)
    primary_tex_ids = {manifest.terrain.texture_id}

    with concurrent.futures.ThreadPoolExecutor(max_workers=14) as pool:
        geo_futs = [
            pool.submit(_worker_carbon_heroes, prompt, manifest, coord, wdir, asset_url_fn, costs, timings, "r_0_0"),
            pool.submit(_worker_carbon_structures, prompt, manifest, coord, costs, timings, "r_0_0"),
            pool.submit(_worker_hydrogen_environment, prompt, manifest, coord, costs, timings, "r_0_0"),
            pool.submit(_worker_hydrogen_characters_and_cameras, prompt, manifest, coord, costs, timings, "r_0_0"),
        ]

        tex_futs = []
        for idx, tr in enumerate(tex_reqs):
            if enable_provisional_textures and (tr.id in primary_tex_ids or idx < 2):
                tex_futs.append(
                    pool.submit(_worker_pbr_texture, tr, wdir, asset_url_fn, coord, costs, timings, tier="provisional")
                )
            tex_futs.append(
                pool.submit(_worker_pbr_texture, tr, wdir, asset_url_fn, coord, costs, timings, tier="refined")
            )

        concurrent.futures.wait(geo_futs)
        _track_milestones()
        timings.time_to_geometry_complete_ms = round((time.perf_counter() - t0) * 1000.0, 1)

        if not coord.world.cameras:
            for cam in _default_cameras_for_world(coord.world):
                coord.commit_op(
                    domain="camera", action="upsert", target_id=cam.id,
                    payload=cam.model_dump(), phase="camera", worker="coordinator_default_cams",
                )

        if coord._persist_cb:
            coord._persist_cb(coord.world)

        concurrent.futures.wait(tex_futs)
        timings.time_to_refined_ms = round((time.perf_counter() - t0) * 1000.0, 1)

    _track_milestones()
    timings.total_ms = round((time.perf_counter() - t0) * 1000.0, 1)

    with coord._lock:
        w = coord.world
        w.cumulative_costs = WorldCosts(
            flash_lite_calls=w.cumulative_costs.flash_lite_calls + costs.flash_lite_calls,
            carbon_calls=w.cumulative_costs.carbon_calls + costs.carbon_calls,
            hydrogen_calls=w.cumulative_costs.hydrogen_calls + costs.hydrogen_calls,
            nano_banana_texture_calls=w.cumulative_costs.nano_banana_texture_calls + costs.nano_banana_texture_calls,
            provisional_texture_calls=w.cumulative_costs.provisional_texture_calls + costs.provisional_texture_calls,
            sdf_meshes_compiled=w.cumulative_costs.sdf_meshes_compiled + costs.sdf_meshes_compiled,
        )
        w.history.append(
            WorldRevision(
                revision=w.revision,
                action="create_world_stream",
                instruction=prompt,
                carbon_summary=f"[{manifest.scene_layout} / {manifest.terrain.enclosure}] {manifest.summary}",
                changed_object_ids=[o.id for o in w.objects if o.visible],
                unchanged_object_ids=[],
                rebuilt_entire_world=True,
                costs=costs,
                timings=timings,
            )
        )

    coord.commit_op(
        domain="status",
        action="complete",
        target_id=coord.world.world_id,
        payload={
            "stream_id": stream_id,
            "generation_status": "complete",
            "timings": timings.model_dump(),
            "costs": costs.model_dump(),
            "world_summary": {
                "world_id": coord.world.world_id,
                "title": coord.world.title,
                "scene_layout": manifest.scene_layout,
                "enclosure": manifest.terrain.enclosure,
                "object_count": len([o for o in coord.world.objects if o.visible]),
                "texture_count": len(coord.world.textures),
                "camera_count": len(coord.world.cameras),
            },
        },
        phase="complete",
        worker="coordinator",
        persist=True,
    )
    return coord.snapshot(), timings, costs


# ---------------------------------------------------------------------------
# Sub-Second / Fast Surgical Edit + Parallel Background Asset Refinement
# ---------------------------------------------------------------------------

def _compact_world_index(world: WorldState, selected_object_id: str | None) -> str:
    lines = [
        f"title:{world.title}|enc:{world.terrain.enclosure}|tod:{world.atmosphere.time_of_day}|selected:{selected_object_id}|tex:{list(world.textures.keys())}|cams:{[c.id for c in world.cameras]}"
    ]
    for o in world.objects:
        if not o.visible:
            continue
        kind = (
            o.parametric.kind if o.parametric
            else ("proc" if o.procedural else (o.agent.rig_kind if o.agent else "sdf"))
        )
        pos = [round(v, 1) for v in o.position]
        extra = f"|tgt={o.behavior.target_id}" if o.behavior.target_id else ""
        if o.agent and o.agent.role:
            extra += f"|role={o.agent.role}|garm={o.agent.garment_style}"
        lines.append(f"{o.id}|{o.name}|{o.carrier[0]}|{kind}|p={pos}|s={round(o.scale,2)}|c={o.material.color}{extra}")
    return "\n".join(lines)


def compile_fast_edit_patch(
    world: WorldState,
    instruction: str,
    selected_object_id: str | None = None,
) -> tuple[FastEditPatch, float]:
    """Compile natural-language edit into minimal FastEditPatch in ~0.8-1.3 s via Gemini 3.5 Flash Lite."""
    client = _get_client()
    system = (
        "You are an ultra-fast Surgical 3D World Diff Compiler. Output ONLY compact valid JSON matching:\n"
        "{\"action\":\"modify_objects|update_behavior|restyle_material|add_objects|remove_objects|update_atmosphere|update_terrain|update_camera|multi_edit\","
        "\"summary\":\"<=12 words\","
        "\"mutations\":[{\"object_id\":str,\"new_position\"?:[x,0,z],\"new_rotation_y_deg\"?:num,\"new_scale\"?:num,"
        "\"new_material\"?:{\"color\":\"#hex\",\"secondary_color\":\"#hex\",\"accent_color\":\"#hex\",\"roughness\":0.7,\"metalness\":0.05,\"emissive\":\"#000000\",\"emissive_intensity\":0,\"texture_id\":str|null,\"roof_texture_id\":str|null,\"texture_repeat\":2.0},"
        "\"new_behavior\"?:{\"kind\":\"orbit_and_perch|orbit_target|patrol_ring|walk_path|stand_and_face|none\",\"target_id\":str|null,\"orbit_radius\":6.0,\"orbit_height\":5.5,\"speed\":0.7,\"waypoints_xz\":[]}}],"
        "\"new_texture_requests\":[{\"id\":\"snake_id\",\"prompt\":\"seamless tileable PBR surface prompt\"}],"
        "\"add_objects\":[...full WorldObject for simple additions (human_character, agent, or parametric)...],"
        "\"complex_object_briefs\":[{\"id\":\"snake_id\",\"name\":str,\"collection\":\"landmarks|structures|props\",\"carrier\":\"procedural_assembly|implicit_sdf\",\"position\":[x,0,z],\"rotation_y_deg\":0,\"color\":\"#hex\",\"texture_id\":str|null,\"brief\":\"detailed 3D object spec\"}],"
        "\"remove_object_ids\":[str],"
        "\"new_atmosphere\":null,"
        "\"new_terrain\":null,"
        "\"add_cameras\":[{\"id\":str,\"name\":str,\"kind\":\"spline|orbit_entity\",\"duration_s\":12,\"keyframes\":[{\"t\":0,\"pos\":[x,y,z],\"look_at\":[lx,ly,lz],\"fov_deg\":46}],\"look_at_id\":str|null,\"orbit_radius\":9,\"orbit_height\":4}]}\n"
        "STRICT RULES:\n"
        "1. ONLY include fields that actually change! Leave `new_atmosphere: null` and `new_terrain: null` unless user explicitly asks to change lighting/sky/weather/terrain!\n"
        "2. Setting `new_atmosphere.time_of_day` to 'night'/'dusk' automatically lights windows & lampposts.\n"
        "3. For material/dress/color restyling requesting a distinct surface texture (mossy obsidian, emerald silk, zellige mosaic, velvet, lace, etc.): emit 1 entry in `new_texture_requests` AND immediately set `new_material.color/secondary_color/accent_color` for instant provisional feedback PLUS `new_material.texture_id`.\n"
        "4. For adding bespoke 3D objects (statues -> carrier='implicit_sdf'; furniture/consoles/arches/holograms/tables/trees -> carrier='procedural_assembly'), put them in `complex_object_briefs` so parallel Gemini 4 Carbon workers build them concurrently!\n"
        "5. If user asks for a new camera shot/angle/dolly/orbit, emit `action='update_camera'` and populate `add_cameras`.\n"
        "6. If `selected` is set and user refers to 'this'/'it', target `selected`."
    )
    ctx = _compact_world_index(world, selected_object_id)
    t0 = time.perf_counter()
    resp = client.models.generate_content(
        model=FLASH_LITE_MODEL,
        contents=f"World Index:\n{ctx}\n\nUser Edit:\n{instruction}",
        config=types.GenerateContentConfig(
            system_instruction=system,
            response_mime_type="application/json",
        ),
    )
    raw = _extract_json_text(resp.text or "")
    data = json.loads(raw)
    if isinstance(data.get("new_atmosphere"), dict) and not data["new_atmosphere"]:
        data["new_atmosphere"] = None
    if isinstance(data.get("new_terrain"), dict) and not data["new_terrain"]:
        data["new_terrain"] = None
    if isinstance(data.get("add_objects"), list):
        data["add_objects"] = [_sanitize_world_object_dict(o) for o in data["add_objects"] if isinstance(o, dict)]
    if isinstance(data.get("mutations"), list):
        for m in data["mutations"]:
            if isinstance(m, dict) and isinstance(m.get("new_behavior"), dict):
                b = m["new_behavior"]
                if "orbit_radius" in b and b["orbit_radius"] is not None:
                    b["orbit_radius"] = max(1.2, min(28.0, float(b["orbit_radius"])))
                if "orbit_height" in b and b["orbit_height"] is not None:
                    b["orbit_height"] = max(0.5, min(20.0, float(b["orbit_height"])))
                if "speed" in b and b["speed"] is not None:
                    b["speed"] = max(0.05, min(4.0, float(b["speed"])))
    patch = FastEditPatch.model_validate(data)
    ms = (time.perf_counter() - t0) * 1000.0
    return patch, ms


def _worker_carbon_single_complex_edit(
    brief: ComplexObjectBrief,
    world_title: str,
    coord: WorldCoordinator,
    wdir: pathlib.Path,
    asset_url_fn,
    costs: WorldCosts,
    timings: WorldTimings,
) -> None:
    """Dedicated parallel Gemini 4 Carbon worker compiling ONE requested complex 3D object (`procedural_assembly` or `implicit_sdf`)."""
    client = _get_client()
    t0 = time.perf_counter()
    try:
        if brief.carrier == "implicit_sdf":
            system = (
                "You are Gemini 4 Carbon, a 3D Implicit SDF Sculpture Compiler. Output ONLY valid compact JSON:\n"
                "{\"description\":str,\"resolution\":50,\"target_height\":2.5,\"pedestal\":true,"
                "\"primitives\":[{\"op\":\"union|smooth_union|subtract|smooth_subtract\",\"k\":0.16,"
                "\"shape\":\"sphere|ellipsoid|capsule|round_box|torus|cone|cylinder\",\"center\":[x,y,z],\"size\":[sx,sy,sz],\"rot_deg\":[rx,ry,rz],\"mirror_x\":bool}]}\n"
                "Use 6..12 primitives in [-1,1]^3 with k in [0.05, 0.35]."
            )
            resp = client.models.generate_content(
                model=CARBON_MODEL,
                contents=f"World: {world_title}\nSculpt: {brief.name} — {brief.brief}",
                config=types.GenerateContentConfig(
                    system_instruction=system,
                    response_mime_type="application/json",
                    thinking_config=types.ThinkingConfig(thinking_budget=0),
                ),
            )
            costs.carbon_calls += 1
            timings.carbon_ms = max(timings.carbon_ms, round((time.perf_counter() - t0) * 1000.0, 1))
            sdf_spec = ImplicitSDFSpec.model_validate(_sanitize_sdf_spec_dict(json.loads(_extract_json_text(resp.text or ""))))
            fname = f"sdf_{brief.id}_edit_{uuid.uuid4().hex[:5]}.json"
            payload, sdf_ms = compile_sdf_mesh(sdf_spec, wdir / fname)
            sdf_spec.mesh_url = asset_url_fn(fname)
            sdf_spec.vertex_count = payload["vertex_count"]
            sdf_spec.face_count = payload["face_count"]
            costs.sdf_meshes_compiled += 1
            timings.sdf_compile_ms = round(timings.sdf_compile_ms + sdf_ms, 1)

            refined = WorldObject(
                id=brief.id, name=brief.name, collection=brief.collection, carrier="implicit_sdf",
                position=brief.position, rotation_y_deg=brief.rotation_y_deg,
                material=MaterialSpec(color=brief.color, texture_id=brief.texture_id, roughness=0.48, metalness=0.1),
                implicit_sdf=sdf_spec,
            )
        else:
            system = (
                "You are Gemini 4 Carbon, a General-Purpose 3D Part-Tree Assembly Compiler. Output ONLY valid compact JSON matching:\n"
                "{\"description\":str,\"parts\":[{\"shape\":\"box|cylinder|cone|sphere|capsule|torus|arch_segment|plane|ring|icosahedron|dodecahedron\","
                "\"pos\":[x,y,z],\"rot_deg\":[rx,ry,rz],\"size\":[a,b,c],\"color\":\"#hex\",\"roughness\":0.6,\"metalness\":0.2,"
                "\"emissive\":null,\"emissive_intensity\":0,\"opacity\":1.0,\"mirror_x\":false,\"repeat_count\":1,\"repeat_offset\":[0,0,0],\"repeat_rot_y_deg\":0,\"anim\":\"none\"}],"
                "\"light_color\":null,\"light_intensity\":0,\"light_pos\":[0,2,0],\"contact_ao_radius\":1.4}\n"
                "Build 6..18 rich multi-part 3D components resting cleanly on y=0."
            )
            resp = client.models.generate_content(
                model=CARBON_MODEL,
                contents=f"World: {world_title}\nBuild 3D object: {brief.name} — {brief.brief}",
                config=types.GenerateContentConfig(
                    system_instruction=system,
                    response_mime_type="application/json",
                    thinking_config=types.ThinkingConfig(thinking_budget=0),
                ),
            )
            costs.carbon_calls += 1
            timings.carbon_ms = max(timings.carbon_ms, round((time.perf_counter() - t0) * 1000.0, 1))
            proc_spec = ProceduralAssemblySpec.model_validate(_sanitize_procedural_dict(json.loads(_extract_json_text(resp.text or ""))))
            refined = WorldObject(
                id=brief.id, name=brief.name, collection=brief.collection, carrier="procedural_assembly",
                position=brief.position, rotation_y_deg=brief.rotation_y_deg,
                material=MaterialSpec(color=brief.color, texture_id=brief.texture_id),
                procedural=proc_spec,
            )

        coord.commit_op(
            domain="object",
            action="upsert",
            target_id=refined.id,
            payload=refined.model_dump(),
            phase="edit",
            worker=f"carbon_edit_{brief.id}",
        )
    except Exception as exc:
        print(f"[WARN] carbon_edit {brief.id} failed: {exc}")


def run_streamed_edit(
    instruction: str,
    selected_object_id: str | None,
    coord: WorldCoordinator,
    wdir: pathlib.Path,
    asset_url_fn,
    *,
    enable_provisional_textures: bool = True,
    stream_id: str = "",
) -> tuple[WorldState, dict, WorldTimings, WorldCosts]:
    """Two-phase streamed surgical edit:
      Phase 1 (~0.8-1.4 s): Immediate transforms, behaviors, atmosphere, cameras, removals, provisional materials & placeholders!
      Phase 2 (parallel async): PBR texture workers + Carbon procedural/SDF workers hot-upgrading in place!
    """
    t0 = time.perf_counter()
    costs = WorldCosts()
    timings = WorldTimings()

    world_snap = coord.snapshot()
    patch, fl_ms = compile_fast_edit_patch(world_snap, instruction, selected_object_id=selected_object_id)
    costs.flash_lite_calls += 1
    timings.flash_lite_ms = round(fl_ms, 1)

    changed_ids: list[str] = []
    behavior_only_ids: list[str] = []
    removed_ids: list[str] = []
    atmosphere_changed = False
    terrain_changed = False
    camera_ids: list[str] = []
    existing_map = {o.id: o for o in world_snap.objects}

    for mut in patch.mutations:
        target = existing_map.get(mut.object_id)
        if target is None:
            continue
        patch_fields: dict = {}
        geom_changed = False
        if mut.new_position is not None:
            patch_fields["position"] = mut.new_position
        if mut.new_rotation_y_deg is not None:
            patch_fields["rotation_y_deg"] = mut.new_rotation_y_deg
        if mut.new_scale is not None:
            patch_fields["scale"] = mut.new_scale
        if mut.new_material is not None:
            patch_fields["material"] = mut.new_material.model_dump()
        if mut.new_parametric is not None:
            patch_fields["parametric"] = mut.new_parametric.model_dump()
            geom_changed = True
        if mut.new_procedural is not None:
            patch_fields["procedural"] = mut.new_procedural.model_dump()
            geom_changed = True
        if mut.new_behavior is not None:
            patch_fields["behavior"] = mut.new_behavior.model_dump()
        if mut.visible is not None:
            patch_fields["visible"] = mut.visible
        if not patch_fields:
            continue

        is_beh_only = (
            mut.new_behavior is not None
            and mut.new_position is None and mut.new_rotation_y_deg is None
            and mut.new_scale is None and mut.new_material is None
            and not geom_changed and mut.visible is None
        )
        if is_beh_only:
            behavior_only_ids.append(target.id)

        coord.commit_op(
            domain="object", action="patch", target_id=target.id,
            payload=patch_fields, phase="edit", worker="flash_lite_edit",
        )
        if target.id not in changed_ids:
            changed_ids.append(target.id)

    for rid in patch.remove_object_ids:
        if rid in existing_map:
            coord.commit_op(
                domain="object", action="delete", target_id=rid,
                payload={"object_id": rid}, phase="edit", worker="flash_lite_edit",
            )
            removed_ids.append(rid)
            if rid not in changed_ids:
                changed_ids.append(rid)

    for obj in patch.add_objects:
        if obj.carrier == "implicit_sdf" and obj.implicit_sdf is not None:
            fname = f"sdf_{obj.id}_v1_{uuid.uuid4().hex[:5]}.json"
            payload, sdf_ms = compile_sdf_mesh(obj.implicit_sdf, wdir / fname)
            obj.implicit_sdf.mesh_url = asset_url_fn(fname)
            obj.implicit_sdf.vertex_count = payload["vertex_count"]
            obj.implicit_sdf.face_count = payload["face_count"]
            costs.sdf_meshes_compiled += 1
            timings.sdf_compile_ms = round(timings.sdf_compile_ms + sdf_ms, 1)
        op = coord.commit_op(
            domain="object", action="upsert", target_id=obj.id,
            payload=obj.model_dump(), phase="edit", worker="flash_lite_edit", resolve_collisions=True,
        )
        if op and op.target_id not in changed_ids:
            changed_ids.append(op.target_id)

    for brief in patch.complex_object_briefs:
        prov_proc = ProceduralAssemblySpec(
            description=f"Provisional silhouette: {brief.name}",
            parts=[
                {"shape": "cylinder", "pos": [0, 0.4, 0], "size": [0.7, 0.85, 0.8], "color": brief.color, "roughness": 0.65},
                {"shape": "icosahedron", "pos": [0, 1.35, 0], "size": [0.55, 0.65, 0.55], "color": brief.color, "emissive": brief.color, "emissive_intensity": 0.25},
            ],
            contact_ao_radius=1.1,
        )
        prov_obj = WorldObject(
            id=brief.id, name=brief.name, collection=brief.collection,
            carrier="procedural_assembly", position=brief.position, rotation_y_deg=brief.rotation_y_deg,
            material=MaterialSpec(color=brief.color, texture_id=brief.texture_id),
            procedural=prov_proc,
        )
        op = coord.commit_op(
            domain="object", action="upsert", target_id=prov_obj.id,
            payload=prov_obj.model_dump(), phase="edit", worker="provisional_placeholder", resolve_collisions=True,
        )
        if op:
            brief.id = op.target_id
            brief.position = op.payload["position"]
            if op.target_id not in changed_ids:
                changed_ids.append(op.target_id)

    if patch.new_atmosphere is not None:
        coord.commit_op(
            domain="atmosphere", action="upsert", target_id="atmosphere",
            payload=patch.new_atmosphere.model_dump(), phase="edit", worker="flash_lite_edit",
        )
        atmosphere_changed = True

    if patch.new_terrain is not None:
        coord.commit_op(
            domain="terrain", action="upsert", target_id="terrain",
            payload=patch.new_terrain.model_dump(), phase="edit", worker="flash_lite_edit",
        )
        terrain_changed = True

    for cam in patch.add_cameras:
        coord.commit_op(
            domain="camera", action="upsert", target_id=cam.id,
            payload=cam.model_dump(), phase="edit", worker="flash_lite_edit",
        )
        camera_ids.append(cam.id)

    timings.time_to_first_visible_ms = round((time.perf_counter() - t0) * 1000.0, 1)

    if patch.new_texture_requests or patch.complex_object_briefs:
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
            futs = []
            for tr in patch.new_texture_requests:
                if enable_provisional_textures:
                    futs.append(pool.submit(_worker_pbr_texture, tr, wdir, asset_url_fn, coord, costs, timings, tier="provisional"))
                futs.append(pool.submit(_worker_pbr_texture, tr, wdir, asset_url_fn, coord, costs, timings, tier="refined"))
            for brief in patch.complex_object_briefs:
                futs.append(pool.submit(_worker_carbon_single_complex_edit, brief, world_snap.title, coord, wdir, asset_url_fn, costs, timings))
            concurrent.futures.wait(futs)

    timings.time_to_refined_ms = round((time.perf_counter() - t0) * 1000.0, 1)
    timings.total_ms = timings.time_to_refined_ms

    with coord._lock:
        w = coord.world
        w.revision += 1
        unchanged_ids = [o.id for o in w.objects if o.visible and o.id not in changed_ids]
        w.cumulative_costs = WorldCosts(
            flash_lite_calls=w.cumulative_costs.flash_lite_calls + costs.flash_lite_calls,
            carbon_calls=w.cumulative_costs.carbon_calls + costs.carbon_calls,
            hydrogen_calls=w.cumulative_costs.hydrogen_calls + costs.hydrogen_calls,
            nano_banana_texture_calls=w.cumulative_costs.nano_banana_texture_calls + costs.nano_banana_texture_calls,
            provisional_texture_calls=w.cumulative_costs.provisional_texture_calls + costs.provisional_texture_calls,
            sdf_meshes_compiled=w.cumulative_costs.sdf_meshes_compiled + costs.sdf_meshes_compiled,
        )
        w.history.append(
            WorldRevision(
                revision=w.revision, action=patch.action, instruction=instruction,
                carbon_summary=patch.summary, changed_object_ids=changed_ids,
                unchanged_object_ids=unchanged_ids, rebuilt_entire_world=False,
                costs=costs, timings=timings,
            )
        )

    delta = {
        "action": patch.action, "summary": patch.summary,
        "changed_object_ids": changed_ids, "behavior_only_ids": behavior_only_ids,
        "removed_ids": removed_ids, "unchanged_object_ids": unchanged_ids,
        "atmosphere_changed": atmosphere_changed, "terrain_changed": terrain_changed,
        "camera_ids": camera_ids, "new_texture_ids": [tr.id for tr in patch.new_texture_requests],
        "timings": timings.model_dump(), "costs": costs.model_dump(),
    }

    coord.commit_op(
        domain="status", action="complete", target_id=coord.world.world_id,
        payload={"stream_id": stream_id, "generation_status": "complete", "delta": delta, "revision": coord.world.revision},
        phase="complete", worker="coordinator", persist=True,
    )
    return coord.snapshot(), delta, timings, costs


# ---------------------------------------------------------------------------
# Seamless Persistent Adjacent-Region Expansion
# ---------------------------------------------------------------------------

REGION_STRIDE_M = 40.0


def run_streamed_region_expansion(
    rx: int,
    rz: int,
    direction_hint: str | None,
    coord: WorldCoordinator,
    wdir: pathlib.Path,
    asset_url_fn,
    *,
    stream_id: str = "",
) -> tuple[WorldState, dict]:
    """Generate a persistent adjacent 3D region at stable world coordinates (rx*40, rz*40).
    Revisiting an existing region returns immediately with 0 calls and bit-identical persistence!"""
    t0 = time.perf_counter()
    region_id = f"r_{rx}_{rz}"
    w_snap = coord.snapshot()

    existing = next((r for r in w_snap.regions if r.region_id == region_id), None)
    if existing is not None:
        info = {
            "region_id": region_id, "cached": True,
            "added_object_ids": [], "existing_object_ids": existing.object_ids,
            "elapsed_ms": round((time.perf_counter() - t0) * 1000.0, 1),
        }
        coord.commit_op(
            domain="status", action="complete", target_id=region_id,
            payload={"stream_id": stream_id, "generation_status": "complete", "region_expansion": info},
            phase="region", worker="region_cache_hit",
        )
        return w_snap, info

    cx = round(rx * REGION_STRIDE_M, 1)
    cz = round(rz * REGION_STRIDE_M, 1)
    costs = WorldCosts()
    timings = WorldTimings()

    reg = RegionSpec(
        region_id=region_id, rx=rx, rz=rz, center_xz=[cx, cz], radius=18.5,
        biome_summary=f"Adjacent continuation ({direction_hint or region_id}) of {w_snap.title}",
        object_ids=[],
    )
    coord.commit_op(
        domain="region", action="upsert", target_id=region_id,
        payload=reg.model_dump(), phase="region", worker="coordinator_region",
    )
    timings.time_to_first_visible_ms = round((time.perf_counter() - t0) * 1000.0, 1)

    neighbor_summary = {
        "world_title": w_snap.title, "world_prompt": w_snap.prompt,
        "ground_kind": w_snap.terrain.ground_kind, "enclosure": w_snap.terrain.enclosure,
        "available_textures": list(w_snap.textures.keys()),
        "new_region_id": region_id, "new_region_center_xz": [cx, cz],
        "bounds_x": [cx - 16.5, cx + 16.5], "bounds_z": [cz - 16.5, cz + 16.5],
        "direction_hint": direction_hint or f"grid ({rx},{rz})",
    }
    client = _get_client()
    added_ids: list[str] = []

    def _region_carbon() -> None:
        sys_p = (
            "You are Gemini 4 Carbon extending an existing 3D world into an adjacent seamless region.\n"
            f"{PROCEDURAL_GRAMMAR_BRIEF}\n"
            "Stream 3 to 4 valid JSON WorldObjects (NDJSON, one per line, NO array brackets) strictly INSIDE bounds_x and bounds_z!\n"
            "Prefix EVERY `id` with `new_region_id`. Include `name`, `collection`, `carrier` (`procedural_assembly` or `parametric_assembly`), `position:[x,0,z]`, `material:{color,texture_id}`, and `procedural` or `parametric` matching the neighbor biome seamlessly."
        )
        t_c = time.perf_counter()
        stream = client.models.generate_content_stream(
            model=CARBON_MODEL,
            contents=f"Neighbor context & bounds:\n{json.dumps(neighbor_summary, separators=(',', ':'))}",
            config=types.GenerateContentConfig(system_instruction=sys_p, thinking_config=types.ThinkingConfig(thinking_budget=0)),
        )
        for raw in _iter_stream_json_objects(stream):
            try:
                clean = _sanitize_world_object_dict(raw)
                if not str(clean.get("id", "")).startswith(region_id):
                    clean["id"] = f"{region_id}_{clean.get('id', 'obj')}"
                clean["position"][0] = max(cx - 16.5, min(cx + 16.5, float(clean["position"][0])))
                clean["position"][2] = max(cz - 16.5, min(cz + 16.5, float(clean["position"][2])))
                obj = WorldObject.model_validate(clean)
                if obj.carrier == "procedural_assembly" and not obj.procedural:
                    continue
                op = coord.commit_op(
                    domain="object", action="upsert", target_id=obj.id, payload=obj.model_dump(),
                    phase="region", worker="carbon_region", resolve_collisions=True, region_id=region_id,
                )
                if op:
                    added_ids.append(op.target_id)
            except Exception as exc:
                print(f"[WARN] carbon_region dropped obj: {exc}")
        costs.carbon_calls += 1
        timings.carbon_ms = round((time.perf_counter() - t_c) * 1000.0, 1)

    def _region_hydrogen() -> None:
        sys_p = (
            "You are Gemini 4 Hydrogen populating an adjacent 3D region with cohesive biome detail, foliage/props, and an optional moving agent.\n"
            f"{PROCEDURAL_GRAMMAR_BRIEF}\n"
            "Stream 4 to 5 valid JSON WorldObjects (NDJSON, one per line, NO array brackets) strictly INSIDE bounds_x and bounds_z!\n"
            "Prefix EVERY `id` with `new_region_id`. Always include `id`, `name`, `collection`, `carrier`, `position:[x,0,z]`, and `material:{color}` matching the neighbor biome."
        )
        t_h = time.perf_counter()
        stream = client.models.generate_content_stream(
            model=HYDROGEN_MODEL,
            contents=f"Neighbor context & bounds:\n{json.dumps(neighbor_summary, separators=(',', ':'))}",
            config=types.GenerateContentConfig(system_instruction=sys_p, thinking_config=types.ThinkingConfig(thinking_budget=0)),
        )
        for raw in _iter_stream_json_objects(stream):
            try:
                clean = _sanitize_world_object_dict(raw)
                if not str(clean.get("id", "")).startswith(region_id):
                    clean["id"] = f"{region_id}_{clean.get('id', 'prop')}"
                clean["position"][0] = max(cx - 16.5, min(cx + 16.5, float(clean["position"][0])))
                clean["position"][2] = max(cz - 16.5, min(cz + 16.5, float(clean["position"][2])))
                obj = WorldObject.model_validate(clean)
                if obj.carrier == "procedural_assembly" and not obj.procedural:
                    continue
                op = coord.commit_op(
                    domain="object", action="upsert", target_id=obj.id, payload=obj.model_dump(),
                    phase="region", worker="hydrogen_region",
                    resolve_collisions=(obj.carrier != "articulated_agent"), region_id=region_id,
                )
                if op:
                    added_ids.append(op.target_id)
            except Exception as exc:
                print(f"[WARN] hydrogen_region dropped obj: {exc}")
        costs.hydrogen_calls += 1
        timings.hydrogen_ms = round((time.perf_counter() - t_h) * 1000.0, 1)

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        f1 = pool.submit(_region_carbon)
        f2 = pool.submit(_region_hydrogen)
        concurrent.futures.wait([f1, f2])

    timings.total_ms = round((time.perf_counter() - t0) * 1000.0, 1)
    with coord._lock:
        w = coord.world
        w.revision += 1
        w.cumulative_costs = WorldCosts(
            flash_lite_calls=w.cumulative_costs.flash_lite_calls + costs.flash_lite_calls,
            carbon_calls=w.cumulative_costs.carbon_calls + costs.carbon_calls,
            hydrogen_calls=w.cumulative_costs.hydrogen_calls + costs.hydrogen_calls,
            nano_banana_texture_calls=w.cumulative_costs.nano_banana_texture_calls + costs.nano_banana_texture_calls,
            provisional_texture_calls=w.cumulative_costs.provisional_texture_calls + costs.provisional_texture_calls,
            sdf_meshes_compiled=w.cumulative_costs.sdf_meshes_compiled + costs.sdf_meshes_compiled,
        )
        unchanged = [o.id for o in w.objects if o.visible and o.id not in added_ids]
        w.history.append(
            WorldRevision(
                revision=w.revision, action="expand_region",
                instruction=f"Expand persistent adjacent region {region_id} at ({cx}, {cz})",
                carbon_summary=f"Streamed {len(added_ids)} persistent 3D objects into region {region_id} preserving all {len(unchanged)} existing objects.",
                changed_object_ids=added_ids, unchanged_object_ids=unchanged,
                rebuilt_entire_world=False, costs=costs, timings=timings,
            )
        )

    info = {
        "region_id": region_id, "cached": False, "center_xz": [cx, cz],
        "added_object_ids": added_ids, "timings": timings.model_dump(), "costs": costs.model_dump(),
    }
    coord.commit_op(
        domain="status", action="complete", target_id=region_id,
        payload={"stream_id": stream_id, "generation_status": "complete", "region_expansion": info},
        phase="complete", worker="coordinator", persist=True,
    )
    return coord.snapshot(), info

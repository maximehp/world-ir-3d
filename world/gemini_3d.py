"""Dual Gemini 4 Architecture for Full 3D Persistent Worlds:
  1. Gemini 4 Carbon (`gemini-4-carbon`)   -> 3D Multi-Carrier World & Surgical Diff Compiler
  2. Gemini 4 Hydrogen (`gemini-4-hydrogen`) -> Independent 4-Viewpoint 3D Visual Auditor & Spatial Repairer
"""

from __future__ import annotations

import io
import json
import os
import time

from dotenv import load_dotenv
from google import genai
from google.genai import types
from PIL import Image

from world.schema import (
    CarbonWorldDraft,
    CarbonWorldEditPatch,
    Hydrogen3DAuditResponse,
    WorldState,
)

load_dotenv()

CARBON_MODEL = "gemini-4-carbon"
HYDROGEN_MODEL = "gemini-4-hydrogen"


def _get_client() -> genai.Client:
    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not key:
        raise RuntimeError("GEMINI_API_KEY is not set")
    return genai.Client(api_key=key)


def _pil_to_part(img: Image.Image, quality: int = 88) -> types.Part:
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=quality)
    return types.Part.from_bytes(data=buf.getvalue(), mime_type="image/jpeg")


def _extract_json_text(raw: str) -> str:
    txt = raw.strip()
    if txt.startswith("```"):
        lines = txt.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        txt = "\n".join(lines).strip()
    return txt


def _call_json_model(model: str, system: str, contents, schema_cls, max_retries: int = 2):
    """Call Gemini 4 with response_mime_type='application/json' + full JSON schema guidance,
    validating strictly against Pydantic v2 with bounded error-feedback retry."""
    client = _get_client()
    schema_json = json.dumps(schema_cls.model_json_schema(), separators=(",", ":"))
    full_system = (
        f"{system}\n\n"
        f"OUTPUT STRICT VALID JSON matching this exact JSON Schema (no markdown fences, no commentary):\n"
        f"{schema_json}"
    )
    last_err = None
    prompt_contents = contents if isinstance(contents, list) else [contents]
    t0 = time.perf_counter()
    for attempt in range(max_retries):
        req_contents = list(prompt_contents)
        if last_err is not None:
            req_contents.append(f"Previous JSON failed Pydantic validation with error:\n{last_err}\nFix and output ONLY valid JSON.")
        resp = client.models.generate_content(
            model=model,
            contents=req_contents,
            config=types.GenerateContentConfig(
                system_instruction=full_system,
                response_mime_type="application/json",
                thinking_config=types.ThinkingConfig(thinking_level="low"),
            ),
        )
        raw = _extract_json_text(resp.text or "")
        try:
            parsed = schema_cls.model_validate_json(raw)
            ms = (time.perf_counter() - t0) * 1000.0
            return parsed, ms
        except Exception as exc:
            last_err = str(exc)[:600]
    raise RuntimeError(f"{model} failed schema validation after {max_retries} attempts: {last_err}")


# ---------------------------------------------------------------------------
# 1. Gemini 4 Carbon: Full 3D World Compiler
# ---------------------------------------------------------------------------

CARBON_WORLD_SYSTEM = (
    "You are Gemini 4 Carbon, a 3D World Compiler producing Blender-style persistent 3D scenes.\n"
    "Coordinate system: right-handed meters, +Y up, plaza/center at (0, 0, 0), ground height is auto-computed so set position[1] = 0.0 for all grounded objects.\n\n"
    "YOU HAVE FOUR DISTINCT 3D GEOMETRY CARRIERS — USE THEM TOGETHER RICHLY:\n"
    "1. `terrain`: analytic heightfield with automatic flat central plaza (plaza_radius 13..20m) and rolling outer hills (plus optional water plane for harbor/river/lake).\n"
    "2. `parametric_assembly`: detailed multi-part 3D assemblies (NOT crude boxes!) — available kinds:\n"
    "   - 'building' (recessed glowing windows, shutters, pitched tiled roof, door, steps, optional balcony/chimney)\n"
    "   - 'tower' (tall stone clock/bell tower with spire/dome roof)\n"
    "   - 'fountain' (stepped octagonal stone basin, central tier, reflective animated water & live 3D water jets)\n"
    "   - 'tree' (branching 3D trunk + layered swaying canopy: oak, pine, cypress, blossom, palm)\n"
    "   - 'archway' (true walkable 3D vaulted stone arch), 'bridge', 'lamp_post' (casts real warm point light!), 'market_stall', 'bench', 'gazebo', 'windmill' (spinning sails!), 'lighthouse' (sweeping beam!), 'scooter', 'car', 'boat'.\n"
    "3. `implicit_sdf` (ALWAYS INCLUDE AT LEAST ONE!): smooth-min Signed Distance Field compiled via Marching Cubes into a smooth organic 3D mesh! "
    "Use this for any sculptural centerpiece, monument, carved statue, organic rock arch, crystal spire, animal sculpture, or bespoke unseen object! "
    "Compose 5..12 primitives in normalized [-1, 1]^3 space using 'smooth_union' (k=0.14..0.28) and 'smooth_subtract', using mirror_x=True for symmetric limbs/ears/arches! Set pedestal=True if it's a statue.\n"
    "4. `articulated_agent` (ALWAYS INCLUDE AT LEAST ONE AUTONOMOUS MOVING AGENT!): rig_kind in ['bird_flock', 'fox', 'scooter_rider', 'car_driver', 'boat_cruiser', 'floating_lanterns'].\n"
    "   - Give birds `behavior.kind='orbit_and_perch'` referencing a real building/tower/fountain `target_id` so they circle around it, disappear behind it, and land on its roof/rim!\n"
    "   - Give vehicles/creatures `behavior.kind='patrol_ring'` around the plaza!\n\n"
    "TEXTURE GENERATION (`texture_requests`, 2 to 3 seamless tileable PBR materials):\n"
    "- Generate 2-3 cohesive seamless material textures via Nano Banana (e.g. 'plaza_cobble' for terrain.texture_id, 'stone_wall' for buildings/tower/fountain, 'marble_sculpt' for SDF/accents).\n"
    "- Reference their exact `id` inside `terrain.texture_id` and `object.material.texture_id`!\n\n"
    "SPATIAL LAYOUT DISCIPLINE (CRITICAL FOR ZERO COLLISIONS):\n"
    "- Place a focal landmark (e.g. fountain, archway, or SDF sculpture) near (0, 0, 0) or (0, 0, -2).\n"
    "- Arrange 3-6 buildings/towers/stalls in a welcoming horseshoe/ring at radius 10m..18m around the plaza, with >= 8m center-to-center spacing so NO buildings ever overlap! Rotate them (`rotation_y_deg`) to face toward the plaza center!\n"
    "- Place 4-7 trees around the perimeter (radius 13m..24m), 2-4 lampposts along walkways (radius 7m..12m), plus benches/vehicles cleanly clear of buildings.\n"
    "- Aim for 14..22 total persistent objects — rich, recognizable, navigable from all 360 degrees!\n"
    "- Place `camera_spawn` around `[0, 4.5, 22]` looking toward `[0, 2.5, -1]` with an unobstructed view into the scene."
)


def carbon_compile_world(user_prompt: str) -> tuple[CarbonWorldDraft, float]:
    """Compile an unseen natural-language prompt into a structured multi-carrier 3D WorldIR."""
    system = CARBON_WORLD_SYSTEM
    return _call_json_model(
        CARBON_MODEL,
        system,
        f"Design a rich, walkable full-3D world for this prompt:\n{user_prompt}",
        CarbonWorldDraft,
    )


# ---------------------------------------------------------------------------
# 2. Gemini 4 Carbon: Surgical 3D World Diff Compiler
# ---------------------------------------------------------------------------

def carbon_compile_world_edit(
    world: WorldState,
    instruction: str,
    selected_object_id: str | None = None,
) -> tuple[CarbonWorldEditPatch, float]:
    """Compile a natural-language chat edit into a minimal surgical WorldEditPatch.

    Preserves all unrelated persistent objects, meshes, textures, and live entity identities.
    """
    system = (
        "You are Gemini 4 Carbon, the Surgical 3D World Diff Compiler.\n"
        "Apply ONLY the minimal localized mutations needed to satisfy the user's edit while leaving all unrelated objects untouched!\n\n"
        "SURGICAL EDIT RULES:\n"
        "1. BEHAVIOR EDIT (e.g. 'make the birds circle the fountain instead', 'have the scooter patrol wider', 'speed up the birds'):\n"
        "   - Emit `action='update_behavior'` and a `mutations` entry with ONLY `object_id` and `new_behavior` referencing the exact target `object_id`! Do NOT delete and recreate the agent!\n"
        "2. MATERIAL / APPEARANCE EDIT (e.g. 'turn the clock tower into mossy obsidian brick with glowing amber windows', 'paint the scooter emerald green'):\n"
        "   - Emit `action='restyle_material'` and mutate ONLY `new_material` on the target `object_id`. "
        "If the user asks for a distinct rich surface texture (mosaic, marble, mossy stone, copper, rusted iron, etc.), add 1 entry in `new_texture_requests` and bind its `id` to `new_material.texture_id`!\n"
        "3. TRANSFORM / DELETE EDIT (move, rotate, scale, delete):\n"
        "   - Mutate ONLY `new_position`/`new_rotation_y_deg`/`new_scale`, or put the ID in `remove_object_ids`.\n"
        "4. ADD OBJECT EDIT (e.g. 'add a carved stone dragon statue beside the fountain', 'add a red car parked near the bakery', 'add glowing floating lanterns'):\n"
        "   - Add to `add_objects` placed cleanly without overlapping existing objects! Use `carrier='implicit_sdf'` with 5..12 smooth_union/subtract primitives for ANY sculptural, organic, animal statue, crystal, or bespoke custom 3D object!\n"
        "5. ATMOSPHERE / TIME-OF-DAY EDIT (e.g. 'switch to moonlit night with glowing warm windows', 'make it golden sunset with dense mist'):\n"
        "   - Update `new_atmosphere`.\n"
        "6. VIDEO-TRACKED AGENTS: agents with `behavior.kind='follow_video_path'` replay a motion path tracked from the source video (`behavior.video_track_id`). "
        "When restyling/rescaling them keep their behavior untouched. Only change their behavior if the user explicitly asks them to stop following the video path. "
        "New agents may reuse an existing `video_track_id` listed in `video_track_ids` to follow the same tracked motion.\n"
        "7. If `selected_object_id` is provided and the user says 'this', 'it', or 'selected object', target `selected_object_id`."
    )

    compact_world = {
        "title": world.title,
        "selected_object_id": selected_object_id,
        "atmosphere": world.atmosphere.model_dump(),
        "terrain": {
            "style": world.terrain.style,
            "plaza_radius": world.terrain.plaza_radius,
            "has_water": world.terrain.has_water,
            "ground_color": world.terrain.ground_color,
        },
        "available_texture_ids": list(world.textures.keys()),
        "video_track_ids": [t.id for t in world.source_video.tracks] if world.source_video else [],
        "objects": [
            {
                "id": o.id,
                "name": o.name,
                "collection": o.collection,
                "carrier": o.carrier,
                "position": o.position,
                "rotation_y_deg": o.rotation_y_deg,
                "scale": o.scale,
                "material": o.material.model_dump(),
                "parametric_kind": o.parametric.kind if o.parametric else None,
                "sdf_description": o.implicit_sdf.description if o.implicit_sdf else None,
                "agent_rig": o.agent.rig_kind if o.agent else None,
                "behavior": o.behavior.model_dump(),
            }
            for o in world.objects
            if o.visible
        ],
    }

    return _call_json_model(
        CARBON_MODEL,
        system,
        f"Current Persistent 3D World State:\n{json.dumps(compact_world, indent=2)}\n\nUser chat edit:\n{instruction}",
        CarbonWorldEditPatch,
    )


# ---------------------------------------------------------------------------
# 3. Gemini 4 Hydrogen: Independent Multi-Viewpoint 3D Visual Auditor
# ---------------------------------------------------------------------------

def hydrogen_audit_multiview(
    world: WorldState,
    multiview_plate_img: Image.Image,
    latest_intent: str,
    allow_repair: bool = True,
) -> tuple[Hydrogen3DAuditResponse, float]:
    """Inspect a 2x2 multi-angle 3D render plate (Overview, Front Eye-Level, Opposite 180° Back, Close-Up)
    and return objective 3D spatial scores, defects, and optional bounded spatial fixes."""
    system = (
        "You are Gemini 4 Hydrogen, an independent Multimodal 3D Visual Auditor.\n"
        "You are inspecting a 2x2 multi-viewpoint 3D WebGL render plate of a generated 3D world from FOUR distinct cameras:\n"
        "  TOP-LEFT: Elevated 3/4 Overview\n"
        "  TOP-RIGHT: Eye-Level Front View\n"
        "  BOTTOM-LEFT: Opposite 180-Degree Back View (proves full 3D back-side geometry!)\n"
        "  BOTTOM-RIGHT: Hero Close-Up\n\n"
        "AUDIT CRITICALLY AND HONESTLY:\n"
        "1. Does the world exhibit genuine 3D structure visible coherently from both front and opposite 180° back views?\n"
        "2. Check for real spatial defects: colliding/overlapping buildings, floating objects, unreadable/tiny silhouettes, broken proportions, or poorly lit/muddy contrast.\n"
        "3. Check whether the latest user intent/edit is visibly reflected in the 3D scene.\n"
        "4. If allow_repair=True and you see a concrete spatial overlap, collision, or scale/placement flaw on 1-3 specific object IDs, "
        "set status='REPAIR_SPATIAL' and return exact bounded `fixes` (`object_id`, `new_position`, `scale_multiplier`, `reason`).\n"
        "5. Otherwise return status='PASS' (if layout, 3D geometry, and lighting look genuinely solid) or 'WARNING' (with honest notes).\n"
        "Never inflate scores or claim photorealism where none exists."
    )
    brief = {
        "title": world.title,
        "latest_intent": latest_intent,
        "allow_repair": allow_repair,
        "objects": [
            {
                "id": o.id,
                "name": o.name,
                "carrier": o.carrier,
                "kind": (
                    o.parametric.kind if o.parametric
                    else (o.agent.rig_kind if o.agent else (o.implicit_sdf.description if o.implicit_sdf else "unknown"))
                ),
                "position": o.position,
                "scale": o.scale,
                "behavior": o.behavior.model_dump() if o.behavior.kind != "none" else None,
            }
            for o in world.objects
            if o.visible
        ],
    }
    return _call_json_model(
        HYDROGEN_MODEL,
        system,
        [
            _pil_to_part(multiview_plate_img, quality=88),
            f"3D World Metadata:\n{json.dumps(brief, indent=2)}",
        ],
        Hydrogen3DAuditResponse,
    )

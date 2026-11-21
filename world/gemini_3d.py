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
FLASH_LITE_MODEL = "gemini-3.5-flash-lite"

_CLIENT: genai.Client | None = None


def _get_client() -> genai.Client:
    global _CLIENT
    if _CLIENT is None:
        key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
        if not key:
            raise RuntimeError("GEMINI_API_KEY is not set")
        _CLIENT = genai.Client(api_key=key)
    return _CLIENT


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

def carbon_compile_world(user_prompt: str) -> tuple[CarbonWorldDraft, float]:
    """Compile an unseen natural-language prompt into a structured general-purpose multi-carrier 3D WorldIR."""
    system = (
        "You are Gemini 4 Carbon, a General-Purpose 3D World Compiler producing persistent 3D scenes matching the user's ACTUAL intent.\n"
        "DO NOT force a circular plaza, village cottages, lampposts, or statues unless the prompt asks for them!\n"
        "Coordinate system: right-handed meters, +Y up.\n\n"
        "YOU HAVE FIVE COMPOSABLE 3D CARRIERS — PICK ONLY WHAT FITS THE USER'S PROMPT:\n"
        "1. `terrain`: set `ground_kind` ('outdoor_hills'|'flat_floor'|'forest_floor'|'interior_deck'|'none') and `enclosure` ('open_sky'|'space_bridge'|'sci_fi_corridor'|'interior_room'|'cathedral_hall'|'forest_canopy') with `enclosure_size`, `space_stars`, `plaza_radius` (0 for forests/interiors).\n"
        "2. `procedural_assembly` (PRIMARY GENERAL-PURPOSE GRAMMAR): compose ANY 3D object (spaceship consoles, holographic displays, ceremony arches, pew rows, banquet tables, gnarled ancient trees, fallen logs, ferns, chandeliers, cryo pods) from 4..24 typed parts (`box|cylinder|cone|sphere|capsule|torus|arch_segment|plane|ring|icosahedron|dodecahedron`) with `mirror_x`, `repeat_count`, `repeat_offset`, `repeat_rot_y_deg`, translucent `opacity`, `emissive`, optional attached `PointLight`, and deterministic `anim`.\n"
        "3. `implicit_sdf` (optional): smooth-min Signed Distance Field compiled via Marching Cubes for organic sculptures/statues/monoliths.\n"
        "4. `articulated_agent` (optional): `human_character` (bride, groom, officiant, guests, crew — with `walk_path` and `stand_and_face` coordinated performances!) plus wildlife/vehicles (`bird_flock`, `fox`, `scooter_rider`, `boat_cruiser`, `floating_lanterns`) ONLY when authentic to the prompt.\n"
        "5. `parametric_assembly` (optional reusable components): building, tower, fountain, tree, archway, bridge, lamp_post, market_stall, bench, gazebo, windmill, lighthouse, scooter, car, boat — ONLY use if they genuinely match the prompt!\n\n"
        "TEXTURE GENERATION (`texture_requests`, 2 to 3 prompt-authentic seamless tileable PBR materials) + unobstructed `camera_spawn` / `camera_look_at` (strictly inside `enclosure_size` for enclosed interiors!)."
    )
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
        "6. If `selected_object_id` is provided and the user says 'this', 'it', or 'selected object', target `selected_object_id`."
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
        "1. PROMPT COVERAGE & ENVIRONMENT AUTHENTICITY (MOST IMPORTANT!): Compare the 3D render against `world_prompt` and `latest_intent`. "
        "Does the scene ACTUALLY depict the requested environment, layout, and semantic objects (e.g. spaceship interior looks like a spaceship interior with consoles/viewport/bulkheads; dense forest looks like a dense forest with no village plaza; wedding ceremony has floral arch, aisle, bride, groom, guests) rather than a generic village template? "
        "Populate `prompt_coverage_score` (0..10), `matched_elements`, and `missing_elements` honestly!\n"
        "2. Does the world exhibit genuine 3D structure visible coherently from both front and opposite 180° back views?\n"
        "3. Check for real spatial defects: colliding/overlapping structures, floating objects, unreadable silhouettes, or broken lighting/contrast.\n"
        "4. If allow_repair=True and you see a concrete spatial overlap, collision, or scale/placement flaw on 1-3 specific object IDs, "
        "set status='REPAIR_SPATIAL' and return exact bounded `fixes` (`object_id`, `new_position`, `scale_multiplier`, `reason`).\n"
        "5. Otherwise return status='PASS' (if prompt coverage, layout, 3D geometry, and lighting look genuinely solid) or 'WARNING' (with honest notes).\n"
        "Never inflate scores or claim photorealism where none exists."
    )
    brief = {
        "title": world.title,
        "world_prompt": world.prompt,
        "enclosure": world.terrain.enclosure,
        "ground_kind": world.terrain.ground_kind,
        "latest_intent": latest_intent,
        "allow_repair": allow_repair,
        "objects": [
            {
                "id": o.id,
                "name": o.name,
                "carrier": o.carrier,
                "kind": (
                    o.parametric.kind if o.parametric
                    else (o.procedural.description if o.procedural
                    else (f"{o.agent.rig_kind}({o.agent.role})" if o.agent
                    else (o.implicit_sdf.description if o.implicit_sdf else "unknown")))
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

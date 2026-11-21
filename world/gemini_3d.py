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

OBJECT_GEOMETRY_GUIDE = (
    "Represent each object with the carrier that matches its actual geometry. "
    "A parametric_assembly can use one of the named reusable builders in the schema when its silhouette and details fit. "
    "For a plain geometric solid choose parametric.kind='primitive', set parametric.shape to box, sphere, cylinder or cone, "
    "and specify width, height and depth in meters. For other shapes, design custom geometry with implicit_sdf: "
    "combine or subtract oriented primitives within normalized [-1, 1]^3, then set target_height in meters. "
    "Use a pedestal only when it belongs to the subject. An articulated_agent provides the listed animated rigs "
    "for subjects whose appearance and motion match them."
)

CARBON_WORLD_SYSTEM = (
    "Compile the user's description and any references into a persistent 3D scene. Derive the subject, "
    "object count, composition, spatial relationships, materials, lighting and camera framing from that input. "
    "Honor explicit counts and exclusions, including empty environments or individual objects. "
    "Leave objects, scenery and movement out when they do not belong in the described world.\n"
    + OBJECT_GEOMETRY_GUIDE
    + "\nCoordinates are in meters with +Y up. Object position[1] is the vertical offset from the terrain "
    "surface, so use zero for grounded objects. Account for object dimensions and any intentional stacking or contact. "
    "Choose terrain, relief, water and atmosphere to match the setting. "
    "Use texture_requests only for surfaces that benefit from generated materials and bind their IDs to those surfaces. "
    "Set camera_spawn and camera_look_at to show the subject at its intended scale with an unobstructed view."
)


def carbon_compile_world(user_prompt: str, refs: list | None = None) -> tuple[CarbonWorldDraft, float]:
    """Compile an unseen natural-language prompt into a structured multi-carrier 3D WorldIR."""
    system = CARBON_WORLD_SYSTEM
    contents: list = [f"Create the 3D scene described by the user:\n{user_prompt}"]
    if refs:
        from world.references import REFERENCE_CREATE_ADDENDUM, reference_parts

        system = system + REFERENCE_CREATE_ADDENDUM
        contents += reference_parts(refs)
    return _call_json_model(CARBON_MODEL, system, contents, CarbonWorldDraft)


# ---------------------------------------------------------------------------
# 2. Gemini 4 Carbon: Surgical 3D World Diff Compiler
# ---------------------------------------------------------------------------

def carbon_compile_world_edit(
    world: WorldState,
    instruction: str,
    selected_object_id: str | None = None,
    refs: list | None = None,
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
        "4. ADD OBJECT EDIT: Place requested objects in `add_objects` in their intended relation to the existing scene. "
        + OBJECT_GEOMETRY_GUIDE
        + "\n"
        "5. ATMOSPHERE / TIME-OF-DAY EDIT (e.g. 'switch to moonlit night with glowing warm windows', 'make it golden sunset with dense mist'):\n"
        "   - Update `new_atmosphere`.\n"
        "6. VIDEO-TRACKED AGENTS: agents with `behavior.kind='follow_video_path'` replay a motion path tracked from the source video (`behavior.video_track_id`). "
        "When restyling/rescaling them keep their behavior untouched. Only change their behavior if the user explicitly asks them to stop following the video path. "
        "New agents may reuse an existing `video_track_id` listed in `video_track_ids` to follow the same tracked motion.\n"
        "7. STYLE CONSISTENCY: apply the scene's style_guide unless the user requests a different appearance.\n"
        "8. If `selected_object_id` is provided and the user says 'this', 'it', or 'selected object', target `selected_object_id`."
    )

    compact_world = {
        "title": world.title,
        "style_guide": world.style_guide,
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
                "parametric": o.parametric.model_dump(exclude_defaults=True) if o.parametric else None,
                "sdf_description": o.implicit_sdf.description if o.implicit_sdf else None,
                "agent_rig": o.agent.rig_kind if o.agent else None,
                "behavior": o.behavior.model_dump(),
            }
            for o in world.objects
            if o.visible
        ],
    }

    contents: list = [f"Current Persistent 3D World State:\n{json.dumps(compact_world, indent=2)}\n\nUser chat edit:\n{instruction}"]
    if refs:
        from world.references import REFERENCE_EDIT_ADDENDUM, reference_parts

        system = system + REFERENCE_EDIT_ADDENDUM
        contents += reference_parts(refs)
    return _call_json_model(CARBON_MODEL, system, contents, CarbonWorldEditPatch)


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
        "2. Judge the layout against the original scene prompt and latest edit. Honor deliberately empty scenes, requested levitation, "
        "and solids that touch, stack or intersect to form a larger object. Preserve these features during repair.\n"
        "3. Check whether the latest user intent/edit is visibly reflected in the 3D scene.\n"
        "4. If allow_repair=True and you see an unintended collision, scale or placement flaw on 1-3 specific object IDs, "
        "set status='REPAIR_SPATIAL' and return exact bounded `fixes` (`object_id`, `new_position`, `scale_multiplier`, `reason`).\n"
        "5. Otherwise return status='PASS' (if layout, 3D geometry, and lighting look genuinely solid) or 'WARNING' (with honest notes).\n"
        "Never inflate scores or claim photorealism where none exists."
    )
    brief = {
        "title": world.title,
        "original_prompt": world.prompt,
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

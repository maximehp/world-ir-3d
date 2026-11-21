"""Multimodal reference images (floor/site plans, building photos, Pinterest-style mood boards,
material swatches, object references) gracefully integrated into a WorldIR by Gemini 4 Carbon.

Carbon classifies each image's role and decides how to blend it with the text prompt (and video, if any):
plans drive WHERE things go, mood boards drive HOW everything looks, swatches become image-conditioned
Nano Banana PBR textures, and object references become sculpted SDF / parametric objects. Every decision is
recorded as a human-readable `ReferenceUsage`, and a persistent `style_guide` keeps later edits on-theme.
"""

from __future__ import annotations

import io
import pathlib
from dataclasses import dataclass

from google.genai import types
from PIL import Image, ImageOps

from world.schema import ReferenceImage, ReferenceUsage, WorldState

MAX_REFERENCE_IMAGES = 8
MAX_SIDE_PX = 1280  # plans need enough resolution for labels / wall lines


@dataclass
class PreparedReference:
    jpeg: bytes
    filename: str
    width: int
    height: int


def prepare_reference_images(raw: list[tuple[bytes, str]]) -> list[PreparedReference]:
    out: list[PreparedReference] = []
    for data, filename in raw[:MAX_REFERENCE_IMAGES]:
        try:
            img = Image.open(io.BytesIO(data))
            img = ImageOps.exif_transpose(img)
        except Exception as exc:
            raise ValueError(f"Could not read image '{filename}': {exc}") from exc
        if img.mode in ("RGBA", "LA", "P"):
            img = img.convert("RGBA")
            bg = Image.new("RGB", img.size, (255, 255, 255))  # plans with transparent backgrounds -> white paper
            bg.paste(img, mask=img.split()[-1])
            img = bg
        img = img.convert("RGB")
        img.thumbnail((MAX_SIDE_PX, MAX_SIDE_PX), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=88)
        out.append(PreparedReference(buf.getvalue(), filename, img.width, img.height))
    return out


def reference_parts(refs: list[PreparedReference]) -> list:
    parts: list = []
    for i, r in enumerate(refs):
        parts.append(types.Part.from_text(text=f"Reference image #{i} (file: {r.filename}, {r.width}x{r.height}px):"))
        parts.append(types.Part.from_bytes(data=r.jpeg, mime_type="image/jpeg"))
    return parts


_ROLE_GUIDE = (
    "- site_or_floor_plan (floor plans, site plans, maps, architectural drawings, layout sketches): read it as a TOP-DOWN map. "
    "Image center = world origin (0,0,0), image up = -Z (north), image right = +X. Use drawn dimensions and labels to infer scale, "
    "names and function. Match each footprint's position, dimensions and orientation. Model walls around interior rooms and preserve "
    "door openings, circulation paths and open spaces. Use a building component where its actual shape matches the plan.\n"
    "- building_reference (photo, facade, elevation or sketch of a structure): match it on the most relevant building(s): floors, "
    "roof_style, balcony/chimney, proportions, wall/roof/trim colors. If its shape does not fit the parametric kinds (domes, organic, "
    "futuristic, unusual towers), build it as implicit_sdf.\n"
    "- mood_board (Pinterest boards, collages, aesthetic/vibe images, color palettes, film stills): drive the WHOLE world's style: "
    "time_of_day, sky/fog/sun colors, a coherent color palette across all materials, vegetation species (tree_style), terrain style and "
    "colors, lighting warmth, emissive accents, and optional texture_requests for distinctive surfaces in the board. Extract themes; do not copy "
    "its literal layout.\n"
    "- material_swatch (close-up of a surface: tile, brick, wood, stone, fabric, metal): add a texture_request with "
    "reference_image_index = that image and a prompt describing the material, then bind it to the fitting surfaces.\n"
    "- object_reference (statue, creature, vehicle, furniture, prop, character): use the object's silhouette and material where the prompt "
    "places it. Use simple solids, an implicit_sdf, or a matching reusable component as appropriate.\n"
    "- scene_photo (a real place or landscape): use it for composition, terrain, vegetation and atmosphere.\n"
)

REFERENCE_CREATE_ADDENDUM = (
    "\n\n=== USER REFERENCE IMAGES ===\n"
    "The user attached reference images (numbered from #0, each preceded by a label). First CLASSIFY each image's role, then "
    "INTEGRATE it like a skilled level designer: gracefully and coherently blended with the text prompt, never as a literal "
    "pasted copy, and never breaking the spatial layout rules above.\n"
    + _ROLE_GUIDE
    + "PRIORITY WHEN SOURCES CONFLICT: the text prompt decides WHAT exists; plans decide WHERE things are; mood boards decide HOW "
    "things look. If a video is also given, keep the video's scene, camera and tracked motion, and apply references as style and additions.\n"
    "OUTPUT REQUIREMENTS: `reference_usage` must contain exactly one entry per image (image_index, role, a specific 1-2 sentence "
    "plain-English `how_used`, and affected_object_ids). Write a concise `style_guide` (palette hexes, materials, architecture rules, "
    "mood) that future edits can follow."
)

REFERENCE_EDIT_ADDENDUM = (
    "\n\n=== USER REFERENCE IMAGES FOR THIS EDIT ===\n"
    "The user attached reference images to this edit (numbered from #0). Classify each one and apply it SURGICALLY, still preserving "
    "unrelated objects:\n"
    + _ROLE_GUIDE
    + "For edits: a mood board -> `multi_edit` restyling materials of the relevant objects (or all, if the user asks for a full "
    "restyle) + `new_atmosphere`, and set `new_style_guide`. A plan -> add or move objects to match it. A building/object reference -> "
    "restyle the selected/mentioned object or add a new one. A swatch -> one `new_texture_requests` entry with reference_image_index, "
    "bound via `new_material.texture_id`.\n"
    "Fill `reference_usage` with exactly one entry per attached image."
)


def save_reference_images(world_dir: pathlib.Path, refs: list[PreparedReference], revision: int) -> list[str]:
    names = []
    for i, r in enumerate(refs):
        name = f"ref_r{revision}_{i}.jpg"
        (world_dir / name).write_bytes(r.jpeg)
        names.append(name)
    return names


def record_references(
    world: WorldState,
    refs: list[PreparedReference],
    urls: list[str],
    usage: list[ReferenceUsage],
    revision: int,
) -> list[ReferenceUsage]:
    """Attach saved reference images + Carbon's interpretation to the world; returns usage cleaned to valid indexes."""
    by_idx = {u.image_index: u for u in usage if 0 <= u.image_index < len(refs)}
    cleaned = []
    for i, (r, url) in enumerate(zip(refs, urls)):
        u = by_idx.get(i) or ReferenceUsage(image_index=i, role="other", how_used="Used as general visual context.")
        cleaned.append(u)
        world.reference_images.append(
            ReferenceImage(url=url, filename=r.filename, revision=revision, image_index=i, role=u.role, how_used=u.how_used)
        )
    return cleaned

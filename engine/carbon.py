from __future__ import annotations

import os
import time
from typing import Literal, Optional
from google import genai
from google.genai import types
from pydantic import BaseModel, Field

from .schema import (
    CameraSpec,
    EditPlan,
    EntityEditDelta,
    EntitySpec,
    RelationshipSpec,
    SceneIR,
    TimedEvent,
)

CARBON_MODEL = "gemini-4-carbon"

COMPILE_SYSTEM_PROMPT = """You are Gemini 4 Carbon, a fast, general-purpose Scene IR compiler for structured generative video.
Compile ANY user scene description (wedding, kitchen, sci-fi, wildlife, sports, cinema, etc.) into a compact, concrete, visually unambiguous Scene IR JSON.

Rules:
1. Never assume or inject any theme not in the prompt. Stay 100% general-purpose.
2. Give every persistent entity a stable snake_case id (e.g. 'bride', 'groom', 'chef', 'cat', 'guests').
3. Separate immutable 'identity_traits' (face, age, ethnicity, hair, build, structural form) from mutable 'appearance' (wardrobe, colors, accessories, state). Keep each field concise (1 short sentence).
4. Set needs_reference=true for at most 3 primary visual entities whose identity must stay consistent across edits.
5. Keep duration_sec=4. Partition 2-3 crisp timed events across 0.0-4.0s with observable motion and ambient audio cues.
6. Specify clear cinematic camera instructions (shot_type, angle, movement, lens_feel, framing_notes).
7. Be concise and concrete — minimize verbosity."""


class _EntityPatch(BaseModel):
    id: str = Field(..., description="Existing entity id to modify.")
    new_appearance: Optional[str] = Field(default=None, description="Updated mutable appearance (omit if unchanged).")
    new_identity_traits: Optional[str] = Field(default=None, description="Only set if core identity explicitly changed.")
    new_position_hint: Optional[str] = Field(default=None, description="Updated spatial placement (omit if unchanged).")
    preserve_identity: str = Field(..., description="Short list of exact identity traits that MUST remain identical.")
    change_description: str = Field(..., description="Minimal visual delta for Nano Banana reference editing.")


class _SettingPatch(BaseModel):
    location: Optional[str] = None
    time_of_day: Optional[str] = None
    lighting: Optional[str] = None
    atmosphere: Optional[str] = None
    visual_style: Optional[str] = None


class _CameraPatch(BaseModel):
    shot_type: Optional[str] = None
    angle: Optional[str] = None
    movement: Optional[str] = None
    lens_feel: Optional[str] = None
    framing_notes: Optional[str] = None


class _CompactEditPatch(BaseModel):
    """Minimal diff emitted by Gemini 4 Carbon (~2-4s latency) and applied deterministically to SceneIR."""

    edit_summary: str = Field(..., description="One concise sentence describing the minimal edit.")
    modified_entities: list[_EntityPatch] = Field(default_factory=list, description="ONLY existing entities that visually changed.")
    added_entities: list[EntitySpec] = Field(default_factory=list, description="ONLY brand-new entities added by the edit.")
    removed_entity_ids: list[str] = Field(default_factory=list, description="Entity ids explicitly removed.")
    added_relationships: list[RelationshipSpec] = Field(default_factory=list)
    setting_patch: Optional[_SettingPatch] = Field(default=None, description="Null unless location/lighting/atmosphere changed.")
    camera_patch: Optional[_CameraPatch] = Field(default=None, description="Null unless framing/angle/camera motion changed.")
    updated_events: Optional[list[TimedEvent]] = Field(default=None, description="Null unless actions or timing changed.")
    edit_strategy: Literal["video_edit", "reference_resynthesis"] = Field(
        ...,
        description=(
            "Use 'video_edit' for appearance/wardrobe/prop/lighting edits, adding elements into the shot, "
            "or moderate framing adjustments. Use 'reference_resynthesis' ONLY for radical camera framing/angle "
            "changes (e.g. wide crane pullback, 180-deg orbit, macro close-up) or entirely new staging."
        ),
    )
    strategy_reason: str = Field(..., description="Short 1-sentence reason for edit_strategy.")
    video_edit_instruction: str = Field(
        ...,
        description="Surgical 1-2 sentence directive stating EXACTLY what changes and what MUST stay identical.",
    )


EDIT_PATCH_SYSTEM_PROMPT = """You are Gemini 4 Carbon, a low-latency surgical Scene IR diff compiler.
Given a compact Scene IR and a natural-language edit request, emit ONLY the minimal _CompactEditPatch JSON — never repeat unchanged fields!

Rules:
1. Only include entities in modified_entities if their appearance, identity, or placement actually changes. Leave untouched entities out so their cached references are 100% reused.
2. When modifying an entity's clothing/color/props, leave new_identity_traits=null so its core face/identity stays locked.
3. For added_entities, set needs_reference=true ONLY if it is a prominent hero character/animal/object (background crowds like guests can have needs_reference=false so existing hero references stay locked).
4. Set setting_patch=null, camera_patch=null, updated_events=null unless explicitly affected.
5. Keep every string crisp and concise for minimal latency."""


def _client() -> genai.Client:
    return genai.Client(api_key=os.environ["GEMINI_API_KEY"])


async def compile_scene_ir(prompt: str) -> tuple[SceneIR, int]:
    """Compile any natural-language scene prompt into a structured SceneIR using Gemini 4 Carbon."""
    t0 = time.perf_counter()
    client = _client()
    resp = await client.aio.models.generate_content(
        model=CARBON_MODEL,
        contents=f"Compile this scene prompt into a compact SceneIR:\n\n{prompt.strip()}",
        config=types.GenerateContentConfig(
            system_instruction=COMPILE_SYSTEM_PROMPT,
            response_mime_type="application/json",
            response_schema=SceneIR,
            thinking_config=types.ThinkingConfig(thinking_level="LOW"),
        ),
    )
    ir = SceneIR.model_validate_json(resp.text)
    ref_count = 0
    for ent in ir.entities:
        if ent.needs_reference:
            ref_count += 1
            if ref_count > 3:
                ent.needs_reference = False
    latency_ms = int((time.perf_counter() - t0) * 1000)
    return ir, latency_ms


async def compile_edit_plan(current_ir: SceneIR, edit_request: str) -> tuple[EditPlan, int]:
    """
    Compile a natural-language edit into a compact diff via Gemini 4 Carbon (~2-4s)
    and deterministically patch the SceneIR in <1ms, guaranteeing 100% cache reuse for untouched entities.
    """
    t0 = time.perf_counter()
    client = _client()

    # Compact representation of current IR to keep prompt & decode fast
    compact_ir = current_ir.model_dump_json(exclude_none=True)
    user_payload = (
        f"CURRENT_IR={compact_ir}\n"
        f"EDIT_REQUEST={edit_request.strip()}\n"
        "Return minimal _CompactEditPatch JSON."
    )
    resp = await client.aio.models.generate_content(
        model=CARBON_MODEL,
        contents=user_payload,
        config=types.GenerateContentConfig(
            system_instruction=EDIT_PATCH_SYSTEM_PROMPT,
            response_mime_type="application/json",
            response_schema=_CompactEditPatch,
            thinking_config=types.ThinkingConfig(thinking_level="LOW"),
        ),
    )
    patch = _CompactEditPatch.model_validate_json(resp.text)

    # Deterministically apply minimal patch to a deep copy of current_ir
    updated_ir = current_ir.model_copy(deep=True)
    mod_by_id = {m.id: m for m in patch.modified_entities}
    removed_set = set(patch.removed_entity_ids)

    changed_ids: list[str] = []
    unchanged_ids: list[str] = []
    deltas: list[EntityEditDelta] = []
    kept_entities: list[EntitySpec] = []

    for ent in updated_ir.entities:
        if ent.id in removed_set:
            continue
        if ent.id in mod_by_id:
            mp = mod_by_id[ent.id]
            visual_changed = False
            if mp.new_appearance is not None and mp.new_appearance != ent.appearance:
                ent.appearance = mp.new_appearance
                visual_changed = True
            if mp.new_identity_traits is not None and mp.new_identity_traits != ent.identity_traits:
                ent.identity_traits = mp.new_identity_traits
                visual_changed = True
            if mp.new_position_hint is not None:
                ent.position_hint = mp.new_position_hint
            if visual_changed:
                ent.appearance_revision += 1
                changed_ids.append(ent.id)
                deltas.append(
                    EntityEditDelta(
                        entity_id=ent.id,
                        preserve_identity=mp.preserve_identity,
                        change_description=mp.change_description,
                    )
                )
            else:
                unchanged_ids.append(ent.id)
        else:
            unchanged_ids.append(ent.id)
        kept_entities.append(ent)

    existing_ids = {e.id for e in kept_entities}
    added_ids: list[str] = []
    for new_ent in patch.added_entities:
        if new_ent.id not in existing_ids:
            new_ent.appearance_revision = 1
            kept_entities.append(new_ent)
            existing_ids.add(new_ent.id)
            added_ids.append(new_ent.id)

    updated_ir.entities = kept_entities

    # Cap total entity refs to 3 (prioritize changed/added entities, then existing refs)
    ref_entities = [e for e in updated_ir.entities if e.needs_reference]
    if len(ref_entities) > 3:
        priority = set(changed_ids) | set(added_ids)
        ordered = sorted(ref_entities, key=lambda e: (0 if e.id in priority else 1))
        keep_ref_ids = {e.id for e in ordered[:3]}
        for e in updated_ir.entities:
            e.needs_reference = e.id in keep_ref_ids

    if patch.added_relationships:
        updated_ir.relationships.extend(patch.added_relationships)

    setting_changed = False
    if patch.setting_patch is not None:
        sp = patch.setting_patch
        for field in ("location", "time_of_day", "lighting", "atmosphere", "visual_style"):
            val = getattr(sp, field)
            if val is not None and val != getattr(updated_ir.setting, field):
                setattr(updated_ir.setting, field, val)
                setting_changed = True
        if setting_changed:
            updated_ir.setting.revision += 1

    camera_changed = False
    if patch.camera_patch is not None:
        cp = patch.camera_patch
        for field in ("shot_type", "angle", "movement", "lens_feel", "framing_notes"):
            val = getattr(cp, field)
            if val is not None and val != getattr(updated_ir.camera, field):
                setattr(updated_ir.camera, field, val)
                camera_changed = True

    events_changed = False
    if patch.updated_events:
        updated_ir.events = patch.updated_events
        events_changed = True

    updated_ir.summary = f"{current_ir.summary} (Edit: {patch.edit_summary})"

    plan = EditPlan(
        edit_summary=patch.edit_summary,
        updated_ir=updated_ir,
        changed_entity_ids=changed_ids,
        added_entity_ids=added_ids,
        removed_entity_ids=list(removed_set),
        unchanged_entity_ids=unchanged_ids,
        setting_changed=setting_changed,
        camera_changed=camera_changed,
        events_changed=events_changed,
        entity_edit_deltas=deltas,
        edit_strategy=patch.edit_strategy,
        strategy_reason=patch.strategy_reason,
        video_edit_instruction=patch.video_edit_instruction,
    )
    latency_ms = int((time.perf_counter() - t0) * 1000)
    return plan, latency_ms


def render_ir_to_video_prompt(
    ir: SceneIR,
    attached_ref_ids: list[str],
    emphasize_camera: bool = False,
) -> str:
    """Deterministically compile a SceneIR + attached reference list into a crisp video generation prompt."""
    c = ir.camera
    camera_line = (
        f"CAMERA: {c.shot_type}, {c.angle}, movement: {c.movement}, lens: {c.lens_feel}."
        + (f" Framing: {c.framing_notes}" if c.framing_notes else "")
    )

    lines: list[str] = [
        f"Generate a photorealistic {ir.duration_sec}-second cinematic video matching the provided appearance reference images.",
    ]
    if emphasize_camera:
        lines.append(camera_line)
    lines.extend(
        [
            f"SCENE: {ir.summary}",
            f"SETTING: {ir.setting.location}. Time: {ir.setting.time_of_day}. Lighting: {ir.setting.lighting}. Atmosphere: {ir.setting.atmosphere}. Style: {ir.setting.visual_style}.",
            "ENTITIES (preserve exact faces, identities, and appearances from matching reference images):",
        ]
    )
    for e in ir.entities:
        ref_tag = " [MATCH PROVIDED REFERENCE IMAGE]" if e.id in attached_ref_ids else ""
        lines.append(
            f"- {e.name} ({e.id}){ref_tag}: {e.identity_traits}; wearing/looking like: {e.appearance}. Placement: {e.position_hint}."
        )
    if ir.relationships:
        rel_str = "; ".join(f"{r.source_id} {r.relation} {r.target_id}" for r in ir.relationships)
        lines.append(f"RELATIONSHIPS: {rel_str}.")
    if ir.events:
        lines.append("TIMED ACTION BEATS:")
        for ev in ir.events:
            audio = f" Audio: {ev.audio_cue}." if ev.audio_cue else ""
            lines.append(f"- [{ev.start_sec:.1f}s-{ev.end_sec:.1f}s] {ev.action}{audio}")
    if not emphasize_camera:
        lines.append(camera_line)
    lines.append("Maintain strict identity consistency, natural physics, smooth motion, and synchronized ambient audio.")
    return "\n".join(lines)

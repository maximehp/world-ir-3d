from __future__ import annotations

import hashlib
from typing import Literal, Optional
from pydantic import BaseModel, Field


class SettingSpec(BaseModel):
    location: str = Field(..., description="Physical or fictional setting where the scene takes place.")
    time_of_day: str = Field(..., description="Time of day or lighting period, e.g. golden hour, night, overcast morning.")
    lighting: str = Field(..., description="Key lighting quality, color temperature, and shadows.")
    atmosphere: str = Field(..., description="Mood, weather, ambient motion like breeze, mist, steam, or dust.")
    visual_style: str = Field(..., description="Cinematographic aesthetic, color grading, and realism level.")
    revision: int = Field(default=1, description="Incremented only when setting visually changes.")

    def appearance_hash(self) -> str:
        payload = f"scene|{self.location}|{self.time_of_day}|{self.lighting}|{self.atmosphere}|{self.visual_style}"
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


class EntitySpec(BaseModel):
    id: str = Field(..., description="Stable snake_case identifier preserved across edits, e.g. 'lead_subject', 'chef', 'vintage_car'.")
    name: str = Field(..., description="Short human-readable label.")
    kind: Literal["person", "group", "object", "animal", "prop"] = Field(
        ..., description="General category of the entity."
    )
    identity_traits: str = Field(
        ...,
        description="Core persistent identity features (face, age, ethnicity, hair, build, or structural form) that stay locked across edits unless explicitly changed.",
    )
    appearance: str = Field(
        ...,
        description="Current mutable appearance (clothing, colors, textures, accessories, visible state).",
    )
    position_hint: str = Field(
        ..., description="Semantic spatial placement relative to the scene and other entities."
    )
    needs_reference: bool = Field(
        default=True,
        description="True for visually important persistent entities (at most 3 entities per scene) that benefit from a dedicated reference image.",
    )
    appearance_revision: int = Field(
        default=1, description="Incremented only when this entity's identity_traits or appearance changes."
    )

    def appearance_hash(self) -> str:
        payload = f"{self.id}|{self.kind}|{self.identity_traits}|{self.appearance}"
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


class RelationshipSpec(BaseModel):
    source_id: str = Field(..., description="Entity id of the subject.")
    target_id: str = Field(..., description="Entity id or 'setting' of the target.")
    relation: str = Field(..., description="Spatial or social relation, e.g. 'holding hands with', 'standing beneath', 'seated beside'.")


class TimedEvent(BaseModel):
    start_sec: float = Field(..., ge=0.0, le=10.0)
    end_sec: float = Field(..., ge=0.0, le=10.0)
    actor_ids: list[str] = Field(default_factory=list, description="Entity ids involved in this beat.")
    action: str = Field(..., description="Concrete observable motion or interaction.")
    audio_cue: str = Field(default="", description="Natural ambient sound or subtle audio cue for this beat.")


class CameraSpec(BaseModel):
    shot_type: str = Field(..., description="Framing scale, e.g. medium two-shot, wide establishing, close-up.")
    angle: str = Field(..., description="Camera angle, e.g. eye-level, low angle, high crane.")
    movement: str = Field(..., description="Camera motion over the clip, e.g. slow dolly push-in, gentle pan right, static tripod.")
    lens_feel: str = Field(..., description="Depth of field and lens character, e.g. 50mm shallow depth of field, 24mm wide.")
    framing_notes: str = Field(default="", description="Subject composition and screen placement notes.")


class SceneIR(BaseModel):
    title: str = Field(..., description="Concise title for the scene.")
    summary: str = Field(..., description="One-sentence summary of the full shot.")
    duration_sec: int = Field(default=4, ge=4, le=8)
    setting: SettingSpec
    entities: list[EntitySpec] = Field(default_factory=list)
    relationships: list[RelationshipSpec] = Field(default_factory=list)
    events: list[TimedEvent] = Field(default_factory=list)
    camera: CameraSpec


class EntityEditDelta(BaseModel):
    entity_id: str = Field(..., description="Entity id being edited.")
    preserve_identity: str = Field(
        ..., description="Exact identity features of this entity that MUST remain visually identical."
    )
    change_description: str = Field(
        ..., description="Minimal, concrete visual change to apply to this entity's reference image."
    )


class EditPlan(BaseModel):
    edit_summary: str = Field(..., description="Concise summary of the minimal edit applied.")
    updated_ir: SceneIR = Field(..., description="The complete updated Scene IR with minimal changes from the original.")
    changed_entity_ids: list[str] = Field(default_factory=list, description="Existing entity ids whose visual appearance or identity changed.")
    added_entity_ids: list[str] = Field(default_factory=list, description="Brand-new entity ids added in this edit.")
    removed_entity_ids: list[str] = Field(default_factory=list, description="Entity ids removed in this edit.")
    unchanged_entity_ids: list[str] = Field(default_factory=list, description="Existing entity ids that remain visually unchanged and can reuse cached references.")
    setting_changed: bool = Field(default=False, description="True only if the setting/location/lighting visually changed.")
    camera_changed: bool = Field(default=False, description="True if shot framing, angle, or camera movement changed.")
    events_changed: bool = Field(default=False, description="True if actions or event timing changed.")
    entity_edit_deltas: list[EntityEditDelta] = Field(
        default_factory=list,
        description="Per-entity edit instructions for Nano Banana reference image editing (only for changed_entity_ids).",
    )
    edit_strategy: Literal["video_edit", "reference_resynthesis"] = Field(
        ...,
        description=(
            "Choose 'video_edit' for appearance/wardrobe/prop/lighting edits, adding elements into the existing shot, "
            "or moderate framing refinements where keeping the original video's motion and actors is best. "
            "Choose 'reference_resynthesis' ONLY when the edit requests a radically different camera framing/angle "
            "(e.g., pulling far back to a wide aerial crane shot or switching to a tight close-up) or entirely new action/staging "
            "that cannot stay locked to the original pixel trajectory."
        ),
    )
    strategy_reason: str = Field(..., description="One-sentence justification for the chosen edit_strategy.")
    video_edit_instruction: str = Field(
        ...,
        description="Surgical natural-language directive for the video model explicitly specifying what changes and what MUST remain identical.",
    )


class ReferenceAsset(BaseModel):
    asset_id: str
    target_id: str  # "scene" or entity.id
    label: str
    cache_key: str
    revision: int
    file_path: str
    url: str
    mime_type: str = "image/jpeg"
    status: Literal["created", "edited", "reused"]
    latency_ms: int = 0
    model: str = ""
    prompt_used: str = ""


class ReferenceSyncReport(BaseModel):
    assets: list[ReferenceAsset] = Field(default_factory=list)
    reused_count: int = 0
    edited_count: int = 0
    created_count: int = 0
    reuse_ratio: float = 0.0
    total_latency_ms: int = 0


class EntityEvalScore(BaseModel):
    entity_name: str
    identity_score: int = Field(..., ge=0, le=100)
    appearance_score: int = Field(..., ge=0, le=100)
    notes: str


class ClipEvalReport(BaseModel):
    mode: Literal["single", "edit_pair", "baseline_comparison"]
    model: str = "gemini-4-hydrogen"
    instruction_adherence: int = Field(..., ge=0, le=100, description="0-100: How accurately the video obeys the prompt or edit request.")
    identity_preservation: int = Field(..., ge=0, le=100, description="0-100: How faithfully persistent entity identities match reference images / original video.")
    appearance_consistency: int = Field(..., ge=0, le=100, description="0-100: Consistency of outfits, colors, objects, and setting across frames and references.")
    temporal_coherence: int = Field(..., ge=0, le=100, description="0-100: Smoothness of motion, physics, and frame-to-frame stability without flicker/morphing.")
    unintended_change_score: int = Field(
        default=0,
        ge=0,
        le=100,
        description="0-100 (LOWER IS BETTER): Severity of unwanted changes to unaffected entities, background, lighting, or motion. 0 = zero unintended changes.",
    )
    overall_score: int = Field(..., ge=0, le=100, description="0-100 holistic quality score.")
    entity_scores: list[EntityEvalScore] = Field(default_factory=list)
    verdict: str = Field(..., description="Concise 1-2 sentence objective visual audit.")
    latency_ms: int = 0


class LatencyBreakdown(BaseModel):
    ir_compile_ms: int = 0
    reference_sync_ms: int = 0
    video_gen_ms: int = 0
    hydrogen_eval_ms: int = 0
    total_until_video_ms: int = 0


class SceneVersion(BaseModel):
    version_id: str
    version_number: int
    parent_version_id: Optional[str] = None
    prompt: str
    edit_instruction: Optional[str] = None
    mode: Literal["structured_initial", "structured_edit", "baseline_initial", "baseline_edit"]
    ir: Optional[SceneIR] = None
    edit_plan: Optional[EditPlan] = None
    references: Optional[ReferenceSyncReport] = None
    video_path: str = ""
    video_url: str = ""
    video_model: str = "gemini-omni-1.2-flash"
    video_task: str = ""
    interaction_id: Optional[str] = None
    compiled_video_prompt: str = ""
    evaluation: Optional[ClipEvalReport] = None
    latency: LatencyBreakdown = Field(default_factory=LatencyBreakdown)
    created_at: str = ""


class SceneProject(BaseModel):
    project_id: str
    title: str
    initial_prompt: str
    versions: list[SceneVersion] = Field(default_factory=list)
    created_at: str = ""

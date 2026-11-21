from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Optional
from google import genai
from google.genai import types

from .schema import ClipEvalReport, EditPlan, ReferenceAsset, SceneIR

HYDROGEN_MODEL = "gemini-4-hydrogen"

HYDROGEN_SYSTEM_PROMPT = """You are Gemini 4 Hydrogen, an independent, strict visual verification auditor for AI-generated videos.
You inspect raw MP4 video clips and appearance reference images directly.

Scoring rubric (ALL scores MUST be integers on a 0 to 100 scale):
- 90-100: Exceptional, near-flawless fidelity and stability.
- 75-89: Strong consistency with only minor, subtle flaws.
- 55-74: Noticeable drift, partial adherence, or moderate artifacts.
- 30-54: Significant identity mismatch, failed edit, or heavy unintended changes.
- 0-29: Complete failure or wrong scene/subject.

For unintended_change_score (0 to 100, LOWER IS BETTER):
- 0-10: Almost zero unintended changes to unaffected subjects, background, lighting, or camera.
- 11-25: Minor subtle shifts only.
- 26-50: Moderate unintended changes to unaffected elements.
- 51-100: Severe unintended changes (e.g., faces replaced, venue changed, camera completely different when not asked).

Be honest, objective, and strict. Do not inflate scores."""


def _client() -> genai.Client:
    return genai.Client(api_key=os.environ["GEMINI_API_KEY"])


async def evaluate_single_clip(
    video_path: Path,
    user_prompt: str,
    ir: Optional[SceneIR] = None,
    ref_assets: Optional[list[ReferenceAsset]] = None,
) -> ClipEvalReport:
    """Independent Gemini 4 Hydrogen visual audit of a generated video against prompt + reference images."""
    t0 = time.perf_counter()
    client = _client()

    parts: list = [
        f"USER PROMPT:\n{user_prompt}\n",
    ]
    if ref_assets:
        parts.append("APPEARANCE REFERENCE IMAGES (ground truth for persistent identity & appearance):")
        for asset in ref_assets[:4]:
            p = Path(asset.file_path)
            if p.exists():
                parts.append(f"Reference [{asset.target_id} - {asset.label}]:")
                parts.append(types.Part.from_bytes(data=p.read_bytes(), mime_type=asset.mime_type))

    parts.append("GENERATED VIDEO TO EVALUATE:")
    parts.append(types.Part.from_bytes(data=video_path.read_bytes(), mime_type="video/mp4"))

    entity_list = ", ".join(e.name for e in ir.entities) if ir else "main subjects"
    parts.append(
        f"Evaluate this video strictly on a 0-100 scale. Score each key entity ({entity_list}) in entity_scores. "
        f"Set mode='single', unintended_change_score=0 (since this is an initial clip). Return strict JSON."
    )

    resp = await client.aio.models.generate_content(
        model=HYDROGEN_MODEL,
        contents=parts,
        config=types.GenerateContentConfig(
            system_instruction=HYDROGEN_SYSTEM_PROMPT,
            response_mime_type="application/json",
            response_schema=ClipEvalReport,
            thinking_config=types.ThinkingConfig(thinking_level="LOW"),
        ),
    )
    report = ClipEvalReport.model_validate_json(resp.text)
    report.mode = "single"
    report.model = HYDROGEN_MODEL
    report.latency_ms = int((time.perf_counter() - t0) * 1000)
    return report


async def evaluate_edit_pair(
    original_video_path: Path,
    edited_video_path: Path,
    edit_instruction: str,
    original_prompt: str,
    edit_plan: Optional[EditPlan] = None,
    ref_assets: Optional[list[ReferenceAsset]] = None,
) -> ClipEvalReport:
    """
    Independent Gemini 4 Hydrogen pairwise visual audit comparing ORIGINAL vs EDITED video.
    Directly measures edit adherence, identity preservation across edits, and unintended visual changes!
    """
    t0 = time.perf_counter()
    client = _client()

    parts: list = [
        f"ORIGINAL SCENE PROMPT: {original_prompt}",
        f"USER EDIT REQUEST: {edit_instruction}",
    ]
    if edit_plan:
        unchanged = ", ".join(edit_plan.unchanged_entity_ids) or "none"
        changed = ", ".join(edit_plan.changed_entity_ids) or "none"
        added = ", ".join(edit_plan.added_entity_ids) or "none"
        parts.append(
            f"EXPECTED SCOPE — Changed: [{changed}], Added: [{added}], MUST REMAIN UNCHANGED: [{unchanged}], "
            f"Setting changed: {edit_plan.setting_changed}, Camera changed: {edit_plan.camera_changed}."
        )

    if ref_assets:
        parts.append("TARGET APPEARANCE REFERENCE IMAGES:")
        for asset in ref_assets[:4]:
            p = Path(asset.file_path)
            if p.exists():
                parts.append(f"Ref [{asset.target_id} - {asset.label}]:")
                parts.append(types.Part.from_bytes(data=p.read_bytes(), mime_type=asset.mime_type))

    parts.append("VIDEO 1 (ORIGINAL BEFORE EDIT):")
    parts.append(types.Part.from_bytes(data=original_video_path.read_bytes(), mime_type="video/mp4"))
    parts.append("VIDEO 2 (EDITED AFTER EDIT):")
    parts.append(types.Part.from_bytes(data=edited_video_path.read_bytes(), mime_type="video/mp4"))

    parts.append(
        "Compare VIDEO 1 and VIDEO 2 strictly on a 0-100 scale:\n"
        "- instruction_adherence (0-100): Did VIDEO 2 execute the USER EDIT REQUEST accurately?\n"
        "- identity_preservation (0-100): Do persistent characters/objects keep the exact same face/identity between VIDEO 1 and VIDEO 2?\n"
        "- appearance_consistency (0-100): Are unchanged outfits/setting preserved AND changed attributes crisp and matching references?\n"
        "- temporal_coherence (0-100): Is VIDEO 2 smooth and artifact-free?\n"
        "- unintended_change_score (0-100, LOWER IS BETTER): How much unrelated content (unaffected people, faces, background, lighting, framing if not requested) changed unintentionally? 0 = completely preserved, 100 = totally regenerated/different scene.\n"
        "- overall_score (0-100): Weighted overall edit quality.\n"
        "Set mode='edit_pair'. Return strict JSON."
    )

    resp = await client.aio.models.generate_content(
        model=HYDROGEN_MODEL,
        contents=parts,
        config=types.GenerateContentConfig(
            system_instruction=HYDROGEN_SYSTEM_PROMPT,
            response_mime_type="application/json",
            response_schema=ClipEvalReport,
            thinking_config=types.ThinkingConfig(thinking_level="LOW"),
        ),
    )
    report = ClipEvalReport.model_validate_json(resp.text)
    report.mode = "edit_pair"
    report.model = HYDROGEN_MODEL
    report.latency_ms = int((time.perf_counter() - t0) * 1000)
    return report

from __future__ import annotations

import base64
import os
import time
from pathlib import Path
from typing import Optional
from google import genai

from .carbon import render_ir_to_video_prompt
from .schema import EditPlan, ReferenceAsset, SceneIR

VIDEO_MODEL = "gemini-omni-1.2-flash"
VIDEO_API_VERSION = "v1beta"


def _client() -> genai.Client:
    return genai.Client(api_key=os.environ["GEMINI_API_KEY"])


def _extract_video_bytes(inter) -> bytes:
    d = inter.model_dump()
    ov = d.get("output_video") or {}
    if ov.get("data"):
        return base64.b64decode(ov["data"])
    for step in d.get("steps") or []:
        for c in step.get("content") or []:
            if c.get("type") == "video" and c.get("data"):
                return base64.b64decode(c["data"])
    raise RuntimeError(f"Video model returned status={inter.status} with no video data.")


async def generate_structured_video(
    ir: SceneIR,
    ref_assets: list[ReferenceAsset],
    out_path: Path,
    resolution: str = "720p",
    emphasize_camera: bool = False,
) -> dict:
    """
    Real neural video synthesis via Gemini Omni 1.2 Flash (task='reference_to_video')
    conditioned on persistent Nano Banana appearance references + compiled Scene IR.
    """
    t0 = time.perf_counter()
    client = _client()

    content: list[dict] = []
    attached_ids: list[str] = []
    for asset in ref_assets[:4]:
        raw = Path(asset.file_path).read_bytes()
        content.append(
            {"type": "text", "text": f"Appearance Reference ({asset.target_id} - {asset.label}):"}
        )
        content.append(
            {
                "type": "image",
                "data": base64.b64encode(raw).decode("ascii"),
                "mime_type": asset.mime_type,
            }
        )
        attached_ids.append(asset.target_id)

    compiled_prompt = render_ir_to_video_prompt(ir, attached_ids, emphasize_camera=emphasize_camera)
    content.append({"type": "text", "text": compiled_prompt})

    inter = await client.aio.interactions.create(
        model=VIDEO_MODEL,
        input=content,
        response_format={"type": "video", "aspect_ratio": "16:9", "resolution": resolution},
        generation_config={"video_config": {"task": "reference_to_video"}},
        store=True,
        api_version=VIDEO_API_VERSION,
    )
    video_bytes = _extract_video_bytes(inter)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(video_bytes)

    return {
        "video_path": str(out_path),
        "interaction_id": inter.id,
        "video_task": "reference_to_video",
        "compiled_prompt": compiled_prompt,
        "latency_ms": int((time.perf_counter() - t0) * 1000),
        "bytes": len(video_bytes),
    }


async def edit_structured_video(
    source_video_path: Path,
    edit_plan: EditPlan,
    ref_assets: list[ReferenceAsset],
    out_path: Path,
    resolution: str = "720p",
) -> dict:
    """
    Real neural video editing conditioned on Scene IR diff + persistent references.
    - 'video_edit': passes source MP4 + changed/added entity reference images (and unchanged hero refs)
      to Gemini Omni 1.2 Flash with task='edit'.
    - 'reference_resynthesis': passes ALL persistent scene & entity references + full updated Scene IR
      to task='reference_to_video' when camera framing/staging radically changes.
    """
    ir = edit_plan.updated_ir
    if edit_plan.edit_strategy == "reference_resynthesis":
        res = await generate_structured_video(
            ir, ref_assets, out_path, resolution=resolution, emphasize_camera=edit_plan.camera_changed
        )
        res["video_task"] = "reference_to_video (resynthesis)"
        return res

    t0 = time.perf_counter()
    client = _client()
    src_bytes = source_video_path.read_bytes()

    content: list[dict] = [
        {
            "type": "video",
            "data": base64.b64encode(src_bytes).decode("ascii"),
            "mime_type": "video/mp4",
        }
    ]

    # Attach changed & added entity references first (highest priority), plus up to 1 unchanged key entity ref
    priority_ids = set(edit_plan.changed_entity_ids) | set(edit_plan.added_entity_ids)
    if edit_plan.setting_changed:
        priority_ids.add("scene")

    selected_refs = [a for a in ref_assets if a.target_id in priority_ids]
    other_entity_refs = [
        a for a in ref_assets if a.target_id not in priority_ids and a.target_id != "scene"
    ]
    for extra in other_entity_refs:
        if len(selected_refs) < 3:
            selected_refs.append(extra)

    for asset in selected_refs:
        raw = Path(asset.file_path).read_bytes()
        role_note = "UPDATED/NEW TARGET REFERENCE" if asset.target_id in priority_ids else "UNCHANGED IDENTITY LOCK REFERENCE"
        content.append(
            {"type": "text", "text": f"{role_note} ({asset.target_id} - {asset.label}):"}
        )
        content.append(
            {
                "type": "image",
                "data": base64.b64encode(raw).decode("ascii"),
                "mime_type": asset.mime_type,
            }
        )

    unchanged_names = [
        e.name for e in ir.entities if e.id in set(edit_plan.unchanged_entity_ids)
    ]
    lock_clause = (
        f"STRICTLY PRESERVE UNCHANGED: {', '.join(unchanged_names)}"
        if unchanged_names
        else "STRICTLY PRESERVE all unaffected subjects"
    )
    if not edit_plan.setting_changed:
        lock_clause += f", exact setting ({ir.setting.location}), lighting ({ir.setting.lighting})"
    if not edit_plan.camera_changed:
        lock_clause += f", exact camera framing & motion ({ir.camera.shot_type}, {ir.camera.movement})"

    edit_prompt = (
        f"SURGICAL VIDEO EDIT: {edit_plan.video_edit_instruction}\n"
        f"{lock_clause}.\n"
        f"Match the attached updated appearance reference image(s) faithfully while preserving smooth temporal continuity and original timing."
    )
    content.append({"type": "text", "text": edit_prompt})

    # Note: Gemini Omni API forbids 'aspect_ratio' in response_format for task='edit' (inherits source video aspect ratio)
    inter = await client.aio.interactions.create(
        model=VIDEO_MODEL,
        input=content,
        response_format={"type": "video", "resolution": resolution},
        generation_config={"video_config": {"task": "edit"}},
        store=True,
        api_version=VIDEO_API_VERSION,
    )
    video_bytes = _extract_video_bytes(inter)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(video_bytes)

    return {
        "video_path": str(out_path),
        "interaction_id": inter.id,
        "video_task": "edit (video+refs)",
        "compiled_prompt": edit_prompt,
        "latency_ms": int((time.perf_counter() - t0) * 1000),
        "bytes": len(video_bytes),
    }


async def generate_baseline_video(
    prompt: str,
    out_path: Path,
    resolution: str = "720p",
) -> dict:
    """
    Naive text-only baseline (no Scene IR, no Nano Banana references, no video-edit conditioning).
    Used in benchmarks to measure concrete improvements of Structured Generative Video.
    """
    t0 = time.perf_counter()
    client = _client()
    inter = await client.aio.interactions.create(
        model=VIDEO_MODEL,
        input=prompt,
        response_format={"type": "video", "aspect_ratio": "16:9", "resolution": resolution},
        generation_config={"video_config": {"task": "text_to_video"}},
        store=True,
        api_version=VIDEO_API_VERSION,
    )
    video_bytes = _extract_video_bytes(inter)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(video_bytes)

    return {
        "video_path": str(out_path),
        "interaction_id": inter.id,
        "video_task": "text_to_video (baseline)",
        "compiled_prompt": prompt,
        "latency_ms": int((time.perf_counter() - t0) * 1000),
        "bytes": len(video_bytes),
    }

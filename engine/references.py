from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path
from typing import Optional
from google import genai
from google.genai import types

from .schema import (
    EditPlan,
    EntityEditDelta,
    EntitySpec,
    ReferenceAsset,
    ReferenceSyncReport,
    SceneIR,
)

# Nano Banana 2 Lite (~6s) for fast hackathon responsiveness; Nano Banana 2.1 available for high-fidelity mode
DEFAULT_IMAGE_MODEL = "gemini-3.1-flash-lite-image"
HIGH_FIDELITY_IMAGE_MODEL = "gemini-nano-banana-2.1"


def _client() -> genai.Client:
    return genai.Client(api_key=os.environ["GEMINI_API_KEY"])


def _extract_image_bytes(resp) -> tuple[bytes, str]:
    for cand in getattr(resp, "candidates", []) or []:
        content = getattr(cand, "content", None)
        for part in getattr(content, "parts", []) or []:
            inline = getattr(part, "inline_data", None)
            if inline and inline.data:
                return inline.data, (inline.mime_type or "image/jpeg")
    raise RuntimeError("Nano Banana returned no image data.")


class ReferenceCacheManager:
    """Manages parallel generation, identity-locked editing, and persistent caching of Nano Banana references."""

    def __init__(self, cache_dir: Path, url_prefix: str = "/media/refs"):
        self.cache_dir = cache_dir
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.url_prefix = url_prefix.rstrip("/")
        self.index_path = self.cache_dir / "index.json"
        self._index: dict[str, dict] = self._load_index()

    def _load_index(self) -> dict[str, dict]:
        if self.index_path.exists():
            try:
                return json.loads(self.index_path.read_text("utf-8"))
            except Exception:
                return {}
        return {}

    def _save_index(self) -> None:
        self.index_path.write_text(json.dumps(self._index, indent=2), encoding="utf-8")

    def _lookup_cached(self, cache_key: str) -> Optional[dict]:
        entry = self._index.get(cache_key)
        if entry and Path(entry["file_path"]).exists():
            return entry
        return None

    async def _generate_image(self, prompt: str, model: str) -> tuple[bytes, str, int]:
        t0 = time.perf_counter()
        client = _client()
        resp = await client.aio.models.generate_content(
            model=model,
            contents=prompt,
            config=types.GenerateContentConfig(response_modalities=["IMAGE"]),
        )
        raw, mime = _extract_image_bytes(resp)
        return raw, mime, int((time.perf_counter() - t0) * 1000)

    async def _edit_image(
        self, prev_image_path: str, prev_mime: str, edit_prompt: str, model: str
    ) -> tuple[bytes, str, int]:
        t0 = time.perf_counter()
        client = _client()
        prev_bytes = Path(prev_image_path).read_bytes()
        resp = await client.aio.models.generate_content(
            model=model,
            contents=[
                types.Part.from_bytes(data=prev_bytes, mime_type=prev_mime),
                edit_prompt,
            ],
            config=types.GenerateContentConfig(response_modalities=["IMAGE"]),
        )
        raw, mime = _extract_image_bytes(resp)
        return raw, mime, int((time.perf_counter() - t0) * 1000)

    def _store(
        self,
        cache_key: str,
        target_id: str,
        label: str,
        revision: int,
        raw: bytes,
        mime: str,
        model: str,
        prompt_used: str,
        status: str,
        latency_ms: int,
    ) -> ReferenceAsset:
        ext = "jpg" if "jpeg" in mime or "jpg" in mime else "png"
        filename = f"{target_id}_r{revision}_{cache_key}.{ext}"
        file_path = self.cache_dir / filename
        file_path.write_bytes(raw)
        url = f"{self.url_prefix}/{filename}"
        record = {
            "asset_id": f"{target_id}_{cache_key}",
            "target_id": target_id,
            "label": label,
            "cache_key": cache_key,
            "revision": revision,
            "file_path": str(file_path),
            "url": url,
            "mime_type": mime,
            "model": model,
            "prompt_used": prompt_used,
        }
        self._index[cache_key] = record
        self._save_index()
        return ReferenceAsset(**record, status=status, latency_ms=latency_ms)

    def _build_scene_prompt(self, ir: SceneIR) -> str:
        s = ir.setting
        return (
            f"Cinematic 16:9 wide establishing plate of the empty/ambient setting without close-up hero faces: "
            f"{s.location}. Time of day: {s.time_of_day}. Lighting: {s.lighting}. "
            f"Atmosphere: {s.atmosphere}. Visual style: {s.visual_style}. "
            f"Photorealistic film still, rich detail, clean composition."
        )

    def _build_entity_prompt(self, ent: EntitySpec, ir: SceneIR) -> str:
        style = f"{ir.setting.visual_style}, {ir.setting.lighting}"
        if ent.kind == "person":
            return (
                f"Clean photorealistic character appearance reference portrait (waist-up / three-quarter view) "
                f"of {ent.name}: {ent.identity_traits}. Wearing: {ent.appearance}. "
                f"Consistent lighting cue: {style}. Clear unobstructed view of face and outfit on a soft neutral backdrop."
            )
        if ent.kind == "group":
            return (
                f"Photorealistic group appearance reference showing {ent.name}: {ent.identity_traits}. "
                f"Appearance: {ent.appearance}. Lighting/style: {style}. Clear cinematic detail."
            )
        return (
            f"Clean photorealistic visual reference of {ent.name} ({ent.kind}): {ent.identity_traits}. "
            f"Appearance details: {ent.appearance}. Style/lighting: {style}. Centered, sharp detail."
        )

    async def sync_references(
        self,
        ir: SceneIR,
        prev_assets: Optional[list[ReferenceAsset]] = None,
        edit_plan: Optional[EditPlan] = None,
        image_model: str = DEFAULT_IMAGE_MODEL,
        scope_salt: str = "",
    ) -> ReferenceSyncReport:
        """
        Generate or reuse appearance references in parallel.
        - Unchanged scene/entities -> instant cache reuse (0ms, 0 API calls).
        - Changed entities with prior ref -> Nano Banana identity-locked image edit.
        - New entities -> parallel fresh generation.
        """
        t0 = time.perf_counter()
        prev_by_target: dict[str, ReferenceAsset] = {
            a.target_id: a for a in (prev_assets or [])
        }
        delta_by_id: dict[str, EntityEditDelta] = {
            d.entity_id: d for d in (edit_plan.entity_edit_deltas if edit_plan else [])
        }

        async def resolve_scene() -> ReferenceAsset:
            cache_key = f"{scope_salt}_{ir.setting.appearance_hash()}" if scope_salt else ir.setting.appearance_hash()
            # Reuse if setting not changed and prev exists, OR exact hash cache hit
            if edit_plan and not edit_plan.setting_changed and "scene" in prev_by_target:
                prev = prev_by_target["scene"]
                return prev.model_copy(update={"status": "reused", "latency_ms": 0})
            cached = self._lookup_cached(cache_key)
            if cached:
                return ReferenceAsset(**cached, status="reused", latency_ms=0)

            prompt = self._build_scene_prompt(ir)
            if edit_plan and edit_plan.setting_changed and "scene" in prev_by_target:
                prev = prev_by_target["scene"]
                edit_prompt = (
                    f"Edit this scene establishing reference image: {edit_plan.edit_summary}. "
                    f"Updated setting details: {ir.setting.location}, {ir.setting.time_of_day}, "
                    f"{ir.setting.lighting}, {ir.setting.atmosphere}. "
                    f"Preserve the underlying architecture and spatial layout unless explicitly changed."
                )
                raw, mime, ms = await self._edit_image(prev.file_path, prev.mime_type, edit_prompt, image_model)
                return self._store(
                    cache_key, "scene", "Scene Setting", ir.setting.revision,
                    raw, mime, image_model, edit_prompt, "edited", ms,
                )

            raw, mime, ms = await self._generate_image(prompt, image_model)
            return self._store(
                cache_key, "scene", "Scene Setting", ir.setting.revision,
                raw, mime, image_model, prompt, "created", ms,
            )

        async def resolve_entity(ent: EntitySpec) -> ReferenceAsset:
            base_hash = ent.appearance_hash()
            cache_key = f"{scope_salt}_{base_hash}" if scope_salt else base_hash

            # Exact unchanged reuse
            if edit_plan and ent.id in edit_plan.unchanged_entity_ids and ent.id in prev_by_target:
                prev = prev_by_target[ent.id]
                return prev.model_copy(update={"status": "reused", "latency_ms": 0})

            cached = self._lookup_cached(cache_key)
            if cached:
                return ReferenceAsset(**cached, status="reused", latency_ms=0)

            # Identity-locked edit of previous reference image when an existing entity changes appearance!
            if edit_plan and ent.id in edit_plan.changed_entity_ids and ent.id in prev_by_target:
                prev = prev_by_target[ent.id]
                delta = delta_by_id.get(ent.id)
                preserve = delta.preserve_identity if delta else ent.identity_traits
                change = delta.change_description if delta else ent.appearance
                edit_prompt = (
                    f"Edit this appearance reference image for {ent.name}. "
                    f"STRICT IDENTITY LOCK — keep COMPLETELY IDENTICAL: {preserve}, same face, pose, proportions, and neutral background. "
                    f"CHANGE ONLY: {change}. Full updated appearance: {ent.appearance}."
                )
                raw, mime, ms = await self._edit_image(prev.file_path, prev.mime_type, edit_prompt, image_model)
                return self._store(
                    cache_key, ent.id, ent.name, ent.appearance_revision,
                    raw, mime, image_model, edit_prompt, "edited", ms,
                )

            prompt = self._build_entity_prompt(ent, ir)
            raw, mime, ms = await self._generate_image(prompt, image_model)
            return self._store(
                cache_key, ent.id, ent.name, ent.appearance_revision,
                raw, mime, image_model, prompt, "created", ms,
            )

        tasks = [resolve_scene()]
        ref_entities = [e for e in ir.entities if e.needs_reference][:3]
        for ent in ref_entities:
            tasks.append(resolve_entity(ent))

        assets = list(await asyncio.gather(*tasks))
        reused = sum(1 for a in assets if a.status == "reused")
        edited = sum(1 for a in assets if a.status == "edited")
        created = sum(1 for a in assets if a.status == "created")
        total = len(assets)
        reuse_ratio = round(reused / total, 3) if total else 0.0

        return ReferenceSyncReport(
            assets=assets,
            reused_count=reused,
            edited_count=edited,
            created_count=created,
            reuse_ratio=reuse_ratio,
            total_latency_ms=int((time.perf_counter() - t0) * 1000),
        )

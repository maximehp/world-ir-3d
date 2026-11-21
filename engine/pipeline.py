from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Callable, Optional

from .carbon import compile_edit_plan, compile_scene_ir
from .hydrogen import evaluate_edit_pair, evaluate_single_clip
from .references import DEFAULT_IMAGE_MODEL, ReferenceCacheManager
from .schema import LatencyBreakdown, SceneProject, SceneVersion
from .video import edit_structured_video, generate_baseline_video, generate_structured_video


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class StructuredVideoPipeline:
    """Minimal orchestrator for Structured Generative Video projects."""

    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.projects_dir = data_dir / "projects"
        self.videos_dir = data_dir / "videos"
        self.refs_dir = data_dir / "refs"
        self.projects_dir.mkdir(parents=True, exist_ok=True)
        self.videos_dir.mkdir(parents=True, exist_ok=True)
        self.refs = ReferenceCacheManager(self.refs_dir, url_prefix="/media/refs")

    def _project_path(self, project_id: str) -> Path:
        return self.projects_dir / f"{project_id}.json"

    def save_project(self, project: SceneProject) -> None:
        self._project_path(project.project_id).write_text(
            project.model_dump_json(indent=2), encoding="utf-8"
        )

    def load_project(self, project_id: str) -> SceneProject:
        p = self._project_path(project_id)
        if not p.exists():
            raise FileNotFoundError(f"Project {project_id} not found")
        return SceneProject.model_validate_json(p.read_text("utf-8"))

    def list_projects(self) -> list[SceneProject]:
        items: list[SceneProject] = []
        for p in sorted(self.projects_dir.glob("*.json"), key=lambda f: f.stat().st_mtime, reverse=True):
            try:
                items.append(SceneProject.model_validate_json(p.read_text("utf-8")))
            except Exception:
                continue
        return items

    async def create_project_stream(
        self,
        prompt: str,
        image_model: str = DEFAULT_IMAGE_MODEL,
        resolution: str = "720p",
        run_eval: bool = True,
    ) -> AsyncIterator[dict[str, Any]]:
        """Generate initial structured scene clip, yielding real-time phase events."""
        project_id = f"proj_{uuid.uuid4().hex[:8]}"
        version_id = "v1"
        latency = LatencyBreakdown()

        yield {"stage": "compiling_ir", "message": "Gemini 4 Carbon compiling Scene IR..."}
        ir, ir_ms = await compile_scene_ir(prompt)
        latency.ir_compile_ms = ir_ms

        project = SceneProject(
            project_id=project_id,
            title=ir.title,
            initial_prompt=prompt,
            versions=[],
            created_at=_now_iso(),
        )
        version = SceneVersion(
            version_id=version_id,
            version_number=1,
            prompt=prompt,
            mode="structured_initial",
            ir=ir,
            latency=latency,
            created_at=_now_iso(),
        )
        project.versions.append(version)
        self.save_project(project)

        yield {
            "stage": "ir_ready",
            "project_id": project_id,
            "version_id": version_id,
            "latency_ms": ir_ms,
            "ir": ir.model_dump(),
            "message": f"Scene IR compiled in {ir_ms / 1000:.2f}s ({len(ir.entities)} entities).",
        }

        yield {
            "stage": "generating_refs",
            "message": "Nano Banana generating persistent appearance references in parallel...",
        }
        ref_report = await self.refs.sync_references(
            ir=ir,
            prev_assets=None,
            edit_plan=None,
            image_model=image_model,
            scope_salt=project_id,
        )
        latency.reference_sync_ms = ref_report.total_latency_ms
        version.references = ref_report
        self.save_project(project)

        yield {
            "stage": "refs_ready",
            "project_id": project_id,
            "version_id": version_id,
            "references": ref_report.model_dump(),
            "message": f"Generated {len(ref_report.assets)} appearance references in {ref_report.total_latency_ms / 1000:.2f}s.",
        }

        yield {
            "stage": "generating_video",
            "message": "Gemini Omni 1.2 Flash synthesizing reference-conditioned video...",
        }
        vid_filename = f"{project_id}_{version_id}.mp4"
        vid_path = self.videos_dir / vid_filename
        vid_res = await generate_structured_video(
            ir=ir,
            ref_assets=ref_report.assets,
            out_path=vid_path,
            resolution=resolution,
        )
        latency.video_gen_ms = vid_res["latency_ms"]
        latency.total_until_video_ms = (
            latency.ir_compile_ms + latency.reference_sync_ms + latency.video_gen_ms
        )
        version.video_path = str(vid_path)
        version.video_url = f"/media/videos/{vid_filename}"
        version.video_task = vid_res["video_task"]
        version.interaction_id = vid_res["interaction_id"]
        version.compiled_video_prompt = vid_res["compiled_prompt"]
        version.latency = latency
        self.save_project(project)

        yield {
            "stage": "video_ready",
            "project_id": project_id,
            "version_id": version_id,
            "version": version.model_dump(),
            "message": f"Neural video synthesized in {vid_res['latency_ms'] / 1000:.2f}s.",
        }

        if run_eval:
            yield {
                "stage": "evaluating",
                "message": "Gemini 4 Hydrogen independently auditing visual consistency...",
            }
            eval_report = await evaluate_single_clip(
                video_path=vid_path,
                user_prompt=prompt,
                ir=ir,
                ref_assets=ref_report.assets,
            )
            latency.hydrogen_eval_ms = eval_report.latency_ms
            version.evaluation = eval_report
            version.latency = latency
            self.save_project(project)

            yield {
                "stage": "eval_ready",
                "project_id": project_id,
                "version_id": version_id,
                "evaluation": eval_report.model_dump(),
                "version": version.model_dump(),
                "message": f"Hydrogen audit complete (overall {eval_report.overall_score}/100).",
            }

        yield {"stage": "done", "project": project.model_dump()}

    async def edit_project_stream(
        self,
        project_id: str,
        edit_instruction: str,
        parent_version_id: Optional[str] = None,
        image_model: str = DEFAULT_IMAGE_MODEL,
        resolution: str = "720p",
        run_eval: bool = True,
    ) -> AsyncIterator[dict[str, Any]]:
        """Apply a natural-language edit to an existing version, streaming fast IR ack + video synthesis."""
        project = self.load_project(project_id)
        if not project.versions:
            raise ValueError("Project has no versions to edit.")

        parent = next(
            (v for v in project.versions if v.version_id == parent_version_id),
            project.versions[-1],
        )
        if not parent.ir:
            raise ValueError("Parent version has no Scene IR.")

        version_num = len(project.versions) + 1
        version_id = f"v{version_num}"
        latency = LatencyBreakdown()

        yield {"stage": "compiling_ir", "message": "Gemini 4 Carbon compiling minimal Scene IR edit..."}
        edit_plan, ir_ms = await compile_edit_plan(parent.ir, edit_instruction)
        latency.ir_compile_ms = ir_ms

        version = SceneVersion(
            version_id=version_id,
            version_number=version_num,
            parent_version_id=parent.version_id,
            prompt=project.initial_prompt,
            edit_instruction=edit_instruction,
            mode="structured_edit",
            ir=edit_plan.updated_ir,
            edit_plan=edit_plan,
            latency=latency,
            created_at=_now_iso(),
        )
        project.versions.append(version)
        self.save_project(project)

        yield {
            "stage": "ir_ready",
            "project_id": project_id,
            "version_id": version_id,
            "latency_ms": ir_ms,
            "edit_plan": edit_plan.model_dump(),
            "ir": edit_plan.updated_ir.model_dump(),
            "message": (
                f"Structural IR edit acknowledged in {ir_ms / 1000:.2f}s — "
                f"changed: {edit_plan.changed_entity_ids or ['none']}, "
                f"added: {edit_plan.added_entity_ids or ['none']}, "
                f"reusing: {edit_plan.unchanged_entity_ids} "
                f"(strategy: {edit_plan.edit_strategy})."
            ),
        }

        yield {
            "stage": "generating_refs",
            "message": "Nano Banana updating only affected appearance references (reusing cached untouched refs)...",
        }
        prev_assets = parent.references.assets if parent.references else []
        ref_report = await self.refs.sync_references(
            ir=edit_plan.updated_ir,
            prev_assets=prev_assets,
            edit_plan=edit_plan,
            image_model=image_model,
            scope_salt=project_id,
        )
        latency.reference_sync_ms = ref_report.total_latency_ms
        version.references = ref_report
        self.save_project(project)

        yield {
            "stage": "refs_ready",
            "project_id": project_id,
            "version_id": version_id,
            "references": ref_report.model_dump(),
            "message": (
                f"References synced in {ref_report.total_latency_ms / 1000:.2f}s — "
                f"{ref_report.reused_count} reused, {ref_report.edited_count} identity-edited, "
                f"{ref_report.created_count} created ({int(ref_report.reuse_ratio * 100)}% cache reuse)."
            ),
        }

        yield {
            "stage": "generating_video",
            "message": f"Gemini Omni 1.2 Flash executing neural {edit_plan.edit_strategy}...",
        }
        vid_filename = f"{project_id}_{version_id}.mp4"
        vid_path = self.videos_dir / vid_filename
        vid_res = await edit_structured_video(
            source_video_path=Path(parent.video_path),
            edit_plan=edit_plan,
            ref_assets=ref_report.assets,
            out_path=vid_path,
            resolution=resolution,
        )
        latency.video_gen_ms = vid_res["latency_ms"]
        latency.total_until_video_ms = (
            latency.ir_compile_ms + latency.reference_sync_ms + latency.video_gen_ms
        )
        version.video_path = str(vid_path)
        version.video_url = f"/media/videos/{vid_filename}"
        version.video_task = vid_res["video_task"]
        version.interaction_id = vid_res["interaction_id"]
        version.compiled_video_prompt = vid_res["compiled_prompt"]
        version.latency = latency
        self.save_project(project)

        yield {
            "stage": "video_ready",
            "project_id": project_id,
            "version_id": version_id,
            "version": version.model_dump(),
            "message": f"Edited neural video completed in {vid_res['latency_ms'] / 1000:.2f}s.",
        }

        if run_eval:
            yield {
                "stage": "evaluating",
                "message": "Gemini 4 Hydrogen comparing Original vs Edited video for identity & edit fidelity...",
            }
            eval_report = await evaluate_edit_pair(
                original_video_path=Path(parent.video_path),
                edited_video_path=vid_path,
                edit_instruction=edit_instruction,
                original_prompt=project.initial_prompt,
                edit_plan=edit_plan,
                ref_assets=ref_report.assets,
            )
            latency.hydrogen_eval_ms = eval_report.latency_ms
            version.evaluation = eval_report
            version.latency = latency
            self.save_project(project)

            yield {
                "stage": "eval_ready",
                "project_id": project_id,
                "version_id": version_id,
                "evaluation": eval_report.model_dump(),
                "version": version.model_dump(),
                "message": (
                    f"Hydrogen audit: adherence {eval_report.instruction_adherence}, "
                    f"identity {eval_report.identity_preservation}, "
                    f"unintended changes {eval_report.unintended_change_score}."
                ),
            }

        yield {"stage": "done", "project": project.model_dump()}

    async def run_baseline_edit_comparison(
        self,
        original_video_path: Path,
        original_prompt: str,
        edit_instruction: str,
        out_name: str,
        resolution: str = "720p",
    ) -> dict[str, Any]:
        """Naive text-only baseline: re-prompts text_to_video with combined prompt, then audited by Hydrogen."""
        combined_prompt = f"{original_prompt.strip()} Modification: {edit_instruction.strip()}"
        vid_path = self.videos_dir / f"{out_name}.mp4"
        vid_res = await generate_baseline_video(
            prompt=combined_prompt,
            out_path=vid_path,
            resolution=resolution,
        )
        eval_report = await evaluate_edit_pair(
            original_video_path=original_video_path,
            edited_video_path=vid_path,
            edit_instruction=edit_instruction,
            original_prompt=original_prompt,
            edit_plan=None,
            ref_assets=None,
        )
        return {
            "video_path": str(vid_path),
            "video_url": f"/media/videos/{out_name}.mp4",
            "latency_ms": vid_res["latency_ms"],
            "evaluation": eval_report.model_dump(),
            "prompt": combined_prompt,
        }

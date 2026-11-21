"""
End-to-end Benchmark Suite for Structured Generative Video.

Runs real neural video generation, edits, and independent Gemini 4 Hydrogen audits across:
1. Primary Benchmark (Cinematic Outdoor Wedding):
   - Initial structured generation (Carbon -> Nano Banana -> Gemini Omni 1.2 Flash -> Hydrogen)
   - Edit 1: Appearance/wardrobe edit ("Change only the bride's wedding dress to a rich emerald green satin gown.")
   - Edit 2: Entity addition ("Add warmly dressed wedding guests seated on wooden chairs along both sides of the garden aisle smiling and watching the couple.")
   - Edit 3: Camera framing edit ("Change camera framing to a wider elevated crane shot pulling gently back to reveal the full floral arch and sunlit garden aisle.")
   - Naive prompt-only baselines on Edit 1 & Edit 2 for direct apples-to-apples Hydrogen comparison.
2. Secondary Benchmark (General Non-Wedding Scene — Late-Night Tokyo Ramen Kitchen):
   - Initial structured generation
   - Edit 1: Wardrobe + new entity ("Change the chef's navy happi coat to a crisp crimson chef jacket and add a tabby cat sitting quietly on the wooden counter watching him.")
   - Naive prompt-only baseline on Edit 1.

Saves full projects into ./data/projects/ (immediately viewable in the Studio UI)
and structured metrics into ./data/benchmark_results.json.
"""
from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

from engine.pipeline import StructuredVideoPipeline
from engine.references import DEFAULT_IMAGE_MODEL

WEDDING_PROMPT = (
    "A cinematic golden-hour outdoor wedding in a lush botanical garden: a bride in an ivory lace "
    "off-the-shoulder gown and a groom in a tailored charcoal tuxedo stand holding hands beneath a "
    "white rose and eucalyptus floral arch as a gentle breeze lifts her sheer veil, with a slow dolly push-in."
)

WEDDING_EDITS = [
    ("Dress Change (Appearance Lock)", "Change only the bride's wedding dress to a rich emerald green satin gown."),
    ("Add Guests (Entity Addition)", "Add warmly dressed wedding guests seated on wooden chairs along both sides of the garden aisle smiling and watching the couple."),
    ("Camera Framing (Wide Crane)", "Change the camera framing to a wider elevated crane shot pulling gently back to reveal the full floral arch, the couple, and the sunlit garden aisle."),
]

RAMEN_PROMPT = (
    "A cinematic shot inside a cozy late-night Tokyo ramen shop: a focused ramen chef in a dark navy "
    "happi coat lifts steaming noodles from a glowing iron pot while warm red lanterns sway outside "
    "the rain-streaked window, slow tracking shot left to right."
)

RAMEN_EDIT = (
    "Outfit + New Entity (Generality)",
    "Change the chef's dark navy happi coat to a crisp crimson chef jacket and add a ginger tabby cat sitting quietly on the wooden counter watching him.",
)


async def _consume_create(pipeline: StructuredVideoPipeline, prompt: str, label: str):
    proj = None
    async for ev in pipeline.create_project_stream(prompt=prompt, image_model=DEFAULT_IMAGE_MODEL, resolution="720p", run_eval=True):
        stage = ev.get("stage")
        if stage in ("ir_ready", "refs_ready", "video_ready", "eval_ready"):
            print(f"[{label}][{stage}] {ev.get('message')}")
        if stage == "done":
            proj = ev["project"]
    return proj


async def _consume_edit(pipeline: StructuredVideoPipeline, project_id: str, parent_vid: str, edit_text: str, label: str):
    proj = None
    async for ev in pipeline.edit_project_stream(
        project_id=project_id,
        edit_instruction=edit_text,
        parent_version_id=parent_vid,
        image_model=DEFAULT_IMAGE_MODEL,
        resolution="720p",
        run_eval=True,
    ):
        stage = ev.get("stage")
        if stage in ("ir_ready", "refs_ready", "video_ready", "eval_ready"):
            print(f"[{label}][{stage}] {ev.get('message')}")
        if stage == "done":
            proj = ev["project"]
    return proj


async def run_wedding_suite(pipeline: StructuredVideoPipeline):
    print("\n================ PRIMARY BENCHMARK: WEDDING ================")
    proj = await _consume_create(pipeline, WEDDING_PROMPT, "Wedding-v1")
    pid = proj["project_id"]
    v1 = proj["versions"][0]
    v1_path = Path(v1["video_path"])

    # Run all 3 edits branching cleanly from v1 (in parallel for speed, wait: saving project JSON concurrently could race, so run edits sequentially or with baseline in parallel!)
    comparisons = []
    edit_versions = []

    for idx, (edit_label, edit_text) in enumerate(WEDDING_EDITS, start=1):
        # Run structured edit and (for edits 1 & 2) naive baseline IN PARALLEL!
        edit_coro = _consume_edit(pipeline, pid, "v1", edit_text, f"Wedding-Edit{idx}")
        if idx in (1, 2):
            base_coro = pipeline.run_baseline_edit_comparison(
                original_video_path=v1_path,
                original_prompt=WEDDING_PROMPT,
                edit_instruction=edit_text,
                out_name=f"baseline_wedding_edit{idx}",
                resolution="720p",
            )
            proj, base_res = await asyncio.gather(edit_coro, base_coro)
            sv = proj["versions"][-1]
            edit_versions.append((edit_label, sv))
            comparisons.append({
                "scene_name": "Primary: Outdoor Wedding",
                "edit_label": edit_label,
                "edit_instruction": edit_text,
                "original_video_url": v1["video_url"],
                "structured": {
                    "version_id": sv["version_id"],
                    "video_url": sv["video_url"],
                    "video_task": sv["video_task"],
                    "ir_ack_ms": sv["latency"]["ir_compile_ms"],
                    "ref_sync_ms": sv["latency"]["reference_sync_ms"],
                    "video_gen_ms": sv["latency"]["video_gen_ms"],
                    "reuse_ratio": sv["references"]["reuse_ratio"],
                    "reused_count": sv["references"]["reused_count"],
                    "total_refs": len(sv["references"]["assets"]),
                    "eval": sv["evaluation"],
                },
                "baseline": {
                    "video_url": base_res["video_url"],
                    "video_gen_ms": base_res["latency_ms"],
                    "eval": base_res["evaluation"],
                },
            })
        else:
            # Also run baseline on camera framing edit so all 3 wedding edits have baseline comparisons!
            base_coro = pipeline.run_baseline_edit_comparison(
                original_video_path=v1_path,
                original_prompt=WEDDING_PROMPT,
                edit_instruction=edit_text,
                out_name=f"baseline_wedding_edit{idx}",
                resolution="720p",
            )
            proj, base_res = await asyncio.gather(edit_coro, base_coro)
            sv = proj["versions"][-1]
            edit_versions.append((edit_label, sv))
            comparisons.append({
                "scene_name": "Primary: Outdoor Wedding",
                "edit_label": edit_label,
                "edit_instruction": edit_text,
                "original_video_url": v1["video_url"],
                "structured": {
                    "version_id": sv["version_id"],
                    "video_url": sv["video_url"],
                    "video_task": sv["video_task"],
                    "ir_ack_ms": sv["latency"]["ir_compile_ms"],
                    "ref_sync_ms": sv["latency"]["reference_sync_ms"],
                    "video_gen_ms": sv["latency"]["video_gen_ms"],
                    "reuse_ratio": sv["references"]["reuse_ratio"],
                    "reused_count": sv["references"]["reused_count"],
                    "total_refs": len(sv["references"]["assets"]),
                    "eval": sv["evaluation"],
                },
                "baseline": {
                    "video_url": base_res["video_url"],
                    "video_gen_ms": base_res["latency_ms"],
                    "eval": base_res["evaluation"],
                },
            })

    return proj, comparisons


async def run_ramen_suite(pipeline: StructuredVideoPipeline):
    print("\n================ SECONDARY BENCHMARK: TOKYO RAMEN SHOP ================")
    proj = await _consume_create(pipeline, RAMEN_PROMPT, "Ramen-v1")
    pid = proj["project_id"]
    v1 = proj["versions"][0]
    v1_path = Path(v1["video_path"])

    edit_label, edit_text = RAMEN_EDIT
    edit_coro = _consume_edit(pipeline, pid, "v1", edit_text, "Ramen-Edit1")
    base_coro = pipeline.run_baseline_edit_comparison(
        original_video_path=v1_path,
        original_prompt=RAMEN_PROMPT,
        edit_instruction=edit_text,
        out_name="baseline_ramen_edit1",
        resolution="720p",
    )
    proj, base_res = await asyncio.gather(edit_coro, base_coro)
    sv = proj["versions"][-1]

    comparison = {
        "scene_name": "Secondary: Tokyo Ramen Kitchen",
        "edit_label": edit_label,
        "edit_instruction": edit_text,
        "original_video_url": v1["video_url"],
        "structured": {
            "version_id": sv["version_id"],
            "video_url": sv["video_url"],
            "video_task": sv["video_task"],
            "ir_ack_ms": sv["latency"]["ir_compile_ms"],
            "ref_sync_ms": sv["latency"]["reference_sync_ms"],
            "video_gen_ms": sv["latency"]["video_gen_ms"],
            "reuse_ratio": sv["references"]["reuse_ratio"],
            "reused_count": sv["references"]["reused_count"],
            "total_refs": len(sv["references"]["assets"]),
            "eval": sv["evaluation"],
        },
        "baseline": {
            "video_url": base_res["video_url"],
            "video_gen_ms": base_res["latency_ms"],
            "eval": base_res["evaluation"],
        },
    }
    return proj, [comparison]


async def main():
    t0 = time.perf_counter()
    pipeline = StructuredVideoPipeline(ROOT / "data")

    # Run Primary (Wedding) and Secondary (Tokyo Ramen) suites in parallel to minimize wall-clock time!
    (wed_proj, wed_comps), (ramen_proj, ramen_comps) = await asyncio.gather(
        run_wedding_suite(pipeline),
        run_ramen_suite(pipeline),
    )

    all_comps = wed_comps + ramen_comps
    results = {
        "total_benchmark_sec": round(time.perf_counter() - t0, 2),
        "models": {
            "compiler": "gemini-4-carbon",
            "references": DEFAULT_IMAGE_MODEL,
            "video": "gemini-omni-1.2-flash",
            "evaluator": "gemini-4-hydrogen",
        },
        "projects": [wed_proj["project_id"], ramen_proj["project_id"]],
        "comparisons": all_comps,
    }

    out_path = ROOT / "data" / "benchmark_results.json"
    out_path.write_text(json.dumps(results, indent=2), encoding="utf-8")

    print("\n" + "=" * 92)
    print(f"BENCHMARK COMPLETE in {results['total_benchmark_sec']}s — Saved to {out_path}")
    print("=" * 92)
    print(f"{'Case':<42} | {'Reuse':>5} | {'IR Ack':>6} | {'ID (Ours/Base)':>14} | {'Adh':>7} | {'Drift↓':>9} | {'Overall':>9}")
    print("-" * 92)
    for c in all_comps:
        s = c["structured"]
        b = c["baseline"]
        se, be = s["eval"], b["eval"]
        label = f"{c['scene_name'].split(':')[0]}: {c['edit_label']}"[:42]
        print(
            f"{label:<42} | {int(s['reuse_ratio']*100):>4}% | {s['ir_ack_ms']/1000:>5.2f}s | "
            f"{se['identity_preservation']:>6}/{be['identity_preservation']:<7} | "
            f"{se['instruction_adherence']:>3}/{be['instruction_adherence']:<3} | "
            f"{se['unintended_change_score']:>4}/{be['unintended_change_score']:<4} | "
            f"{se['overall_score']:>4}/{be['overall_score']:<4}"
        )


if __name__ == "__main__":
    asyncio.run(main())

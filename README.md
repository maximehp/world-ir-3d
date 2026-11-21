# Structured Generative Video (SceneIR Studio)

A lightweight, general-purpose AI video generation and surgical editing system powered by persistent semantic Scene IR, cached Nano Banana appearance references, real neural video synthesis (`gemini-omni-1.2-flash`), and independent visual verification (`gemini-4-hydrogen`).

Built for the **Gemini 4 NYC Hackathon** — zero 3D engine, zero procedural geometry, zero hardcoded wedding logic, 100% real 720p H.264 + AAC neural video generation.

## Architecture

1. **Gemini 4 Carbon (`gemini-4-carbon`)** — *Scene IR Compiler & Surgical Diff Planner*
   - Compiles any unscripted scene prompt into a compact, editable `SceneIR` (`setting`, persistent `entities` separating immutable `identity_traits` from mutable `appearance`, `relationships`, timed `events`, and `camera`).
   - Compiles natural-language edit requests into minimal `_CompactEditPatch` diffs (~5s structural acknowledgment) and deterministically applies them so unaffected entities keep identical revisions and cache hashes.
   - Automatically selects `edit_strategy`:
     - `video_edit` (`task="edit"`): for appearance/wardrobe/prop/lighting edits and entity additions, preserving exact motion and actor identity.
     - `reference_resynthesis` (`task="reference_to_video"`): for radical camera framing/angle changes where pixel-locked editing resists camera movement, reusing 100% of cached appearance references.

2. **Nano Banana (`gemini-3.1-flash-lite-image` default / `gemini-nano-banana-2.1` high-fidelity)** — *Parallel Persistent Appearance Reference Cache*
   - Generates the scene establishing plate and up to 3 primary entity references in parallel (~6–10s wall-clock).
   - Caches every asset by `(entity_id, appearance_hash)`.
   - On edits: unaffected references hit cache in **0ms**; modified entities run **identity-locked image-to-image editing** on their previous reference image so faces/identities stay fixed while only the requested attribute changes.

3. **Gemini Omni 1.2 Flash (`gemini-omni-1.2-flash`, Interactions API `v1beta`)** — *Real Neural Video Synthesis & Editing*
   - Initial synthesis: `task="reference_to_video"` conditioned on all cached Nano Banana references + compiled Scene IR prompt (720p, 24fps H.264 + 48kHz stereo AAC MP4).
   - Local/entity edits: `task="edit"` conditioned on source MP4 + updated/new Nano Banana reference images + unchanged identity lock references.
   - Major camera framing changes: `task="reference_to_video"` reusing 100% cached persistent references.

4. **Gemini 4 Hydrogen (`gemini-4-hydrogen`)** — *Independent Multimodal Video Auditor*
   - Directly inspects raw MP4 clips (Original + Edited) and appearance reference images.
   - Scores `instruction_adherence`, `identity_preservation`, `appearance_consistency`, `temporal_coherence`, and `unintended_change_score` (lower is better) on a strict 0–100 rubric.

## Verified Benchmark Results (Structured vs. Naive Prompt-Only Baseline)

Measured end-to-end on real generated 720p videos and independently audited by **Gemini 4 Hydrogen** (`uv run python benchmark.py`):

| Benchmark Case | Ref Cache Reuse | IR Edit Ack | Identity Preservation (Ours vs Base) | Instruction Adherence (Ours vs Base) | Unintended Drift ↓ (Ours vs Base) | Overall Score (Ours vs Base) |
|---|---:|---:|---:|---:|---:|---:|
| **Primary (Wedding): Dress Change** (`video_edit`) | **75%** (3/4) | 5.92s | **82** vs 35 (**+47**) | **82** vs 78 | **12** vs 75 (**-63**) | **81** vs 42 (**+39**) |
| **Primary (Wedding): Add Guests** (`video_edit`) | **100%** (4/4, 0.00s) | 8.39s | **84** vs 38 (**+46**) | **82** vs 78 | **16** vs 65 (**-49**) | **82** vs 52 (**+30**) |
| **Primary (Wedding): Wide Crane Shot** (`reference_resynthesis`) | **100%** (4/4, 0.05s) | 5.10s | **84** vs 35 (**+49**) | 68 vs 82 | **22** vs 58 (**-36**) | **76** vs 55 (**+21**) |
| **Secondary (Tokyo Ramen Shop): Jacket + Cat** (`video_edit`) | **50%** (2/4) | 19.32s* | **84** vs 45 (**+39**) | **82** vs 78 | **14** vs 68 (**-54**) | **82** vs 58 (**+24**) |

*\*Secondary run executed prior to the Compact Diff Patch upgrade (`engine/carbon.py`), which reduced Carbon IR edit acknowledgment from 13–19s down to 5.1–8.4s (~2.5–5s for single-entity edits).*

### Ablation Finding on Camera Framing
Testing `video_edit` (`task="edit"`) vs `reference_resynthesis` (`task="reference_to_video"` with 100% cached refs) on the wide crane camera edit proved why two-mode routing matters:
- `video_edit` refused to pull back the camera (`adherence=25`, `overall=35`).
- `reference_resynthesis` with cached persistent references achieved `identity=84`, `adherence=68`, `drift=22`, `overall=76` (beating naive text-only baseline by +21 overall and +49 identity!).

## Quick Start

```bash
# 1. Configure API key
cp .env.example .env
# Edit .env and set GEMINI_API_KEY=...

# 2. Install dependencies
uv sync

# 3. Run the Studio UI (http://127.0.0.1:8010)
uv run python server.py

# 4. (Optional) Re-run full Primary + Secondary benchmark suite
uv run python benchmark.py
```

## File Structure

- `engine/schema.py` — General-purpose `SceneIR`, `EditPlan`, `ReferenceAsset`, and `ClipEvalReport` Pydantic models
- `engine/carbon.py` — Gemini 4 Carbon Scene IR compiler & compact minimal diff patcher
- `engine/references.py` — Nano Banana parallel reference generator, identity-locked editor, and hash cache
- `engine/video.py` — Gemini Omni 1.2 Flash video synthesis, surgical video+ref editing, and naive baseline runner
- `engine/hydrogen.py` — Gemini 4 Hydrogen independent video consistency auditor
- `engine/pipeline.py` — Streaming SSE orchestrator & project persistence
- `server.py` — FastAPI server + static UI/media serving
- `web/index.html` — Studio UI with side-by-side synchronized video playback, reference cache gallery, IR inspector, and benchmark comparison view
- `benchmark.py` — Reproducible end-to-end benchmark runner

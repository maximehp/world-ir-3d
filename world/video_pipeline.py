"""Appearance-Anchored Generative Video Pipeline over Authoritative World IR.

Architecture:
  Stage 1 — Parallel Persistent Appearance Reference Layer (Cached by Entity ID + Appearance Hash):
    - Photorealistic Scene Reference conditioned on deterministic 3D establishing render + G-Buffer
    - Multi-View Canonical Entity Turnaround Sheets ([Front 0° | 3/4 Side | Back 180°]) for hero actors
    - Generated in parallel via Nano Banana 2.1; cache hits on unchanged entities during edits (0 calls)

  Stage 2 — Video Model Capability Probe + Strongest Functioning Neural Video Engine:
    - Probes Gemini API for native video models (veo-3.0/3.1/2.0); logs explicit empirical availability
    - Strongest compatible strategy for Nano Banana 2.1:
        Joint Multi-Frame Synchronized 2x2 Keyframe Grid Generation (cross-frame self-attention)
        + Overlapping Temporal Anchor Chaining across windows
        + Bidirectional Occlusion-Aware DIS Optical Flow Interpolation -> Real 24 FPS H.264 MP4

  Stage 3 — Quantitative + Independent Gemini 4 Hydrogen Video Evaluation:
    - Decodes actual MP4 frames to measure Temporal Warp PSNR/L1, 3D Structural Edge F1,
      Object-Silhouette Recall, 3D Motion-Vector Correlation, and Hydrogen Multimodal Video Audit.
"""

from __future__ import annotations

import base64
import concurrent.futures
import hashlib
import io
import json
import pathlib
import subprocess
import time
from typing import Literal

import cv2
import numpy as np
from google.genai import types
from PIL import Image
from pydantic import BaseModel, Field

from world.gemini_3d import HYDROGEN_MODEL, _call_json_model, _get_client
from world.neural_baker import _decode_b64_img, _extract_image, _pil_to_part, measure_structural_preservation
from world.schema import AppearanceReference, WorldObject, WorldState
from world.textures import NANO_BANANA_MODEL


# ---------------------------------------------------------------------------
# API Video Capability Probe (Empirical Verification)
# ---------------------------------------------------------------------------

def probe_video_model_support() -> dict:
    """Empirically verify whether native video-generation models (Veo) are accessible on this API key."""
    client = _get_client()
    available_models = [getattr(m, "name", "") for m in client.models.list()]
    video_models = [m for m in available_models if "veo" in m.lower() or "video" in m.lower()]
    probed_errors: dict[str, str] = {}
    if not video_models:
        for cand in ("veo-3.1-generate-preview", "veo-3.0-generate-001", "veo-2.0-generate-001"):
            try:
                client.models.get(model=cand)
                video_models.append(cand)
            except Exception as exc:
                probed_errors[cand] = str(exc)[:140]
    return {
        "native_video_models_available": video_models,
        "native_video_supported": len(video_models) > 0,
        "probed_errors": probed_errors,
        "selected_engine": (
            video_models[0]
            if video_models
            else "nano_banana_2.1_joint_2x2_temporal_anchor_plus_bidirectional_dis_flow_24fps"
        ),
    }


# ---------------------------------------------------------------------------
# Deterministic Appearance Hashing (Incremental Cache Invalidation)
# ---------------------------------------------------------------------------

def compute_scene_appearance_hash(world: WorldState) -> str:
    """Hash only environment, atmosphere, and static backdrop appearance (ignores dynamic agent positions/behaviors)."""
    static_sig = [
        {
            "id": o.id,
            "carrier": o.carrier,
            "pos": [round(v, 2) for v in o.position],
            "rot": round(o.rotation_y_deg, 1),
            "scale": round(o.scale, 2),
            "mat": o.material.model_dump(),
            "param": o.parametric.model_dump() if o.parametric else None,
        }
        for o in world.objects
        if o.visible and o.carrier != "articulated_agent"
    ]
    blob = json.dumps(
        {
            "terrain": world.terrain.model_dump(),
            "atmosphere": world.atmosphere.model_dump(),
            "static": static_sig,
        },
        sort_keys=True,
    )
    return hashlib.sha256(blob.encode()).hexdigest()[:12]


def compute_entity_appearance_hash(obj: WorldObject) -> str:
    """Hash ONLY persistent identity & appearance attributes of an entity (ignores position/rotation/behavior/motion!)."""
    blob = json.dumps(
        {
            "id": obj.id,
            "name": obj.name,
            "carrier": obj.carrier,
            "material": obj.material.model_dump(),
            "agent": obj.agent.model_dump() if obj.agent else None,
            "sdf_desc": obj.implicit_sdf.description if obj.implicit_sdf else None,
        },
        sort_keys=True,
    )
    return hashlib.sha256(blob.encode()).hexdigest()[:12]


# ---------------------------------------------------------------------------
# Stage 1: Persistent Parallel Scene & Canonical Entity Reference Generator
# ---------------------------------------------------------------------------

def generate_scene_reference(
    world: WorldState,
    scene_rgb_b64: str,
    out_dir: pathlib.Path,
    asset_url_fn,
    scene_depth_b64: str | None = None,
    scene_normal_b64: str | None = None,
    scene_obj_id_b64: str | None = None,
    force: bool = False,
) -> tuple[AppearanceReference, bool]:
    """Generate or fetch cached photorealistic scene reference conditioned on deterministic World IR render."""
    ahash = compute_scene_appearance_hash(world)
    existing = world.appearance_refs.get("scene")
    if not force and existing and existing.appearance_hash == ahash:
        ref_file = out_dir / "refs" / pathlib.Path(existing.image_url).name
        if ref_file.exists():
            return existing, True  # Cache hit!

    refs_dir = out_dir / "refs"
    refs_dir.mkdir(parents=True, exist_ok=True)

    rgb_img = _decode_b64_img(scene_rgb_b64).resize((768, 480), Image.Resampling.LANCZOS)
    guide_name = f"refs/scene_guide_{ahash}.jpg"
    rgb_img.save(out_dir / guide_name, quality=92)

    parts: list = [_pil_to_part(rgb_img, fmt="JPEG")]
    cond_extra = ""
    if scene_depth_b64 and scene_normal_b64 and scene_obj_id_b64:
        w, h = 384, 240
        dep = _decode_b64_img(scene_depth_b64).resize((w, h), Image.Resampling.BILINEAR)
        nrm = _decode_b64_img(scene_normal_b64).resize((w, h), Image.Resampling.BILINEAR)
        oid = _decode_b64_img(scene_obj_id_b64).resize((w, h), Image.Resampling.NEAREST)
        gbuf = Image.new("RGB", (w * 3, h))
        gbuf.paste(dep, (0, 0))
        gbuf.paste(nrm, (w, 0))
        gbuf.paste(oid, (w * 2, 0))
        parts.append(_pil_to_part(gbuf, fmt="JPEG"))
        cond_extra = (
            "IMAGE 2 provides the exact deterministic 3D G-Buffer [Depth | World Normals | Object-ID Masks]. "
            "Respect every single architectural silhouette, walkway edge, arch geometry, fountain, foliage mass, and shadow direction strictly. "
        )

    prompt = (
        f"Cinema-grade photorealistic MASTER SCENE REFERENCE photograph of: {world.title} — {world.prompt}. "
        f"Atmosphere: {world.atmosphere.time_of_day}. "
        f"IMAGE 1 is the authoritative 3D World IR layout render. {cond_extra}"
        "Transform the 3D scene into breathtaking natural 35mm cinema photography (ARRI Alexa, natural golden sunlight, "
        "authentic weathered stone, lush realistic florals and cypress leaves, shimmering water, authentic sky depth). "
        "Preserve exact composition, camera framing, building positions, arch position, and lighting direction pixel-for-pixel. "
        "This image serves as the canonical environment appearance anchor for an entire video sequence."
    )
    parts.append(prompt)

    client = _get_client()
    t0 = time.perf_counter()
    resp = client.models.generate_content(
        model=NANO_BANANA_MODEL,
        contents=parts,
        config=types.GenerateContentConfig(response_modalities=["IMAGE"]),
    )
    ms = round((time.perf_counter() - t0) * 1000.0, 1)
    img_out = _extract_image(resp).resize((768, 480), Image.Resampling.LANCZOS)

    rev = (existing.appearance_rev + 1) if existing else 1
    out_name = f"refs/scene_ref_v{rev}_{ahash}.jpg"
    img_out.save(out_dir / out_name, quality=93)

    ref = AppearanceReference(
        ref_id="scene",
        kind="scene",
        appearance_rev=rev,
        appearance_hash=ahash,
        prompt=prompt[:300],
        image_url=asset_url_fn(out_name),
        guide_url=asset_url_fn(guide_name),
        model=NANO_BANANA_MODEL,
        inference_ms=ms,
    )
    return ref, False


def generate_entity_canonical_reference(
    world: WorldState,
    obj: WorldObject,
    front_b64: str,
    side_b64: str,
    back_b64: str,
    out_dir: pathlib.Path,
    asset_url_fn,
    force: bool = False,
) -> tuple[AppearanceReference, bool]:
    """Generate or fetch cached 3-view canonical turnaround reference [Front | 3/4 Side | Back] for a hero entity."""
    ahash = compute_entity_appearance_hash(obj)
    existing = world.appearance_refs.get(obj.id)
    if not force and existing and existing.appearance_hash == ahash:
        ref_file = out_dir / "refs" / pathlib.Path(existing.image_url).name
        if ref_file.exists():
            return existing, True  # Cache hit!

    refs_dir = out_dir / "refs"
    refs_dir.mkdir(parents=True, exist_ok=True)

    f_img = _decode_b64_img(front_b64).resize((384, 512), Image.Resampling.LANCZOS)
    s_img = _decode_b64_img(side_b64).resize((384, 512), Image.Resampling.LANCZOS)
    b_img = _decode_b64_img(back_b64).resize((384, 512), Image.Resampling.LANCZOS)

    guide = Image.new("RGB", (1152, 512))
    guide.paste(f_img, (0, 0))
    guide.paste(s_img, (384, 0))
    guide.paste(b_img, (768, 0))
    guide_name = f"refs/guide_{obj.id}_{ahash}.jpg"
    guide.save(out_dir / guide_name, quality=92)

    role_desc = ""
    if obj.agent and obj.agent.rig_kind == "human_character":
        ag = obj.agent
        extras = []
        if ag.role:
            extras.append(f"role: {ag.role}")
        if ag.garment_style:
            extras.append(f"attire silhouette: {ag.garment_style} in primary color {obj.material.color} and accent {obj.material.secondary_color}")
        if ag.hair_color:
            extras.append(f"hair color: {ag.hair_color}")
        if ag.has_veil:
            extras.append("sheer translucent bridal cathedral veil trailing down the back")
        if ag.has_bouquet:
            extras.append("holding a fresh white-and-blush rose wedding bouquet")
        if ag.appearance_prompt:
            extras.append(ag.appearance_prompt)
        role_desc = "; ".join(extras)
    else:
        role_desc = f"{obj.name}, primary color {obj.material.color}, secondary {obj.material.secondary_color}"

    prompt = (
        f"Photorealistic canonical 3-VIEW CHARACTER/ENTITY TURNAROUND SHEET for: {obj.name} ({role_desc}). "
        "This 3-panel horizontal image shows THREE EXACT VIEWS of the EXACT SAME REAL PERSON/OBJECT on a clean neutral studio gray background: "
        "LEFT PANEL (0..33%) = FULL-BODY FRONT VIEW; "
        "CENTER PANEL (33..66%) = FULL-BODY 3/4 SIDE VIEW; "
        "RIGHT PANEL (66..100%) = FULL-BODY BACK VIEW. "
        "Preserve the exact pose, proportions, garment silhouette, and panel layout of IMAGE 1 while upgrading the subject to "
        "ultra-photorealistic 35mm cinema photography: natural lifelike human face with consistent facial identity across Front and 3/4 Side, "
        "realistic hair strands, authentic draped fabric folds, delicate lace/tailoring weave, realistic hands, and flat even neutral studio lighting. "
        "CRITICAL: All 3 panels MUST depict the EXACT SAME individual wearing the EXACT SAME garment from front, side, and back with zero drift. "
        "Keep clean neutral studio backdrop with NO text labels."
    )

    client = _get_client()
    t0 = time.perf_counter()
    resp = client.models.generate_content(
        model=NANO_BANANA_MODEL,
        contents=[_pil_to_part(guide, fmt="JPEG"), prompt],
        config=types.GenerateContentConfig(response_modalities=["IMAGE"]),
    )
    ms = round((time.perf_counter() - t0) * 1000.0, 1)
    sheet_out = _extract_image(resp).resize((1152, 512), Image.Resampling.LANCZOS)

    rev = (existing.appearance_rev + 1) if existing else 1
    out_name = f"refs/ref_{obj.id}_v{rev}_{ahash}.jpg"
    sheet_out.save(out_dir / out_name, quality=93)

    ref = AppearanceReference(
        ref_id=obj.id,
        kind="entity_turnaround",
        appearance_rev=rev,
        appearance_hash=ahash,
        prompt=role_desc[:300],
        image_url=asset_url_fn(out_name),
        guide_url=asset_url_fn(guide_name),
        model=NANO_BANANA_MODEL,
        inference_ms=ms,
    )
    return ref, False


def ensure_appearance_references_parallel(
    world: WorldState,
    scene_guide: dict,
    entity_guides: dict[str, dict],
    out_dir: pathlib.Path,
    asset_url_fn,
    force: bool = False,
) -> tuple[dict[str, AppearanceReference], dict]:
    """Generate/refresh scene reference + all hero entity canonical references IN PARALLEL,
    returning updated refs and explicit cache hit/miss + latency telemetry."""
    t0 = time.perf_counter()
    results: dict[str, AppearanceReference] = {}
    cache_hits: list[str] = []
    regenerated: list[str] = []
    per_ref_ms: dict[str, float] = {}

    obj_map = {o.id: o for o in world.objects if o.visible}

    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        futs: dict[concurrent.futures.Future, str] = {}
        if scene_guide and scene_guide.get("rgb"):
            f = pool.submit(
                generate_scene_reference,
                world,
                scene_guide["rgb"],
                out_dir,
                asset_url_fn,
                scene_guide.get("depth"),
                scene_guide.get("normals"),
                scene_guide.get("obj_id"),
                force,
            )
            futs[f] = "scene"

        for eid, eg in entity_guides.items():
            obj = obj_map.get(eid)
            if obj is None:
                continue
            f = pool.submit(
                generate_entity_canonical_reference,
                world,
                obj,
                eg["front"],
                eg["side"],
                eg["back"],
                out_dir,
                asset_url_fn,
                force,
            )
            futs[f] = eid

        for fut in concurrent.futures.as_completed(futs):
            rid = futs[fut]
            ref, was_cached = fut.result()
            results[rid] = ref
            if was_cached:
                cache_hits.append(rid)
                per_ref_ms[rid] = 0.0
            else:
                regenerated.append(rid)
                per_ref_ms[rid] = ref.inference_ms

    wall_ms = round((time.perf_counter() - t0) * 1000.0, 1)
    return results, {
        "wall_ms": wall_ms,
        "cache_hits": sorted(cache_hits),
        "regenerated": sorted(regenerated),
        "per_ref_ms": per_ref_ms,
        "nano_banana_calls": len(regenerated),
    }


# ---------------------------------------------------------------------------
# Stage 2: Joint Multi-Frame Neural Keyframe Synthesis + 24 FPS Flow MP4
# ---------------------------------------------------------------------------

def _make_2x2_grid(imgs: list[Image.Image], cell_w: int = 512, cell_h: int = 320) -> Image.Image:
    assert len(imgs) == 4
    grid = Image.new("RGB", (cell_w * 2, cell_h * 2))
    coords = [(0, 0), (cell_w, 0), (0, cell_h), (cell_w, cell_h)]
    for img, (x, y) in zip(imgs, coords):
        grid.paste(img.resize((cell_w, cell_h), Image.Resampling.LANCZOS), (x, y))
    return grid


def _split_2x2_grid(grid: Image.Image, cell_w: int = 512, cell_h: int = 320) -> list[Image.Image]:
    g = grid.resize((cell_w * 2, cell_h * 2), Image.Resampling.LANCZOS)
    return [
        g.crop((0, 0, cell_w, cell_h)),
        g.crop((cell_w, 0, cell_w * 2, cell_h)),
        g.crop((0, cell_h, cell_w, cell_h * 2)),
        g.crop((cell_w, cell_h, cell_w * 2, cell_h * 2)),
    ]


def _stitch_gbuffer_panel(dep: Image.Image, nrm: Image.Image, oid: Image.Image, cw: int = 256, ch: int = 160) -> Image.Image:
    """Compact 3-channel vertical-stack or horizontal strip per cell: [Depth | Normals | ObjectID]"""
    out = Image.new("RGB", (cw, ch))
    sw = cw // 3
    out.paste(dep.resize((sw, ch), Image.Resampling.BILINEAR), (0, 0))
    out.paste(nrm.resize((sw, ch), Image.Resampling.BILINEAR), (sw, 0))
    out.paste(oid.resize((cw - 2 * sw, ch), Image.Resampling.NEAREST), (2 * sw, 0))
    return out


def _synthesize_keyframe_window_2x2(
    world: WorldState,
    window_frames: list[dict],
    shot_description: str,
    out_dir: pathlib.Path,
    tag: str,
    *,
    mode: Literal["structural_only", "appearance_anchored"],
    scene_ref_path: pathlib.Path | None = None,
    entity_ref_paths: list[tuple[str, pathlib.Path]] | None = None,
    prev_anchor_img: Image.Image | None = None,
) -> tuple[list[Image.Image], float]:
    """Synthesize 4 synchronized cinema keyframes in ONE Nano Banana 2.1 call via a 2x2 temporal contact sheet."""
    cw, ch = 512, 320
    rgb_imgs = [_decode_b64_img(f["rgb"]).resize((cw, ch), Image.Resampling.LANCZOS) for f in window_frames]
    rgb_grid = _make_2x2_grid(rgb_imgs, cw, ch)
    rgb_grid.save(out_dir / f"vid_{tag}_rgb_grid.jpg", quality=92)

    parts: list = [_pil_to_part(rgb_grid, fmt="JPEG")]
    img_idx = 2

    # Build matching 2x2 G-Buffer conditioning grid (Depth | World Normals | Object-ID)
    has_gbuf = all(f.get("depth") and f.get("normals") and f.get("obj_id") for f in window_frames)
    gbuf_desc = ""
    if has_gbuf:
        g_cells = [
            _stitch_gbuffer_panel(_decode_b64_img(f["depth"]), _decode_b64_img(f["normals"]), _decode_b64_img(f["obj_id"]), 384, 240)
            for f in window_frames
        ]
        gbuf_grid = _make_2x2_grid(g_cells, 384, 240)
        gbuf_grid.save(out_dir / f"vid_{tag}_gbuf_grid.jpg", quality=88)
        parts.append(_pil_to_part(gbuf_grid, fmt="JPEG"))
        gbuf_desc = (
            f"IMAGE {img_idx} is the matching 2x2 deterministic 3D G-Buffer grid (each cell shows [Depth | Normals | Object-ID]). "
            "Follow EVERY actor silhouette, pose, stride, camera motion, archway, and architectural boundary across all 4 frames pixel-for-pixel! "
        )
        img_idx += 1

    ref_desc = ""
    if mode == "appearance_anchored":
        if scene_ref_path and scene_ref_path.exists():
            parts.append(_pil_to_part(Image.open(scene_ref_path).convert("RGB"), fmt="JPEG"))
            ref_desc += (
                f"IMAGE {img_idx} is the PERSISTENT CANONICAL SCENE REFERENCE: strictly match its exact stone textures, floral archway, "
                "foliage, cobblestone courtyard, warm sunlight direction, and photographic color grading in ALL 4 panels! "
            )
            img_idx += 1

        for ename, epath in (entity_ref_paths or []):
            if epath.exists():
                parts.append(_pil_to_part(Image.open(epath).convert("RGB"), fmt="JPEG"))
                ref_desc += (
                    f"IMAGE {img_idx} is the PERSISTENT 3-VIEW CANONICAL APPEARANCE SHEET for '{ename}' ([Front | 3/4 Side | Back]): "
                    f"preserve '{ename}'s EXACT facial identity, hairstyle, garment cut, fabric texture, veil/bouquet/tailoring across ALL 4 panels! "
                )
                img_idx += 1

        if prev_anchor_img is not None:
            parts.append(_pil_to_part(prev_anchor_img.resize((cw, ch), Image.Resampling.LANCZOS), fmt="JPEG"))
            ref_desc += (
                f"IMAGE {img_idx} is the ALREADY-RENDERED PHOTOREALISTIC FRAME FOR PANEL 1 (TOP-LEFT): "
                "reproduce Panel 1 (TOP-LEFT) matching IMAGE {0} seamlessly, and continue Panels 2, 3, and 4 as smooth temporal continuations of the EXACT SAME continuous cinema shot! ".format(img_idx)
            )
            img_idx += 1

    ts_list = ", ".join(f"Panel {i+1}: t={f.get('t', i):.2f}s" for i, f in enumerate(window_frames))
    prompt = (
        f"Photorealistic 35mm cinema 4-frame sequential filmstrip (2x2 grid: TOP-LEFT=Frame 1, TOP-RIGHT=Frame 2, BOTTOM-LEFT=Frame 3, BOTTOM-RIGHT=Frame 4; {ts_list}). "
        f"Shot: {shot_description} in {world.title} ({world.atmosphere.time_of_day}). "
        f"IMAGE 1 is the exact 2x2 deterministic 3D structural render grid showing the moving camera trajectory and actor motion. "
        f"{gbuf_desc}{ref_desc}"
        "Render ALL 4 panels as consecutive frames of ONE continuous live-action movie take (ARRI Alexa 35mm photography, natural skin, authentic lace/silk/wool fabric folds, "
        "sunlit floral courtyard, natural depth of field, subtle ground shadows). "
        "CRITICAL: Maintain 100% identical human faces, clothing, architecture, lighting, and color grade across all 4 panels; "
        "preserve exact panel borders with NO white margins, NO text labels, and NO extra invented people."
    )
    parts.append(prompt)

    client = _get_client()
    t0 = time.perf_counter()
    resp = client.models.generate_content(
        model=NANO_BANANA_MODEL,
        contents=parts,
        config=types.GenerateContentConfig(response_modalities=["IMAGE"]),
    )
    ms = round((time.perf_counter() - t0) * 1000.0, 1)
    out_grid = _extract_image(resp).resize((cw * 2, ch * 2), Image.Resampling.LANCZOS)
    out_grid.save(out_dir / f"vid_{tag}_out_grid.jpg", quality=93)
    return _split_2x2_grid(out_grid, cw, ch), ms


def _warp_frame(img: np.ndarray, flow: np.ndarray) -> np.ndarray:
    h, w = img.shape[:2]
    grid_x, grid_y = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    map_x = grid_x + flow[..., 0]
    map_y = grid_y + flow[..., 1]
    return cv2.remap(img, map_x, map_y, interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


def interpolate_keyframes_bidirectional_flow(
    keyframes_rgb: list[np.ndarray],
    subframes_per_interval: int = 16,
) -> list[np.ndarray]:
    """Synthesize smooth 24 FPS intermediate video frames between consecutive photorealistic keyframes
    using bidirectional occlusion-aware DIS Optical Flow warping."""
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    all_frames: list[np.ndarray] = []

    for idx in range(len(keyframes_rgb) - 1):
        im0 = keyframes_rgb[idx]
        im1 = keyframes_rgb[idx + 1]
        g0 = cv2.cvtColor(im0, cv2.COLOR_RGB2GRAY)
        g1 = cv2.cvtColor(im1, cv2.COLOR_RGB2GRAY)

        # Forward (0->1) and Backward (1->0) dense optical flow
        flow_01 = dis.calc(g0, g1, None)
        flow_10 = dis.calc(g1, g0, None)

        all_frames.append(im0)
        for s in range(1, subframes_per_interval):
            alpha = s / float(subframes_per_interval)
            # Smooth temporal warp from both endpoints toward t = alpha
            w0 = _warp_frame(im0, -alpha * flow_01)
            w1 = _warp_frame(im1, -(1.0 - alpha) * flow_10)

            # Occlusion-aware blend weight using warped pixel agreement
            diff = np.mean(np.abs(w0.astype(np.float32) - w1.astype(np.float32)), axis=-1, keepdims=True) / 255.0
            smooth_a = 0.5 - 0.5 * np.cos(alpha * np.pi)
            blended = (1.0 - smooth_a) * w0.astype(np.float32) + smooth_a * w1.astype(np.float32)
            # Slight confidence damping on high-disocclusion boundaries prevents ghosting
            if np.mean(diff) > 0.14:
                direct = (1.0 - smooth_a) * im0.astype(np.float32) + smooth_a * im1.astype(np.float32)
                occ = np.clip((diff - 0.12) * 2.5, 0.0, 0.45)
                blended = blended * (1.0 - occ) + direct * occ
            all_frames.append(np.clip(blended, 0, 255).astype(np.uint8))

    all_frames.append(keyframes_rgb[-1])
    return all_frames


def encode_frames_to_mp4(frames_rgb: list[np.ndarray], out_mp4: pathlib.Path, fps: int = 24) -> None:
    """Encode RGB numpy frames into browser-playable H.264 yuv420p MP4 via ffmpeg."""
    assert frames_rgb, "No frames to encode"
    h, w, _ = frames_rgb[0].shape
    # Ensure even dimensions for yuv420p
    w2 = w - (w % 2)
    h2 = h - (h % 2)
    cmd = [
        "ffmpeg", "-y",
        "-f", "rawvideo",
        "-vcodec", "rawvideo",
        "-pix_fmt", "rgb24",
        "-s", f"{w2}x{h2}",
        "-r", str(fps),
        "-i", "-",
        "-an",
        "-vcodec", "libx264",
        "-pix_fmt", "yuv420p",
        "-preset", "fast",
        "-crf", "19",
        "-movflags", "+faststart",
        str(out_mp4),
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    assert proc.stdin is not None
    for fr in frames_rgb:
        if fr.shape[0] != h2 or fr.shape[1] != w2:
            fr = cv2.resize(fr, (w2, h2), interpolation=cv2.INTER_AREA)
        proc.stdin.write(fr.tobytes())
    proc.stdin.close()
    err = proc.stderr.read().decode(errors="ignore") if proc.stderr else ""
    rc = proc.wait()
    if rc != 0:
        raise RuntimeError(f"ffmpeg encoding failed ({rc}): {err[:300]}")


def decode_mp4_frames(mp4_path: pathlib.Path) -> list[np.ndarray]:
    """Decode actual saved MP4 frames back to RGB for honest post-encode evaluation."""
    cap = cv2.VideoCapture(str(mp4_path))
    frames: list[np.ndarray] = []
    while True:
        ok, bgr = cap.read()
        if not ok:
            break
        frames.append(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
    cap.release()
    return frames


# ---------------------------------------------------------------------------
# Stage 3: Quantitative Video Metrics + Independent Gemini 4 Hydrogen Audit
# ---------------------------------------------------------------------------

def evaluate_decoded_video(
    decoded_frames: list[np.ndarray],
    guide_keyframes_rgb: list[np.ndarray],
    guide_keyframes_oid: list[np.ndarray | None],
    keyframe_indices: list[int],
) -> dict:
    """Compute objective temporal stability, structural preservation, and 3D motion fidelity on actual MP4 frames."""
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_FAST)

    # 1. Temporal Stability across consecutive decoded frames (optical-flow warp error)
    warp_l1s: list[float] = []
    warp_psnrs: list[float] = []
    sample_step = max(1, len(decoded_frames) // 24)
    for i in range(0, len(decoded_frames) - sample_step, sample_step):
        f0 = decoded_frames[i]
        f1 = decoded_frames[i + sample_step]
        g0 = cv2.cvtColor(f0, cv2.COLOR_RGB2GRAY)
        g1 = cv2.cvtColor(f1, cv2.COLOR_RGB2GRAY)
        fl = dis.calc(g1, g0, None)
        warped_0_to_1 = _warp_frame(f0, fl)
        diff = np.abs(warped_0_to_1.astype(np.float32) - f1.astype(np.float32))
        l1 = float(np.mean(diff) / 255.0)
        mse = float(np.mean(diff * diff))
        psnr = 20.0 * np.log10(255.0 / max(np.sqrt(mse), 1e-4))
        warp_l1s.append(l1)
        warp_psnrs.append(psnr)

    # 2. Structural & Object-Silhouette Preservation at keyframes against deterministic 3D World IR
    edge_f1s: list[float] = []
    obj_recalls: list[float] = []
    luma_corrs: list[float] = []
    gen_kfs: list[np.ndarray] = []
    for kf_i, g_rgb, g_oid in zip(keyframe_indices, guide_keyframes_rgb, guide_keyframes_oid):
        gen_f = decoded_frames[min(kf_i, len(decoded_frames) - 1)]
        gen_kfs.append(gen_f)
        m = measure_structural_preservation(g_rgb, gen_f, g_oid)
        edge_f1s.append(m["edge_f1_3px"])
        luma_corrs.append(m["layout_luma_corr"])
        if m["object_silhouette_recall"] is not None:
            obj_recalls.append(m["object_silhouette_recall"])

    # 3. Cross-Keyframe Color/Exposure Stability (std of mean RGB across keyframes — lower = less flicker!)
    kf_means = np.array([np.mean(f.astype(np.float32), axis=(0, 1)) for f in gen_kfs])
    exposure_drift_std = float(np.mean(np.std(kf_means, axis=0)))

    # 4. 3D Motion Vector Correlation (compare generated optical flow direction/magnitude vs 3D guide flow!)
    flow_corrs: list[float] = []
    for k in range(len(gen_kfs) - 1):
        h, w = 240, 384
        gg0 = cv2.cvtColor(cv2.resize(guide_keyframes_rgb[k], (w, h)), cv2.COLOR_RGB2GRAY)
        gg1 = cv2.cvtColor(cv2.resize(guide_keyframes_rgb[k + 1], (w, h)), cv2.COLOR_RGB2GRAY)
        fg0 = cv2.cvtColor(cv2.resize(gen_kfs[k], (w, h)), cv2.COLOR_RGB2GRAY)
        fg1 = cv2.cvtColor(cv2.resize(gen_kfs[k + 1], (w, h)), cv2.COLOR_RGB2GRAY)
        fl_guide = dis.calc(gg0, gg1, None).ravel()
        fl_gen = dis.calc(fg0, fg1, None).ravel()
        if np.std(fl_guide) > 1e-4 and np.std(fl_gen) > 1e-4:
            flow_corrs.append(float(np.corrcoef(fl_guide, fl_gen)[0, 1]))

    return {
        "frame_count": len(decoded_frames),
        "temporal_warp_l1": round(float(np.mean(warp_l1s)), 4) if warp_l1s else 0.0,
        "temporal_warp_psnr_db": round(float(np.mean(warp_psnrs)), 2) if warp_psnrs else 0.0,
        "keyframe_exposure_drift_std": round(exposure_drift_std, 2),
        "mean_edge_f1_3px": round(float(np.mean(edge_f1s)), 4) if edge_f1s else 0.0,
        "mean_object_silhouette_recall": round(float(np.mean(obj_recalls)), 4) if obj_recalls else None,
        "mean_layout_luma_corr": round(float(np.mean(luma_corrs)), 4) if luma_corrs else 0.0,
        "motion_flow_corr_vs_3d": round(float(np.mean(flow_corrs)), 4) if flow_corrs else 0.0,
    }


class HydrogenVideoComparisonAudit(BaseModel):
    structural_only_photorealism: float = Field(..., ge=0.0, le=10.0)
    structural_only_identity_consistency: float = Field(..., ge=0.0, le=10.0)
    structural_only_motion_fidelity: float = Field(..., ge=0.0, le=10.0)
    structural_only_temporal_stability: float = Field(..., ge=0.0, le=10.0)
    anchored_photorealism: float = Field(..., ge=0.0, le=10.0)
    anchored_identity_consistency: float = Field(..., ge=0.0, le=10.0)
    anchored_motion_fidelity: float = Field(..., ge=0.0, le=10.0)
    anchored_temporal_stability: float = Field(..., ge=0.0, le=10.0)
    winner: Literal["structural_only", "appearance_anchored", "tie"]
    summary: str
    specific_observations: list[str] = Field(default_factory=list)


def hydrogen_audit_video_ab(
    strip_guide: Image.Image,
    strip_structural: Image.Image,
    strip_anchored: Image.Image,
    ref_images: list[Image.Image],
    shot_description: str,
) -> tuple[HydrogenVideoComparisonAudit, float]:
    """Independent Gemini 4 Hydrogen evaluation comparing actual extracted frames from BOTH MP4 videos."""
    system = (
        "You are Gemini 4 Hydrogen, an independent Multimodal Cinema Video Auditor.\n"
        "You are comparing TWO generated MP4 videos of the EXACT SAME 3D wedding shot side-by-side:\n"
        "  - IMAGE 1: Authoritative 3D World IR Structural Guide Filmstrip (7 sequential timestamps)\n"
        "  - IMAGE 2: VIDEO A (Structural Guidance Alone) — 7 frames extracted directly from the encoded MP4\n"
        "  - IMAGE 3: VIDEO B (Structural Guidance + Persistent Appearance References) — 7 frames extracted directly from the encoded MP4\n"
        "  - Remaining images: The persistent canonical appearance references (Scene Ref + Bride & Groom 3-view turnarounds).\n\n"
        "Evaluate CRITICALLY and HONESTLY (never inflate scores!):\n"
        "1. Photorealism (natural photography, faces, wedding attire, lighting)\n"
        "2. Identity Consistency (do the bride's face, hair, dress, veil AND the groom's face/suit remain the EXACT SAME person/clothing across all 7 frames?)\n"
        "3. Motion Fidelity (does the bride smoothly walk toward the groom with the moving camera matching IMAGE 1?)\n"
        "4. Temporal Stability (consistent exposure, stonework, foliage, floral arch, minimal frame-to-frame drift/hallucination).\n"
        "Note any concrete flaws honestly (face shifts, dress morphing, blur, artifacts)."
    )
    parts: list = [
        _pil_to_part(strip_guide, fmt="JPEG"),
        _pil_to_part(strip_structural, fmt="JPEG"),
        _pil_to_part(strip_anchored, fmt="JPEG"),
    ]
    for r in ref_images:
        parts.append(_pil_to_part(r, fmt="JPEG"))
    parts.append(f"Shot description: {shot_description}\nCompare Video A (IMAGE 2) vs Video B (IMAGE 3) objectively.")
    return _call_json_model(HYDROGEN_MODEL, system, parts, HydrogenVideoComparisonAudit)


def _make_horizontal_strip(imgs: list[Image.Image], cell_w: int = 320, cell_h: int = 200) -> Image.Image:
    strip = Image.new("RGB", (cell_w * len(imgs), cell_h))
    for i, im in enumerate(imgs):
        strip.paste(im.resize((cell_w, cell_h), Image.Resampling.LANCZOS), (i * cell_w, 0))
    return strip


def run_video_generation_experiment(
    world: WorldState,
    keyframes_data: list[dict],
    shot_description: str,
    out_dir: pathlib.Path,
    asset_url_fn,
    *,
    mode: Literal["structural_only", "appearance_anchored"],
    hero_entity_ids: list[str] | None = None,
    fps: int = 24,
    subframes_per_interval: int = 16,
) -> dict:
    """Run full neural video generation for one mode (7 keyframes via 2 overlapping 2x2 Nano Banana 2.1 windows
    -> 24 FPS bidirectional DIS optical flow interpolation -> real H.264 MP4 -> decoded evaluation)."""
    assert len(keyframes_data) >= 4, "Need at least 4 sequential keyframes"
    vid_dir = out_dir / "videos"
    vid_dir.mkdir(parents=True, exist_ok=True)
    t0 = time.perf_counter()

    # Resolve cached persistent references for appearance_anchored mode
    scene_ref_path = None
    entity_ref_paths: list[tuple[str, pathlib.Path]] = []
    if mode == "appearance_anchored":
        sref = world.appearance_refs.get("scene")
        if sref:
            scene_ref_path = out_dir / "refs" / pathlib.Path(sref.image_url).name
        for eid in (hero_entity_ids or []):
            eref = world.appearance_refs.get(eid)
            if eref:
                entity_ref_paths.append((eid, out_dir / "refs" / pathlib.Path(eref.image_url).name))

    # Window 1: frames [0, 1, 2, 3] jointly in ONE 2x2 pass
    win1_imgs, w1_ms = _synthesize_keyframe_window_2x2(
        world,
        keyframes_data[0:4],
        shot_description,
        vid_dir,
        tag=f"{mode}_w1",
        mode=mode,
        scene_ref_path=scene_ref_path,
        entity_ref_paths=entity_ref_paths,
        prev_anchor_img=None,
    )
    all_kf_pil = list(win1_imgs)
    nb_ms_total = w1_ms
    nb_calls = 1

    # Window 2 (overlapping on frame 3!): frames [3, 4, 5, 6]
    if len(keyframes_data) >= 7:
        win2_imgs, w2_ms = _synthesize_keyframe_window_2x2(
            world,
            keyframes_data[3:7],
            shot_description,
            vid_dir,
            tag=f"{mode}_w2",
            mode=mode,
            scene_ref_path=scene_ref_path,
            entity_ref_paths=entity_ref_paths,
            prev_anchor_img=win1_imgs[3] if mode == "appearance_anchored" else None,
        )
        # Keep frame 3 from Window 1 (or 50/50 seam blend) and append frames 4, 5, 6!
        all_kf_pil.extend(win2_imgs[1:4])
        nb_ms_total += w2_ms
        nb_calls += 1

    kf_np = [np.asarray(im) for im in all_kf_pil]
    strip_img = _make_horizontal_strip(all_kf_pil, 320, 200)
    strip_name = f"videos/{mode}_keyframes_strip.jpg"
    strip_img.save(out_dir / strip_name, quality=92)

    # Interpolate to 24 FPS using bidirectional occlusion-aware DIS optical flow
    t_flow = time.perf_counter()
    dense_frames = interpolate_keyframes_bidirectional_flow(kf_np, subframes_per_interval=subframes_per_interval)
    flow_ms = round((time.perf_counter() - t_flow) * 1000.0, 1)

    t_enc = time.perf_counter()
    mp4_name = f"videos/{mode}.mp4"
    mp4_path = out_dir / mp4_name
    encode_frames_to_mp4(dense_frames, mp4_path, fps=fps)
    enc_ms = round((time.perf_counter() - t_enc) * 1000.0, 1)

    # Decode actual MP4 back from disk for honest evaluation
    decoded = decode_mp4_frames(mp4_path)
    kf_indices = [i * subframes_per_interval for i in range(len(kf_np))]
    guide_rgb = [np.asarray(_decode_b64_img(f["rgb"]).resize((512, 320), Image.Resampling.LANCZOS)) for f in keyframes_data[: len(kf_np)]]
    guide_oid = [
        np.asarray(_decode_b64_img(f["obj_id"]).resize((512, 320), Image.Resampling.NEAREST)) if f.get("obj_id") else None
        for f in keyframes_data[: len(kf_np)]
    ]
    metrics = evaluate_decoded_video(decoded, guide_rgb, guide_oid, kf_indices)

    total_ms = round((time.perf_counter() - t0) * 1000.0, 1)
    return {
        "mode": mode,
        "mp4_url": asset_url_fn(mp4_name),
        "mp4_path": str(mp4_path),
        "keyframes_strip_url": asset_url_fn(strip_name),
        "keyframes_strip_path": str(out_dir / strip_name),
        "keyframe_count": len(kf_np),
        "fps": fps,
        "duration_s": round(len(decoded) / float(fps), 2),
        "nano_banana_calls": nb_calls,
        "timings": {
            "nano_banana_ms": round(nb_ms_total, 1),
            "flow_interp_ms": flow_ms,
            "ffmpeg_encode_ms": enc_ms,
            "total_ms": total_ms,
        },
        "metrics": metrics,
    }


def build_side_by_side_comparison_mp4(
    guide_frames_dense: list[np.ndarray],
    mp4_a_path: pathlib.Path,
    mp4_b_path: pathlib.Path,
    out_mp4: pathlib.Path,
    fps: int = 24,
) -> None:
    """Compose a synchronized 3-up MP4: [World IR 3D Guide | A: Structural Only | B: Appearance-Anchored]."""
    fa = decode_mp4_frames(mp4_a_path)
    fb = decode_mp4_frames(mp4_b_path)
    n = min(len(guide_frames_dense), len(fa), len(fb))
    cw, ch = 480, 300
    combined: list[np.ndarray] = []

    labels = [
        "1. WORLD IR 3D GUIDE (Authoritative)",
        "2. VIDEO A: Structural Guidance Alone",
        "3. VIDEO B: + Persistent Appearance Refs",
    ]
    for i in range(n):
        panels = [
            cv2.resize(guide_frames_dense[i], (cw, ch), interpolation=cv2.INTER_AREA),
            cv2.resize(fa[i], (cw, ch), interpolation=cv2.INTER_AREA),
            cv2.resize(fb[i], (cw, ch), interpolation=cv2.INTER_AREA),
        ]
        canvas = np.zeros((ch + 32, cw * 3, 3), dtype=np.uint8)
        canvas[:32, :, :] = (16, 20, 28)
        for p_idx, (p, lbl) in enumerate(zip(panels, labels)):
            x0 = p_idx * cw
            canvas[32:, x0 : x0 + cw] = p
            cv2.putText(canvas, lbl, (x0 + 10, 21), cv2.FONT_HERSHEY_SIMPLEX, 0.50, (235, 240, 248), 1, cv2.LINE_AA)
        combined.append(canvas)

    encode_frames_to_mp4(combined, out_mp4, fps=fps)

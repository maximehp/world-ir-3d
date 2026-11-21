"""2D Video -> Persistent 3D WorldIR.

Pipeline (merged from the Video2Sim branch):
  1. OpenCV (video2sim.backend.video_analyzer): temporal-median clean background, keyframes,
     and tracked 2D trajectories (t, u, v) of every moving object.
  2. Gemini 4 Carbon (multimodal): reconstructs the scene seen in the video as a full multi-carrier
     WorldIR draft, estimates the original camera pose, and binds each tracked trajectory to an
     articulated agent (`behavior.kind='follow_video_path'`).
  3. Deterministic lifting: each 2D trajectory is unprojected through the matched pinhole camera into a
     timed 3D world-space path (sky tracks on a depth plane scaled by apparent size, ground/water tracks
     intersected with the ground plane). The studio replays these paths in sync with the source video.
"""

from __future__ import annotations

import json
import math

import numpy as np
from google.genai import types

from video2sim.backend.models import TrackedTrajectory
from video2sim.backend.video_analyzer import VideoAnalysisArtifacts
from world.gemini_3d import CARBON_MODEL, CARBON_WORLD_SYSTEM, _call_json_model
from world.schema import (
    ArticulatedAgentSpec,
    BehaviorSpec,
    CarbonVideoWorldDraft,
    MaterialSpec,
    TerrainSpec,
    VideoTrack3D,
    WorldObject,
)

VIDEO_CAMERA_FOV_DEG = 54.0  # must match the studio PerspectiveCamera FOV

VIDEO_SYSTEM_ADDENDUM = (
    "\n\n=== VIDEO RECONSTRUCTION MODE ===\n"
    "You are reconstructing the REAL scene shown in a 2D video as a persistent, walkable 3D WorldIR.\n"
    "Image 1 is the clean static background (moving objects removed by temporal median). The following images are keyframes "
    "showing the moving objects. OpenCV tracked trajectories are given in normalized image coords (u: 0 left..1 right, v: 0 top..1 bottom).\n\n"
    "RECONSTRUCTION FIDELITY RULES:\n"
    "- Match the video: terrain style, water (has_water/water_color if there is a lake/sea/river), ground & hill colors, "
    "time of day, sky zenith/horizon colors, sun direction, fog. Sample colors from the actual pixels.\n"
    "- Recreate the static things you SEE (houses, trees, mountains/hills, towers, bridges, boats, lamps, fences, etc.) using the best-fitting "
    "parametric kinds / implicit_sdf, laid out to match their positions in the frame relative to the camera. Then plausibly extend the world "
    "behind and beside the camera so it holds up from 360 degrees. Do NOT invent a plaza/fountain if the video has none.\n"
    "- CAMERA MATCH (critical): set `camera_spawn` and `camera_look_at` to approximate the ORIGINAL video camera so that a render from "
    "camera_spawn looking at camera_look_at with a 54-degree vertical FOV reproduces the video framing (horizon height, what is near/far). "
    "Keep the scene within ~30 m of the origin and the camera within ~28 m of the origin.\n"
    "- MOVING OBJECTS: for EVERY tracked trajectory create exactly one `articulated_agent` object and one `track_bindings` entry "
    "(track_id -> agent_object_id). Pick the rig from what the keyframes show: bird_flock (count 1, or 2-3 if the blob is a small group) for "
    "anything flying; fox for animals or people walking; scooter_rider for bikes/scooters/motorbikes; car_driver for cars/trucks/buses; "
    "boat_cruiser for boats. Set the agent `behavior.kind='follow_video_path'` and `behavior.video_track_id` to the track id, color its material "
    "to match the tracked avg_color, and set `region` to sky / ground / water. Do NOT use orbit/patrol behaviors for tracked objects.\n"
    "- You may add additional ambient agents (orbit_and_perch birds, etc.) only if they are clearly visible but untracked."
)


def compile_world_from_video(
    artifacts: VideoAnalysisArtifacts, user_hint: str = "", refs: list | None = None
) -> tuple[CarbonVideoWorldDraft, float]:
    md = artifacts.metadata
    traj_summary = []
    for tr in artifacts.trajectories:
        pts = tr.points
        traj_summary.append(
            {
                "id": tr.id,
                "num_points": len(pts),
                "avg_color": tr.avg_color,
                "avg_area_frac": tr.avg_area,
                "opencv_region_guess": tr.dominant_region,
                "time_span_s": [pts[0].t, pts[-1].t],
                "start_uv": [pts[0].u, pts[0].v],
                "mid_uv": [pts[len(pts) // 2].u, pts[len(pts) // 2].v],
                "end_uv": [pts[-1].u, pts[-1].v],
            }
        )

    text = (
        f"Source video: {md.filename}, {md.width}x{md.height}, {md.duration}s @ {md.fps} fps.\n"
        f"OpenCV tracked moving-object trajectories ({len(traj_summary)}):\n{json.dumps(traj_summary, indent=1)}\n"
        + (f"\nUser direction for the reconstruction: {user_hint}\n" if user_hint else "")
        + "\nReconstruct this video as a full persistent 3D WorldIR. Image 1 = clean background:"
    )
    contents: list = [types.Part.from_text(text=text), types.Part.from_bytes(data=artifacts.background_jpeg, mime_type="image/jpeg")]
    for ts, jpeg in artifacts.keyframe_jpegs:
        contents.append(types.Part.from_text(text=f"Keyframe at t={ts}s:"))
        contents.append(types.Part.from_bytes(data=jpeg, mime_type="image/jpeg"))

    system = CARBON_WORLD_SYSTEM + VIDEO_SYSTEM_ADDENDUM
    if refs:
        from world.references import REFERENCE_CREATE_ADDENDUM, reference_parts

        system += REFERENCE_CREATE_ADDENDUM
        contents.append(types.Part.from_text(text="The user also attached these reference images:"))
        contents += reference_parts(refs)
    return _call_json_model(CARBON_MODEL, system, contents, CarbonVideoWorldDraft)


# ---------------------------------------------------------------------------
# 2D trajectory -> 3D world path lifting
# ---------------------------------------------------------------------------

def _camera_basis(pos: list[float], look: list[float]):
    c = np.array(pos, dtype=float)
    f = np.array(look, dtype=float) - c
    n = np.linalg.norm(f)
    f = f / n if n > 1e-6 else np.array([0.0, 0.0, -1.0])
    up = np.array([0.0, 1.0, 0.0])
    r = np.cross(f, up)
    if np.linalg.norm(r) < 1e-6:
        r = np.array([1.0, 0.0, 0.0])
    r /= np.linalg.norm(r)
    u = np.cross(r, f)
    return c, f, r, u, max(n, 4.0)


def _smooth(vals: np.ndarray, k: int = 3) -> np.ndarray:
    if len(vals) < k:
        return vals
    pad = k // 2
    padded = np.pad(vals, (pad, pad), mode="edge")
    return np.convolve(padded, np.ones(k) / k, mode="valid")


def lift_track_to_3d(
    tr: TrackedTrajectory,
    region: str,
    cam_pos: list[float],
    cam_look: list[float],
    aspect: float,
    terrain: TerrainSpec,
    fov_deg: float = VIDEO_CAMERA_FOV_DEG,
    max_points: int = 90,
) -> list[list[float]]:
    c, f, r, u, look_dist = _camera_basis(cam_pos, cam_look)
    tan_v = math.tan(math.radians(fov_deg) / 2.0)
    tan_h = tan_v * aspect
    half = terrain.size / 2.0 * 0.92

    ts = np.array([p.t for p in tr.points])
    us = _smooth(np.array([p.u for p in tr.points]))
    vs = _smooth(np.array([p.v for p in tr.points]))

    # Apparent size -> depth: bigger blobs are closer. Reference area ~0.2% of the frame at the look-at distance.
    size_scale = float(np.clip(math.sqrt(0.002 / max(tr.avg_area, 1e-5)), 0.55, 1.5))
    sky_depth = look_dist * size_scale
    ground_y = terrain.water_level if region == "water" else 0.0

    out = []
    for t, uu, vv in zip(ts, us, vs):
        ray = f + (2 * uu - 1) * tan_h * r + (1 - 2 * vv) * tan_v * u
        ray /= np.linalg.norm(ray)
        if region in ("ground", "water") and ray[1] < -1e-3:
            dist = (ground_y - c[1]) / ray[1]
            p = c + ray * min(dist, look_dist * 3.0)
        else:
            # Intersect plane perpendicular to the view direction at sky_depth
            dist = sky_depth / max(float(np.dot(ray, f)), 0.2)
            p = c + ray * dist
            if region == "sky":
                p[1] = max(p[1], 1.8)
        p[0] = float(np.clip(p[0], -half, half))
        p[2] = float(np.clip(p[2], -half, half))
        out.append([round(float(t), 3), round(float(p[0]), 3), round(float(p[1]), 3), round(float(p[2]), 3)])

    if len(out) > max_points:
        idx = np.linspace(0, len(out) - 1, max_points).round().astype(int)
        out = [out[i] for i in idx]
    return out


_RIG_FOR_REGION = {"sky": "bird_flock", "ground": "fox", "water": "boat_cruiser"}
_COLLECTION_FOR_RIG = {"bird_flock": "agents", "fox": "agents", "floating_lanterns": "agents",
                       "scooter_rider": "vehicles", "car_driver": "vehicles", "boat_cruiser": "vehicles"}


def bind_and_lift_tracks(
    draft: CarbonVideoWorldDraft,
    artifacts: VideoAnalysisArtifacts,
) -> list[VideoTrack3D]:
    """Ensure every tracked trajectory drives exactly one agent, then lift all tracks into 3D."""
    md = artifacts.metadata
    aspect = md.width / max(md.height, 1)
    objs = {o.id: o for o in draft.objects}
    bindings = {b.track_id: b for b in draft.track_bindings}
    tracks3d: list[VideoTrack3D] = []

    for tr in artifacts.trajectories:
        b = bindings.get(tr.id)
        region = b.region if b else ("ground" if tr.dominant_region == "ground" else "sky")
        label = b.label if b else f"tracked {region} object"
        agent = objs.get(b.agent_object_id) if b else None
        if agent is None or agent.carrier != "articulated_agent":
            # Carbon missed this track: synthesize a matching agent so no tracked motion is dropped
            rig = _RIG_FOR_REGION[region]
            agent = WorldObject(
                id=f"video_{tr.id}",
                name=label.title(),
                collection=_COLLECTION_FOR_RIG[rig],
                carrier="articulated_agent",
                material=MaterialSpec(color=tr.avg_color),
                agent=ArticulatedAgentSpec(rig_kind=rig, count=1),
            )
            draft.objects.append(agent)
            objs[agent.id] = agent
        if agent.agent is None:
            agent.agent = ArticulatedAgentSpec(rig_kind=_RIG_FOR_REGION[region], count=1)
        if agent.agent.rig_kind == "bird_flock":
            agent.agent.count = min(agent.agent.count, 3)
        agent.behavior = BehaviorSpec(kind="follow_video_path", video_track_id=tr.id, speed=1.0)

        tracks3d.append(
            VideoTrack3D(
                id=tr.id,
                label=label,
                region=region,
                color=tr.avg_color,
                points=lift_track_to_3d(tr, region, draft.camera_spawn, draft.camera_look_at, aspect, draft.terrain),
            )
        )

    # Any agent Carbon pointed at a non-existent track falls back to an ambient behavior
    valid = {t.id for t in tracks3d}
    for o in draft.objects:
        if o.behavior.kind == "follow_video_path" and o.behavior.video_track_id not in valid:
            o.behavior = BehaviorSpec(kind="patrol_ring" if o.agent and o.agent.rig_kind != "bird_flock" else "orbit_target")
    return tracks3d

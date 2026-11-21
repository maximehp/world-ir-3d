from __future__ import annotations

import json
import os
from typing import Optional

from google import genai
from google.genai import types

from models import SceneGraph
from video_analyzer import VideoAnalysisArtifacts


SYSTEM_PROMPT = """You are an expert 3D technical artist and computer vision scene reconstructor.
Your job is to inspect frames from a 2D video (plus OpenCV-tracked moving object trajectories) and reconstruct an accurate, richly detailed 3D SceneGraph JSON that recreates the 2D video as an actual interactive 3D world.

COORDINATE SYSTEM (strictly follow this!):
- The ground plane is at y = 0.
- The default 3D camera sits at (x=0, y=11, z=32) looking toward (x=0, y=4.5, z=-4) with ~45 deg FOV.
- X axis (left to right): -28 is far left edge of the 2D frame, 0 is center, +28 is far right edge.
  Formula from normalized 2D image u in [0, 1]: x ≈ (u - 0.5) * 52.
- Z axis (depth, back to front):
  - Far background sky/sun: z ≈ -42
  - Mountains / distant hills: z between -28 and -18
  - Midground trees / houses: z between -8 and +6
  - Foreground ponds / paths / near trees: z between +2 and +14
  (Objects lower in the 2D frame are closer to the camera, i.e. larger/more positive Z.)

GUIDELINES:
1. Extract exact hex colors from the image for sky_top_color, sky_bottom_color, ground_color, sun, mountains, water, paths, buildings, domes, marble/sandstone walls, tree trunks/foliage.
2. For MONUMENTAL / ARCHITECTURAL SCENES (like the Taj Mahal, palaces, mosques, temples, courtyards, formal gardens):
   - Decompose the complete architectural complex into modular 3D structures!
   - Use `kind="plinth"` for raised marble/stone terraces or platforms (`elevation_y=0`, `height=2..3.5`).
   - Place the main monument (`kind="mausoleum"` or `"palace"` or `"mosque"`) on top of the plinth by setting `elevation_y` equal to the plinth's height, with `roof_style="onion_dome"` or `"dome"`, `has_chhatris=true` if corner pavilions exist, and `dome_color`/`accent_color` matching the marble/gold/sandstone trim.
   - Add corner towers/minarets as individual `kind="minaret"` structures (`num_balconies=3`, `elevation_y` matching the plinth height) at the 4 corners so the user can inspect and customize each minaret individually!
   - Add flanking buildings (e.g. red sandstone Mosque & Jawab pavilions) on the left and right (`kind="mosque"` or `"pavilion"`, `rotation_y` facing inward toward the courtyard).
   - For formal reflecting pools, use `WaterBodySpec` with `shape="rectangle"`, `has_fountains=true`, and `fountain_count=5..9`.
   - For symmetrical garden avenues, place rows of `kind="cypress"` trees along the pool and crisp `PathSpec` walkways dividing the lawns.
   - For ANCIENT PYRAMIDS / DESERT MONUMENTS (like the Pyramids of Giza): use `kind="pyramid"` (set `has_chhatris=true` to add a smooth limestone capstone like Khafre's Pyramid!), `kind="sphinx"`, `kind="ruins"` for mortuary temples/mastabas, sandy desert `ground_color`, warm golden-hour `sky_bottom_color`, and winding desert causeway `PathSpec` roads.
   - Add `kind="person"` dynamic entities strolling along the walkways if visitors are visible.
3. For NATURAL / STYLIZED LANDSCAPES:
   - Place every visible mountain peak, water body (pond/lake), dirt/stone path, house/building, and tree/bush accurately so that from the default camera the 3D scene mirrors the 2D video composition, while having true 3D depth when the user orbits around!
4. For dynamic_entities:
   - You will be given a list of OpenCV-tracked moving trajectories (with IDs like "traj_1", "traj_2", ...).
   - For each meaningful moving object visible in the video (e.g., flying birds, clouds, cars, boats, strolling people), create a DynamicEntitySpec and set its `trajectory_id` to the matching OpenCV trajectory ID (or provide a `fallback_path` if the camera itself is moving/panning).
   - Spread bird `depth_z` slightly (e.g., -6, -2, +2) so they fly in true 3D parallax.
5. Make sure paths have at least 2-6 smooth (x, z) waypoints along the ground plane.
"""


def build_scene_with_gemini(
    artifacts: VideoAnalysisArtifacts,
    api_key: Optional[str] = None,
    model: str = "gemini-2.5-flash",
) -> SceneGraph:
    resolved_key = (api_key or os.getenv("GEMINI_API_KEY") or "").strip()
    if not resolved_key:
        raise ValueError("No Gemini API key provided.")

    client = genai.Client(api_key=resolved_key)

    traj_summary = []
    for tr in artifacts.trajectories:
        first = tr.points[0]
        last = tr.points[-1]
        mid = tr.points[len(tr.points) // 2]
        traj_summary.append(
            {
                "id": tr.id,
                "num_points": len(tr.points),
                "avg_color": tr.avg_color,
                "dominant_region": tr.dominant_region,
                "start": {"t": first.t, "u": first.u, "v": first.v},
                "mid": {"t": mid.t, "u": mid.u, "v": mid.v},
                "end": {"t": last.t, "u": last.u, "v": last.v},
            }
        )

    user_prompt = (
        f"Video metadata: {artifacts.metadata.width}x{artifacts.metadata.height}, "
        f"{artifacts.metadata.duration}s @ {artifacts.metadata.fps} fps.\n"
        f"Image 1 is the clean static background (moving objects removed via temporal median).\n"
        f"Subsequent images are keyframes showing the moving objects at different timestamps.\n"
        f"OpenCV tracked moving object trajectories:\n"
        f"{json.dumps(traj_summary, indent=2)}\n\n"
        f"Generate the complete 3D SceneGraph JSON matching this video."
    )

    contents = [
        types.Part.from_text(text=user_prompt),
        types.Part.from_bytes(data=artifacts.background_jpeg, mime_type="image/jpeg"),
    ]
    for ts, jpeg_bytes in artifacts.keyframe_jpegs:
        contents.append(types.Part.from_text(text=f"Keyframe at t={ts}s:"))
        contents.append(types.Part.from_bytes(data=jpeg_bytes, mime_type="image/jpeg"))

    response = client.models.generate_content(
        model=model,
        contents=contents,
        config=types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            response_mime_type="application/json",
            response_schema=SceneGraph,
            temperature=0.2,
        ),
    )

    if getattr(response, "parsed", None) is not None:
        return response.parsed

    return SceneGraph.model_validate_json(response.text)

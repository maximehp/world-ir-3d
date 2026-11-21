from __future__ import annotations

import math
from dataclasses import dataclass
from typing import List, Tuple

import cv2
import numpy as np

from .models import TrackedTrajectory, TrajectoryPoint, VideoMetadata


@dataclass
class VideoAnalysisArtifacts:
    metadata: VideoMetadata
    background_bgr: np.ndarray
    background_jpeg: bytes
    keyframe_jpegs: List[Tuple[float, bytes]]
    trajectories: List[TrackedTrajectory]


def bgr_to_hex(bgr: np.ndarray) -> str:
    b, g, r = [int(np.clip(c, 0, 255)) for c in bgr]
    return f"#{r:02x}{g:02x}{b:02x}"


def _encode_jpeg(frame_bgr: np.ndarray, max_width: int = 960, quality: int = 85) -> bytes:
    h, w = frame_bgr.shape[:2]
    if w > max_width:
        scale = max_width / float(w)
        frame_bgr = cv2.resize(frame_bgr, (max_width, int(h * scale)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", frame_bgr, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    if not ok:
        raise RuntimeError("Failed to encode frame to JPEG")
    return buf.tobytes()


def analyze_video_opencv(
    video_path: str,
    filename: str,
    video_url: str,
    max_track_samples: int = 120,
) -> VideoAnalysisArtifacts:
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise ValueError(f"Could not open video file: {video_path}")

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 24.0)
    if fps <= 0.1 or math.isnan(fps):
        fps = 24.0
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)

    # Read frames (downsample to reasonable working resolution for fast median + tracking)
    frames_small: List[Tuple[int, np.ndarray]] = []
    full_keyframes: List[Tuple[float, np.ndarray]] = []

    work_w = min(width, 640)
    scale = work_w / float(width) if width > 0 else 1.0
    work_h = max(1, int(round(height * scale)))

    # Decide stride for tracking
    est_total = frame_count if frame_count > 0 else 300
    stride = max(1, est_total // max_track_samples)

    idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if idx % stride == 0:
            small = cv2.resize(frame, (work_w, work_h), interpolation=cv2.INTER_AREA)
            frames_small.append((idx, small))
        idx += 1

    cap.release()

    actual_frames = max(idx, 1)
    duration = actual_frames / fps

    if not frames_small:
        raise ValueError("Video contains no readable frames.")

    # Compute temporal median background from up to 25 evenly spaced samples
    bg_step = max(1, len(frames_small) // 25)
    bg_stack = np.stack([f for _, f in frames_small[::bg_step]], axis=0)
    median_bg = np.median(bg_stack, axis=0).astype(np.uint8)

    # Pick 3 evenly spaced keyframes (20%, 50%, 80%) for AI vision context
    kf_indices = sorted(
        set(
            [
                min(len(frames_small) - 1, int(len(frames_small) * r))
                for r in (0.15, 0.5, 0.85)
            ]
        )
    )
    for k_i in kf_indices:
        frame_idx, small_f = frames_small[k_i]
        full_keyframes.append((round(frame_idx / fps, 2), small_f))

    # Track moving objects via background subtraction + connected components
    bg_float = median_bg.astype(np.float32)
    kernel_close = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    kernel_open = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))

    active_tracks: List[dict] = []
    finished_tracks: List[dict] = []
    next_track_id = 1

    min_area = max(12, int(work_w * work_h * 0.00008))
    max_area = int(work_w * work_h * 0.20)
    max_match_dist = 0.14  # normalized image distance between consecutive sampled frames

    for sample_i, (frame_idx, frame_small) in enumerate(frames_small):
        t = round(frame_idx / fps, 3)
        diff = np.abs(frame_small.astype(np.float32) - bg_float)
        diff_max = np.max(diff, axis=2)

        mask = (diff_max > 28.0).astype(np.uint8) * 255
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel_open)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel_close)

        num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(mask, connectivity=8)

        detections = []
        for lbl in range(1, num_labels):
            area = int(stats[lbl, cv2.CC_STAT_AREA])
            if area < min_area or area > max_area:
                continue
            bx = int(stats[lbl, cv2.CC_STAT_LEFT])
            by = int(stats[lbl, cv2.CC_STAT_TOP])
            bw = int(stats[lbl, cv2.CC_STAT_WIDTH])
            bh = int(stats[lbl, cv2.CC_STAT_HEIGHT])
            cx, cy = centroids[lbl]

            # Sample average color inside the un-closed diff region for accurate object color
            comp_mask = (labels == lbl) & (diff_max > 28.0)
            if np.any(comp_mask):
                avg_bgr = np.mean(frame_small[comp_mask], axis=0)
            else:
                avg_bgr = np.mean(frame_small[labels == lbl], axis=0)

            detections.append(
                {
                    "u": float(cx / work_w),
                    "v": float(cy / work_h),
                    "w": float(bw / work_w),
                    "h": float(bh / work_h),
                    "area": float(area / (work_w * work_h)),
                    "bgr": avg_bgr,
                    "t": t,
                }
            )

        # Match detections to active tracks (greedy closest pair)
        used_dets = set()
        used_tracks = set()
        pairs = []
        for ti, tr in enumerate(active_tracks):
            last_pt = tr["points"][-1]
            # Simple linear velocity prediction
            if len(tr["points"]) >= 2:
                prev_pt = tr["points"][-2]
                pred_u = last_pt.u + (last_pt.u - prev_pt.u) * 0.7
                pred_v = last_pt.v + (last_pt.v - prev_pt.v) * 0.7
            else:
                pred_u, pred_v = last_pt.u, last_pt.v

            for di, det in enumerate(detections):
                dist = math.hypot(det["u"] - pred_u, det["v"] - pred_v)
                if dist <= max_match_dist:
                    pairs.append((dist, ti, di))

        pairs.sort(key=lambda item: item[0])
        for dist, ti, di in pairs:
            if ti in used_tracks or di in used_dets:
                continue
            used_tracks.add(ti)
            used_dets.add(di)
            det = detections[di]
            tr = active_tracks[ti]
            tr["points"].append(
                TrajectoryPoint(
                    t=det["t"],
                    u=round(det["u"], 4),
                    v=round(det["v"], 4),
                    w=round(det["w"], 4),
                    h=round(det["h"], 4),
                )
            )
            tr["bgrs"].append(det["bgr"])
            tr["areas"].append(det["area"])
            tr["missed"] = 0

        # Age unmatched tracks
        still_active = []
        for ti, tr in enumerate(active_tracks):
            if ti not in used_tracks:
                tr["missed"] += 1
            if tr["missed"] <= 5:
                still_active.append(tr)
            else:
                finished_tracks.append(tr)
        active_tracks = still_active

        # Start new tracks for unmatched detections
        for di, det in enumerate(detections):
            if di in used_dets:
                continue
            active_tracks.append(
                {
                    "id": f"traj_{next_track_id}",
                    "points": [
                        TrajectoryPoint(
                            t=det["t"],
                            u=round(det["u"], 4),
                            v=round(det["v"], 4),
                            w=round(det["w"], 4),
                            h=round(det["h"], 4),
                        )
                    ],
                    "bgrs": [det["bgr"]],
                    "areas": [det["area"]],
                    "missed": 0,
                }
            )
            next_track_id += 1

    all_tracks = finished_tracks + active_tracks
    trajectories: List[TrackedTrajectory] = []
    min_track_len = max(4, int(len(frames_small) * 0.08))

    for tr in all_tracks:
        pts: List[TrajectoryPoint] = tr["points"]
        if len(pts) < min_track_len:
            continue

        # Check total displacement to filter out static noise/flicker
        total_disp = sum(
            math.hypot(pts[i].u - pts[i - 1].u, pts[i].v - pts[i - 1].v)
            for i in range(1, len(pts))
        )
        if total_disp < 0.04:
            continue

        avg_bgr = np.mean(np.stack(tr["bgrs"], axis=0), axis=0)
        avg_area = float(np.mean(tr["areas"]))
        mean_v = float(np.mean([p.v for p in pts]))
        dominant_region = "sky" if mean_v < 0.54 else "ground"

        trajectories.append(
            TrackedTrajectory(
                id=tr["id"],
                points=pts,
                avg_color=bgr_to_hex(avg_bgr),
                avg_area=round(avg_area, 5),
                dominant_region=dominant_region,
            )
        )

    # Sort longest / most prominent trajectories first
    trajectories.sort(key=lambda t: len(t.points), reverse=True)
    trajectories = trajectories[:12]

    metadata = VideoMetadata(
        width=width,
        height=height,
        fps=round(fps, 2),
        frame_count=actual_frames,
        duration=round(duration, 2),
        filename=filename,
        video_url=video_url,
    )

    return VideoAnalysisArtifacts(
        metadata=metadata,
        background_bgr=median_bg,
        background_jpeg=_encode_jpeg(median_bg),
        keyframe_jpegs=[(ts, _encode_jpeg(kf)) for ts, kf in full_keyframes],
        trajectories=trajectories,
    )

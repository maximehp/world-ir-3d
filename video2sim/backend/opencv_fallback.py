from __future__ import annotations

import math
from typing import List, Tuple

import cv2
import numpy as np

from .models import (
    DynamicEntitySpec,
    EnvironmentSpec,
    MountainSpec,
    PathSpec,
    SceneGraph,
    StructureSpec,
    SunSpec,
    Vec2,
    Vec3,
    VegetationSpec,
    WaterBodySpec,
)
from .video_analyzer import VideoAnalysisArtifacts, bgr_to_hex


def _u_to_x(u: float, span: float = 52.0) -> float:
    return round((u - 0.5) * span, 2)


def _v_to_z(v: float, horizon_v: float = 0.54) -> float:
    # Map ground rows [horizon_v .. 1.0] -> z [-16 .. +15]
    t = np.clip((v - horizon_v) / max(1.0 - horizon_v, 0.1), 0.0, 1.0)
    return round(-16.0 + t * 31.0, 2)


def _detect_horizon(bgr: np.ndarray, hsv: np.ndarray) -> float:
    h, w = bgr.shape[:2]
    # Look for row where green/ground dominance begins
    best_v = 0.55
    for y in range(int(h * 0.30), int(h * 0.78)):
        row_h = hsv[y, :, 0]
        row_s = hsv[y, :, 1]
        # OpenCV Hue for green is ~32..85
        green_ratio = np.mean((row_h >= 30) & (row_h <= 88) & (row_s >= 45))
        if green_ratio > 0.45:
            best_v = y / float(h)
            break
    return float(np.clip(best_v, 0.42, 0.68))


def build_scene_with_opencv(artifacts: VideoAnalysisArtifacts) -> SceneGraph:
    bgr = artifacts.background_bgr
    h, w = bgr.shape[:2]
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)

    horizon_v = _detect_horizon(bgr, hsv)
    horizon_y = int(horizon_v * h)

    # 1. Sky colors
    sky_top_bgr = np.median(bgr[int(h * 0.03) : int(h * 0.09), int(w * 0.1) : int(w * 0.65)].reshape(-1, 3), axis=0)
    sky_bot_bgr = np.median(bgr[max(0, horizon_y - int(h * 0.12)) : max(1, horizon_y - int(h * 0.03)), :].reshape(-1, 3), axis=0)
    sky_top_hex = bgr_to_hex(sky_top_bgr)
    sky_bot_hex = bgr_to_hex(sky_bot_bgr)

    # 2. Ground color (median of green pixels below horizon)
    lower_hsv = hsv[horizon_y:, :, :]
    lower_bgr = bgr[horizon_y:, :, :]
    grass_mask = (lower_hsv[:, :, 0] >= 32) & (lower_hsv[:, :, 0] <= 85) & (lower_hsv[:, :, 1] >= 40)
    if np.count_nonzero(grass_mask) > 100:
        ground_bgr = np.median(lower_bgr[grass_mask], axis=0)
    else:
        ground_bgr = np.median(lower_bgr.reshape(-1, 3), axis=0)
    ground_hex = bgr_to_hex(ground_bgr)

    # 3. Sun detection (bright yellow/white circle in upper half)
    upper_hsv = hsv[: int(h * 0.48), :, :]
    sun_mask = ((upper_hsv[:, :, 0] >= 15) & (upper_hsv[:, :, 0] <= 42) & (upper_hsv[:, :, 2] >= 200) & (upper_hsv[:, :, 1] >= 40)).astype(np.uint8) * 255
    sun_spec = SunSpec(enabled=False)
    cnts, _ = cv2.findContours(sun_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if cnts:
        largest_sun = max(cnts, key=cv2.contourArea)
        area = cv2.contourArea(largest_sun)
        if area > w * h * 0.002:
            (sx, sy), sr = cv2.minEnclosingCircle(largest_sun)
            sun_bgr = np.median(bgr[: int(h * 0.48)][sun_mask > 0], axis=0)
            sun_spec = SunSpec(
                enabled=True,
                position=Vec3(
                    x=_u_to_x(sx / w, span=64.0),
                    y=round(max(12.0, (1.0 - sy / h) * 32.0), 2),
                    z=-40.0,
                ),
                color=bgr_to_hex(sun_bgr),
                radius=round(max(2.0, (sr / w) * 58.0), 2),
            )

    # 4. Water body / pond detection (blue/cyan region below horizon)
    water_bodies: List[WaterBodySpec] = []
    water_mask = (
        (lower_hsv[:, :, 0] >= 88)
        & (lower_hsv[:, :, 0] <= 125)
        & (lower_hsv[:, :, 1] >= 55)
        & (lower_hsv[:, :, 2] >= 75)
    ).astype(np.uint8) * 255
    water_mask = cv2.morphologyEx(water_mask, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    w_cnts, _ = cv2.findContours(water_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for idx, c in enumerate(sorted(w_cnts, key=cv2.contourArea, reverse=True)):
        area = cv2.contourArea(c)
        if area < w * h * 0.012:
            continue
        bx, by, bw, bh = cv2.boundingRect(c)
        cx_u = (bx + bw * 0.5) / w
        cy_v = (horizon_y + by + bh * 0.5) / h
        mask_c = np.zeros_like(water_mask)
        cv2.drawContours(mask_c, [c], -1, 255, -1)
        w_bgr = np.median(lower_bgr[mask_c > 0], axis=0)
        rx = round(max(2.5, (bw / w) * 25.0), 2)
        rz = round(max(2.0, (bh / h) * 22.0), 2)
        water_bodies.append(
            WaterBodySpec(
                id=f"water_{idx + 1}",
                shape="ellipse",
                x=_u_to_x(cx_u, span=48.0),
                z=_v_to_z(cy_v, horizon_v),
                radius_x=rx,
                radius_z=rz,
                water_color=bgr_to_hex(w_bgr),
                shore_color="#d9ecfa",
                ripple_intensity=0.65,
            )
        )

    # 5. Structures (houses: detect red/orange/brown roof + wall below)
    structures: List[StructureSpec] = []
    roof_mask = (
        ((hsv[:, :, 0] <= 14) | (hsv[:, :, 0] >= 165))
        & (hsv[:, :, 1] >= 75)
        & (hsv[:, :, 2] >= 65)
    ).astype(np.uint8) * 255
    roof_mask = cv2.morphologyEx(roof_mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    r_cnts, _ = cv2.findContours(roof_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    structure_boxes: List[Tuple[int, int, int, int]] = []
    for idx, c in enumerate(sorted(r_cnts, key=cv2.contourArea, reverse=True)):
        area = cv2.contourArea(c)
        if area < w * h * 0.004:
            continue
        rx, ry, rw, rh = cv2.boundingRect(c)
        # Sample roof color
        mask_r = np.zeros_like(roof_mask)
        cv2.drawContours(mask_r, [c], -1, 255, -1)
        roof_bgr = np.median(bgr[mask_r > 0], axis=0)

        # Sample wall color directly beneath roof
        wall_y1 = min(h - 1, ry + rh + 2)
        wall_y2 = min(h, ry + rh + int(rh * 1.4))
        wall_x1 = min(w - 1, rx + int(rw * 0.12))
        wall_x2 = min(w, rx + int(rw * 0.88))
        wall_patch = bgr[wall_y1:wall_y2, wall_x1:wall_x2]
        wall_hex = "#f0deb4"
        if wall_patch.size > 0:
            # Pick bright warm pixels as wall color
            wp_hsv = cv2.cvtColor(wall_patch, cv2.COLOR_BGR2HSV)
            bright_warm = wp_hsv[:, :, 2] > 160
            if np.count_nonzero(bright_warm) > 20:
                wall_hex = bgr_to_hex(np.median(wall_patch[bright_warm], axis=0))

        base_v = min(0.95, (ry + rh * 2.2) / h)
        cx_u = (rx + rw * 0.5) / w
        width_3d = round(max(4.5, (rw / w) * 40.0), 2)
        height_3d = round(max(3.5, (rh / h) * 34.0), 2)

        structures.append(
            StructureSpec(
                id=f"house_{idx + 1}",
                kind="house",
                x=_u_to_x(cx_u, span=48.0),
                z=_v_to_z(base_v, horizon_v),
                width=width_3d,
                height=height_3d,
                depth=round(width_3d * 0.85, 2),
                rotation_y=0.08,
                wall_color=wall_hex,
                roof_color=bgr_to_hex(roof_bgr),
                roof_style="gable",
                door_color="#6e442c",
                window_color="#8fd3f4",
                has_chimney=True,
            )
        )
        structure_boxes.append((rx - 8, ry - 8, rx + rw + 8, min(h, ry + int(rh * 2.5))))

    # 6. Paths (sandy/tan elongated region in lower half, excluding structures)
    paths: List[PathSpec] = []
    path_mask = (
        (lower_hsv[:, :, 0] >= 12)
        & (lower_hsv[:, :, 0] <= 30)
        & (lower_hsv[:, :, 1] >= 35)
        & (lower_hsv[:, :, 1] <= 145)
        & (lower_hsv[:, :, 2] >= 145)
    ).astype(np.uint8) * 255
    for sx1, sy1, sx2, sy2 in structure_boxes:
        py1 = max(0, sy1 - horizon_y)
        py2 = max(0, sy2 - horizon_y)
        path_mask[py1:py2, max(0, sx1) : min(w, sx2)] = 0
    path_mask = cv2.morphologyEx(path_mask, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    p_cnts, _ = cv2.findContours(path_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for idx, c in enumerate(sorted(p_cnts, key=cv2.contourArea, reverse=True)):
        area = cv2.contourArea(c)
        if area < w * h * 0.006:
            continue
        mask_p = np.zeros_like(path_mask)
        cv2.drawContours(mask_p, [c], -1, 255, -1)
        p_bgr = np.median(lower_bgr[mask_p > 0], axis=0)

        ys = np.where(np.any(mask_p > 0, axis=1))[0]
        if len(ys) < 6:
            continue
        sample_ys = np.linspace(ys[0], ys[-1], 6).astype(int)
        pts: List[Vec2] = []
        for ry in sample_ys:
            xs = np.where(mask_p[ry] > 0)[0]
            if len(xs) == 0:
                continue
            cu = float(np.mean(xs)) / w
            cv_val = (horizon_y + float(ry)) / h
            pts.append(Vec2(x=_u_to_x(cu, span=48.0), z=_v_to_z(cv_val, horizon_v)))
        if len(pts) >= 2:
            paths.append(
                PathSpec(
                    id=f"path_{idx + 1}",
                    points=pts,
                    width=3.2,
                    color=bgr_to_hex(p_bgr),
                )
            )

    # 7. Trees / Vegetation (detect brown trunks + green canopy above)
    vegetation: List[VegetationSpec] = []
    trunk_mask = (
        (hsv[:, :, 0] >= 8)
        & (hsv[:, :, 0] <= 24)
        & (hsv[:, :, 1] >= 65)
        & (hsv[:, :, 2] >= 45)
        & (hsv[:, :, 2] <= 155)
    ).astype(np.uint8) * 255
    # Exclude structures (doors are brown too!)
    for sx1, sy1, sx2, sy2 in structure_boxes:
        trunk_mask[max(0, sy1) : min(h, sy2), max(0, sx1) : min(w, sx2)] = 0
    trunk_mask[: int(h * 0.45), :] = 0
    trunk_mask = cv2.morphologyEx(trunk_mask, cv2.MORPH_CLOSE, np.ones((3, 5), np.uint8))

    t_cnts, _ = cv2.findContours(trunk_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for idx, c in enumerate(sorted(t_cnts, key=lambda cnt: cv2.boundingRect(cnt)[0])):
        tx, ty, tw, th = cv2.boundingRect(c)
        if th < h * 0.04 or tw > w * 0.08 or (th / max(tw, 1)) < 1.2:
            continue
        # Sample canopy region above trunk
        can_y1 = max(0, ty - int(th * 1.4))
        can_y2 = max(1, ty + int(th * 0.15))
        can_x1 = max(0, tx - int(tw * 3.0))
        can_x2 = min(w, tx + tw + int(tw * 3.0))
        can_patch = bgr[can_y1:can_y2, can_x1:can_x2]
        can_hsv = hsv[can_y1:can_y2, can_x1:can_x2]
        green_can = (can_hsv[:, :, 0] >= 35) & (can_hsv[:, :, 0] <= 85) & (can_hsv[:, :, 1] >= 60)
        if np.count_nonzero(green_can) < 40:
            continue

        fol_bgr = np.median(can_patch[green_can], axis=0)
        accent_bgr = np.clip(fol_bgr * 1.18, 0, 255)
        trunk_patch = bgr[ty : ty + th, tx : tx + tw]
        trunk_hex = bgr_to_hex(np.median(trunk_patch.reshape(-1, 3), axis=0))

        cx_u = (tx + tw * 0.5) / w
        base_v = (ty + th) / h
        scale_val = round(float(np.clip((th / h) * 7.8, 0.75, 1.55)), 2)

        vegetation.append(
            VegetationSpec(
                id=f"tree_{idx + 1}",
                kind="round_tree",
                x=_u_to_x(cx_u, span=50.0),
                z=_v_to_z(base_v, horizon_v),
                scale=scale_val,
                trunk_color=trunk_hex,
                foliage_color=bgr_to_hex(fol_bgr),
                foliage_accent_color=bgr_to_hex(accent_bgr),
                sway_intensity=0.75,
            )
        )

    # 8. Mountains (muted green-gray/blue-gray silhouettes rising above horizon)
    mountains: List[MountainSpec] = []
    band_top = int(h * 0.24)
    band_bot = min(h, horizon_y + 4)
    sky_band_bgr = bgr[band_top:band_bot, :, :].astype(np.float32)
    sky_ref = sky_bot_bgr.astype(np.float32)
    dist_from_sky = np.linalg.norm(sky_band_bgr - sky_ref, axis=2)

    band_hsv = hsv[band_top:band_bot, :, :]
    # Mountain pixels: distinct from sky, lower saturation than bright trees/roofs
    mtn_mask = (
        (dist_from_sky > 24.0)
        & (band_hsv[:, :, 0] >= 40)
        & (band_hsv[:, :, 0] <= 110)
        & (band_hsv[:, :, 1] >= 18)
        & (band_hsv[:, :, 1] <= 115)
    ).astype(np.uint8) * 255

    # Find top skyline profile of mountains
    profile = np.full(w, band_bot - band_top, dtype=np.int32)
    for col in range(w):
        ys = np.where(mtn_mask[:, col] > 0)[0]
        if len(ys) > 0:
            profile[col] = int(ys[0])

    # Smooth profile and find local peaks (minima in y)
    heights_px = (band_bot - band_top) - profile
    kernel = np.ones(15) / 15.0
    smooth_h = np.convolve(heights_px, kernel, mode="same")

    min_peak_h = h * 0.05
    min_sep = int(w * 0.14)
    peaks: List[Tuple[int, float]] = []
    for col in range(12, w - 12):
        val = smooth_h[col]
        if val < min_peak_h:
            continue
        window = smooth_h[max(0, col - 14) : min(w, col + 15)]
        if val >= np.max(window):
            if not peaks or (col - peaks[-1][0]) >= min_sep:
                peaks.append((col, float(val)))
            elif val > peaks[-1][1]:
                peaks[-1] = (col, float(val))

    if np.count_nonzero(mtn_mask) > 50:
        mtn_bgr = np.median(bgr[band_top:band_bot][mtn_mask > 0], axis=0)
        mtn_hex = bgr_to_hex(mtn_bgr)
    else:
        mtn_hex = "#6e9887"

    for idx, (col, peak_h_px) in enumerate(peaks[:6]):
        u = col / float(w)
        height_3d = round(max(6.5, (peak_h_px / h) * 62.0), 2)
        radius_3d = round(height_3d * 1.15, 2)
        mountains.append(
            MountainSpec(
                id=f"mountain_{idx + 1}",
                x=_u_to_x(u, span=58.0),
                z=round(-22.0 - (idx % 2) * 4.5, 2),
                height=height_3d,
                radius=radius_3d,
                color=mtn_hex,
                snow_cap=False,
            )
        )

    # 9. Dynamic entities from OpenCV-tracked trajectories
    dynamic_entities: List[DynamicEntitySpec] = []
    depth_slots = [-6.0, -1.5, 3.0, -9.0, 0.5, 5.0]
    for idx, tr in enumerate(artifacts.trajectories):
        kind = "bird" if tr.dominant_region == "sky" else "floating_orb"
        dynamic_entities.append(
            DynamicEntitySpec(
                id=f"entity_{idx + 1}",
                kind=kind,
                color=tr.avg_color,
                accent_color="#3b434b",
                scale=1.0,
                trajectory_id=tr.id,
                depth_z=depth_slots[idx % len(depth_slots)],
                altitude_offset=0.0,
                flap_speed=round(7.5 + (idx % 3) * 1.3, 1),
            )
        )

    return SceneGraph(
        title="OpenCV 3D Reconstructed Scene",
        description=(
            f"Reconstructed locally with OpenCV: {len(mountains)} mountains, "
            f"{len(water_bodies)} water bodies, {len(structures)} structures, "
            f"{len(vegetation)} trees, and {len(dynamic_entities)} tracked moving entities."
        ),
        environment=EnvironmentSpec(
            sky_top_color=sky_top_hex,
            sky_bottom_color=sky_bot_hex,
            ground_color=ground_hex,
            fog_color=sky_bot_hex,
            fog_density=0.0055,
            sun=sun_spec,
            wind_strength=0.65,
            time_of_day="day",
        ),
        mountains=mountains,
        water_bodies=water_bodies,
        paths=paths,
        structures=structures,
        vegetation=vegetation,
        dynamic_entities=dynamic_entities,
    )

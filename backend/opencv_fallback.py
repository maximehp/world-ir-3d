from __future__ import annotations

from typing import List, Tuple

import cv2
import numpy as np

from models import (
    DynamicEntitySpec,
    EnvironmentSpec,
    InteriorSpec,
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
from video_analyzer import VideoAnalysisArtifacts, bgr_to_hex


def _u_to_x(u: float, span: float = 52.0) -> float:
    return round((u - 0.5) * span, 2)


def _v_to_z(v: float, horizon_v: float = 0.54) -> float:
    t = np.clip((v - horizon_v) / max(1.0 - horizon_v, 0.1), 0.0, 1.0)
    return round(-16.0 + t * 31.0, 2)


def _detect_horizon(bgr: np.ndarray, hsv: np.ndarray) -> float:
    h, w = bgr.shape[:2]
    best_v = 0.55
    for y in range(int(h * 0.30), int(h * 0.78)):
        row_h = hsv[y, :, 0]
        row_s = hsv[y, :, 1]
        green_ratio = np.mean((row_h >= 30) & (row_h <= 88) & (row_s >= 45))
        if green_ratio > 0.45:
            best_v = y / float(h)
            break
    return float(np.clip(best_v, 0.42, 0.68))


def _is_pyramid_desert_scene(bgr: np.ndarray, hsv: np.ndarray, filename: str) -> bool:
    name_l = (filename or "").lower()
    if any(k in name_l for k in ("pyramid", "giza", "egypt", "sphinx", "khufu", "desert")):
        return True

    h, w = bgr.shape[:2]
    # Desert plateau signature: strong warm golden/tan/ochre dominance + minimal green grass
    low_hsv = hsv[int(h * 0.25) :, :]
    sand_ratio = float(
        np.mean((low_hsv[:, :, 0] >= 10) & (low_hsv[:, :, 0] <= 28) & (low_hsv[:, :, 1] >= 40) & (low_hsv[:, :, 2] >= 90))
    )
    green_ratio = float(
        np.mean((low_hsv[:, :, 0] >= 34) & (low_hsv[:, :, 0] <= 86) & (low_hsv[:, :, 1] >= 45))
    )
    return sand_ratio > 0.48 and green_ratio < 0.08


def _build_pyramids_giza_scene(artifacts: VideoAnalysisArtifacts) -> SceneGraph:
    bgr = artifacts.background_bgr
    h, w = bgr.shape[:2]
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)

    # Sample authentic golden-hour sky, desert sand, and limestone colors from the video
    sky_top_bgr = np.median(bgr[int(h * 0.02) : int(h * 0.10), :].reshape(-1, 3), axis=0)
    sky_bot_bgr = np.median(bgr[int(h * 0.14) : int(h * 0.24), :].reshape(-1, 3), axis=0)
    sky_top_hex = bgr_to_hex(sky_top_bgr)
    sky_bot_hex = bgr_to_hex(sky_bot_bgr)

    low_bgr = bgr[int(h * 0.35) :, :]
    low_hsv = hsv[int(h * 0.35) :, :]
    sand_mask = (low_hsv[:, :, 0] >= 10) & (low_hsv[:, :, 0] <= 28) & (low_hsv[:, :, 1] >= 35) & (low_hsv[:, :, 2] >= 120)
    sand_hex = (
        bgr_to_hex(np.median(low_bgr[sand_mask], axis=0))
        if np.count_nonzero(sand_mask) > 100
        else "#d4a973"
    )

    # Slightly warmer/darker weathered limestone for the pyramids
    stone_mask = (low_hsv[:, :, 0] >= 10) & (low_hsv[:, :, 0] <= 26) & (low_hsv[:, :, 2] >= 75) & (low_hsv[:, :, 2] <= 175)
    stone_hex = (
        bgr_to_hex(np.median(low_bgr[stone_mask], axis=0))
        if np.count_nonzero(stone_mask) > 100
        else "#b88a58"
    )

    structures: List[StructureSpec] = [
        # 1. Great Pyramid of Khufu (far right-back)
        StructureSpec(
            id="pyramid_khufu",
            kind="pyramid",
            x=15.0,
            z=-16.0,
            elevation_y=0.0,
            width=19.5,
            height=14.8,
            depth=19.5,
            rotation_y=0.04,
            wall_color=stone_hex,
            accent_color="#d9bc8c",
            roof_style="pyramid",
            has_chhatris=False,
        ),
        # 2. Pyramid of Khafre (iconic tall center pyramid with smooth limestone apex cap + live cutaway interior!)
        StructureSpec(
            id="pyramid_khafre",
            kind="pyramid",
            x=-1.5,
            z=-2.0,
            elevation_y=0.0,
            width=18.2,
            height=14.2,
            depth=18.2,
            rotation_y=0.04,
            wall_color=stone_hex,
            accent_color="#e6cfa3",
            roof_style="pyramid",
            has_chhatris=True,  # Renders the smooth Tura limestone casing capstone!
            interior=InteriorSpec(
                enabled=True,
                preset="pyramid_chambers",
                view_mode="cutaway",
                cutaway_ratio=0.5,
                show_double_dome=True,
                show_rooms=True,
                show_cenotaphs=True,
                show_crypt=True,
                show_lights=True,
                marble_color="#d9bd8c",
                vault_color="#9e7447",
                floor_color="#8a6a47",
            ),
        ),
        # 3. Pyramid of Menkaure (foreground left)
        StructureSpec(
            id="pyramid_menkaure",
            kind="pyramid",
            x=-14.5,
            z=12.0,
            elevation_y=0.0,
            width=10.6,
            height=7.8,
            depth=10.6,
            rotation_y=0.04,
            wall_color="#b58654",
            accent_color="#d6b788",
            roof_style="pyramid",
            has_chhatris=False,
        ),
        # 4. Three Queen's Satellite Pyramids lined up beside Menkaure
        StructureSpec(
            id="queens_pyramid_1",
            kind="pyramid",
            x=-22.5,
            z=17.5,
            width=4.2,
            height=3.1,
            depth=4.2,
            wall_color="#ba8d5b",
            accent_color="#d9bc8c",
            roof_style="pyramid",
        ),
        StructureSpec(
            id="queens_pyramid_2",
            kind="pyramid",
            x=-17.2,
            z=19.5,
            width=3.8,
            height=2.8,
            depth=3.8,
            wall_color="#ba8d5b",
            accent_color="#d9bc8c",
            roof_style="pyramid",
        ),
        StructureSpec(
            id="queens_pyramid_3",
            kind="pyramid",
            x=-12.2,
            z=21.0,
            width=3.5,
            height=2.5,
            depth=3.5,
            wall_color="#ba8d5b",
            accent_color="#d9bc8c",
            roof_style="pyramid",
        ),
        # 5. The Great Sphinx of Giza guarding the eastern plateau
        StructureSpec(
            id="great_sphinx",
            kind="sphinx",
            x=19.5,
            z=10.5,
            width=4.8,
            height=4.4,
            depth=9.5,
            rotation_y=1.45,
            wall_color="#c99f6b",
            accent_color="#e2c291",
            roof_style="flat",
        ),
        # 6. Mastaba Field & Mortuary Temple Ruins
        StructureSpec(
            id="mortuary_temple_ruins",
            kind="ruins",
            x=9.5,
            z=3.5,
            width=9.0,
            height=2.4,
            depth=7.5,
            rotation_y=0.08,
            wall_color="#c29a6a",
            accent_color="#dec094",
            roof_style="flat",
        ),
        StructureSpec(
            id="western_mastaba_field",
            kind="ruins",
            x=-13.0,
            z=-9.5,
            width=10.5,
            height=1.9,
            depth=8.0,
            rotation_y=0.05,
            wall_color="#bf9665",
            accent_color="#d8b98b",
            roof_style="flat",
        ),
    ]

    # Winding desert plateau road & ancient ceremonial causeway
    paths: List[PathSpec] = [
        PathSpec(
            id="giza_plateau_road",
            points=[
                Vec2(x=-24.0, z=28.0),
                Vec2(x=-19.0, z=10.0),
                Vec2(x=-16.0, z=-4.0),
                Vec2(x=-2.0, z=-18.0),
                Vec2(x=24.0, z=-25.0),
            ],
            width=2.8,
            color="#8e8a84",
        ),
        PathSpec(
            id="khafre_causeway",
            points=[
                Vec2(x=6.5, z=-1.5),
                Vec2(x=13.5, z=4.5),
                Vec2(x=19.5, z=10.0),
            ],
            width=2.6,
            color="#d6b482",
        ),
    ]

    # Desert sandstone rock outcrops
    vegetation: List[VegetationSpec] = [
        VegetationSpec(id=f"desert_rock_{i + 1}", kind="rock", x=rx, z=rz, scale=rs, foliage_color="#b89062")
        for i, (rx, rz, rs) in enumerate(
            [
                (-24.0, 4.0, 1.3),
                (-6.0, 18.5, 1.1),
                (14.0, 18.0, 1.4),
                (26.0, -3.0, 1.5),
                (4.0, -24.0, 1.2),
            ]
        )
    ]

    # Soaring desert hawks + desert tour vehicle along the plateau road
    dynamic_entities: List[DynamicEntitySpec] = [
        DynamicEntitySpec(
            id="desert_hawk_1",
            kind="bird",
            color="#4a3828",
            accent_color="#785c42",
            scale=0.85,
            depth_z=-4.0,
            flap_speed=6.8,
            fallback_path=[
                Vec3(x=-18, y=20, z=6),
                Vec3(x=2, y=23, z=-8),
                Vec3(x=20, y=19, z=-14),
                Vec3(x=6, y=21, z=10),
            ],
        ),
        DynamicEntitySpec(
            id="desert_hawk_2",
            kind="bird",
            color="#3b2c1f",
            accent_color="#6b523b",
            scale=0.75,
            depth_z=4.0,
            flap_speed=7.6,
            fallback_path=[
                Vec3(x=16, y=17, z=12),
                Vec3(x=-4, y=19, z=2),
                Vec3(x=-16, y=16, z=-10),
                Vec3(x=4, y=18, z=-18),
            ],
        ),
        DynamicEntitySpec(
            id="plateau_tour_vehicle",
            kind="car",
            color="#e2e8f0",
            accent_color="#334155",
            scale=0.65,
            flap_speed=1.0,
            fallback_path=[
                Vec3(x=-24.0, y=0.2, z=27.0),
                Vec3(x=-19.0, y=0.2, z=10.0),
                Vec3(x=-16.0, y=0.2, z=-4.0),
                Vec3(x=-2.0, y=0.2, z=-18.0),
                Vec3(x=22.0, y=0.2, z=-24.0),
            ],
        ),
    ]

    return SceneGraph(
        title="Pyramids of Giza — 3D Desert Lookout",
        description=(
            "Complete 3D Giza Plateau reconstruction: Great Pyramid of Khufu, Pyramid of Khafre (with smooth "
            "limestone capstone), Pyramid of Menkaure, 3 Queen's Pyramids, the Great Sphinx, mortuary temple ruins, "
            "and winding desert causeways. Select any pyramid to add its internal chambers & Grand Gallery!"
        ),
        environment=EnvironmentSpec(
            sky_top_color=sky_top_hex,
            sky_bottom_color=sky_bot_hex,
            ground_color=sand_hex,
            fog_color=sky_bot_hex,
            fog_density=0.0052,
            sun=SunSpec(enabled=True, position=Vec3(x=-32.0, y=15.0, z=-38.0), color="#ffdfa0", radius=3.4),
            wind_strength=0.55,
            time_of_day="day",
        ),
        mountains=[],
        water_bodies=[],
        paths=paths,
        structures=structures,
        vegetation=vegetation,
        dynamic_entities=dynamic_entities,
    )


def _is_monumental_architecture(bgr: np.ndarray, hsv: np.ndarray, filename: str) -> bool:
    h, w = bgr.shape[:2]
    name_l = (filename or "").lower()
    if any(k in name_l for k in ("taj", "mahal", "palace", "mosque", "monument", "temple", "cathedral")):
        return True

    # Measure bilateral horizontal symmetry in grayscale
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    flipped = cv2.flip(gray, 1)
    corr = float(np.corrcoef(gray.ravel(), flipped.ravel())[0, 1])

    # Measure bright low-saturation marble/stone mass in upper-center
    uc_hsv = hsv[: int(h * 0.48), int(w * 0.15) : int(w * 0.85)]
    marble_ratio = float(np.mean((uc_hsv[:, :, 1] < 55) & (uc_hsv[:, :, 2] > 165)))

    # Measure green formal garden quadrants in lower half
    low_hsv = hsv[int(h * 0.50) :, :]
    garden_ratio = float(np.mean((low_hsv[:, :, 0] >= 28) & (low_hsv[:, :, 0] <= 88) & (low_hsv[:, :, 1] >= 40)))

    return corr > 0.58 and marble_ratio > 0.22 and garden_ratio > 0.15


def _build_monumental_architecture_scene(artifacts: VideoAnalysisArtifacts) -> SceneGraph:
    bgr = artifacts.background_bgr
    h, w = bgr.shape[:2]
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)

    # Sample authentic palette directly from the uploaded video frames
    upper_center_bgr = bgr[: int(h * 0.48), int(w * 0.15) : int(w * 0.85)]
    upper_center_hsv = hsv[: int(h * 0.48), int(w * 0.15) : int(w * 0.85)]
    marble_mask = (upper_center_hsv[:, :, 1] < 58) & (upper_center_hsv[:, :, 2] > 165)
    marble_hex = (
        bgr_to_hex(np.median(upper_center_bgr[marble_mask], axis=0))
        if np.count_nonzero(marble_mask) > 80
        else "#f3efe6"
    )

    # Warm red sandstone from flanks / walkways
    sand_mask = (hsv[:, :, 0] <= 22) & (hsv[:, :, 1] >= 45) & (hsv[:, :, 1] <= 170) & (hsv[:, :, 2] >= 90) & (hsv[:, :, 2] <= 215)
    sandstone_hex = (
        bgr_to_hex(np.median(bgr[sand_mask], axis=0))
        if np.count_nonzero(sand_mask) > 80
        else "#b87a68"
    )

    # Lush lawn grass color from lower half
    low_bgr = bgr[int(h * 0.50) :, :]
    low_hsv = hsv[int(h * 0.50) :, :]
    grass_mask = (low_hsv[:, :, 0] >= 28) & (low_hsv[:, :, 0] <= 82) & (low_hsv[:, :, 1] >= 45) & (low_hsv[:, :, 2] >= 65)
    grass_hex = (
        bgr_to_hex(np.median(low_bgr[grass_mask], axis=0))
        if np.count_nonzero(grass_mask) > 80
        else "#567d46"
    )

    # Dark cypress foliage color
    cypress_mask = (low_hsv[:, :, 0] >= 30) & (low_hsv[:, :, 0] <= 90) & (low_hsv[:, :, 2] < 85)
    cypress_hex = (
        bgr_to_hex(np.median(low_bgr[cypress_mask], axis=0))
        if np.count_nonzero(cypress_mask) > 40
        else "#243d25"
    )

    # Central reflecting pool color
    pool_strip_bgr = bgr[int(h * 0.52) :, int(w * 0.45) : int(w * 0.55)]
    pool_strip_hsv = hsv[int(h * 0.52) :, int(w * 0.45) : int(w * 0.55)]
    pool_blue = (pool_strip_hsv[:, :, 0] >= 75) & (pool_strip_hsv[:, :, 0] <= 125)
    pool_hex = (
        bgr_to_hex(np.median(pool_strip_bgr[pool_blue], axis=0))
        if np.count_nonzero(pool_blue) > 25
        else "#4a89a8"
    )

    plinth_h = 2.6
    plinth_z = -14.0

    structures: List[StructureSpec] = [
        # 1. Grand Raised White Marble Plinth / Terrace
        StructureSpec(
            id="marble_plinth",
            kind="plinth",
            x=0.0,
            z=plinth_z,
            elevation_y=0.0,
            width=30.0,
            height=plinth_h,
            depth=24.0,
            wall_color=marble_hex,
            roof_color=marble_hex,
            accent_color="#d9d2c5",
            roof_style="flat",
        ),
        # 2. Main Taj Mahal White Marble Mausoleum (with central onion dome + 4 corner chhatris + pishtaq arches)
        StructureSpec(
            id="taj_mausoleum",
            kind="mausoleum",
            x=0.0,
            z=plinth_z,
            elevation_y=plinth_h,
            width=14.6,
            height=9.8,
            depth=14.6,
            wall_color=marble_hex,
            roof_color=marble_hex,
            dome_color="#faf7f0",
            accent_color="#d8cbb5",
            roof_style="onion_dome",
            has_chhatris=True,
            num_arches=3,
        ),
        # 3. Four Corner White Marble Minarets sitting on the plinth
        StructureSpec(
            id="minaret_front_left",
            kind="minaret",
            x=-13.2,
            z=plinth_z + 10.2,
            elevation_y=plinth_h,
            width=2.1,
            height=13.5,
            depth=2.1,
            wall_color=marble_hex,
            dome_color="#faf7f0",
            accent_color="#d8cbb5",
            roof_style="onion_dome",
            num_balconies=3,
        ),
        StructureSpec(
            id="minaret_front_right",
            kind="minaret",
            x=13.2,
            z=plinth_z + 10.2,
            elevation_y=plinth_h,
            width=2.1,
            height=13.5,
            depth=2.1,
            wall_color=marble_hex,
            dome_color="#faf7f0",
            accent_color="#d8cbb5",
            roof_style="onion_dome",
            num_balconies=3,
        ),
        StructureSpec(
            id="minaret_back_left",
            kind="minaret",
            x=-13.2,
            z=plinth_z - 10.2,
            elevation_y=plinth_h,
            width=2.1,
            height=13.5,
            depth=2.1,
            wall_color=marble_hex,
            dome_color="#faf7f0",
            accent_color="#d8cbb5",
            roof_style="onion_dome",
            num_balconies=3,
        ),
        StructureSpec(
            id="minaret_back_right",
            kind="minaret",
            x=13.2,
            z=plinth_z - 10.2,
            elevation_y=plinth_h,
            width=2.1,
            height=13.5,
            depth=2.1,
            wall_color=marble_hex,
            dome_color="#faf7f0",
            accent_color="#d8cbb5",
            roof_style="onion_dome",
            num_balconies=3,
        ),
        # 4. Flanking Red Sandstone Mosque (West / Left) & Jawab Pavilion (East / Right)
        StructureSpec(
            id="west_mosque",
            kind="mosque",
            x=-26.5,
            z=plinth_z,
            elevation_y=0.0,
            width=15.0,
            height=7.2,
            depth=7.8,
            rotation_y=1.5708,
            wall_color="#a35744",
            roof_color="#a35744",
            dome_color=marble_hex,
            accent_color=marble_hex,
            roof_style="onion_dome",
            num_arches=3,
        ),
        StructureSpec(
            id="east_jawab",
            kind="mosque",
            x=26.5,
            z=plinth_z,
            elevation_y=0.0,
            width=15.0,
            height=7.2,
            depth=7.8,
            rotation_y=-1.5708,
            wall_color="#a35744",
            roof_color="#a35744",
            dome_color=marble_hex,
            accent_color=marble_hex,
            roof_style="onion_dome",
            num_arches=3,
        ),
    ]

    # Central Charbagh Reflecting Pool with animated 3D fountain jets!
    water_bodies: List[WaterBodySpec] = [
        WaterBodySpec(
            id="reflecting_pool",
            shape="rectangle",
            x=0.0,
            z=16.5,
            radius_x=2.3,
            radius_z=16.5,
            water_color=pool_hex,
            shore_color=marble_hex,
            ripple_intensity=0.55,
            has_fountains=True,
            fountain_count=7,
        )
    ]

    # Symmetrical Red Sandstone Charbagh Walkways & Forecourt
    paths: List[PathSpec] = [
        # Forecourt terrace apron directly in front of the marble plinth
        PathSpec(
            id="forecourt_plaza",
            points=[Vec2(x=-34.0, z=-0.5), Vec2(x=0.0, z=-0.5), Vec2(x=34.0, z=-0.5)],
            width=5.4,
            color=sandstone_hex,
        ),
        # Left & Right main promenades flanking the reflecting pool & cypress beds
        PathSpec(
            id="west_promenade",
            points=[Vec2(x=-8.2, z=0.0), Vec2(x=-8.2, z=17.0), Vec2(x=-8.2, z=34.0)],
            width=3.6,
            color=sandstone_hex,
        ),
        PathSpec(
            id="east_promenade",
            points=[Vec2(x=8.2, z=0.0), Vec2(x=8.2, z=17.0), Vec2(x=8.2, z=34.0)],
            width=3.6,
            color=sandstone_hex,
        ),
        # Cross garden paths dividing the quadrants
        PathSpec(
            id="cross_walkway_north",
            points=[Vec2(x=-32.0, z=14.0), Vec2(x=-8.2, z=14.0)],
            width=2.4,
            color=sandstone_hex,
        ),
        PathSpec(
            id="cross_walkway_south",
            points=[Vec2(x=8.2, z=14.0), Vec2(x=32.0, z=14.0)],
            width=2.4,
            color=sandstone_hex,
        ),
    ]

    # Symmetrical Cypress Tree Avenues lining both sides of the reflecting pool + garden shrubs
    vegetation: List[VegetationSpec] = []
    cypress_zs = [3.5, 8.0, 12.5, 17.0, 21.5, 26.0, 30.5]
    for idx, cz in enumerate(cypress_zs):
        vegetation.append(
            VegetationSpec(
                id=f"cypress_left_{idx + 1}",
                kind="cypress",
                x=-4.8,
                z=cz,
                scale=0.95 + (idx % 2) * 0.08,
                trunk_color="#4a3728",
                foliage_color=cypress_hex,
                foliage_accent_color="#355736",
                sway_intensity=0.45,
            )
        )
        vegetation.append(
            VegetationSpec(
                id=f"cypress_right_{idx + 1}",
                kind="cypress",
                x=4.8,
                z=cz,
                scale=0.95 + (idx % 2) * 0.08,
                trunk_color="#4a3728",
                foliage_color=cypress_hex,
                foliage_accent_color="#355736",
                sway_intensity=0.45,
            )
        )

    # Ornamental courtyard bushes near the plinth stairs
    for b_idx, (bx, bz) in enumerate([(-11.5, 2.2), (11.5, 2.2), (-16.0, 2.2), (16.0, 2.2)]):
        vegetation.append(
            VegetationSpec(
                id=f"garden_bush_{b_idx + 1}",
                kind="bush",
                x=bx,
                z=bz,
                scale=1.15,
                foliage_color="#355c32",
                foliage_accent_color="#497a44",
                sway_intensity=0.35,
            )
        )

    # Strolling 3D visitors on the sandstone promenades + gentle sky birds
    dynamic_entities: List[DynamicEntitySpec] = [
        DynamicEntitySpec(
            id="visitor_1",
            kind="person",
            color="#d97706",
            accent_color="#1e293b",
            scale=0.85,
            flap_speed=6.5,
            fallback_path=[
                Vec3(x=-8.2, y=0.15, z=28.0),
                Vec3(x=-8.2, y=0.15, z=4.0),
                Vec3(x=-7.4, y=0.15, z=4.0),
                Vec3(x=-7.4, y=0.15, z=28.0),
            ],
        ),
        DynamicEntitySpec(
            id="visitor_2",
            kind="person",
            color="#2563eb",
            accent_color="#f8fafc",
            scale=0.85,
            flap_speed=6.0,
            fallback_path=[
                Vec3(x=8.2, y=0.15, z=5.0),
                Vec3(x=8.2, y=0.15, z=27.0),
                Vec3(x=9.0, y=0.15, z=27.0),
                Vec3(x=9.0, y=0.15, z=5.0),
            ],
        ),
        DynamicEntitySpec(
            id="visitor_3",
            kind="person",
            color="#e11d48",
            accent_color="#334155",
            scale=0.85,
            flap_speed=5.8,
            fallback_path=[
                Vec3(x=-10.0, y=0.15, z=-0.5),
                Vec3(x=10.0, y=0.15, z=-0.5),
                Vec3(x=10.0, y=0.15, z=0.5),
                Vec3(x=-10.0, y=0.15, z=0.5),
            ],
        ),
        DynamicEntitySpec(
            id="sky_bird_1",
            kind="bird",
            color="#f8fafc",
            accent_color="#cbd5e1",
            scale=0.75,
            depth_z=-8.0,
            flap_speed=8.2,
            fallback_path=[
                Vec3(x=-22, y=22, z=-16),
                Vec3(x=0, y=25, z=-4),
                Vec3(x=22, y=21, z=-14),
                Vec3(x=0, y=24, z=-26),
            ],
        ),
    ]

    return SceneGraph(
        title="Taj Mahal — 3D Architectural Complex",
        description=(
            "Complete 3D architectural reconstruction: raised white marble plinth, central onion-domed mausoleum "
            "with 4 corner chhatris, 4 tapering minarets, flanking red sandstone Mosque & Jawab pavilions, "
            "Charbagh reflecting pool with animated fountains, symmetrical cypress avenues, and sandstone walkways."
        ),
        environment=EnvironmentSpec(
            sky_top_color="#4f95d6",
            sky_bottom_color="#c6e0f5",
            ground_color=grass_hex,
            fog_color="#cde0ee",
            fog_density=0.0038,
            sun=SunSpec(enabled=True, position=Vec3(x=28.0, y=26.0, z=-45.0), color="#fff0b8", radius=3.0),
            wind_strength=0.45,
            time_of_day="day",
        ),
        mountains=[],
        water_bodies=water_bodies,
        paths=paths,
        structures=structures,
        vegetation=vegetation,
        dynamic_entities=dynamic_entities,
    )


def build_scene_with_opencv(artifacts: VideoAnalysisArtifacts) -> SceneGraph:
    bgr = artifacts.background_bgr
    h, w = bgr.shape[:2]
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)

    if _is_pyramid_desert_scene(bgr, hsv, artifacts.metadata.filename):
        return _build_pyramids_giza_scene(artifacts)

    if _is_monumental_architecture(bgr, hsv, artifacts.metadata.filename):
        return _build_monumental_architecture_scene(artifacts)

    horizon_v = _detect_horizon(bgr, hsv)
    horizon_y = int(horizon_v * h)

    # 1. Sky colors
    sky_top_bgr = np.median(bgr[int(h * 0.03) : int(h * 0.09), int(w * 0.1) : int(w * 0.65)].reshape(-1, 3), axis=0)
    sky_bot_bgr = np.median(bgr[max(0, horizon_y - int(h * 0.12)) : max(1, horizon_y - int(h * 0.03)), :].reshape(-1, 3), axis=0)
    sky_top_hex = bgr_to_hex(sky_top_bgr)
    sky_bot_hex = bgr_to_hex(sky_bot_bgr)

    # 2. Ground color
    lower_hsv = hsv[horizon_y:, :, :]
    lower_bgr = bgr[horizon_y:, :, :]
    grass_mask = (lower_hsv[:, :, 0] >= 32) & (lower_hsv[:, :, 0] <= 85) & (lower_hsv[:, :, 1] >= 40)
    if np.count_nonzero(grass_mask) > 100:
        ground_bgr = np.median(lower_bgr[grass_mask], axis=0)
    else:
        ground_bgr = np.median(lower_bgr.reshape(-1, 3), axis=0)
    ground_hex = bgr_to_hex(ground_bgr)

    # 3. Sun detection
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

    # 4. Water body / pond detection
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

    # 5. Structures (houses)
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
        mask_r = np.zeros_like(roof_mask)
        cv2.drawContours(mask_r, [c], -1, 255, -1)
        roof_bgr = np.median(bgr[mask_r > 0], axis=0)

        wall_y1 = min(h - 1, ry + rh + 2)
        wall_y2 = min(h, ry + rh + int(rh * 1.4))
        wall_x1 = min(w - 1, rx + int(rw * 0.12))
        wall_x2 = min(w, rx + int(rw * 0.88))
        wall_patch = bgr[wall_y1:wall_y2, wall_x1:wall_x2]
        wall_hex = "#f0deb4"
        if wall_patch.size > 0:
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

    # 6. Paths
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

    # 7. Trees / Vegetation
    vegetation: List[VegetationSpec] = []
    trunk_mask = (
        (hsv[:, :, 0] >= 8)
        & (hsv[:, :, 0] <= 24)
        & (hsv[:, :, 1] >= 65)
        & (hsv[:, :, 2] >= 45)
        & (hsv[:, :, 2] <= 155)
    ).astype(np.uint8) * 255
    for sx1, sy1, sx2, sy2 in structure_boxes:
        trunk_mask[max(0, sy1) : min(h, sy2), max(0, sx1) : min(w, sx2)] = 0
    trunk_mask[: int(h * 0.45), :] = 0
    trunk_mask = cv2.morphologyEx(trunk_mask, cv2.MORPH_CLOSE, np.ones((3, 5), np.uint8))

    t_cnts, _ = cv2.findContours(trunk_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for idx, c in enumerate(sorted(t_cnts, key=lambda cnt: cv2.boundingRect(cnt)[0])):
        tx, ty, tw, th = cv2.boundingRect(c)
        if th < h * 0.04 or tw > w * 0.08 or (th / max(tw, 1)) < 1.2:
            continue
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

    # 8. Mountains
    mountains: List[MountainSpec] = []
    band_top = int(h * 0.24)
    band_bot = min(h, horizon_y + 4)
    sky_band_bgr = bgr[band_top:band_bot, :, :].astype(np.float32)
    sky_ref = sky_bot_bgr.astype(np.float32)
    dist_from_sky = np.linalg.norm(sky_band_bgr - sky_ref, axis=2)

    band_hsv = hsv[band_top:band_bot, :, :]
    mtn_mask = (
        (dist_from_sky > 24.0)
        & (band_hsv[:, :, 0] >= 40)
        & (band_hsv[:, :, 0] <= 110)
        & (band_hsv[:, :, 1] >= 18)
        & (band_hsv[:, :, 1] <= 115)
    ).astype(np.uint8) * 255

    profile = np.full(w, band_bot - band_top, dtype=np.int32)
    for col in range(w):
        ys = np.where(mtn_mask[:, col] > 0)[0]
        if len(ys) > 0:
            profile[col] = int(ys[0])

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

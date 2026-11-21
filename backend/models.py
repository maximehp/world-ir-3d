from typing import List, Literal, Optional
from pydantic import BaseModel, Field


class Vec2(BaseModel):
    x: float = Field(..., description="Horizontal world coordinate (-30 left to +30 right)")
    z: float = Field(..., description="Depth world coordinate (-35 far background to +15 foreground)")


class Vec3(BaseModel):
    x: float
    y: float
    z: float


class TrajectoryPoint(BaseModel):
    t: float = Field(..., description="Timestamp in seconds")
    u: float = Field(..., description="Normalized 2D X coordinate (0 left to 1 right)")
    v: float = Field(..., description="Normalized 2D Y coordinate (0 top to 1 bottom)")
    w: float = Field(0.03, description="Normalized bounding box width")
    h: float = Field(0.03, description="Normalized bounding box height")


class TrackedTrajectory(BaseModel):
    id: str
    points: List[TrajectoryPoint]
    avg_color: str = "#222222"
    avg_area: float = 0.001
    dominant_region: Literal["sky", "ground", "water", "mixed"] = "sky"


class SunSpec(BaseModel):
    enabled: bool = True
    position: Vec3 = Field(default_factory=lambda: Vec3(x=24.0, y=22.0, z=-38.0))
    color: str = "#ffe87c"
    radius: float = 3.2


class EnvironmentSpec(BaseModel):
    sky_top_color: str = "#5aaae6"
    sky_bottom_color: str = "#a8daf5"
    ground_color: str = "#5a8c49"
    fog_color: str = "#9ecce8"
    fog_density: float = 0.006
    sun: SunSpec = Field(default_factory=SunSpec)
    wind_strength: float = Field(0.5, ge=0.0, le=2.0)
    time_of_day: Literal["dawn", "day", "sunset", "night"] = "day"


class MountainSpec(BaseModel):
    id: str
    x: float
    z: float
    height: float
    radius: float
    color: str = "#6d9886"
    snow_cap: bool = False


class WaterBodySpec(BaseModel):
    id: str
    shape: Literal["ellipse", "circle", "rectangle"] = "ellipse"
    x: float
    z: float
    radius_x: float
    radius_z: float
    water_color: str = "#4f94c4"
    shore_color: str = "#d9ecfa"
    ripple_intensity: float = 0.6


class PathSpec(BaseModel):
    id: str
    points: List[Vec2]
    width: float = 3.5
    color: str = "#c9b38c"


class StructureSpec(BaseModel):
    id: str
    kind: Literal["house", "cabin", "tower", "barn", "building"] = "house"
    x: float
    z: float
    width: float = 7.5
    height: float = 5.2
    depth: float = 6.2
    rotation_y: float = 0.0
    wall_color: str = "#f0deb4"
    roof_color: str = "#b84b39"
    roof_style: Literal["gable", "pyramid", "flat"] = "gable"
    door_color: str = "#6e442c"
    window_color: str = "#8fd3f4"
    has_chimney: bool = False


class VegetationSpec(BaseModel):
    id: str
    kind: Literal["round_tree", "pine_tree", "bush", "rock"] = "round_tree"
    x: float
    z: float
    scale: float = 1.0
    trunk_color: str = "#6e472b"
    foliage_color: str = "#387a3d"
    foliage_accent_color: str = "#4d944c"
    sway_intensity: float = 0.7


class DynamicEntitySpec(BaseModel):
    id: str
    kind: Literal["bird", "cloud", "boat", "car", "fish", "butterfly", "floating_orb"] = "bird"
    color: str = "#1f2428"
    accent_color: str = "#3c454d"
    scale: float = 1.0
    trajectory_id: Optional[str] = Field(
        None,
        description="ID of a tracked OpenCV motion trajectory to follow, if matched.",
    )
    depth_z: float = Field(
        -4.0,
        description="Base 3D depth Z for projecting 2D trajectory into 3D space (-25 far to +10 near)",
    )
    altitude_offset: float = Field(
        0.0,
        description="Optional vertical offset in world units",
    )
    flap_speed: float = Field(8.0, description="Animation cycle speed (e.g. wing flaps/sec)")
    fallback_path: Optional[List[Vec3]] = Field(
        None,
        description="3D looping waypoints if no OpenCV trajectory_id is attached",
    )


class SceneGraph(BaseModel):
    title: str = "3D Reconstructed Landscape"
    description: str = "Interactive 3D simulation reconstructed from 2D video."
    environment: EnvironmentSpec = Field(default_factory=EnvironmentSpec)
    mountains: List[MountainSpec] = Field(default_factory=list)
    water_bodies: List[WaterBodySpec] = Field(default_factory=list)
    paths: List[PathSpec] = Field(default_factory=list)
    structures: List[StructureSpec] = Field(default_factory=list)
    vegetation: List[VegetationSpec] = Field(default_factory=list)
    dynamic_entities: List[DynamicEntitySpec] = Field(default_factory=list)


class VideoMetadata(BaseModel):
    width: int
    height: int
    fps: float
    frame_count: int
    duration: float
    filename: str
    video_url: str


class AnalysisResponse(BaseModel):
    mode_used: Literal["gemini", "opencv"]
    model_used: Optional[str] = None
    warning: Optional[str] = None
    metadata: VideoMetadata
    scene: SceneGraph
    trajectories: List[TrackedTrajectory]

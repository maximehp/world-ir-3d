"""Strict Pydantic v2 schemas for the Persistent Multi-Carrier 3D World IR.

Every object is an independently addressable 3D entity belonging to a Blender-style
collection, carried by one of four genuine 3D representations:
  - heightfield_terrain : continuous analytic heightfield h(x, z) + water plane
  - parametric_assembly : multi-part 3D architectural / natural / vehicle geometry
  - implicit_sdf        : smooth-min 3D Signed Distance Field compiled via Marching Cubes
  - articulated_agent   : multi-part animated 3D rig with target-referencing behavior state machine
"""

from __future__ import annotations

from typing import Literal
from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Material & PBR Texture Specs
# ---------------------------------------------------------------------------

class MaterialSpec(BaseModel):
    color: str = Field(default="#c8b8a2", description="Primary hex color")
    secondary_color: str = Field(default="#6e4a38", description="Roof / trim / accent hex color")
    accent_color: str = Field(default="#ffd584", description="Window glow / metal / foliage accent hex color")
    roughness: float = Field(default=0.72, ge=0.05, le=1.0)
    metalness: float = Field(default=0.05, ge=0.0, le=1.0)
    emissive: str = Field(default="#000000", description="Optional emissive glow hex")
    emissive_intensity: float = Field(default=0.0, ge=0.0, le=3.0)
    texture_id: str | None = Field(default=None, description="ID of a Nano Banana generated seamless PBR texture")
    texture_repeat: float = Field(default=2.0, ge=0.5, le=16.0)


class PBRTextureAsset(BaseModel):
    id: str
    prompt: str
    albedo_url: str
    normal_url: str
    roughness_url: str
    source: Literal["nano_banana_pbr", "procedural"] = "nano_banana_pbr"


# ---------------------------------------------------------------------------
# Carrier 1: Analytic Heightfield Terrain & Atmosphere
# ---------------------------------------------------------------------------

class TerrainSpec(BaseModel):
    size: float = Field(default=72.0, ge=36.0, le=140.0)
    style: Literal["cobblestone_plaza", "meadow_hills", "coastal_harbor", "snowy_valley", "desert_oasis", "forest_clearing"] = "cobblestone_plaza"
    ground_color: str = "#8a8275"
    hill_color: str = "#4f6d3f"
    plaza_radius: float = Field(default=15.0, ge=4.0, le=32.0, description="Flat central village/courtyard radius in meters")
    hill_height: float = Field(default=3.2, ge=0.0, le=12.0)
    has_water: bool = False
    water_level: float = Field(default=-0.4, ge=-3.0, le=2.0)
    water_color: str = "#2a6f8f"
    texture_id: str | None = None


class AtmosphereSpec(BaseModel):
    time_of_day: Literal["morning", "noon", "golden_hour", "dusk", "night"] = "golden_hour"
    sky_zenith: str = "#2b588f"
    sky_horizon: str = "#f2b880"
    sun_color: str = "#fff0d6"
    sun_intensity: float = Field(default=2.8, ge=0.2, le=5.5)
    sun_elevation_deg: float = Field(default=34.0, ge=5.0, le=82.0)
    sun_azimuth_deg: float = Field(default=42.0, ge=0.0, le=360.0)
    fog_color: str = "#d8c4ae"
    fog_density: float = Field(default=0.0085, ge=0.0, le=0.045)
    ambient_intensity: float = Field(default=0.75, ge=0.15, le=2.0)
    cloud_count: int = Field(default=9, ge=0, le=20)
    wind_strength: float = Field(default=0.55, ge=0.0, le=2.0)


# ---------------------------------------------------------------------------
# Carrier 2: Parametric Multi-Part 3D Assemblies
# ---------------------------------------------------------------------------

class ParametricSpec(BaseModel):
    kind: Literal[
        "building",
        "tower",
        "fountain",
        "tree",
        "archway",
        "bridge",
        "lamp_post",
        "market_stall",
        "bench",
        "gazebo",
        "windmill",
        "lighthouse",
        "scooter",
        "car",
        "boat",
    ]
    width: float = Field(default=4.5, ge=0.4, le=18.0)
    height: float = Field(default=5.2, ge=0.4, le=24.0)
    depth: float = Field(default=4.2, ge=0.4, le=18.0)
    floors: int = Field(default=2, ge=1, le=6)
    roof_style: Literal["gable", "hip", "cone", "dome", "flat"] = "gable"
    tree_style: Literal["oak", "pine", "cypress", "blossom", "palm"] = "oak"
    seed: int = Field(default=42, ge=1, le=9999)
    has_balcony: bool = False
    has_chimney: bool = False
    light_on: bool = True


# ---------------------------------------------------------------------------
# Carrier 3: Implicit Signed Distance Field (Compiled via Marching Cubes!)
# ---------------------------------------------------------------------------

class SDFPrimitive(BaseModel):
    op: Literal["union", "smooth_union", "subtract", "smooth_subtract"] = "smooth_union"
    k: float = Field(default=0.18, ge=0.01, le=0.65, description="Smooth blend radius")
    shape: Literal["sphere", "ellipsoid", "capsule", "round_box", "torus", "cone", "cylinder"] = "ellipsoid"
    center: list[float] = Field(default=[0.0, 0.0, 0.0], min_length=3, max_length=3, description="Local normalized center in [-1, 1]^3")
    size: list[float] = Field(default=[0.4, 0.4, 0.4], min_length=3, max_length=3, description="Shape radii/extents in local space")
    end: list[float] | None = Field(default=None, description="Optional second endpoint [x,y,z] for capsule")
    rot_deg: list[float] = Field(default=[0.0, 0.0, 0.0], min_length=3, max_length=3, description="Euler rotation [rx, ry, rz] in degrees")
    mirror_x: bool = Field(default=False, description="Symmetrically mirror across X=0 (great for creatures, arches, statues)")


class ImplicitSDFSpec(BaseModel):
    description: str
    primitives: list[SDFPrimitive] = Field(..., min_length=2, max_length=16)
    resolution: int = Field(default=52, ge=36, le=64)
    target_height: float = Field(default=2.4, ge=0.4, le=12.0, description="Final world height in meters after normalizing mesh bottom to y=0")
    pedestal: bool = Field(default=False, description="Mount sculpture on a carved stone plinth")
    mesh_url: str | None = Field(default=None, description="Compiled Marching Cubes mesh JSON URL")
    vertex_count: int = 0
    face_count: int = 0


# ---------------------------------------------------------------------------
# Carrier 4: Articulated Autonomous Agents & Persistent Behaviors
# ---------------------------------------------------------------------------

class ArticulatedAgentSpec(BaseModel):
    rig_kind: Literal["bird_flock", "fox", "scooter_rider", "boat_cruiser", "floating_lanterns"] = "bird_flock"
    count: int = Field(default=5, ge=1, le=14, description="Number of instances in flock/group (1 for single vehicle/creature)")
    entity_scale: float = Field(default=1.0, ge=0.3, le=3.0)


class BehaviorSpec(BaseModel):
    kind: Literal["none", "orbit_target", "orbit_and_perch", "patrol_ring", "patrol_waypoints", "sway_wind", "rotate_continuous", "bob_water"] = "none"
    target_id: str | None = Field(default=None, description="ID of another persistent 3D world object to orbit, perch on, or circle")
    orbit_radius: float = Field(default=6.0, ge=1.2, le=28.0)
    orbit_height: float = Field(default=5.5, ge=0.5, le=20.0)
    speed: float = Field(default=0.65, ge=0.05, le=4.0)
    perch_duration_sec: float = Field(default=3.5, ge=1.0, le=12.0)
    fly_duration_sec: float = Field(default=7.5, ge=2.0, le=20.0)
    waypoints_xz: list[list[float]] = Field(default_factory=list, description="Optional [[x,z], ...] loop for patrol_waypoints")


# ---------------------------------------------------------------------------
# Unified Persistent 3D World Object & Collections
# ---------------------------------------------------------------------------

class WorldObject(BaseModel):
    id: str = Field(..., description="Unique snake_case persistent ID, e.g. 'bell_tower', 'central_fountain', 'village_birds'")
    name: str
    collection: Literal["architecture", "landmarks", "nature", "vehicles", "agents", "props", "lighting"] = "architecture"
    carrier: Literal["parametric_assembly", "implicit_sdf", "articulated_agent"]
    position: list[float] = Field(default=[0.0, 0.0, 0.0], min_length=3, max_length=3, description="World [x, y_offset, z] in meters; grounded to h(x,z)+y_offset")
    rotation_y_deg: float = Field(default=0.0, ge=-360.0, le=360.0)
    scale: float = Field(default=1.0, ge=0.2, le=4.0)
    material: MaterialSpec = Field(default_factory=MaterialSpec)
    parametric: ParametricSpec | None = None
    implicit_sdf: ImplicitSDFSpec | None = None
    agent: ArticulatedAgentSpec | None = None
    behavior: BehaviorSpec = Field(default_factory=BehaviorSpec)
    version: int = 1
    visible: bool = True


# ---------------------------------------------------------------------------
# Telemetry, Multi-View 3D Audit, and Revision History
# ---------------------------------------------------------------------------

class WorldCosts(BaseModel):
    carbon_calls: int = 0
    hydrogen_calls: int = 0
    nano_banana_texture_calls: int = 0
    sdf_meshes_compiled: int = 0


class WorldTimings(BaseModel):
    carbon_ms: float = 0.0
    nano_banana_ms: float = 0.0
    sdf_compile_ms: float = 0.0
    hydrogen_ms: float = 0.0
    total_ms: float = 0.0


class SpatialDefect(BaseModel):
    category: Literal["floating_or_sinking", "collision_overlap", "silhouette_unreadable", "lighting_contrast", "scale_mismatch", "edit_missed", "other"]
    severity: Literal["low", "medium", "high"]
    object_id: str | None = None
    description: str


class BoundedSpatialFix(BaseModel):
    object_id: str
    new_position: list[float] | None = Field(default=None, min_length=3, max_length=3)
    new_rotation_y_deg: float | None = None
    scale_multiplier: float = Field(default=1.0, ge=0.5, le=2.0)
    reason: str


class MultiViewAuditVerdict(BaseModel):
    model: str = "gemini-4-hydrogen"
    status: Literal["PASS", "REPAIR_SPATIAL", "WARNING"]
    geometry_3d_score: float = Field(..., ge=0.0, le=10.0)
    spatial_coherence_score: float = Field(..., ge=0.0, le=10.0)
    lighting_material_score: float = Field(..., ge=0.0, le=10.0)
    summary: str
    defects: list[SpatialDefect] = Field(default_factory=list)
    fixes: list[BoundedSpatialFix] = Field(default_factory=list)
    multiview_plate_url: str | None = None


class WorldRevision(BaseModel):
    revision: int
    action: str
    instruction: str
    carbon_summary: str
    changed_object_ids: list[str] = Field(default_factory=list)
    unchanged_object_ids: list[str] = Field(default_factory=list)
    rebuilt_entire_world: bool = False
    costs: WorldCosts = Field(default_factory=WorldCosts)
    timings: WorldTimings = Field(default_factory=WorldTimings)
    audit: MultiViewAuditVerdict | None = None


class WorldState(BaseModel):
    world_id: str
    title: str
    prompt: str
    terrain: TerrainSpec
    atmosphere: AtmosphereSpec
    textures: dict[str, PBRTextureAsset] = Field(default_factory=dict)
    objects: list[WorldObject] = Field(default_factory=list)
    revision: int = 1
    history: list[WorldRevision] = Field(default_factory=list)
    cumulative_costs: WorldCosts = Field(default_factory=WorldCosts)
    camera_spawn: list[float] = Field(default=[0.0, 3.2, 22.0], min_length=3, max_length=3)
    camera_look_at: list[float] = Field(default=[0.0, 2.5, 0.0], min_length=3, max_length=3)


# ---------------------------------------------------------------------------
# Gemini 4 Carbon Structured Compiler Contracts
# ---------------------------------------------------------------------------

class TextureRequest(BaseModel):
    id: str = Field(..., description="Short snake_case texture id, e.g. 'sandstone_wall', 'cobblestone_ground'")
    prompt: str = Field(..., description="Seamless tileable top-down PBR material texture prompt for Nano Banana")


class CarbonWorldDraft(BaseModel):
    title: str
    summary: str
    terrain: TerrainSpec
    atmosphere: AtmosphereSpec
    texture_requests: list[TextureRequest] = Field(default_factory=list, max_length=3, description="2-3 key seamless tileable PBR materials for Nano Banana")
    objects: list[WorldObject] = Field(..., min_length=5, max_length=26)
    camera_spawn: list[float] = Field(default=[0.0, 3.5, 22.0], min_length=3, max_length=3)
    camera_look_at: list[float] = Field(default=[0.0, 2.5, 0.0], min_length=3, max_length=3)


class ObjectMutation(BaseModel):
    object_id: str
    new_position: list[float] | None = Field(default=None, min_length=3, max_length=3)
    new_rotation_y_deg: float | None = None
    new_scale: float | None = Field(default=None, ge=0.2, le=4.0)
    new_material: MaterialSpec | None = None
    new_behavior: BehaviorSpec | None = None
    new_parametric: ParametricSpec | None = None
    new_implicit_sdf: ImplicitSDFSpec | None = None
    visible: bool | None = None


class CarbonWorldEditPatch(BaseModel):
    action: Literal[
        "modify_objects",
        "update_behavior",
        "restyle_material",
        "add_objects",
        "remove_objects",
        "update_atmosphere",
        "update_terrain",
        "multi_edit",
    ]
    summary: str
    new_texture_requests: list[TextureRequest] = Field(default_factory=list, max_length=2, description="Only request a new Nano Banana texture if user asks for a distinct new surface material")
    mutations: list[ObjectMutation] = Field(default_factory=list)
    add_objects: list[WorldObject] = Field(default_factory=list)
    remove_object_ids: list[str] = Field(default_factory=list)
    new_atmosphere: AtmosphereSpec | None = None
    new_terrain: TerrainSpec | None = None


class Hydrogen3DAuditResponse(BaseModel):
    status: Literal["PASS", "REPAIR_SPATIAL", "WARNING"]
    geometry_3d_score: float = Field(..., ge=0.0, le=10.0)
    spatial_coherence_score: float = Field(..., ge=0.0, le=10.0)
    lighting_material_score: float = Field(..., ge=0.0, le=10.0)
    summary: str
    defects: list[SpatialDefect] = Field(default_factory=list)
    fixes: list[BoundedSpatialFix] = Field(default_factory=list)

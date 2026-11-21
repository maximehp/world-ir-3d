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
    roof_texture_id: str | None = Field(default=None, description="Optional PBR texture ID for roof tiles / secondary surfaces")
    texture_repeat: float = Field(default=2.0, ge=0.5, le=16.0)


class PBRTextureAsset(BaseModel):
    id: str
    prompt: str
    albedo_url: str
    normal_url: str
    roughness_url: str
    ao_url: str | None = None
    source: Literal["nano_banana_pbr", "flash_lite_provisional", "procedural"] = "nano_banana_pbr"
    tier: Literal["provisional", "refined"] = "refined"
    version: int = 1


# ---------------------------------------------------------------------------
# Carrier 1: Analytic Heightfield Terrain & Atmosphere
# ---------------------------------------------------------------------------

class TerrainSpec(BaseModel):
    size: float = Field(default=72.0, ge=24.0, le=140.0)
    style: Literal["cobblestone_plaza", "meadow_hills", "coastal_harbor", "snowy_valley", "desert_oasis", "forest_clearing", "interior_deck", "stone_hall"] = "cobblestone_plaza"
    ground_kind: Literal["outdoor_hills", "flat_floor", "forest_floor", "water_surface", "interior_deck", "none"] = "outdoor_hills"
    enclosure: Literal["open_sky", "interior_room", "sci_fi_corridor", "space_bridge", "forest_canopy", "cathedral_hall"] = "open_sky"
    enclosure_size: list[float] = Field(default=[24.0, 8.5, 28.0], min_length=3, max_length=3, description="[width, height, depth] in meters for enclosed interiors")
    enclosure_color: str = "#222936"
    enclosure_accent: str = "#38bdf8"
    space_stars: bool = False
    ground_color: str = "#8a8275"
    hill_color: str = "#4f6d3f"
    plaza_radius: float = Field(default=15.0, ge=0.0, le=32.0, description="Flat central radius in meters (0.0 for continuous forest/interior)")
    hill_height: float = Field(default=3.2, ge=0.0, le=12.0)
    has_water: bool = False
    water_level: float = Field(default=-0.4, ge=-3.0, le=2.0)
    water_color: str = "#2a6f8f"
    texture_id: str | None = None
    hill_texture_id: str | None = None


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
    # Optional Approach B: Persistent Object-Space Dual-Projection Neural Baked Detail (1 call -> 360 deg @ 60 FPS)
    baked_front_url: str | None = None
    baked_back_url: str | None = None
    baked_front_normal_url: str | None = None
    baked_back_normal_url: str | None = None
    baked_prompt: str | None = None


# ---------------------------------------------------------------------------
# Carrier 4: Articulated Autonomous Agents & Persistent Behaviors
# ---------------------------------------------------------------------------

class ArticulatedAgentSpec(BaseModel):
    rig_kind: Literal["bird_flock", "fox", "scooter_rider", "boat_cruiser", "floating_lanterns", "human_character"] = "bird_flock"
    count: int = Field(default=5, ge=1, le=14, description="Number of instances in flock/group (1 for single vehicle/creature/human)")
    entity_scale: float = Field(default=1.0, ge=0.3, le=3.0)
    # Optional human character attributes (for wedding / cinematic performances)
    role: Literal["bride", "groom", "officiant", "guest", "villager"] | None = None
    garment_style: Literal["gown_aline", "gown_sheath", "tuxedo", "suit", "dress_cocktail", "robe", "casual"] | None = None
    hair_color: str | None = None
    skin_tone: str | None = None
    has_veil: bool = False
    has_bouquet: bool = False
    appearance_prompt: str | None = None


class BehaviorSpec(BaseModel):
    kind: Literal[
        "none",
        "orbit_target",
        "orbit_and_perch",
        "patrol_ring",
        "patrol_waypoints",
        "walk_path",
        "stand_and_face",
        "sway_wind",
        "rotate_continuous",
        "bob_water",
    ] = "none"
    target_id: str | None = Field(default=None, description="ID of another persistent 3D world object to orbit, perch on, face, or walk toward")
    orbit_radius: float = Field(default=6.0, ge=1.2, le=28.0)
    orbit_height: float = Field(default=5.5, ge=0.5, le=20.0)
    speed: float = Field(default=0.65, ge=0.05, le=4.0)
    perch_duration_sec: float = Field(default=3.5, ge=1.0, le=12.0)
    fly_duration_sec: float = Field(default=7.5, ge=2.0, le=20.0)
    waypoints_xz: list[list[float]] = Field(default_factory=list, description="Optional [[x,z], ...] path for patrol_waypoints or walk_path")
    start_time_s: float = Field(default=0.0, ge=0.0, le=120.0)
    duration_s: float = Field(default=6.0, ge=0.5, le=120.0)


# ---------------------------------------------------------------------------
# Carrier 5: General-Purpose Composable 3D Part-Tree Grammar (`procedural_assembly`)
# Expresses arbitrary architectural, sci-fi, floral, organic, furniture & mechanical 3D objects
# without requiring hardcoded domain templates!
# ---------------------------------------------------------------------------

class AssemblyPart(BaseModel):
    shape: Literal[
        "box",
        "cylinder",
        "cone",
        "sphere",
        "capsule",
        "torus",
        "arch_segment",
        "plane",
        "ring",
        "icosahedron",
        "dodecahedron",
    ] = "box"
    pos: list[float] = Field(default=[0.0, 0.0, 0.0], min_length=3, max_length=3)
    rot_deg: list[float] = Field(default=[0.0, 0.0, 0.0], min_length=3, max_length=3)
    size: list[float] = Field(
        default=[1.0, 1.0, 1.0],
        min_length=3,
        max_length=3,
        description="box/plane:[w,h,d], cyl/cone:[rTop,rBot,h], sphere/ico/dodec:[rx,ry,rz], torus:[R,tube,arc_deg], capsule:[r,len,1], arch_segment:[innerR,outerR,depth], ring:[innerR,outerR,1]",
    )
    color: str | None = None
    roughness: float | None = Field(default=None, ge=0.02, le=1.0)
    metalness: float | None = Field(default=None, ge=0.0, le=1.0)
    emissive: str | None = None
    emissive_intensity: float = Field(default=0.0, ge=0.0, le=6.0)
    opacity: float = Field(default=1.0, ge=0.05, le=1.0)
    texture_id: str | None = None
    mirror_x: bool = False
    repeat_count: int = Field(default=1, ge=1, le=16)
    repeat_offset: list[float] = Field(default=[0.0, 0.0, 0.0], min_length=3, max_length=3)
    repeat_rot_y_deg: float = Field(default=0.0, ge=-360.0, le=360.0)
    anim: Literal["none", "spin_y", "spin_z", "bob_y", "pulse_emissive", "sway"] = "none"


class ProceduralAssemblySpec(BaseModel):
    description: str
    parts: list[AssemblyPart] = Field(..., min_length=1, max_length=28)
    light_color: str | None = None
    light_intensity: float = Field(default=0.0, ge=0.0, le=40.0)
    light_pos: list[float] = Field(default=[0.0, 2.0, 0.0], min_length=3, max_length=3)
    light_distance: float = Field(default=14.0, ge=1.0, le=45.0)
    contact_ao_radius: float = Field(default=1.2, ge=0.0, le=12.0)


# ---------------------------------------------------------------------------
# Unified Persistent 3D World Object & Collections
# ---------------------------------------------------------------------------

class WorldObject(BaseModel):
    id: str = Field(..., description="Unique snake_case persistent ID")
    name: str
    collection: Literal["architecture", "landmarks", "nature", "vehicles", "agents", "props", "lighting", "structures", "characters"] = "props"
    carrier: Literal["parametric_assembly", "procedural_assembly", "implicit_sdf", "articulated_agent"]
    position: list[float] = Field(default=[0.0, 0.0, 0.0], min_length=3, max_length=3, description="World [x, y_offset, z] in meters; grounded to h(x,z)+y_offset")
    rotation_y_deg: float = Field(default=0.0, ge=-360.0, le=360.0)
    scale: float = Field(default=1.0, ge=0.2, le=4.0)
    material: MaterialSpec = Field(default_factory=MaterialSpec)
    parametric: ParametricSpec | None = None
    procedural: ProceduralAssemblySpec | None = None
    implicit_sdf: ImplicitSDFSpec | None = None
    agent: ArticulatedAgentSpec | None = None
    behavior: BehaviorSpec = Field(default_factory=BehaviorSpec)
    version: int = 1
    visible: bool = True


# ---------------------------------------------------------------------------
# Telemetry, Multi-View 3D Audit, and Revision History
# ---------------------------------------------------------------------------

class WorldCosts(BaseModel):
    flash_lite_calls: int = 0
    carbon_calls: int = 0
    hydrogen_calls: int = 0
    nano_banana_texture_calls: int = 0
    provisional_texture_calls: int = 0
    sdf_meshes_compiled: int = 0


class WorldTimings(BaseModel):
    flash_lite_ms: float = 0.0
    carbon_ms: float = 0.0
    nano_banana_ms: float = 0.0
    sdf_compile_ms: float = 0.0
    hydrogen_ms: float = 0.0
    time_to_first_visible_ms: float = 0.0
    time_to_first_object_ms: float = 0.0
    time_to_geometry_complete_ms: float = 0.0
    time_to_refined_ms: float = 0.0
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
    prompt_coverage_score: float = Field(default=8.0, ge=0.0, le=10.0)
    matched_elements: list[str] = Field(default_factory=list)
    missing_elements: list[str] = Field(default_factory=list)
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


# ---------------------------------------------------------------------------
# Camera-Independent Cinematic Tracks, Spatial Regions & Streamed WorldOps
# ---------------------------------------------------------------------------

class CameraKeyframe(BaseModel):
    t: float = Field(..., ge=0.0, le=120.0)
    pos: list[float] = Field(..., min_length=3, max_length=3)
    look_at: list[float] | None = Field(default=None, min_length=3, max_length=3)
    fov_deg: float = Field(default=48.0, ge=20.0, le=90.0)


class CameraTrack(BaseModel):
    id: str = Field(..., description="Unique camera track ID, e.g. 'hero_dolly', 'aerial_crane'")
    name: str
    kind: Literal["spline", "orbit_entity", "static"] = "spline"
    duration_s: float = Field(default=12.0, ge=2.0, le=60.0)
    keyframes: list[CameraKeyframe] = Field(default_factory=list)
    look_at_id: str | None = None
    orbit_radius: float = Field(default=11.0, ge=2.0, le=55.0)
    orbit_height: float = Field(default=4.5, ge=0.5, le=32.0)


class RegionSpec(BaseModel):
    region_id: str = Field(..., description="Deterministic spatial chunk ID, e.g. 'r_0_0', 'r_1_0'")
    rx: int = 0
    rz: int = 0
    center_xz: list[float] = Field(default=[0.0, 0.0], min_length=2, max_length=2)
    radius: float = Field(default=22.0, ge=10.0, le=40.0)
    biome_summary: str = ""
    object_ids: list[str] = Field(default_factory=list)


class WorldOp(BaseModel):
    op_id: str
    world_id: str
    seq: int = 0
    phase: Literal[
        "scaffold",
        "geometry",
        "agent",
        "texture_provisional",
        "texture_refined",
        "camera",
        "edit",
        "audit",
        "region",
        "complete",
    ] = "geometry"
    worker: str = "coordinator"
    domain: Literal["init", "terrain", "atmosphere", "texture", "object", "camera", "region", "status"]
    action: Literal["upsert", "patch", "delete", "complete"] = "upsert"
    target_id: str = ""
    payload: dict = Field(default_factory=dict)
    elapsed_ms: float = 0.0


class AppearanceReference(BaseModel):
    ref_id: str                     # e.g. "scene" or entity object_id ("bride", "groom")
    kind: Literal["scene", "entity_turnaround"] = "entity_turnaround"
    appearance_rev: int = 1
    appearance_hash: str = ""
    prompt: str = ""
    image_url: str
    guide_url: str | None = None
    model: str = "gemini-nano-banana-2.1"
    inference_ms: float = 0.0


class WorldState(BaseModel):
    world_id: str
    title: str
    prompt: str
    terrain: TerrainSpec
    atmosphere: AtmosphereSpec
    textures: dict[str, PBRTextureAsset] = Field(default_factory=dict)
    appearance_refs: dict[str, AppearanceReference] = Field(default_factory=dict)
    objects: list[WorldObject] = Field(default_factory=list)
    cameras: list[CameraTrack] = Field(default_factory=list)
    regions: list[RegionSpec] = Field(default_factory=list)
    revision: int = 1
    seq: int = 0
    generation_status: Literal["idle", "streaming", "complete"] = "complete"
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
    new_procedural: ProceduralAssemblySpec | None = None
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
    prompt_coverage_score: float = Field(default=8.0, ge=0.0, le=10.0)
    matched_elements: list[str] = Field(default_factory=list)
    missing_elements: list[str] = Field(default_factory=list)
    summary: str
    defects: list[SpatialDefect] = Field(default_factory=list)
    fixes: list[BoundedSpatialFix] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Fast Parallel Scaffold & Streaming Edit Contracts
# ---------------------------------------------------------------------------

class ScaffoldAnchor(BaseModel):
    id: str
    name: str
    role: Literal["hero_procedural", "hero_sdf", "structure", "environment", "character", "agent"] = "hero_procedural"
    position: list[float] = Field(default=[0.0, 0.0, 0.0], min_length=3, max_length=3)
    radius: float = Field(default=2.5, ge=0.4, le=12.0)
    brief: str = ""


class WorldScaffoldManifest(BaseModel):
    title: str
    summary: str
    scene_layout: str = Field(default="open_scene", description="e.g. 'ceremony_aisle', 'spaceship_bridge', 'dense_forest_trail', 'courtyard', 'hall'")
    terrain: TerrainSpec
    atmosphere: AtmosphereSpec
    texture_requests: list[TextureRequest] = Field(default_factory=list, max_length=5)
    anchors: list[ScaffoldAnchor] = Field(default_factory=list, max_length=12)
    camera_spawn: list[float] = Field(default=[0.0, 3.2, 16.0], min_length=3, max_length=3)
    camera_look_at: list[float] = Field(default=[0.0, 1.8, -2.0], min_length=3, max_length=3)


class ComplexObjectBrief(BaseModel):
    id: str
    name: str
    collection: Literal["architecture", "landmarks", "nature", "vehicles", "agents", "props", "lighting", "structures", "characters"] = "landmarks"
    carrier: Literal["implicit_sdf", "procedural_assembly", "parametric_assembly"] = "procedural_assembly"
    position: list[float] = Field(default=[3.5, 0.0, 3.5], min_length=3, max_length=3)
    rotation_y_deg: float = 0.0
    color: str = "#c8b8a2"
    texture_id: str | None = None
    brief: str = ""


class FastEditPatch(BaseModel):
    action: Literal[
        "modify_objects",
        "update_behavior",
        "restyle_material",
        "add_objects",
        "remove_objects",
        "update_atmosphere",
        "update_terrain",
        "update_camera",
        "multi_edit",
    ]
    summary: str
    new_texture_requests: list[TextureRequest] = Field(default_factory=list, max_length=3)
    mutations: list[ObjectMutation] = Field(default_factory=list)
    add_objects: list[WorldObject] = Field(default_factory=list)
    complex_object_briefs: list[ComplexObjectBrief] = Field(default_factory=list, max_length=5)
    remove_object_ids: list[str] = Field(default_factory=list)
    new_atmosphere: AtmosphereSpec | None = None
    new_terrain: TerrainSpec | None = None
    add_cameras: list[CameraTrack] = Field(default_factory=list)

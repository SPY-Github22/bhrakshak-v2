import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ---------- Auth ----------
class LoginIn(BaseModel):
    email: str
    password: str


class TokenOut(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    role: str


class RefreshIn(BaseModel):
    refresh_token: str


class UserOut(ORMModel):
    id: uuid.UUID
    email: str
    full_name: str
    role: str
    district: str | None = None
    preferred_lang: str


# ---------- Zones ----------
class ZoneOut(ORMModel):
    id: uuid.UUID
    zone_code: str
    name: str | None
    district: str | None
    state: str | None
    susc_mean: float | None
    susc_p90: float | None
    population: int | None
    road_km: float | None
    hazard_level: int = 0
    prob_24h: float | None = None


class ZoneDossier(BaseModel):
    zone: ZoneOut
    rainfall_series: list[dict]
    sensors: list[dict]
    reports: list[dict]
    alerts: list[dict]
    drivers: list[dict]  # SHAP-style top contributors
    historical_events: list[dict]
    flood_level: int = 0
    isolation: int = 50
    dc_directive: dict | None = None


# ---------- Reports ----------
class ReportIn(BaseModel):
    client_id: uuid.UUID  # generated on device; makes sync idempotent
    category: str = Field(pattern="^(crack|slope_movement|blocked_road|past_slide|water_seepage|other)$")
    lat: float
    lon: float
    description: str | None = None
    taken_at: datetime | None = None
    media_refs: list[str] = []
    exif_geo_ok: bool | None = None


class SyncBatchIn(BaseModel):
    batch_id: uuid.UUID
    reports: list[ReportIn]


class SyncBatchOut(BaseModel):
    batch_id: uuid.UUID
    accepted: int
    duplicates_merged: int
    flagged: int
    synced_ids: list[uuid.UUID]
    # Reports that failed to persist. The mobile client keeps these in its
    # offline queue and retries; it must never drop a row the server rejected.
    rejected_ids: list[uuid.UUID] = []


class ReportOut(ORMModel):
    id: uuid.UUID
    author_id: uuid.UUID | None
    role: str | None
    category: str
    description: str | None
    status: str
    dup_count: int
    exif_geo_ok: bool | None
    taken_at: datetime | None
    created_at: datetime
    lat: float | None = None
    lon: float | None = None


# ---------- Alerts ----------
class AlertOut(ORMModel):
    id: uuid.UUID
    zone_id: uuid.UUID
    level: int
    lang: str
    channels: list[str] | None
    recipients: int
    message_template: str | None
    ack_at: datetime | None
    fired_at: datetime


class AckIn(BaseModel):
    note: str | None = None


# ---------- Roads ----------
class RoadStatusOut(BaseModel):
    osm_way_id: int
    road_name: str | None
    status: str
    source: str
    delay_min: int | None


class ClearanceEstimate(BaseModel):
    blocked_corridor: str
    estimated_debris_volume_m3: float
    debris_type: str  # "rockfall", "mudflow", "colluvial_slide"
    jcb_excavators_assigned: int
    dump_trucks_assigned: int
    estimated_clearance_hours: float
    single_lane_restoration_hours: float
    full_reopening_eta_hours: float
    machinery_staging_junction: str


class DetourOut(BaseModel):
    from_point: list[float]
    to_point: list[float]
    distance_km: float
    delay_min: int
    geometry: list[list[float]]  # [[lon,lat], ...]
    blocked_segments: list[int]
    corridor_name: str | None = None
    clearance_estimate: ClearanceEstimate | None = None


# ---------- Demo / Analytics ----------
class StormInjectIn(BaseModel):
    district: str
    peak_mm_h: float = 45.0
    hours: int = 3


class KpisOut(BaseModel):
    zones_l3_l4: int
    alerts_today: int
    pending_reports: int
    sensors_online: int
    total_zones: int


class RegistryOut(ORMModel):
    id: int
    name: str
    version: str
    git_sha: str | None
    metrics: dict
    artifact_uri: str | None
    notes: str | None
    trained_at: datetime

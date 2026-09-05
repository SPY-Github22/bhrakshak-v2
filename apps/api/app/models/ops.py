import uuid
from datetime import datetime

from geoalchemy2 import Geometry
from sqlalchemy import (
    ARRAY,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, utcnow


class CitizenReport(Base):
    __tablename__ = "citizen_reports"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)  # client-generated => idempotent sync
    author_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    role: Mapped[str | None] = mapped_column(String(30))  # citizen | field_official
    category: Mapped[str] = mapped_column(String(30))  # crack|slope_movement|blocked_road|past_slide|water_seepage|other
    geom: Mapped[object] = mapped_column(Geometry(geometry_type="POINT", srid=4326))
    description: Mapped[str | None] = mapped_column(Text)
    media_refs: Mapped[list | None] = mapped_column(ARRAY(Text))  # MinIO keys
    taken_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sync_batch: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending|verified|rejected
    verified_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    exif_geo_ok: Mapped[bool | None] = mapped_column(Boolean)  # EXIF GPS vs claimed coords < 500m
    dup_count: Mapped[int] = mapped_column(Integer, default=0)  # proximity dedupe merges
    risk_contribution: Mapped[float] = mapped_column(Float, default=0.0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    # Model V (geo-verified photo AI) output — written by POST /reports/analyze-photo
    ai_analysis: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    image_url: Mapped[str | None] = mapped_column(String(500), nullable=True)


class Shelter(Base):
    """Designated relief/evacuation shelter — target of the pathway model.

    "Safe" is a column, not a vibe: a shelter is safe when it is far from
    high-susceptibility terrain, sits on gentle ground, and has capacity. The
    evacuation router (services/evacuation.py) scores candidate shelters on
    exactly these fields.
    """

    __tablename__ = "shelters"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(160))
    district: Mapped[str | None] = mapped_column(String(120), index=True)
    geom: Mapped[object] = mapped_column(Geometry(geometry_type="POINT", srid=4326))
    capacity: Mapped[int] = mapped_column(Integer, default=200)
    occupancy: Mapped[int] = mapped_column(Integer, default=0)
    shelter_type: Mapped[str] = mapped_column(String(40), default="community_hall")  # school|stadium|hall|hospital|stadium
    has_medical: Mapped[bool] = mapped_column(Boolean, default=False)
    water_liters: Mapped[int] = mapped_column(Integer, default=0)
    ration_packets: Mapped[int] = mapped_column(Integer, default=0)
    # terrain safety attributes of the shelter site itself
    elevation_m: Mapped[float | None] = mapped_column(Float)
    slope_deg: Mapped[float | None] = mapped_column(Float)  # gentler = safer
    distance_to_steep_slope_m: Mapped[float | None] = mapped_column(Float)  # farther = safer
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Alert(Base):
    __tablename__ = "alerts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    zone_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("zones.id"), index=True)
    level: Mapped[int] = mapped_column(Integer)  # 1..4
    message_template: Mapped[str | None] = mapped_column(Text)
    messages: Mapped[dict | None] = mapped_column(JSONB, nullable=True)  # {"en": "...", "hi": "...", ...}
    lang: Mapped[str] = mapped_column(String(10), default="en")
    channels: Mapped[list | None] = mapped_column(ARRAY(Text))  # sms|push|ivr|siren
    recipients: Mapped[int] = mapped_column(Integer, default=0)
    ack_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    ack_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    fired_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class RoadStatus(Base):
    """Current state per OSM way; served as vector tiles by Martin."""

    __tablename__ = "road_status"

    osm_way_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    road_name: Mapped[str | None] = mapped_column(String(160))
    segment_geom: Mapped[object] = mapped_column(Geometry(geometry_type="LINESTRING", srid=4326))
    status: Mapped[str] = mapped_column(String(24), default="open")  # open|risk|predicted_blocked|confirmed_blocked
    source: Mapped[str] = mapped_column(String(20), default="model")  # model|report|official
    detour_geom: Mapped[object | None] = mapped_column(Geometry(geometry_type="LINESTRING", srid=4326))
    delay_min: Mapped[int | None] = mapped_column(Integer)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class DisplacementPoint(Base):
    """Sentinel-1 PSInSAR persistent scatterer (Layer 3: slow creep)."""

    __tablename__ = "displacement_points"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    geom: Mapped[object] = mapped_column(Geometry(geometry_type="POINT", srid=4326))
    vel_mm_yr: Mapped[float | None] = mapped_column(Float)
    p_value: Mapped[float | None] = mapped_column(Float)
    cluster_id: Mapped[int | None] = mapped_column(Integer, index=True)


class DisplacementSeries(Base):
    __tablename__ = "displacement_series"

    point_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    los_mm: Mapped[float | None] = mapped_column(Float)

class BleSighting(Base):
    """Aggregate BLE beacon sighting per zone-tick (crowd density proxy).

    Privacy by design: the PWA reports only *hashed, rotated* device class
    counts (Android/iOS/unknown), never MACs, never persistent IDs. One row
    per zone per 10-minute tick. Consumed by the offline-population heatmap
    and by rescue prioritisation when cell coverage is down.
    """

    __tablename__ = "ble_sightings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    zone_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("zones.id", ondelete="CASCADE"), index=True
    )
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    n_devices: Mapped[int] = mapped_column(Integer)
    n_android: Mapped[int] = mapped_column(Integer, default=0)
    n_ios: Mapped[int] = mapped_column(Integer, default=0)
    n_unknown: Mapped[int] = mapped_column(Integer, default=0)
    # mean RSSI of the observed fleet: closer crowd -> higher (less negative)
    mean_rssi: Mapped[float | None] = mapped_column(Float)
    # how many distinct reporter devices contributed this tick
    n_reporters: Mapped[int] = mapped_column(Integer, default=1)

class SafeCheckin(Base):
    """Citizen "I am safe" roll call.

    Written by the public (login-free) endpoint so any phone — even one that
    cannot complete a full account login on a dying 2G link — can tell the
    district command center it is alive. Powers the missing-persons triage
    view: people in L3/L4 zones with NO check-in are the search priority.
    """

    __tablename__ = "safe_checkins"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    geom: Mapped[object] = mapped_column(Geometry(geometry_type="POINT", srid=4326), nullable=True)
    district: Mapped[str | None] = mapped_column(String(120), index=True)
    device_hash: Mapped[str | None] = mapped_column(String(64))  # rotated id, not persistent identity
    note: Mapped[str | None] = mapped_column(Text)

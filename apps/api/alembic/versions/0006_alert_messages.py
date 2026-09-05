"""add messages JSONB column to alerts

Revision ID: 0006_alert_messages
Revises: 0005_image_url
Create Date: 2026-09-05
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0006_alert_messages"
down_revision = "0005_image_url"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE alerts ADD COLUMN IF NOT EXISTS messages JSONB")


def downgrade() -> None:
    op.execute("ALTER TABLE alerts DROP COLUMN IF EXISTS messages")

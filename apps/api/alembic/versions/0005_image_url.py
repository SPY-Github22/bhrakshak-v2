"""add image_url to citizen_reports

Revision ID: 0005_image_url
Revises: 0004_safe_checkins
Create Date: 2026-09-05
"""
from alembic import op
import sqlalchemy as sa

revision = "0005_image_url"
down_revision = "0004_safe_checkins"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE citizen_reports ADD COLUMN IF NOT EXISTS image_url VARCHAR(500)")


def downgrade() -> None:
    op.execute("ALTER TABLE citizen_reports DROP COLUMN IF EXISTS image_url")

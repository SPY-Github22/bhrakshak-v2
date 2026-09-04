from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings

engine = create_async_engine(settings.database_url, echo=False, pool_pre_ping=True)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def get_db():
    has_yielded = False
    try:
        async with SessionLocal() as session:
            has_yielded = True
            yield session
    except Exception:
        if not has_yielded:
            yield None
        else:
            raise

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pymongo import MongoClient

from .config import Settings
from .routes import router
from .services import ensure_indexes

log = logging.getLogger("notixias")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    logging.basicConfig(level=settings.log_level.upper())

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        client = MongoClient(settings.mongo_url, tz_aware=True, serverSelectionTimeoutMS=3000)
        app.state.client = client
        app.state.db = client[settings.mongo_db]
        ensure_indexes(app.state.db)
        if not settings.api_key_hash:
            log.warning("API_KEY_HASH vazio: toda requisição autenticada será recusada")
        yield
        client.close()

    docs = None if settings.is_prod else "/docs"
    app = FastAPI(
        title="notiXias",
        lifespan=lifespan,
        docs_url=docs,
        redoc_url=None,
        openapi_url=None if settings.is_prod else "/openapi.json",
    )
    app.state.settings = settings
    app.include_router(router)

    @app.get("/healthz")
    def healthz():
        try:
            app.state.client.admin.command("ping")
        except Exception:
            return JSONResponse({"status": "mongo_unavailable"}, status_code=503)
        return {"status": "ok"}

    return app


app = create_app()

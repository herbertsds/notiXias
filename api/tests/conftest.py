import hashlib
import os

import pytest
from fastapi.testclient import TestClient
from pymongo import MongoClient

from app.config import Settings
from app.main import create_app

TEST_DB = "notixias_test"
TEST_KEY = "chave-de-teste-" + "k" * 40
AUTH = {"Authorization": f"Bearer {TEST_KEY}"}


@pytest.fixture(scope="session")
def settings() -> Settings:
    return Settings(
        env="test",
        mongo_url=os.environ.get("MONGO_URL", "mongodb://mongo:27017"),
        mongo_db=TEST_DB,
        api_key_hash="sha256:" + hashlib.sha256(TEST_KEY.encode()).hexdigest(),
        log_level="warning",
    )


@pytest.fixture
def client(settings):
    # Trava de segurança: nunca apagar outro banco que não o de teste.
    assert settings.mongo_db == TEST_DB
    raw = MongoClient(settings.mongo_url, serverSelectionTimeoutMS=3000)
    raw.drop_database(TEST_DB)
    raw.close()
    app = create_app(settings)
    with TestClient(app) as c:
        c.headers.update(AUTH)
        yield c


@pytest.fixture
def anon(client):
    """Cliente sem cabeçalho de autenticação, apontando para o mesmo app."""
    with TestClient(client.app) as c:
        yield c


@pytest.fixture
def db(client):
    return client.app.state.db

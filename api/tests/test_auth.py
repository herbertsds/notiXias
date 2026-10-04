import pytest

ROTAS = [
    ("get", "/api/v1/state"),
    ("get", "/api/v1/queue"),
    ("get", "/api/v1/queue/anchor"),
    ("get", "/api/v1/export"),
    ("get", "/api/v1/health/skeleton"),
]


@pytest.mark.parametrize("method,path", ROTAS)
def test_sem_chave_401(anon, method, path):
    r = getattr(anon, method)(path)
    assert r.status_code == 401
    assert r.json() == {"detail": "unauthorized"}


def test_chave_errada_e_ausente_tem_resposta_identica(anon):
    sem = anon.get("/api/v1/state")
    errada = anon.get("/api/v1/state", headers={"Authorization": "Bearer chave-errada"})
    malformada = anon.get("/api/v1/state", headers={"Authorization": "Basic abc"})
    assert sem.status_code == errada.status_code == malformada.status_code == 401
    assert sem.json() == errada.json() == malformada.json()


def test_chave_certa_200(client):
    assert client.get("/api/v1/state").status_code == 200


def test_post_sem_chave_401(anon):
    r = anon.post("/api/v1/queue/append", json={"items": [], "anchor_found": True})
    assert r.status_code == 401


def test_sem_hash_configurado_recusa_tudo(settings):
    from dataclasses import replace

    from fastapi.testclient import TestClient

    from app.main import create_app
    from tests.conftest import AUTH

    app = create_app(replace(settings, api_key_hash=""))
    with TestClient(app) as c:
        assert c.get("/api/v1/state", headers=AUTH).status_code == 401


def test_docs_desligado_em_producao(settings):
    from dataclasses import replace

    from fastapi.testclient import TestClient

    from app.main import create_app

    with TestClient(create_app(replace(settings, env="prod"))) as c:
        assert c.get("/docs").status_code == 404
        assert c.get("/openapi.json").status_code == 404
        assert c.get("/healthz").status_code == 200

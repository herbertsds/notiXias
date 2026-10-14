from datetime import timedelta

from app import services as svc

AUTH = "a" * 40
CT0 = "b" * 64


def _put(client, **kw):
    return client.put("/api/v1/robot/session", json={"auth_token": AUTH, "ct0": CT0, **kw})


def test_sessao_enviada_e_entregue_uma_vez_e_apagada(client, db):
    assert client.post("/api/v1/robot/session/take").json() == {"pending": False}
    assert _put(client).status_code == 200
    got = client.post("/api/v1/robot/session/take").json()
    assert got["pending"] is True and got["auth_token"] == AUTH and got["ct0"] == CT0
    assert client.post("/api/v1/robot/session/take").json() == {"pending": False}      # entregue uma vez só
    assert db.meta.find_one({"_id": "robot_session"}) is None                         # os cookies não ficam no banco


def test_sessao_vencida_e_descartada(client, db):
    _put(client)
    from datetime import datetime, timezone
    db.meta.update_one({"_id": "robot_session"}, {"$set": {"created_at": datetime.now(timezone.utc) - svc.SESSION_TTL - timedelta(minutes=1)}})
    assert client.post("/api/v1/robot/session/take").json() == {"pending": False}
    assert db.meta.find_one({"_id": "robot_session"}) is None


def test_nova_sessao_substitui_a_pendente(client):
    _put(client)
    client.put("/api/v1/robot/session", json={"auth_token": "c" * 40, "ct0": "d" * 40})
    assert client.post("/api/v1/robot/session/take").json()["auth_token"] == "c" * 40


def test_validacao_e_chave(client, anon):
    assert client.put("/api/v1/robot/session", json={"auth_token": "curto", "ct0": CT0}).status_code == 422
    assert client.put("/api/v1/robot/session", json={"auth_token": "x y" * 20, "ct0": CT0}).status_code == 422
    assert client.put("/api/v1/robot/session", json={"auth_token": AUTH}).status_code == 422
    assert anon.put("/api/v1/robot/session", json={"auth_token": AUTH, "ct0": CT0}).status_code == 401
    assert anon.post("/api/v1/robot/session/take").status_code == 401

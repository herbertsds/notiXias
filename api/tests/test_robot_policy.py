from datetime import datetime, timedelta, timezone

from app import robot_policy as rp

from .helpers import append, item


def test_faixas_de_intervalo_por_nao_lidas():
    assert rp.tier_for(0)["max_minutes"] == 25 and rp.tier_for(49) == {"tier": "low", "min_minutes": 10, "max_minutes": 25}
    assert rp.tier_for(50) == {"tier": "mid", "min_minutes": 30, "max_minutes": 45}
    assert rp.tier_for(99)["tier"] == "mid"
    assert rp.tier_for(100) == {"tier": "high", "min_minutes": 45, "max_minutes": 60}
    assert rp.tier_for(5000)["tier"] == "high"


def test_limiares_atravessados_para_baixo():
    assert rp.crossed_thresholds(30, 29) == [30]
    assert rp.crossed_thresholds(15, 14) == [15]
    assert rp.crossed_thresholds(6, 5) == [6]
    assert rp.crossed_thresholds(31, 30) == []                  # ainda não passou
    assert rp.crossed_thresholds(29, 28) == []                  # já estava abaixo
    assert rp.crossed_thresholds(5, 6) == []                    # subir não conta
    assert rp.crossed_thresholds(40, 10) == [30, 15]            # pulo grande atravessa dois


def _entries(client, n):
    append(client, [item(1000 + i) for i in range(n, 0, -1)])            # seq 1..n, a mais antiga primeiro na fila


def _cursor(client, seq):
    r = client.put("/api/v1/state", json={"cursor_seq": seq})
    assert r.status_code == 200, r.text
    return r.json()


def _request(client):
    return client.get("/api/v1/robot/request").json()


def _runs(client):
    return client.get("/api/v1/runs").json()["items"]


def test_ler_de_30_para_29_pede_busca_e_registra_o_motivo(client):
    _entries(client, 45)
    _cursor(client, 15)                                           # sobram 30
    assert _request(client)["pending"] is False
    _cursor(client, 16)                                           # sobram 29: atravessou 30
    req = _request(client)
    assert req["pending"] is True and req["threshold"] == 30 and "29" in req["reason"]
    log = [r for r in _runs(client) if r.get("kind") == "request"]
    assert len(log) == 1 and log[0]["reason"] == req["reason"]


def test_so_dispara_ao_atravessar_e_nao_ao_continuar_lendo(client):
    _entries(client, 45)
    _cursor(client, 15)
    _cursor(client, 16)
    client.post("/api/v1/robot/request/ack")
    _cursor(client, 17)                                           # 28: nada novo
    assert _request(client)["pending"] is False
    _cursor(client, 30)                                           # sobram 15
    assert _request(client)["pending"] is False
    _cursor(client, 31)                                           # sobram 14: atravessou 15
    assert _request(client)["threshold"] == 15
    client.post("/api/v1/robot/request/ack")
    _cursor(client, 39)                                           # sobram 6
    _cursor(client, 40)                                           # sobram 5: atravessou 6
    assert _request(client)["threshold"] == 6
    assert [r["kind"] for r in _runs(client) if r.get("kind") == "request"] == ["request"] * 3


def test_voltar_uma_mensagem_ou_chegar_novas_nao_pede_busca(client):
    _entries(client, 45)
    _cursor(client, 16)                                           # 29
    client.post("/api/v1/robot/request/ack")
    _cursor(client, 15)                                           # voltou (sobem para 30)
    assert _request(client)["pending"] is False
    append(client, [item(5000 + i) for i in range(10, 0, -1)])    # chegaram 10 novas
    assert _request(client)["pending"] is False


def test_ack_devolve_o_motivo_e_limpa(client):
    _entries(client, 45)
    _cursor(client, 15)
    _cursor(client, 16)
    got = client.post("/api/v1/robot/request/ack").json()
    assert got["pending"] is True and "29" in got["reason"]
    assert client.post("/api/v1/robot/request/ack").json() == {"pending": False}
    assert _request(client)["pending"] is False


def _set_next(client, minutes, mode="normal"):
    at = (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat()
    client.put("/api/v1/robot/next", json={"at": at, "mode": mode, "state": "scheduled"})
    return at


def test_mudar_de_faixa_antecipa_a_proxima_busca_se_ela_passar_do_maximo_novo(client):
    _entries(client, 105)
    _cursor(client, 5)                                            # sobram 100 (faixa alta, 45-60)
    _set_next(client, 55)
    _cursor(client, 6)                                            # 99: faixa média (30-45); faltam 55 > 45
    nxt = client.get("/api/v1/robot/next").json()
    left = (datetime.fromisoformat(nxt["at"]) - datetime.now(timezone.utc)).total_seconds() / 60
    assert 29 <= left <= 45 and nxt["rescheduled_by"] == "unread"
    assert any(r.get("kind") == "reschedule" for r in _runs(client))


def test_nao_mexe_se_o_horario_ja_cabe_na_faixa_nova(client):
    _entries(client, 105)
    _cursor(client, 5)
    at = _set_next(client, 40)                                    # 40 min <= 45
    _cursor(client, 6)
    assert client.get("/api/v1/robot/next").json()["at"][:16] == at[:16]
    assert not any(r.get("kind") == "reschedule" for r in _runs(client))


def test_nao_mexe_na_verificacao_de_perfis_nem_com_robo_pausado(client):
    _entries(client, 105)
    _cursor(client, 5)
    at = _set_next(client, 300, mode="profiles")
    _cursor(client, 6)
    assert client.get("/api/v1/robot/next").json()["at"][:16] == at[:16]
    client.put("/api/v1/robot/next", json={"at": None, "state": "paused"})
    _cursor(client, 7)
    assert client.get("/api/v1/robot/next").json()["state"] == "paused"


def test_politica_do_robo_informa_faixa_pelas_nao_lidas(client):
    _entries(client, 60)
    pol = client.get("/api/v1/robot/policy").json()
    assert pol["unread"] == 60 and pol["tier"] == "mid" and (pol["min_minutes"], pol["max_minutes"]) == (30, 45)
    _cursor(client, 20)
    assert client.get("/api/v1/robot/policy").json()["tier"] == "low"


def test_relatorio_de_perfis_e_fronteira_separada_da_do_feed(client):
    base = {"source": "robot", "created": 0, "updated": 0}
    client.post("/api/v1/runs/report", json={**base, "mode": "deep", "started_at": "2026-10-06T10:00:00+00:00"})
    client.post("/api/v1/runs/report", json={**base, "mode": "profiles", "started_at": "2026-10-06T06:00:00+00:00", "trigger": "x"})
    assert client.get("/api/v1/runs/deep-last").json()["started_at"].startswith("2026-10-06T10:00")
    assert client.get("/api/v1/runs/deep-last", params={"mode": "profiles"}).json()["started_at"].startswith("2026-10-06T06:00")
    assert client.get("/api/v1/runs/deep-last", params={"mode": "outro"}).status_code == 422
    assert client.get("/api/v1/runs").json()["items"][0]["trigger"] == "x"

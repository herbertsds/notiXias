from .helpers import append, item


def _post(client, items, **extra):
    r = client.post("/api/v1/queue/append", json={"items": items, "anchor_found": True, **extra})
    assert r.status_code == 200, r.text
    return r.json()


def _runs(client, **params):
    r = client.get("/api/v1/runs", params=params)
    assert r.status_code == 200, r.text
    return r.json()["items"]


def test_sem_execucoes_lista_vazia(client):
    assert _runs(client) == []


def test_append_com_run_entra_no_historico_mais_nova_primeiro(client):
    _post(client, [item(2), item(1)], run={"source": "manual", "mode": "normal"},
          scan={"reason": "backfill", "steps": 4, "collected": 2})
    _post(client, [item(3), item(2)], run={"source": "robot", "mode": "deep"},
          scan={"reason": "anchor", "steps": 9, "collected": 2})
    runs = _runs(client)
    assert [(r["source"], r["mode"]) for r in runs] == [("robot", "deep"), ("manual", "normal")]
    assert runs[0]["ok"] is True and runs[0]["created"] == 1 and runs[0]["reason"] == "anchor" and runs[0]["steps"] == 9
    assert runs[1]["created"] == 2 and runs[0]["at"] >= runs[1]["at"]


def test_append_sem_run_nao_registra(client):
    append(client, [item(2), item(1)])
    assert _runs(client) == []


def test_reenvio_do_mesmo_lote_nao_duplica_o_historico(client):
    for _ in range(2):
        _post(client, [item(2), item(1)], batch_id="b-1", run={"source": "manual", "mode": "normal"})
    assert len(_runs(client)) == 1


def test_falha_entra_no_historico(client):
    r = client.post("/api/v1/runs", json={"source": "robot", "mode": "normal", "error": "A captura falhou"})
    assert r.status_code == 201
    run = _runs(client)[0]
    assert run["ok"] is False and run["error"] == "A captura falhou" and run["source"] == "robot"


def test_limite_e_validacao(client):
    for i in range(3):
        _post(client, [item(10 + i)], run={"source": "manual", "mode": "normal"})
    assert len(_runs(client, limit=2)) == 2
    bad = client.post("/api/v1/queue/append", json={"items": [], "anchor_found": True, "run": {"source": "outro"}})
    assert bad.status_code == 422
    assert client.get("/api/v1/runs", params={"limit": 0}).status_code == 422


def test_proxima_execucao_do_robo_aparece_no_historico(client):
    assert client.get("/api/v1/runs").json()["next"] is None
    r = client.put("/api/v1/robot/next", json={"at": "2026-10-06T13:25:00+00:00", "mode": "deep", "state": "scheduled"})
    assert r.status_code == 200
    nxt = client.get("/api/v1/runs").json()["next"]
    assert nxt["mode"] == "deep" and nxt["state"] == "scheduled" and nxt["at"].startswith("2026-10-06T13:25:00")
    client.put("/api/v1/robot/next", json={"at": None, "state": "paused"})
    nxt = client.get("/api/v1/runs").json()["next"]
    assert nxt["state"] == "paused" and nxt["at"] is None


def test_proxima_execucao_validacao_e_chave(client, anon):
    assert client.put("/api/v1/robot/next", json={"state": "outro"}).status_code == 422
    assert anon.put("/api/v1/robot/next", json={"state": "paused"}).status_code == 401


def test_relatorio_da_profunda_e_horario_da_ultima(client):
    assert client.get("/api/v1/runs/deep-last").json() == {"started_at": None}
    body = {"source": "robot", "mode": "deep", "started_at": "2026-10-06T08:10:00+00:00", "created": 12, "updated": 1,
            "gap": False, "reason": "time_boundary", "steps": 90, "collected": 140,
            "profiles_done": 55, "profiles_skipped": 2, "profile_created": 4}
    assert client.post("/api/v1/runs/report", json=body).status_code == 201
    last = client.get("/api/v1/runs/deep-last").json()
    assert last["started_at"].startswith("2026-10-06T08:10:00")
    run = client.get("/api/v1/runs").json()["items"][0]
    assert run["mode"] == "deep" and run["profiles_done"] == 55 and run["profile_created"] == 4 and run["created"] == 12


def test_so_a_profunda_concluida_conta_para_a_fronteira(client):
    client.post("/api/v1/runs", json={"source": "robot", "mode": "deep", "error": "falhou"})        # falha: não conta
    client.post("/api/v1/runs/report", json={"source": "manual", "mode": "normal", "started_at": "2026-10-06T09:00:00+00:00",
                                              "created": 1, "updated": 0})                            # normal: não conta
    assert client.get("/api/v1/runs/deep-last").json() == {"started_at": None}
    client.post("/api/v1/runs/report", json={"source": "manual", "mode": "deep", "started_at": "2026-10-06T10:00:00+00:00",
                                              "created": 0, "updated": 0})
    client.post("/api/v1/runs/report", json={"source": "robot", "mode": "deep", "started_at": "2026-10-06T15:00:00+00:00",
                                              "created": 0, "updated": 0})
    assert client.get("/api/v1/runs/deep-last").json()["started_at"].startswith("2026-10-06T15:00:00")      # a mais recente


def test_relatorio_validacao_e_chave(client, anon):
    assert client.post("/api/v1/runs/report", json={"source": "robot", "mode": "deep"}).status_code == 422
    assert anon.get("/api/v1/runs/deep-last").status_code == 401

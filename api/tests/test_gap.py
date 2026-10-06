from datetime import datetime, timedelta, timezone

from datetime import datetime, timedelta, timezone

from .helpers import append, item, queue


def _post(client, newest_first, **extra):
    body = {"items": newest_first, **extra}
    r = client.post("/api/v1/queue/append", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _export_entry(client, tweet_id):
    es = client.get("/api/v1/export").json()["entries"]
    return next(e for e in es if e["tweet_id"] == str(tweet_id))


def _gap(client, **params):
    r = client.get("/api/v1/queue/gap", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def test_sem_lacuna_nada_a_preencher(client):
    append(client, [item(2), item(1)])
    assert _gap(client) == {"seq": None, "keys": []}


def test_motivo_da_parada_fica_na_lacuna_e_no_lote(client):
    append(client, [item(2), item(1)])
    r = _post(client, [item(5), item(4)], anchor_found=False, batch_id="b1",
              scan={"reason": "max_steps", "steps": 150, "collected": 40})
    assert r["gap"] is True
    assert _export_entry(client, 4)["gap_reason"] == "max_steps"
    g = _gap(client)
    assert g["seq"] == 3 and g["reason"] == "max_steps"
    # o outro lado da lacuna: as aparições capturadas ANTES dela
    assert sorted(g["keys"]) == ["1|", "2|"]


def test_lacuna_nao_resolvida_vira_motivo_proprio(client):
    append(client, [item(2), item(1)])
    _post(client, [item(5), item(4)], anchor_found=False,
          scan={"reason": "anchor", "steps": 10, "collected": 4, "gap_unresolved": 2})
    assert _gap(client)["reason"] == "gap_unresolved"


def test_preencher_lacuna_fecha_a_bandeira(client):
    append(client, [item(2), item(1)])
    _post(client, [item(6), item(5)], anchor_found=False)           # lacuna começa em tweet 5 (seq 3)
    g = _gap(client)
    r = _post(client, [item(6), item(5), item(4), item(3), item(2)], anchor_found=True, gap_seq=g["seq"])
    assert r["created"] == 2 and r["gap"] is False
    assert _gap(client)["seq"] is None
    assert not any(e["gap_before"] for e in queue(client))
    assert [e["tweet_id"] for e in queue(client)] == ["1", "2", "3", "4", "5", "6"]


def test_preenchimento_parcial_move_a_bandeira(client):
    append(client, [item(2), item(1)])
    _post(client, [item(9), item(8)], anchor_found=False)           # lacuna em tweet 8 (seq 3)
    g = _gap(client)
    r = _post(client, [item(9), item(8), item(7), item(6)], anchor_found=False, gap_seq=g["seq"],
              scan={"reason": "max_steps", "steps": 400, "collected": 4})
    assert r["gap"] is True
    q = {e["tweet_id"]: e["gap_before"] for e in queue(client)}
    assert q["8"] is False and q["6"] is True                        # a lacuna restante fica antes do 6
    assert _gap(client)["seq"] == 5


def test_preenchimento_sem_nada_novo_mantem_a_lacuna(client):
    append(client, [item(2), item(1)])
    _post(client, [item(9), item(8)], anchor_found=False)
    g = _gap(client)
    r = _post(client, [item(9), item(8)], anchor_found=False, gap_seq=g["seq"])
    assert r["created"] == 0
    assert _gap(client)["seq"] == g["seq"]


def test_lacuna_antiga_demais_e_ignorada(client, db):
    append(client, [item(2), item(1)])
    _post(client, [item(5), item(4)], anchor_found=False)
    assert _gap(client, max_age_days=1)["seq"] == 3
    # com limite maior ou igual ao dia da captura ela continua alcançável; uma lacuna de 10 dias atrás não
    db.entries.update_one({"seq": 3}, {"$set": {"captured_at": datetime.now(timezone.utc) - timedelta(days=10)}})
    assert _gap(client, max_age_days=3)["seq"] is None


def test_scan_invalido_e_rejeitado(client):
    r = client.post("/api/v1/queue/append", json={"items": [], "anchor_found": True, "scan": {"reason": "x y"}})
    assert r.status_code == 422

from datetime import datetime, timedelta, timezone

from app import services as svc

from .helpers import append, item, queue


def _running(client):
    return client.get("/api/v1/robot/running").json()


def _req(client):
    return client.get("/api/v1/robot/request").json()


def test_pedir_busca_cria_pedido_manual_com_o_modo_e_registra_no_historico(client):
    r = client.post("/api/v1/robot/run-now", json={"mode": "deep"}).json()
    assert r == {"accepted": True, "running": False}
    req = _req(client)
    assert req["pending"] is True and req["manual"] is True and req["mode"] == "deep"
    ack = client.post("/api/v1/robot/request/ack").json()
    assert ack["manual"] is True and ack["mode"] == "deep"
    ev = [x for x in client.get("/api/v1/runs").json()["items"] if x.get("kind") == "request"][0]
    assert ev["source"] == "manual" and "pedida pelo celular" in ev["reason"]


def test_pedido_repetido_nao_duplica_e_busca_em_andamento_recusa(client):
    assert client.post("/api/v1/robot/run-now", json={}).json()["accepted"] is True
    again = client.post("/api/v1/robot/run-now", json={}).json()
    assert again["accepted"] is True and again["already_pending"] is True
    client.post("/api/v1/robot/request/ack")
    client.put("/api/v1/robot/running", json={"running": True, "kind": "normal"})
    busy = client.post("/api/v1/robot/run-now", json={"mode": "normal"}).json()
    assert busy == {"accepted": False, "running": True, "kind": "normal"}
    assert _req(client)["pending"] is False                              # nada foi criado


def test_estado_rodando_aparece_no_state_e_traz_o_resultado_ao_terminar(client):
    assert client.get("/api/v1/state").json()["robot"] == {"running": False, "kind": None}
    client.put("/api/v1/robot/running", json={"running": True, "kind": "deep", "trigger": "busca pedida pelo celular"})
    assert client.get("/api/v1/state").json()["robot"] == {"running": True, "kind": "deep"}
    client.put("/api/v1/robot/running", json={"running": False, "kind": "deep", "ok": True, "created": 4, "updated": 1})
    d = _running(client)
    assert d["running"] is False and d["result"] == {"ok": True, "created": 4, "updated": 1, "error": None}
    assert d["started_at"] is not None and d["finished_at"] is not None
    assert client.get("/api/v1/state").json()["robot"]["running"] is False


def test_rodando_velho_demais_e_resto_de_queda(client, db):
    client.put("/api/v1/robot/running", json={"running": True, "kind": "normal"})
    db.meta.update_one({"_id": "robot_running"}, {"$set": {"updated_at": datetime.now(timezone.utc) - svc.RUNNING_STALE - timedelta(minutes=1)}})
    assert _running(client)["running"] is False
    assert client.post("/api/v1/robot/run-now", json={}).json()["accepted"] is True      # não trava para sempre


def test_validacao_e_chave(client, anon):
    assert client.post("/api/v1/robot/run-now", json={"mode": "xyz"}).status_code == 422
    assert client.put("/api/v1/robot/running", json={"kind": "normal"}).status_code == 422
    assert client.post("/api/v1/maintenance/purge", json={"days": 1}).status_code == 422
    for call in (lambda: anon.post("/api/v1/robot/run-now", json={}), lambda: anon.get("/api/v1/robot/running"),
                 lambda: anon.post("/api/v1/maintenance/purge", json={"days": 7})):
        assert call().status_code == 401


def _envelhece(db, tweet_ids, dias):
    db.entries.update_many({"tweet_id": {"$in": [str(i) for i in tweet_ids]}},
                           {"$set": {"captured_at": datetime.now(timezone.utc) - timedelta(days=dias)}})


def test_limpeza_apaga_o_capturado_ha_mais_de_uma_semana_e_o_que_depende_dele(client, db):
    append(client, [item(5), item(4), item(3), item(2), item(1)])                 # seq 1..5 (tweet 1 é o mais antigo)
    _envelhece(db, [1, 2], 8)                                                      # capturados há 8 dias
    _envelhece(db, [3], 6)                                                         # há 6: fica
    client.post("/api/v1/views", json={"seqs": [1]})
    client.put("/api/v1/state", json={"cursor_seq": 3})                            # posição de leitura na entrada 3
    r = client.post("/api/v1/maintenance/purge", json={"days": 7}).json()
    assert r["deleted"] == 2 and r["views"] == 1 and r["days"] == 7
    assert [e["tweet_id"] for e in queue(client)] == ["3", "4", "5"]
    assert db.views.count_documents({"entry_seq": 1}) == 0
    ev = [x for x in client.get("/api/v1/runs").json()["items"] if x.get("kind") == "purge"][0]
    assert ev["deleted"] == 2 and "7 dias" in ev["reason"]


def test_limpeza_nunca_apaga_a_posicao_de_leitura_e_nao_dispara_pedido_de_busca(client, db):
    append(client, [item(i) for i in range(40, 0, -1)])                            # 40 entradas
    client.put("/api/v1/state", json={"cursor_seq": 2})
    _envelhece(db, range(1, 41), 9)                                                # tudo velho, inclusive a posição de leitura
    r = client.post("/api/v1/maintenance/purge", json={"days": 7}).json()
    assert r["deleted"] == 39                                                      # a entrada 2 (posição de leitura) fica
    assert client.get("/api/v1/state").json()["cursor_seq"] == 2
    assert client.get("/api/v1/robot/request").json()["pending"] is False         # a contagem caiu, mas não é "leitura"
    client.put("/api/v1/state", json={"cursor_seq": 2})
    assert client.get("/api/v1/robot/request").json()["pending"] is False


def test_limpeza_sem_nada_velho_nao_faz_nada(client):
    append(client, [item(2), item(1)])
    assert client.post("/api/v1/maintenance/purge", json={"days": 7}).json() == {"deleted": 0, "views": 0, "days": 7}
    assert len(queue(client)) == 2


def _fol(client, *handles):
    return client.put("/api/v1/accounts/following", json={"accounts": [{"handle": h, "name": h} for h in handles]})


def _evento(client):
    return [x for x in client.get("/api/v1/runs").json()["items"] if x.get("kind") == "following"]


def test_releitura_da_lista_registra_quem_entrou_e_saiu_e_tira_da_fila_o_nao_lido_de_quem_saiu(client):
    _fol(client, "ana", "bia")
    assert _evento(client) == []                                                    # a primeira leitura não é mudança
    append(client, [item(5, author="Bia"), item(4, author="ana"), item(3, author="bia"), item(2, author="bia")])
    client.post("/api/v1/views", json={"seqs": [4]})                                  # o de Bia que foi lido fica
    _fol(client, "ana", "caio")
    ev = _evento(client)[0]
    assert ev["added"] == ["caio"] and ev["removed"] == ["bia"] and ev["total"] == 2 and ev["dropped"] >= 1
    restantes = [e["tweet_id"] for e in queue(client)]
    assert "3" not in restantes and "2" not in restantes and "4" in restantes   # não lidos de Bia saíram; o lido (e a posição de leitura) ficam


def test_lista_igual_registra_sem_mudancas(client):
    _fol(client, "ana")
    _fol(client, "ana")
    ev = _evento(client)[0]
    assert ev["added"] == [] and ev["removed"] == [] and ev["dropped"] == 0


def test_seguir_e_deixar_de_seguir_ao_vivo_tambem_registram(client):
    client.post("/api/v1/accounts/following/add", json={"handle": "Zeca", "name": "Zeca"})
    client.post("/api/v1/accounts/following/remove", json={"handle": "zeca"})
    evs = _evento(client)
    assert evs[1]["added"] == ["zeca"] and evs[0]["removed"] == ["zeca"]

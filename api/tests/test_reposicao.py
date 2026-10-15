"""Repost nunca vale por um horário ANTERIOR ao do próprio tweet; o que ficou assim é reposicionado no fim de cada busca."""
from datetime import datetime, timezone

from .helpers import append, queue


def sid(h, m=0, d=6):
    ms = int(datetime(2026, 10, d, h, m, tzinfo=timezone.utc).timestamp() * 1000)
    return str((ms - 1288834974657) << 22)


def post(h, m=0, author="conta_a"):
    return {"tweet_id": sid(h, m), "author": author, "reposter": None, "kind": "post"}


def repost(h, m=0, author="dono_x", by="seguido_y"):
    return {"tweet_id": sid(h, m), "author": author, "reposter": by, "kind": "repost"}


def ids(client):
    return [e["tweet_id"] for e in queue(client) if not e["read_at"]]


def test_repost_nao_fica_antes_do_proprio_tweet_ao_ser_criado(client):
    append(client, [post(12), post(11), post(10)])
    # lote (mais novo primeiro): vizinho de 10:15 ABAIXO do repost de um tweet de 11:30 -> a estimativa seria 10:15 (< 11:30)
    append(client, [post(12, 30), repost(11, 30), post(10, 15)])
    assert ids(client) == [sid(10), sid(10, 15), sid(11), sid(11, 30), sid(12), sid(12, 30)]


def test_repost_de_tweet_antigo_continua_onde_o_feed_o_mostrou(client):
    append(client, [post(12), post(11), post(10)])
    # tweet de 40 h atrás reposto agora: não dá para saber a hora do repost; fica pelo vizinho do feed (11:10), não vai para a frente
    antigo = {"tweet_id": sid(10, 0, d=4), "author": "dono_x", "reposter": "seguido_y", "kind": "repost"}
    append(client, [post(12, 30), antigo, post(11, 10)])
    lista = ids(client)
    assert lista.index(sid(10, 0, d=4)) > lista.index(sid(11))            # logo depois do vizinho (11:10), depois do 11:00
    assert lista.index(sid(10, 0, d=4)) < lista.index(sid(12))


def test_busca_conserta_entrada_antiga_que_ficou_fora_de_ordem(client, db):
    append(client, [post(14), post(13), post(12), post(11), post(10)])
    # estado antigo: um repost de tweet das 13:40 ficou posicionado como se fosse das 10:30
    append(client, [post(13, 40)])
    e = db.entries.find_one({"tweet_id": sid(13, 40)})
    entre = db.entries.find_one({"tweet_id": sid(10)})
    db.entries.update_one({"_id": e["_id"]}, {"$set": {"sort_id": sid(10, 30), "ord": entre["ord"] + 0.5}})
    assert ids(client).index(sid(13, 40)) < ids(client).index(sid(11))      # confirmado: fora de ordem
    r = append(client, [post(15)])                                           # qualquer busca nova conserta
    assert r["repositioned"] == 1
    lista = ids(client)
    assert lista.index(sid(13, 40)) > lista.index(sid(13)) and lista.index(sid(13, 40)) < lista.index(sid(14))
    assert db.entries.find_one({"_id": e["_id"]})["sort_id"] == sid(13, 40)


def test_so_mexe_no_que_e_impossivel_e_nao_nas_lidas(client, db):
    append(client, [post(14), post(13), post(12), post(11), post(10)])
    r = append(client, [post(15)])
    assert r["repositioned"] == 0                                            # tudo certo: nada muda
    # entrada JÁ LIDA (antes da posição) não é tocada
    e = db.entries.find_one({"tweet_id": sid(10)})
    db.entries.update_one({"_id": e["_id"]}, {"$set": {"sort_id": sid(9)}})
    client.post("/api/v1/views", json={"seqs": [e["seq"]]})
    client.put("/api/v1/state", json={"cursor_seq": e["seq"]})
    assert append(client, [post(16)])["repositioned"] == 0


def test_conversas_nao_sao_reposicionadas(client, db):
    append(client, [post(14), post(13), post(12)])
    e = db.entries.find_one({"tweet_id": sid(12)})
    db.entries.update_one({"_id": e["_id"]}, {"$set": {"members": ["999"], "sort_id": sid(9)}})
    assert append(client, [post(15)])["repositioned"] == 0

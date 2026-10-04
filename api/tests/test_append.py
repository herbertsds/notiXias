from concurrent.futures import ThreadPoolExecutor

from app import services as svc
from app.models import AppearanceIn

from .helpers import append, entry, item, queue, seed, tweet_ids


def test_ordem_de_leitura_mais_antigo_primeiro(client):
    # feed: mais novo primeiro
    r = append(client, [item(300), item(200), item(100)])
    assert r["created"] == 3
    q = queue(client)
    assert tweet_ids(q) == ["100", "200", "300"]
    assert [e["seq"] for e in q] == [1, 2, 3]


def test_repost_de_tweet_antigo_segue_a_posicao_no_feed_e_nao_o_horario_original(client):
    # feed (novo -> antigo): 900, repost do tweet antigo 100, 800, 700. O repost aconteceu entre 800 e 900.
    append(client, [item(900, "a"), item(100, "velho", reposter="x"), item(800, "b"), item(700, "c")])
    assert tweet_ids(queue(client)) == ["700", "800", "100", "900"]


def test_repost_no_fim_do_lote_usa_o_vizinho_mais_novo(client):
    append(client, [item(900, "a"), item(100, "velho", reposter="x")])
    assert tweet_ids(queue(client)) == ["100", "900"]


def test_repost_sem_nenhum_tweet_comum_no_lote_usa_o_proprio_tweet(client):
    append(client, [item(300, "a", reposter="x"), item(100, "b", reposter="y")])
    assert tweet_ids(queue(client)) == ["100", "300"]


def test_reposts_antigos_nao_pulam_para_o_comeco_da_fila_nao_lida(client):
    # situação real: cursor no último lido; reposts de tweets de ontem aparecem no meio do feed de hoje
    append(client, [item(500, "a")])
    client.post("/api/v1/views", json={"seqs": [1]})
    client.put("/api/v1/state", json={"cursor_seq": 1})
    novos = [item(900, "z"), item(10, "velho1", reposter="r1"), item(800, "y"), item(5, "velho2", reposter="r2"), item(700, "x"), item(600, "w")]
    append(client, novos)
    # leitura: 600, 700, [velho2], 800, [velho1], 900  (a ordem do feed, de baixo para cima)
    assert tweet_ids(queue(client, after=1)) == ["600", "700", "5", "800", "10", "900"]
    assert client.get("/api/v1/state").json()["next_seq"] == entry(client, 600)["seq"]


def test_novos_entram_entre_os_nao_lidos_pelo_horario_do_tweet_original(client):
    # tweets comuns continuam entrando pelo horário (chegou depois, mas é de horário intermediário)
    append(client, [item(30, "a"), item(10, "b")])
    append(client, [item(20, "c")])
    assert tweet_ids(queue(client)) == ["10", "20", "30"]


def test_lotes_sucessivos_acrescentam_no_fim(client):
    append(client, [item(2), item(1)])
    append(client, [item(4), item(3)])
    assert tweet_ids(queue(client)) == ["1", "2", "3", "4"]


def test_dedupe_por_chave_de_aparicao(client):
    append(client, [item(2), item(1)])
    r = append(client, [item(3), item(2), item(1)])
    assert r["created"] == 1 and r["skipped"] == 2
    assert tweet_ids(queue(client)) == ["1", "2", "3"]


def test_merge_de_reposts_antes_da_leitura(client):
    append(client, [item(10, "conta_b", reposter="ana"), item(10, "conta_b", reposter="beto")])
    q = queue(client)
    assert len(q) == 1
    assert sorted(q[0]["reposters"]) == ["ana", "beto"]
    assert q[0]["kind"] == "repost"


def test_merge_post_original_e_repost_posterior(client):
    append(client, [item(10, "conta_b")])
    r = append(client, [item(10, "conta_b", reposter="ana")])
    assert r["merged"] == 1 and r["created"] == 0
    q = queue(client)
    assert len(q) == 1 and q[0]["reposters"] == ["ana"]


def _visto_ha(client, seq, horas):
    from datetime import datetime, timedelta, timezone

    quando = (datetime.now(timezone.utc) - timedelta(hours=horas)).isoformat()
    assert client.post("/api/v1/views", json={"seqs": [seq], "viewed_at": quando}).status_code == 200


def test_repost_de_post_visto_ha_mais_de_2h_volta_como_nova_entrada(client):
    append(client, [item(10, "conta_b")])
    _visto_ha(client, 1, 3)
    r = append(client, [item(10, "conta_b", reposter="ana")])
    assert r["created"] == 1 and r["merged"] == 0 and r["absorbed"] == 0
    q = queue(client)
    assert [e["seq"] for e in q] == [1, 2]
    assert q[1]["reposters"] == ["ana"]
    # a etiqueta de "já visto" vem do histórico do mesmo tweet_id
    e2 = client.get("/api/v1/entries/2").json()
    assert e2["view_count"] == 1 and e2["read_at"] is None


def test_repost_de_post_visto_ha_menos_de_2h_nao_volta_mas_fica_registrado(client):
    append(client, [item(10, "conta_b")])
    _visto_ha(client, 1, 1)
    r = append(client, [item(10, "conta_b", reposter="ana")])
    assert r["created"] == 0 and r["absorbed"] == 1
    assert len(queue(client)) == 1
    e1 = client.get("/api/v1/entries/1").json()
    assert e1["all_reposters"] == ["ana"] and e1["reposters"] == ["ana"]
    # reenvio da mesma aparição não duplica nem recria
    assert append(client, [item(10, "conta_b", reposter="ana")])["skipped"] == 1


def test_repost_absorvido_nao_volta_depois_que_passam_as_2h(client, db):
    # a aparição foi registrada; uma busca futura não a trata de novo como nova
    append(client, [item(10, "conta_b")])
    _visto_ha(client, 1, 1)
    append(client, [item(10, "conta_b", reposter="ana")])
    from datetime import datetime, timedelta, timezone

    db.views.update_many({}, {"$set": {"viewed_at": datetime.now(timezone.utc) - timedelta(hours=5)}})
    r = append(client, [item(10, "conta_b", reposter="ana")])
    assert r["created"] == 0 and r["skipped"] == 1


def test_outro_reposter_depois_de_2h_cria_entrada_nova(client, db):
    append(client, [item(10, "conta_b")])
    _visto_ha(client, 1, 1)
    append(client, [item(10, "conta_b", reposter="ana")])  # absorvido
    from datetime import datetime, timedelta, timezone

    db.views.update_many({}, {"$set": {"viewed_at": datetime.now(timezone.utc) - timedelta(hours=3)}})
    r = append(client, [item(10, "conta_b", reposter="beto")])
    assert r["created"] == 1
    assert queue(client)[-1]["reposters"] == ["beto"]
    assert client.get("/api/v1/entries/1").json()["all_reposters"] == ["ana", "beto"]


def test_limite_de_2h_usa_a_ultima_visualizacao_do_tweet(client):
    # visto há 5h na 1ª entrada e há 30min numa 2ª: vale a mais recente -> não volta
    append(client, [item(10, "conta_b")])
    _visto_ha(client, 1, 5)
    append(client, [item(10, "conta_b", reposter="ana")])
    _visto_ha(client, 2, 0.5)
    r = append(client, [item(10, "conta_b", reposter="beto")])
    assert r["created"] == 0 and r["absorbed"] == 1


def test_repost_de_nao_lido_continua_juntando_na_mesma_entrada(client):
    append(client, [item(10, "b")])
    r = append(client, [item(10, "b", reposter="ana")])
    assert r["merged"] == 1 and r["created"] == 0 and r["absorbed"] == 0


def test_chave_de_reposter_ignora_maiusculas(client):
    append(client, [item(10, "conta_b", reposter="Ana")])
    r = append(client, [item(10, "conta_b", reposter="ana")])
    assert r["skipped"] == 1
    assert len(queue(client)) == 1


def test_gap_before_quando_ancora_nao_encontrada(client):
    append(client, [item(2), item(1)])
    r = append(client, [item(5), item(4)], anchor_found=False)
    assert r["gap"] is True and r["first_new_seq"] == 3
    q = queue(client)
    assert [e["gap_before"] for e in q] == [False, False, True, False]


def test_sem_gap_na_primeira_carga_mesmo_sem_ancora(client):
    r = append(client, [item(2), item(1)], anchor_found=False)
    assert r["gap"] is False
    assert not any(e["gap_before"] for e in queue(client))


def test_sem_gap_se_nada_foi_criado(client):
    append(client, [item(2), item(1)])
    r = append(client, [item(2)], anchor_found=False)
    assert r["created"] == 0 and r["gap"] is False


def test_idempotencia_por_batch_id(client):
    lote = [item(3), item(2), item(1)]
    r1 = append(client, lote, batch_id="b-1")
    r2 = append(client, lote, batch_id="b-1")
    assert r1 == r2
    assert len(queue(client)) == 3


def test_ancoras_das_ultimas_entradas(client):
    append(client, [item(3), item(2, "conta_b", reposter="ana"), item(1)])
    a = client.get("/api/v1/queue/anchor", params={"depth": 2}).json()
    assert a["last_seq"] == 3
    assert set(a["keys"]) == {"3|", "2|ana"}
    vazio = client.get("/api/v1/queue/anchor").json()
    assert len(vazio["keys"]) == 3


def test_ancora_com_fila_vazia(client):
    assert client.get("/api/v1/queue/anchor").json() == {"keys": [], "last_seq": None}


def test_ancora_inclui_todas_as_chaves_de_entrada_com_merge(client):
    append(client, [item(10, "b", reposter="ana"), item(10, "b", reposter="beto")])
    a = client.get("/api/v1/queue/anchor").json()
    assert set(a["keys"]) == {"10|ana", "10|beto"}


def test_url_canonica_e_autor(client):
    append(client, [item(77, "Conta_X")])
    e = queue(client)[0]
    assert e["url"] == "https://x.com/Conta_X/status/77"
    assert e["author"] == "Conta_X"


def test_validacao_rejeita_dados_invalidos(client):
    def post(items):
        return client.post("/api/v1/queue/append", json={"items": items, "anchor_found": True})

    assert post([{"tweet_id": "abc", "author": "x"}]).status_code == 422
    assert post([{"tweet_id": "1", "author": "nome com espaço"}]).status_code == 422
    assert post([{"tweet_id": "1", "author": "x" * 16}]).status_code == 422
    assert post([{"tweet_id": "1" * 26, "author": "x"}]).status_code == 422
    assert post([{"tweet_id": "1", "author": "x", "reposter": "a/b"}]).status_code == 422
    assert post([item(i) for i in range(1001)]).status_code == 422
    r = client.post("/api/v1/queue/append", json={"items": [], "anchor_found": True, "batch_id": "tem espaço"})
    assert r.status_code == 422


def test_lote_vazio_ok(client):
    r = append(client, [])
    assert r["created"] == 0 and r["first_new_seq"] is None


def test_paginacao_after_before(client):
    seed(client, 5)  # seq 1..5
    assert [e["seq"] for e in queue(client, after=2, limit=2)] == [3, 4]
    assert [e["seq"] for e in queue(client, before=4, limit=2)] == [3, 2]
    r = client.get("/api/v1/queue", params={"after": 1, "before": 3})
    assert r.status_code == 422


def test_seq_sem_colisao_com_escritas_concorrentes(db):
    svc.ensure_indexes(db)

    def work(base):
        items = [AppearanceIn(tweet_id=str(base + i), author="conta_a") for i in range(20)]
        return svc.append_items(db, items, True, None)

    with ThreadPoolExecutor(max_workers=8) as ex:
        results = list(ex.map(work, [1000 * n for n in range(1, 9)]))
    assert sum(r["created"] for r in results) == 160
    seqs = sorted(d["seq"] for d in db.entries.find({}, {"seq": 1}))
    assert seqs == list(range(1, 161))


def test_mesma_aparicao_concorrente_nao_duplica(db):
    svc.ensure_indexes(db)

    def work(_):
        items = [AppearanceIn(tweet_id=str(i), author="conta_a") for i in range(1, 31)]
        return svc.append_items(db, items, True, None)

    with ThreadPoolExecutor(max_workers=6) as ex:
        results = list(ex.map(work, range(6)))
    assert db.entries.count_documents({}) == 30
    assert sum(r["created"] for r in results) == 30

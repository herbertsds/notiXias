from .helpers import append, item, queue, seed


def test_cobertura_so_marca_nao_lidas_do_mesmo_autor(client):
    append(client, [item(5, "autor"), item(4, "outro"), item(3, "autor"), item(2, "autor"), item(1, "autor")])
    # seq: 1(1) 2(2) 3(3) 4(4 outro) 5(5)
    client.post("/api/v1/views", json={"seqs": [1]})  # tweet 1 já lido
    r = client.post("/api/v1/entries/cover", json={"covered_by": 5, "tweet_ids": ["1", "2", "3", "4"]})
    assert r.json() == {"covered": 2}  # 2 e 3; 1 está lido, 4 é de outro autor
    cobertas = {e["tweet_id"] for e in queue(client, include_covered=True) if e["covered"]}
    assert cobertas == {"2", "3"}
    e5 = client.get("/api/v1/entries/5").json()
    assert e5["covered_count"] == 2


def test_cobertura_ignora_maiusculas_do_autor(client):
    append(client, [item(2, "Autor"), item(1, "autor")])
    r = client.post("/api/v1/entries/cover", json={"covered_by": 2, "tweet_ids": ["1"]})
    assert r.json()["covered"] == 1


def test_cobertura_nao_cobre_a_si_mesma(client):
    seed(client, 2, author="autor")
    r = client.post("/api/v1/entries/cover", json={"covered_by": 2, "tweet_ids": ["102"]})
    assert r.json()["covered"] == 0


def test_cobertura_destino_inexistente_404(client):
    seed(client, 1)
    r = client.post("/api/v1/entries/cover", json={"covered_by": 9, "tweet_ids": ["101"]})
    assert r.status_code == 404


def test_reabrir_cobertas(client):
    seed(client, 3, author="autor")
    client.post("/api/v1/entries/cover", json={"covered_by": 3, "tweet_ids": ["101", "102"]})
    assert [e["seq"] for e in queue(client)] == [3]
    r = client.post("/api/v1/entries/uncover", json={"covered_by": 3})
    assert r.json() == {"reopened": 2}
    assert [e["seq"] for e in queue(client)] == [1, 2, 3]
    assert client.get("/api/v1/entries/3").json()["covered_count"] == 0


def test_patch_cobrir_e_descobrir(client):
    seed(client, 3, author="autor")
    r = client.patch("/api/v1/entries/1", json={"covered": True, "covered_by": 3})
    assert r.status_code == 200 and r.json()["covered"] is True and r.json()["covered_by"] == 3
    r = client.patch("/api/v1/entries/1", json={"covered": False})
    assert r.json()["covered"] is False and r.json()["covered_by"] is None


def test_patch_validacoes(client):
    seed(client, 2)
    assert client.patch("/api/v1/entries/1", json={}).status_code == 422
    assert client.patch("/api/v1/entries/1", json={"covered": True}).status_code == 422
    assert client.patch("/api/v1/entries/1", json={"covered": True, "covered_by": 1}).status_code == 422
    assert client.patch("/api/v1/entries/1", json={"covered": True, "covered_by": 99}).status_code == 422
    assert client.patch("/api/v1/entries/99", json={"removed": True}).status_code == 404


def test_remocao_logica_nao_apaga(client, db):
    seed(client, 2)
    r = client.patch("/api/v1/entries/1", json={"removed": True})
    assert r.status_code == 200
    assert client.get("/api/v1/entries/1").status_code == 404
    assert db.entries.count_documents({"seq": 1}) == 1  # continua no banco
    assert [e["seq"] for e in queue(client)] == [2]
    # entrada removida não recebe merge de repost novo
    r = append(client, [item(101, "conta_a", reposter="ana")])
    assert r["created"] == 1


def test_skeleton_guarda_e_lista(client):
    r = client.post("/api/v1/health/skeleton", json={"page": "home", "skeleton": "article\n  div", "note": "teste"})
    assert r.status_code == 201
    client.post("/api/v1/health/skeleton", json={"page": "home", "skeleton": "article\n  span"})
    itens = client.get("/api/v1/health/skeleton", params={"limit": 5}).json()["items"]
    assert len(itens) == 2 and itens[0]["skeleton"].endswith("span")  # mais recente primeiro


def test_skeleton_limite_de_tamanho(client):
    r = client.post("/api/v1/health/skeleton", json={"page": "home", "skeleton": "x" * 200_001})
    assert r.status_code == 422


def test_export_tem_tudo_e_sem_campos_internos(client):
    seed(client, 2)
    client.post("/api/v1/views", json={"seqs": [1]})
    client.put("/api/v1/state", json={"cursor_seq": 1})
    ex = client.get("/api/v1/export").json()
    assert len(ex["entries"]) == 2 and len(ex["views"]) == 1
    assert ex["state"]["cursor_seq"] == 1
    assert all("_id" not in e and "author_lc" not in e for e in ex["entries"])


def test_healthz_503_quando_mongo_indisponivel(client):
    class Quebrado:
        class admin:  # noqa: N801
            @staticmethod
            def command(*_a, **_k):
                raise RuntimeError("mongo fora")

    original = client.app.state.client
    client.app.state.client = Quebrado
    try:
        r = client.get("/healthz")
    finally:
        client.app.state.client = original
    assert r.status_code == 503
    assert r.json() == {"status": "mongo_unavailable"}


# ---- resposta + original (autores diferentes): um único registro ----
def _resposta_e_original(client):
    """R (resposta, autor b) tem seq 1; O (original, autor a) vem depois, seq 2 — como no uso real."""
    append(client, [item(900, "a"), item(700, "b")])  # feed: mais novo primeiro -> seq1=700(b), seq2=900(a)
    q = queue(client)
    assert [e["tweet_id"] for e in q] == ["700", "900"]
    return q


def test_ancestrais_de_outro_autor_viram_o_mesmo_registro(client):
    _resposta_e_original(client)
    r = client.post("/api/v1/entries/cover", json={"covered_by": 1, "ancestor_ids": ["900"]})
    assert r.json() == {"covered": 1}
    assert [e["seq"] for e in queue(client)] == [1]
    assert client.get("/api/v1/entries/2").status_code == 200
    assert client.get("/api/v1/entries/1").json()["covered_count"] == 1
    # ao sair da resposta, o original conta como visto no mesmo momento
    client.post("/api/v1/views", json={"seqs": [1]})
    assert client.get("/api/v1/entries/2").json()["read_at"] is not None


def test_tweet_ids_continua_restrito_ao_mesmo_autor(client):
    _resposta_e_original(client)
    r = client.post("/api/v1/entries/cover", json={"covered_by": 1, "tweet_ids": ["900"]})
    assert r.json() == {"covered": 0}  # 900 é de outro autor: só entra por ancestor_ids


def test_ancestrais_nao_cobrem_lidas_nem_ja_cobertas_por_outra(client):
    append(client, [item(3, "c"), item(2, "b"), item(1, "a")])  # seq 1=1(a) 2=2(b) 3=3(c)
    client.post("/api/v1/views", json={"seqs": [1]})  # 1 já lida
    client.post("/api/v1/entries/cover", json={"covered_by": 2, "ancestor_ids": ["1"]})  # lida: ignorada
    assert client.get("/api/v1/entries/1").json()["covered"] is False
    client.post("/api/v1/entries/cover", json={"covered_by": 3, "ancestor_ids": ["2"]})
    r = client.post("/api/v1/entries/cover", json={"covered_by": 1, "ancestor_ids": ["2"]})  # já coberta por 3
    assert r.json() == {"covered": 0}
    assert client.get("/api/v1/entries/2").json()["covered_by"] == 3


def test_ancestrais_e_pedacos_juntos_e_validacao(client):
    append(client, [item(30, "a"), item(20, "b"), item(10, "a")])  # seq1=10(a) seq2=20(b) seq3=30(a)
    r = client.post("/api/v1/entries/cover", json={"covered_by": 3, "tweet_ids": ["10"], "ancestor_ids": ["20", "999"]})
    assert r.json() == {"covered": 2}
    assert [e["seq"] for e in queue(client)] == [3]
    assert client.post("/api/v1/entries/cover", json={"covered_by": 3}).status_code == 422
    assert client.post("/api/v1/entries/cover", json={"covered_by": 3, "tweet_ids": [], "ancestor_ids": []}).status_code == 422


def test_reabrir_devolve_tambem_os_ancestrais(client):
    _resposta_e_original(client)
    client.post("/api/v1/entries/cover", json={"covered_by": 1, "ancestor_ids": ["900"]})
    assert client.post("/api/v1/entries/uncover", json={"covered_by": 1}).json() == {"reopened": 1}
    assert [e["seq"] for e in queue(client)] == [1, 2]

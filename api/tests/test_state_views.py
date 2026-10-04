from .helpers import append, item, queue, seed


def test_estado_inicial_sem_fila(client):
    s = client.get("/api/v1/state").json()
    assert s["cursor_seq"] is None and s["current"] is None and s["next_seq"] is None
    assert s["total_visible"] == 0 and s["unread_after"] == 0 and s["position"] == 0
    assert s["feed"] == {"url": "https://x.com/home", "tab_index": 1}
    assert s["version"] == 0


def test_estado_com_fila_e_sem_cursor(client):
    seed(client, 3)
    s = client.get("/api/v1/state").json()
    assert s["cursor_seq"] is None
    assert s["next_seq"] == 1
    assert s["total_visible"] == 3 and s["unread_after"] == 3 and s["position"] == 0


def test_put_state_move_cursor_e_incrementa_versao(client):
    seed(client, 5)
    r = client.put("/api/v1/state", json={"cursor_seq": 2})
    assert r.status_code == 200
    s = r.json()
    assert s["cursor_seq"] == 2 and s["current"]["seq"] == 2
    assert s["next_seq"] == 3 and s["position"] == 2 and s["unread_after"] == 3
    assert s["version"] == 1


def test_put_state_cursor_inexistente_422(client):
    seed(client, 2)
    r = client.put("/api/v1/state", json={"cursor_seq": 99})
    assert r.status_code == 422
    assert client.get("/api/v1/state").json()["cursor_seq"] is None


def test_put_state_concorrencia_otimista(client):
    seed(client, 3)
    assert client.put("/api/v1/state", json={"cursor_seq": 1, "expected_version": 0}).status_code == 200
    r = client.put("/api/v1/state", json={"cursor_seq": 2, "expected_version": 0})
    assert r.status_code == 409
    body = r.json()
    assert body["detail"] == "version_conflict"
    assert body["state"]["cursor_seq"] == 1 and body["state"]["version"] == 1


def test_put_state_troca_feed(client):
    r = client.put("/api/v1/state", json={"feed": {"url": "https://x.com/i/lists/123", "tab_index": None}})
    assert r.status_code == 200
    assert r.json()["feed"] == {"url": "https://x.com/i/lists/123", "tab_index": None}


def test_put_state_rejeita_feed_fora_do_x(client):
    r = client.put("/api/v1/state", json={"feed": {"url": "https://evil.example.com/", "tab_index": 1}})
    assert r.status_code == 422


def test_put_state_pode_limpar_cursor(client):
    seed(client, 2)
    client.put("/api/v1/state", json={"cursor_seq": 2})
    r = client.put("/api/v1/state", json={"cursor_seq": None})
    assert r.json()["cursor_seq"] is None


def test_views_uma_por_entrada_e_read_at(client):
    seed(client, 3)
    r = client.post("/api/v1/views", json={"seqs": [1]})
    assert r.json()["recorded"] == 1
    r = client.post("/api/v1/views", json={"seqs": [1]})
    assert r.json() == {"recorded": 0, "already": 1, "seqs": [1]}
    e = client.get("/api/v1/entries/1").json()
    assert e["read_at"] is not None and e["view_count"] == 1
    assert client.get("/api/v1/entries/2").json()["read_at"] is None


def test_views_entrada_inexistente_404_e_nada_gravado(client):
    seed(client, 2)
    r = client.post("/api/v1/views", json={"seqs": [1, 99]})
    assert r.status_code == 404
    assert client.get("/api/v1/entries/1").json()["read_at"] is None


def test_views_com_data_informada(client):
    seed(client, 1)
    client.post("/api/v1/views", json={"seqs": [1], "viewed_at": "2026-10-03T21:14:00Z"})
    e = client.get("/api/v1/entries/1").json()
    assert e["views"][0]["viewed_at"].startswith("2026-10-03T21:14:00")


def test_views_lista_historico_do_mesmo_tweet_entre_entradas(client):
    append(client, [item(10, "b")])
    client.post("/api/v1/views", json={"seqs": [1], "viewed_at": "2026-10-01T10:00:00Z"})
    append(client, [item(10, "b", reposter="ana")])
    client.post("/api/v1/views", json={"seqs": [2], "viewed_at": "2026-10-03T10:00:00Z"})
    e = client.get("/api/v1/entries/2").json()
    assert e["view_count"] == 2
    assert e["views"][0]["viewed_at"].startswith("2026-10-03")  # mais recente primeiro
    assert e["views"][1]["viewed_at"].startswith("2026-10-01")


def test_views_registra_tambem_as_cobertas(client):
    seed(client, 4, author="autor")
    client.post("/api/v1/entries/cover", json={"covered_by": 4, "tweet_ids": ["101", "102", "103"]})
    r = client.post("/api/v1/views", json={"seqs": [4]})
    assert r.json()["recorded"] == 4
    for seq in (1, 2, 3, 4):
        assert client.get(f"/api/v1/entries/{seq}").json()["read_at"] is not None


def test_get_entry_inexistente_404(client):
    assert client.get("/api/v1/entries/5").status_code == 404


def test_navegacao_ignora_cobertas_e_removidas(client):
    seed(client, 5, author="autor")
    client.post("/api/v1/entries/cover", json={"covered_by": 5, "tweet_ids": ["102", "103"]})
    client.patch("/api/v1/entries/4", json={"removed": True})
    assert [e["seq"] for e in queue(client)] == [1, 5]
    s = client.get("/api/v1/state").json()
    assert s["total_visible"] == 2
    assert [e["seq"] for e in queue(client, include_covered=True)] == [1, 2, 3, 5]


def test_all_reposters_inclui_reposts_em_outras_entradas_do_mesmo_tweet(client):
    # post lido e depois repostado: o repost vira nova entrada, mas a entrada antiga também mostra quem repostou
    append(client, [item(10, "b")])
    client.post("/api/v1/views", json={"seqs": [1]})
    append(client, [item(10, "b", reposter="ana")])
    antiga = client.get("/api/v1/entries/1").json()
    nova = client.get("/api/v1/entries/2").json()
    assert antiga["reposters"] == [] and antiga["read_at"] is not None
    assert antiga["all_reposters"] == ["ana"]
    assert nova["reposters"] == ["ana"] and nova["all_reposters"] == ["ana"]


def test_all_reposters_sem_repetir_e_na_ordem(client):
    append(client, [item(10, "b", reposter="Ana")])
    client.post("/api/v1/views", json={"seqs": [1]})
    append(client, [item(10, "b", reposter="beto"), item(10, "b", reposter="ana")])
    e = client.get("/api/v1/entries/1").json()
    assert e["all_reposters"] == ["Ana", "beto"]


def test_all_reposters_ignora_removidas_e_outros_tweets(client):
    # tweet 10 lido, depois repostado por ana (entrada 2); tweet 11 repostado por zeca (entrada 3)
    append(client, [item(10, "b")])
    client.post("/api/v1/views", json={"seqs": [1]})
    append(client, [item(11, "b", reposter="zeca"), item(10, "b", reposter="ana")])
    assert client.get("/api/v1/entries/1").json()["all_reposters"] == ["ana"]  # não mistura o repost do tweet 11
    ana = [e for e in client.get("/api/v1/queue", params={"after": 0}).json()["items"] if e["reposters"] == ["ana"]][0]
    client.patch(f"/api/v1/entries/{ana['seq']}", json={"removed": True})
    assert client.get("/api/v1/entries/1").json()["all_reposters"] == []  # entrada removida não conta


def test_state_current_traz_all_reposters(client):
    append(client, [item(10, "b")])
    client.post("/api/v1/views", json={"seqs": [1]})
    append(client, [item(10, "b", reposter="ana")])
    client.put("/api/v1/state", json={"cursor_seq": 1})
    assert client.get("/api/v1/state").json()["current"]["all_reposters"] == ["ana"]

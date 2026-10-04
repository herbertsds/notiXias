from .helpers import append, citem, entry, item, queue, tweet_ids


def acc(*handles):
    return {"accounts": [{"handle": h, "name": h.title()} for h in handles]}


def test_resumo_inicial_vazio(client):
    r = client.get("/api/v1/accounts/following").json()
    assert r == {"count": 0, "last_full_at": None, "updated_at": None}
    assert client.get("/api/v1/state").json()["following"]["count"] == 0


def test_leitura_completa_substitui_a_lista(client):
    client.put("/api/v1/accounts/following", json=acc("ana", "beto", "caio"))
    r = client.put("/api/v1/accounts/following", json=acc("beto", "dani")).json()
    assert r["count"] == 2
    lista = client.get("/api/v1/accounts/following", params={"include": "true"}).json()
    assert [a["handle"] for a in lista["accounts"]] == ["beto", "dani"]
    assert lista["last_full_at"] is not None


def test_leitura_completa_ignora_repetidos_e_maiusculas(client):
    r = client.put("/api/v1/accounts/following", json=acc("Ana", "ana", "ANA")).json()
    assert r["count"] == 1


def test_seguir_e_deixar_de_seguir_ao_vivo(client):
    client.put("/api/v1/accounts/following", json=acc("ana"))
    assert client.post("/api/v1/accounts/following/add", json={"handle": "Beto", "name": "Beto Lima"}).json()["count"] == 2
    assert client.post("/api/v1/accounts/following/add", json={"handle": "beto"}).json()["count"] == 2   # idempotente
    assert client.post("/api/v1/accounts/following/remove", json={"handle": "ANA"}).json()["count"] == 1
    assert client.post("/api/v1/accounts/following/remove", json={"handle": "ninguem"}).json()["count"] == 1
    nomes = {a["handle"]: a["name"] for a in client.get("/api/v1/accounts/following", params={"include": "true"}).json()["accounts"]}
    assert nomes == {"beto": "Beto Lima"}


def test_validacao(client):
    assert client.put("/api/v1/accounts/following", json={"accounts": [{"handle": "tem espaço"}]}).status_code == 422
    assert client.post("/api/v1/accounts/following/add", json={"handle": "x" * 16}).status_code == 422
    assert client.put("/api/v1/accounts/following", json={}).status_code == 422


def test_exige_chave(anon):
    assert anon.get("/api/v1/accounts/following").status_code == 401
    assert anon.put("/api/v1/accounts/following", json=acc("a")).status_code == 401


def test_export_inclui_a_lista(client):
    client.put("/api/v1/accounts/following", json=acc("ana"))
    assert [a["handle"] for a in client.get("/api/v1/export").json()["following"]["accounts"]] == ["ana"]


# ---- a lista exata decide quem é "seguido" no horário da conversa ----
def test_lista_exata_raiz_nao_listada_nao_define_o_horario(client):
    client.put("/api/v1/accounts/following", json=acc("ana", "bia", "jose"))
    append(client, [item(60, "ana"), item(50, "bia")])
    append(client, [citem(5, "joao", 1), citem(55, "jose", 1)])        # joão NÃO está na lista
    assert tweet_ids(queue(client)) == ["50", "55", "60"]


def test_lista_exata_raiz_listada_e_nova_define_o_horario(client):
    client.put("/api/v1/accounts/following", json=acc("ana", "bia", "jose", "joao"))
    append(client, [item(60, "ana"), item(50, "bia")])
    append(client, [citem(5, "joao", 1), citem(55, "jose", 1)])        # joão está na lista: vale o horário dele
    assert tweet_ids(queue(client)) == ["55", "50", "60"]              # horário 5 -> à frente de 50 e 60


def test_lista_exata_vale_mesmo_contra_o_que_foi_aprendido(client):
    # 'joao' aparece com post próprio (aprendido como seguido), mas a lista exata diz que não segue
    client.put("/api/v1/accounts/following", json=acc("ana", "jose"))
    append(client, [item(90, "ana"), item(80, "joao")])
    append(client, [citem(7, "joao", 1), citem(85, "jose", 1)])
    # se valesse o aprendido (joão seguido), a conversa iria para o horário 7 e ficaria na frente
    assert tweet_ids(queue(client)) == ["80", "85", "90"]


def test_sem_lista_completa_ainda_usa_o_aprendido_do_feed(client):
    append(client, [item(60, "ana"), item(50, "bia")])
    append(client, [citem(5, "joao", 1), citem(55, "jose", 1)])        # joão só aparece como raiz: não aprendido
    assert tweet_ids(queue(client)) == ["50", "55", "60"]


def test_seguir_ao_vivo_sem_leitura_completa_soma_ao_aprendido(client):
    client.post("/api/v1/accounts/following/add", json={"handle": "joao"})   # sem last_full_at: soma
    append(client, [item(60, "ana"), item(50, "bia")])
    append(client, [citem(5, "joao", 1), citem(55, "jose", 1)])        # joão agora conta como seguido
    assert tweet_ids(queue(client)) == ["55", "50", "60"]

"""Itens capturados por uma busca profunda (feed ou perfis) entram na fila de não lidas pela DATA do post (a data vem do
ID). Só vão para o começo das não lidas se forem mais antigos que a primeira não lida."""
from datetime import datetime, timezone

from .helpers import append, queue, tweet_ids


def sid(h, m=0, d=6):
    """ID de um post feito em 2026-10-<d> <h>:<m> UTC (o horário está nos bits altos do ID do X)."""
    ms = int(datetime(2026, 10, d, h, m, tzinfo=timezone.utc).timestamp() * 1000)
    return str((ms - 1288834974657) << 22)


def post(h, m=0, author="conta_a", d=6):
    return {"tweet_id": sid(h, m, d), "author": author, "reposter": None, "kind": "post"}


def unread_ids(client):
    return [e["tweet_id"] for e in queue(client) if not e["read_at"]]


def _fila(client):
    """Lida 09:00 (cursor nela) e não lidas 10:00, 11:00, 12:00."""
    append(client, [post(12), post(11), post(10), post(9)])
    r = client.post("/api/v1/views", json={"seqs": [1]})
    assert r.status_code in (200, 201)
    assert client.put("/api/v1/state", json={"cursor_seq": 1}).status_code == 200


def test_entra_no_meio_na_ordem_do_horario(client):
    _fila(client)
    append(client, [post(11, 30), post(10, 30)], anchor_found=False)         # busca profunda: dois no meio
    assert unread_ids(client) == [sid(10), sid(10, 30), sid(11), sid(11, 30), sid(12)]


def test_so_vai_para_o_comeco_das_nao_lidas_se_for_antes_da_primeira(client):
    _fila(client)
    append(client, [post(9, 30)])                                            # entre a lida (09:00) e a primeira não lida (10:00)
    assert unread_ids(client)[0] == sid(9, 30)
    append(client, [post(10, 1)])                                            # DEPOIS da primeira não lida (agora 09:30): não passa na frente
    ids = unread_ids(client)
    assert ids[0] == sid(9, 30) and ids.index(sid(10, 1)) == ids.index(sid(10)) + 1


def test_mais_antigo_que_a_ultima_lida_tambem_vai_para_o_comeco_das_nao_lidas(client):
    _fila(client)
    append(client, [post(8, 0)])                                             # anterior a tudo, até ao que já foi lido
    q = queue(client)
    assert [e["tweet_id"] for e in q][:2] == [sid(9), sid(8)]                # a lida fica onde estava; o novo é o 1º não lido
    assert unread_ids(client)[0] == sid(8)


def test_mais_novo_que_todos_vai_para_o_fim(client):
    _fila(client)
    append(client, [post(15)])
    assert unread_ids(client)[-1] == sid(15)


def test_lote_de_perfil_com_posts_e_comentarios_misturados_respeita_a_data_de_cada_um(client):
    _fila(client)
    # o que a verificação de perfis enviou (mais novo primeiro): comentário 11:45, post 10:15, comentário 8:30, post 12:30
    append(client, [post(12, 30, "conta_b"), post(11, 45, "conta_c"), post(10, 15, "conta_b"), post(8, 30, "conta_c")])
    assert unread_ids(client) == [sid(8, 30), sid(10), sid(10, 15), sid(11), sid(11, 45), sid(12), sid(12, 30)]


def test_reenvio_do_mesmo_lote_nao_duplica_nem_muda_a_ordem(client):
    _fila(client)
    lote = [post(11, 30), post(10, 30)]
    append(client, lote)
    antes = unread_ids(client)
    r = append(client, lote)
    assert r["created"] == 0 and unread_ids(client) == antes
    assert tweet_ids(queue(client)).count(sid(10, 30)) == 1


def test_conversa_capturada_pela_busca_profunda_entra_pelo_horario_da_resposta_de_conta_seguida(client):
    _fila(client)
    raiz = {**post(10, 40, "conta_x"), "cluster": 1}                         # raiz (conta que talvez nem seja seguida)
    resp = {**post(11, 20, "conta_y"), "cluster": 1}                         # resposta de conta seguida: dá o horário
    append(client, [raiz, resp])                                             # na ordem do feed: a conversa vem de cima para baixo (raiz, resposta)
    ids = unread_ids(client)
    pos = ids.index(sid(11, 20)) if sid(11, 20) in ids else ids.index(sid(10, 40))
    assert ids[pos - 1] == sid(11) and ids[pos + 1] == sid(12)               # entre 11:00 e 12:00

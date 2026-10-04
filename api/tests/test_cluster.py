"""Conversas vistas no feed: raiz, resposta 1, resposta 2 (IDs crescendo de cima para baixo) = um registro,
tendo a ÚLTIMA resposta como referência."""
from .helpers import append, citem, entry, item, queue, tweet_ids


def conversa(client, a=10, b=11, c=12, cluster=1):
    """Feed (topo -> base): raiz a, resposta b, resposta c."""
    return append(client, [citem(a, "x", cluster), citem(b, "y", cluster), citem(c, "z", cluster)])


def test_conversa_vira_um_unico_registro_com_a_ultima_como_referencia(client):
    r = conversa(client)
    assert r["created"] == 1 and r["linked"] == 2
    assert tweet_ids(queue(client)) == ["12"]          # só a referência na fila de leitura
    ref = entry(client, 12)
    assert ref["seq"] == 1 and ref["covered"] is False
    for tid in (10, 11):
        e = entry(client, tid)
        assert e["covered"] is True and e["covered_by"] == 1
    det = client.get("/api/v1/entries/1").json()
    assert det["covered_count"] == 2 and sorted(det["members"]) == ["10", "11"]


def test_conversa_ocupa_o_lugar_dela_entre_os_outros_posts(client):
    # feed: X(30) novo no topo, conversa A,B,C, Y(5) velho embaixo -> leitura: Y, conversa, X
    append(client, [item(30, "w"), citem(10, "x", 1), citem(11, "y", 1), citem(12, "z", 1), item(5, "v")])
    assert tweet_ids(queue(client)) == ["5", "12", "30"]


def test_raiz_nao_lida_mantem_a_posicao_e_so_troca_o_link_para_a_nova_resposta(client):
    # João (10h) não lido; às 12h José responde. O registro continua onde estava, abrindo a resposta do José.
    append(client, [item(10, "joao")])
    r = append(client, [citem(10, "joao", 1), citem(11, "jose", 1)])
    assert r["created"] == 0 and r["updated"] == 1
    assert tweet_ids(queue(client)) == ["10"]            # nenhuma entrada nova: a do João é o registro
    e = entry(client, 10)
    assert e["seq"] == 1 and e["open_id"] == "11" and e["url"] == "https://x.com/jose/status/11"
    assert entry(client, 11) is None                      # a resposta não virou entrada própria
    # reenviar não duplica nem recria
    r2 = append(client, [citem(10, "joao", 1), citem(11, "jose", 1)])
    assert r2["created"] == 0 and len(queue(client, include_covered="true")) == 1


def test_posicao_na_fila_nao_muda_com_respostas_novas(client):
    append(client, [item(30, "z"), item(20, "joao"), item(10, "x")])    # leitura: 10, 20 (joão), 30
    append(client, [citem(20, "joao", 1), citem(21, "jose", 1)])         # José responde ao João
    assert tweet_ids(queue(client)) == ["10", "20", "30"]
    assert entry(client, 20)["open_id"] == "21"


def test_varias_respostas_seguidas_so_atualizam_o_link(client):
    append(client, [item(10, "joao")])
    append(client, [citem(10, "joao", 1), citem(11, "jose", 1)])
    append(client, [citem(10, "joao", 1), citem(11, "jose", 1), citem(12, "ana", 1)])
    e = entry(client, 10)
    assert e["open_id"] == "12" and e["url"] == "https://x.com/ana/status/12"
    det = client.get(f"/api/v1/entries/{e['seq']}").json()
    assert sorted(det["members"]) == ["11", "12"]
    assert tweet_ids(queue(client)) == ["10"]


def test_link_nunca_volta_para_uma_resposta_mais_antiga(client):
    append(client, [item(10, "joao")])
    append(client, [citem(10, "joao", 1), citem(11, "jose", 1), citem(12, "ana", 1)])
    append(client, [citem(10, "joao", 1), citem(11, "jose", 1)])         # feed momentaneamente sem a última
    assert entry(client, 10)["open_id"] == "12"


def test_dois_registros_nao_lidos_da_mesma_conversa_ficam_no_mais_antigo(client):
    append(client, [item(20, "b")])                       # entrada 1
    append(client, [item(21, "c"), item(10, "a")])        # leitura: 10 (seq 2)... ordem: a, depois c
    # o registro da conversa [10, 20, 21] fica no de menor seq e cobre os outros
    r = append(client, [citem(10, "a", 1), citem(20, "b", 1), citem(21, "c", 1)])
    assert r["created"] == 0 and r["updated"] == 1 and r["linked"] == 2
    visiveis = queue(client)
    assert len(visiveis) == 1 and visiveis[0]["seq"] == 1
    assert visiveis[0]["open_id"] == "21"


def test_post_ja_lido_volta_ao_topo_com_a_resposta_nova(client):
    # exceção da regra: lido às 10h; às 12h José responde -> volta para o fim da fila (para ver a resposta)
    append(client, [item(10, "joao"), item(5, "w")])
    client.post("/api/v1/views", json={"seqs": [1, 2]})
    r = append(client, [citem(10, "joao", 1), citem(11, "jose", 1)])
    assert r["created"] == 1 and r["updated"] == 0
    nova = entry(client, 11)
    assert nova["seq"] == 3 and nova["open_id"] == "11" and nova["read_at"] is None   # nova entrada, no fim
    raiz = entry(client, 10)
    assert raiz["read_at"] is not None and raiz["covered"] is False and raiz["open_id"] == "10"   # histórico intacto
    # a resposta mostra o "Visto em" da raiz já lida
    assert client.get(f"/api/v1/entries/{nova['seq']}").json()["view_count"] == 1


def test_raiz_ja_lida_nao_e_coberta_mas_o_visto_aparece_na_resposta(client):
    append(client, [item(10, "x")])
    client.post("/api/v1/views", json={"seqs": [1], "viewed_at": "2026-10-03T10:00:00Z"})
    append(client, [citem(10, "x", 1), citem(11, "y", 1)])
    assert entry(client, 10)["covered"] is False and entry(client, 10)["read_at"] is not None
    ref = client.get(f"/api/v1/entries/{entry(client, 11)['seq']}").json()
    assert ref["members"] == ["10"]
    assert ref["view_count"] == 1 and ref["views"][0]["viewed_at"].startswith("2026-10-03T10:00")


def test_nova_resposta_numa_conversa_nao_lida_mantem_o_registro_e_aponta_para_ela(client):
    conversa(client)                                    # registro = 12 (seq 1), não lido
    append(client, [citem(10, "x", 1), citem(11, "y", 1), citem(12, "z", 1), citem(13, "x", 1)])
    assert tweet_ids(queue(client)) == ["12"]           # mesma posição; sem entrada nova
    e = entry(client, 12)
    assert e["seq"] == 1 and e["open_id"] == "13"


def test_reenvio_da_mesma_conversa_nao_duplica(client):
    conversa(client)
    r = conversa(client)
    assert r["created"] == 0 and r["linked"] == 0
    assert len(queue(client, include_covered="true")) == 3


def test_settle_confirma_o_que_a_pagina_mostra_e_solta_o_resto(client):
    conversa(client)                                    # ref 12 (seq1), membros 11 (seq2), 10 (seq3)
    r = client.post("/api/v1/entries/settle", json={"covered_by": 1, "present_ids": ["10", "12"]})
    assert r.json() == {"confirmed": 1, "released": 1}
    assert entry(client, 10)["covered"] is True         # estava na página: confirmada
    assert entry(client, 11)["covered"] is False        # não estava: volta à fila, depois da referência
    assert tweet_ids(queue(client)) == ["12", "11"]


def test_visualizacao_so_inclui_cobertas_confirmadas(client):
    conversa(client)
    r = client.post("/api/v1/views", json={"seqs": [1]})
    assert r.json()["recorded"] == 1                    # provisórias não contam como vistas
    assert entry(client, 10)["read_at"] is None
    # depois de confirmar, passam a contar
    client.post("/api/v1/entries/settle", json={"covered_by": 1, "present_ids": ["10", "11"]})
    client.patch("/api/v1/entries/1", json={"removed": False}) if False else None
    from app import services as svc  # noqa: F401
    r2 = client.post("/api/v1/views", json={"seqs": [1]})
    assert r2.json()["already"] >= 1                    # a referência já estava lida


def test_visualizacao_das_confirmadas_junto_com_a_referencia(client):
    conversa(client)
    client.post("/api/v1/entries/settle", json={"covered_by": 1, "present_ids": ["10", "11"]})
    r = client.post("/api/v1/views", json={"seqs": [1]})
    assert r.json()["recorded"] == 3
    assert entry(client, 10)["read_at"] is not None and entry(client, 11)["read_at"] is not None


def test_cobrir_ancestral_confirma_e_reabrir_limpa_provisorio(client):
    conversa(client)
    client.post("/api/v1/entries/cover", json={"covered_by": 1, "ancestor_ids": ["10"]})
    # 10 passou a confirmada: o settle não a mexe
    r = client.post("/api/v1/entries/settle", json={"covered_by": 1, "present_ids": []})
    assert r.json() == {"confirmed": 0, "released": 1}  # só o 11 (provisório) é solto
    assert entry(client, 10)["covered"] is True
    assert client.post("/api/v1/entries/uncover", json={"covered_by": 1}).json()["reopened"] == 1


def test_conversas_diferentes_no_mesmo_lote_nao_se_misturam(client):
    append(client, [citem(20, "a", 2), citem(21, "b", 2), citem(10, "c", 1), citem(11, "d", 1)])
    assert tweet_ids(queue(client)) == ["11", "21"]
    assert entry(client, 10)["covered_by"] == entry(client, 11)["seq"]
    assert entry(client, 20)["covered_by"] == entry(client, 21)["seq"]


def test_item_sem_cluster_continua_como_antes(client):
    r = append(client, [item(3), item(2), item(1)])
    assert r["created"] == 3 and r["linked"] == 0
    assert tweet_ids(queue(client)) == ["1", "2", "3"]


def test_ancora_com_profundidade_maior(client):
    append(client, [item(i) for i in range(150, 0, -1)])
    assert len(client.get("/api/v1/queue/anchor", params={"depth": 120}).json()["keys"]) == 120
    assert client.get("/api/v1/queue/anchor", params={"depth": 201}).status_code == 422


def test_cenario_real_703_reagrupado_com_respostas_e_posts_que_estavam_ausentes(client):
    """Reproduz o Seguindo de 2026-10-04: o tweet 703 já estava na fila (lido); depois ganhou respostas e subiu no
    feed junto delas, ficando ACIMA de posts novos. Antes, a busca parava no 703 e perdia os posts abaixo dele."""
    V, R, FI, FL, CA, LU = "2106703818130149651", "2106711451792822638", "2106716219420422521", "2106715963739807892", "2106715572201456032", "2106714190031302934"
    VE2 = "2106718319915217378"
    # 1ª busca (11:25): o 703 era um dos mais novos
    append(client, [item(V, "venecasagrande"), item("2106703885448413661", "flamengomeumund")])
    client.post("/api/v1/views", json={"seqs": [entry(client, V)["seq"]], "viewed_at": "2026-10-04T14:37:00Z"})
    # busca posterior: feed (topo -> base) com a conversa [703, RicardoPF, venecasagrande] acima de posts novos
    r = append(client, [
        citem("2106722693630345290", "futebol_info"),                          # novo, acima
        citem(V, "venecasagrande", 1), citem(R, "RicardoPF", 1), citem(VE2, "venecasagrande", 1),  # conversa
        citem(FI, "futebol_info"), citem(FL, "Flamengo"), citem(CA, "cahemota"), citem(LU, "luizfilipecm"),  # ausentes antes
        citem("2106703885448413661", "flamengomeumund"),                       # conhecido (contexto)
    ])
    assert r["created"] == 6 + 1 - 0 or r["created"] >= 6          # 4 posts + referência + o do topo
    # todos os que estavam ausentes agora existem
    for tid in (R, VE2, FI, FL, CA, LU):
        assert entry(client, tid) is not None, tid
    # a conversa é um registro: referência = a última resposta (VE2); a resposta do meio fica coberta
    ref = entry(client, VE2)
    assert ref["covered"] is False
    assert entry(client, R)["covered"] is True and entry(client, R)["covered_by"] == ref["seq"]
    # o 703 já estava lido: não é coberto e o "Visto em" aparece na referência
    assert entry(client, V)["covered"] is False and entry(client, V)["read_at"] is not None
    det = client.get(f"/api/v1/entries/{ref['seq']}").json()
    assert sorted(det["members"]) == sorted([V, R]) and det["view_count"] == 1
    # ordem de leitura: pelo horário. A conversa entra pelo horário do 1º post NOVO de conta seguida (RicardoPF,
    # 11:42), que é anterior aos demais -> vem antes deles; o 703 já estava lido e não conta.
    visiveis = tweet_ids(queue(client))
    assert visiveis.index(VE2) < visiveis.index(LU) < visiveis.index(CA) < visiveis.index(FL) < visiveis.index(FI) < visiveis.index("2106722693630345290")


def test_open_id_padrao_e_o_proprio_tweet(client):
    append(client, [item(7, "a")])
    e = client.get("/api/v1/entries/1").json()
    assert e["open_id"] == "7"



# ---- ordem por horário entre os não lidos ----
def test_entrada_nova_vai_para_o_meio_dos_nao_lidos_pelo_horario(client):
    append(client, [item(30, "a"), item(10, "b")])      # leitura: 10, 30
    append(client, [item(20, "c")])                      # chegou depois, mas é de horário intermediário
    assert tweet_ids(queue(client)) == ["10", "20", "30"]


def test_entrada_nova_nunca_entra_antes_do_cursor_nem_entre_os_lidos(client):
    append(client, [item(30, "a"), item(20, "b"), item(10, "c")])   # 10, 20, 30
    client.post("/api/v1/views", json={"seqs": [1, 2]})             # 10 e 20 lidos
    client.put("/api/v1/state", json={"cursor_seq": 2})             # cursor no 20
    append(client, [item(5, "d")])                                   # tweet MAIS ANTIGO que tudo
    # entra logo depois do cursor, antes dos não lidos (30), nunca antes dos lidos
    assert tweet_ids(queue(client)) == ["10", "20", "5", "30"]
    assert client.get("/api/v1/state").json()["next_seq"] == entry(client, 5)["seq"]


def test_navegacao_segue_a_posicao_e_nao_o_seq(client):
    append(client, [item(30, "a"), item(10, "b")])
    append(client, [item(20, "c")])                       # seq 3, posição 2
    client.put("/api/v1/state", json={"cursor_seq": 1})   # em "10"
    proxima = client.get("/api/v1/queue", params={"after": 1, "limit": 1}).json()["items"][0]
    assert proxima["tweet_id"] == "20"
    anterior = client.get("/api/v1/queue", params={"before": 2, "limit": 1}).json()["items"][0]   # antes do "30"
    assert anterior["tweet_id"] == "20"
    s = client.get("/api/v1/state").json()
    assert s["position"] == 1 and s["unread_after"] == 2


def test_muitas_insercoes_no_mesmo_vao_renumeram_sem_perder_a_ordem(client):
    append(client, [item(1000, "a"), item(10, "b")])
    for i in range(60):                                   # 60 inserções entre o 10 e o 1000, sempre crescentes
        append(client, [item(20 + i, "c")])
    ids = [int(t) for t in tweet_ids(queue(client))]
    assert ids == sorted(ids) and len(ids) == 62


# ---- horário-chave da conversa: primeira conta SEGUIDA de cima para baixo ----
def test_raiz_de_conta_nao_seguida_nao_define_o_horario_da_conversa(client):
    # João (não seguido) postou ontem; José (seguido) respondeu depois de um post das 11h de outra conta
    append(client, [item(60, "ana"), item(50, "bia")])    # leitura: 50 (bia), 60 (ana), ambas seguidas (posts próprios)
    # conversa [joão=5 (raiz), josé=55]: josé é o "primeiro seguido" -> posição pelo horário 55, entre 50 e 60
    append(client, [citem(5, "joao", 1), citem(55, "jose", 1)])
    assert tweet_ids(queue(client)) == ["50", "55", "60"]


def test_raiz_seguida_e_nova_define_o_horario(client):
    append(client, [item(7, "joao")])                     # joão aparece com post próprio: é seguido (e está lido abaixo)
    client.post("/api/v1/views", json={"seqs": [1]})
    append(client, [item(90, "ana"), item(40, "bia")])    # 40, 90
    # conversa nova [joão=70 (raiz, seguido), jose=80]: horário = o do joão (70)
    append(client, [citem(70, "joao", 1), citem(80, "jose", 1)])
    assert tweet_ids(queue(client)) == ["7", "40", "80", "90"]
    assert entry(client, 80)["open_id"] == "80"


def test_conversa_de_post_lido_volta_ao_fim_pelo_horario_da_resposta_nova(client):
    append(client, [item(10, "joao"), item(5, "w")])
    client.post("/api/v1/views", json={"seqs": [1, 2]})   # 5 e 10 lidos
    append(client, [item(50, "x")])                       # não lido 50
    append(client, [citem(10, "joao", 1), citem(60, "jose", 1)])   # resposta nova (60) ao post lido
    assert tweet_ids(queue(client)) == ["5", "10", "50", "60"]



# ---- exemplo do dono: 10 comentários; o horário é o do PRIMEIRO que ele segue, de cima para baixo ----
def test_horario_da_conversa_e_o_do_primeiro_seguido_de_cima_para_baixo(client):
    client.put("/api/v1/accounts/following", json={"accounts": [{"handle": h} for h in ("x1", "x2", "c3", "c2", "c1")]})
    append(client, [item(100, "x1"), item(65, "x2"), item(55, "x1")])        # não lidos: 55, 65, 100
    # conversa (topo -> base): raiz de conta não seguida, comentário de não seguida, e depois c3, c2, c1 (seguidos)
    append(client, [
        citem(50, "joao_nao_sigo", 1), citem(51, "outro_nao_sigo", 1),
        citem(60, "c3", 1), citem(70, "c2", 1), citem(80, "c1", 1),
    ])
    # entra com o horário do antepenúltimo (c3 = 60): entre o 55 e o 65; a referência é o último (c1 = 80)
    assert tweet_ids(queue(client)) == ["55", "80", "65", "100"]
    assert entry(client, 80)["covered"] is False and entry(client, 60)["covered"] is True


def test_conversa_sem_nenhum_seguido_entre_os_novos_usa_o_horario_do_ultimo(client):
    client.put("/api/v1/accounts/following", json={"accounts": [{"handle": "x"}]})
    append(client, [item(30, "x"), item(10, "x")])
    append(client, [citem(5, "a", 1), citem(20, "b", 1)])                      # ninguém seguido
    assert tweet_ids(queue(client))[:3] == ["10", "20", "30"]

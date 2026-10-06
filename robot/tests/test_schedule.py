import random
from datetime import datetime, timedelta

from app import schedule
from app.schedule import TZ, next_run


def at(h, m=0, day=6):
    return datetime(2026, 10, day, h, m, tzinfo=TZ)


def test_intervalo_entre_30_e_45_minutos():
    rng = random.Random(1)
    last = at(10, 0)
    vistos = set()
    for _ in range(200):
        n = next_run(last, last, rng)
        mins = (n - last).total_seconds() / 60
        assert 30 <= mins <= 45
        vistos.add(round(mins))
    assert len(vistos) > 8  # varia de verdade a cada execução


def test_primeira_execucao_e_agora():
    now = at(10, 0)
    assert next_run(None, now) == now


def test_depois_de_1h_roda_uma_unica_vez_e_para_ate_4h45():
    rng = random.Random(2)
    last = at(0, 40)                      # última antes da madrugada
    n1 = next_run(last, last, rng)        # 01:10..01:25 -> cai na madrugada: roda (a única)
    assert at(1) <= n1 < at(4, 45)
    n2 = next_run(n1, n1, rng)            # já rodou na madrugada: só às 04:45
    assert n2 == at(4, 45)
    n3 = next_run(n2, n2, rng)            # volta ao ritmo normal
    assert n2 + timedelta(minutes=30) <= n3 <= n2 + timedelta(minutes=45)


def test_ultima_as_00_59_proxima_cai_na_madrugada_e_roda_uma_vez():
    last = at(0, 59)
    n = next_run(last, last, random.Random(3))
    assert at(1, 29) <= n <= at(1, 44)


def test_ultima_cedo_demais_nao_pula_a_unica_execucao():
    last = at(23, 50, day=5)
    n = next_run(last, last, random.Random(4))      # 00:20..00:35, antes da 01:00: normal
    assert not schedule.in_night(n)
    n = at(0, 50)                                   # e a seguinte, depois de 01:00, é a única da madrugada
    n2 = next_run(n, n, random.Random(5))
    assert at(1, 20) <= n2 <= at(1, 35)


def test_reinicio_na_madrugada_depois_de_ja_ter_rodado_espera_4h45():
    last = at(1, 20)
    now = at(3, 0)                                     # contêiner reiniciou às 03:00
    assert next_run(last, now, random.Random(6)) == at(4, 45)


def test_reinicio_na_madrugada_sem_rodada_na_madrugada_roda_agora():
    last = at(23, 0, day=5)
    now = at(3, 0)
    assert next_run(last, now, random.Random(7)) == now


def test_horario_perdido_nao_e_recuperado_em_rajada():
    last = at(10, 0)
    now = at(12, 0)
    assert next_run(last, now, random.Random(8)) == now


def test_fuso_de_sao_paulo_independe_do_fuso_do_servidor():
    from datetime import timezone
    last = datetime(2026, 10, 6, 3, 40, tzinfo=timezone.utc)     # 00:40 em São Paulo (UTC-3)
    n = next_run(last, last, random.Random(9))
    assert schedule.in_night(n)
    assert next_run(n, n, random.Random(9)) == at(4, 45)


def test_primeira_busca_depois_das_4h45_e_profunda():
    rng = random.Random(10)
    night = at(1, 20)
    when = next_run(night, night, rng)
    assert when == at(4, 45)
    assert schedule.is_deep(night, when) is True
    nxt = next_run(when, when, rng)
    assert schedule.is_deep(when, nxt) is False          # as seguintes são normais
    assert schedule.is_deep(None, at(10, 0)) is False    # sem histórico não é profunda


def test_busca_normal_do_dia_nunca_e_profunda():
    last, when = at(10, 0), at(10, 40)
    assert schedule.is_deep(last, when) is False
    assert schedule.is_deep(at(23, 0, day=5), at(0, 30)) is False          # antes das 04:45 do dia
    assert schedule.is_deep(at(0, 50), at(1, 30)) is False                 # a única da madrugada é normal


def test_depois_de_reinicio_a_primeira_apos_4h45_tambem_e_profunda():
    last = at(1, 20)
    now = at(7, 0)                                                         # contêiner ficou parado até as 07:00
    when = next_run(last, now, random.Random(11))
    assert when == now and schedule.is_deep(last, when) is True


def test_primeira_busca_depois_das_12h30_e_profunda_e_a_seguinte_nao():
    last = at(11, 55)
    when = next_run(last, last, random.Random(12))            # 12:25..12:40
    if when < at(12, 30):
        last, when = when, next_run(when, when, random.Random(13))
    assert when >= at(12, 30) and schedule.is_deep(last, when) is True
    seguinte = next_run(when, when, random.Random(14))
    assert schedule.is_deep(when, seguinte) is False


def test_plan_sorteia_junto_e_informa_se_e_profunda():
    last = at(12, 10)
    when, deep = schedule.plan(last, last, random.Random(15))
    assert 30 <= (when - last).total_seconds() / 60 <= 45
    assert deep == schedule.is_deep(last, when)
    assert schedule.plan(at(12, 31), at(12, 31), random.Random(16))[1] is False   # já passou das 12:30 nessa rodada

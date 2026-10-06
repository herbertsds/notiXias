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


def test_depois_de_1h_roda_uma_unica_vez_e_para_ate_5h20():
    rng = random.Random(2)
    last = at(0, 40)                      # última antes da madrugada
    n1 = next_run(last, last, rng)        # 01:10..01:25 -> cai na madrugada: roda (a única)
    assert at(1) <= n1 < at(5, 20)
    n2 = next_run(n1, n1, rng)            # já rodou na madrugada: só às 05:20
    assert n2 == at(5, 20)
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


def test_reinicio_na_madrugada_depois_de_ja_ter_rodado_espera_5h20():
    last = at(1, 20)
    now = at(3, 0)                                     # contêiner reiniciou às 03:00
    assert next_run(last, now, random.Random(6)) == at(5, 20)


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
    assert next_run(n, n, random.Random(9)) == at(5, 20)

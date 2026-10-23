"""O laço principal com o navegador, a API e o relógio simulados: roda, registra, pausa em falha de sessão e retoma,
atende pedidos de busca, adota horário antecipado e faz a verificação diária dos perfis."""
import asyncio
import json
import os
from datetime import datetime, timedelta, timezone

import pytest

from app import main as robot_main
from app import runner

REAL_SLEEP = asyncio.sleep
published = []   # (quando, modo, estado) informados à API
run_kwargs = []  # argumentos de cada execução simulada
world = {}       # o que a "API" responde: policy, next, requests


@pytest.fixture
def env(tmp_path, monkeypatch):
    bundle = tmp_path / "b.js"
    bundle.write_text("//", encoding="utf-8")
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("BUNDLE_PATH", str(bundle))
    monkeypatch.setenv("API_KEY", "k")
    (tmp_path / "data").mkdir()
    monkeypatch.setattr(robot_main, "PROFILES_ENABLED", True)   # os testes de perfis ligam; um teste próprio cobre o desligado
    return tmp_path / "data"


async def _run_for(seconds):
    task = asyncio.create_task(robot_main.main())
    await REAL_SLEEP(seconds)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


def now():
    return datetime.now(timezone.utc)


def _patch(monkeypatch, results, *, normal_at=None, profiles_at=None):
    """`normal_at`/`profiles_at`: função que devolve o horário (padrão: a normal é já; os perfis só amanhã)."""
    calls = []

    async def fake_run(**kw):
        calls.append(1)
        run_kwargs.append(kw)
        await real_sleep(0.01)  # o navegador de verdade leva tempo; sem isto o laço nunca cederia ao relógio
        return runner.RunResult(results[min(len(calls) - 1, len(results) - 1)])

    real_sleep = asyncio.sleep
    published.clear()
    run_kwargs.clear()
    world.clear()
    world.update(policy=None, next=None, requests=[], intervals=[], session=None, running=[], purges=[])

    async def fake_publish(api_base, key, when, mode, state, unread=None):
        published.append((when, mode, state))

    async def fake_policy(api_base, key):
        return world["policy"]

    async def fake_next(api_base, key):
        return world["next"]

    async def fake_take(api_base, key):
        if not world["requests"]:
            return None
        r = world["requests"].pop(0)
        return {"pending": True, **r} if isinstance(r, dict) else {"pending": True, "reason": r}

    async def fake_running(api_base, key, running, kind, trigger=None, result=None):
        world["running"].append((running, kind, result and result.get("ok")))

    async def fake_purge(api_base, key, days=7):
        world["purges"].append(days)
        return {"deleted": 3}

    async def fake_session(api_base, key):
        got, world["session"] = world["session"], None
        return {"pending": True, **got} if got else None

    def fake_next_run(last, nw, rng, interval=None):
        world["intervals"].append(interval)
        return normal_at() if normal_at else nw

    monkeypatch.setattr(robot_main.notify, "publish_next", fake_publish)
    monkeypatch.setattr(robot_main.notify, "fetch_policy", fake_policy)
    monkeypatch.setattr(robot_main.notify, "fetch_next", fake_next)
    monkeypatch.setattr(robot_main.notify, "take_request", fake_take)
    monkeypatch.setattr(robot_main.notify, "take_session", fake_session)
    monkeypatch.setattr(robot_main.notify, "publish_running", fake_running)
    monkeypatch.setattr(robot_main.notify, "purge_old", fake_purge)
    monkeypatch.setattr(runner, "run_once", fake_run)
    monkeypatch.setattr(robot_main.schedule, "next_run", fake_next_run)
    monkeypatch.setattr(robot_main.schedule, "next_profiles",
                        lambda last, nw, rng, current=None: profiles_at() if profiles_at else nw + timedelta(days=1))
    monkeypatch.setattr(robot_main.asyncio, "sleep", lambda s: real_sleep(min(s, 0.02)))
    return calls


def _status(env):
    return json.loads((env / "status.json").read_text())


def test_sem_sessao_nao_roda_e_avisa(env, monkeypatch):
    calls = _patch(monkeypatch, [{"ok": True}])
    asyncio.run(_run_for(0.3))
    assert calls == []
    assert _status(env)["waiting_session"] is True
    assert published and published[-1][2] == "waiting_session" and published[-1][0] is None


def test_roda_e_registra_sucesso(env, monkeypatch):
    (env / "x_state.json").write_text("{}")
    calls = _patch(monkeypatch, [{"ok": True, "created": 3}])
    asyncio.run(_run_for(0.3))
    assert len(calls) >= 2
    st = _status(env)
    assert st["consecutive_failures"] == 0 and st["last_result"]["created"] == 3 and st["last_ok_at"]
    assert run_kwargs[0]["start_url"] == runner.HOME_URL and run_kwargs[0]["timeout_s"] == runner.NORMAL_TIMEOUT_S


def test_sessao_expirada_pausa_e_retoma_com_sessao_nova(env, monkeypatch):
    (env / "x_state.json").write_text("{}")
    calls = _patch(monkeypatch, [{"ok": False, "error": "login", "login": True}, {"ok": True}])

    async def scenario():
        task = asyncio.create_task(robot_main.main())
        await REAL_SLEEP(0.3)
        assert len(calls) == 1                          # tentou uma vez e parou
        st = _status(env)
        assert st["paused"] is True and st["consecutive_failures"] >= 3
        p = env / "x_state.json"
        os.utime(p, (p.stat().st_atime, p.stat().st_mtime + 10))   # "sessão nova" enviada
        await REAL_SLEEP(0.4)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    asyncio.run(scenario())
    assert len(calls) >= 2
    assert _status(env)["paused"] is False


def test_tres_falhas_seguidas_pausam_e_informam_a_api(env, monkeypatch):
    (env / "x_state.json").write_text("{}")
    calls = _patch(monkeypatch, [{"ok": False, "error": "x"}])
    asyncio.run(_run_for(0.4))
    assert len(calls) == robot_main.MAX_FAILURES
    assert _status(env)["paused"] is True
    states = [p[2] for p in published]
    assert "scheduled" in states and states[-1] == "paused"


def test_sorteio_e_guardado_e_reaproveitado_apos_reinicio(env, monkeypatch):
    (env / "x_state.json").write_text("{}")
    calls = _patch(monkeypatch, [{"ok": True}])
    futuro = now() + timedelta(hours=2)
    last = now() - timedelta(minutes=10)
    (env / "status.json").write_text(json.dumps({
        "last_run_at": last.isoformat(),
        "plan": {"base": last.isoformat(), "when": futuro.isoformat(), "deep": True},
    }))
    asyncio.run(_run_for(0.3))
    assert world["intervals"] == [] and calls == []                 # não sorteou de novo nem rodou antes da hora
    assert published[0][0] == futuro and published[0][1] == "deep"  # informou o horário (e o tipo) já guardado


def test_faixa_de_intervalo_vem_das_nao_lidas(env, monkeypatch):
    (env / "x_state.json").write_text("{}")
    _patch(monkeypatch, [{"ok": True}])
    world["policy"] = {"unread": 120, "tier": "high", "min_minutes": 45, "max_minutes": 60}
    asyncio.run(_run_for(0.2))
    assert world["intervals"][0] == (45, 60)
    assert _status(env)["plan"]["unread"] == 120


def test_sem_resposta_da_api_usa_a_faixa_padrao(env, monkeypatch):
    (env / "x_state.json").write_text("{}")
    _patch(monkeypatch, [{"ok": True}])
    asyncio.run(_run_for(0.2))
    assert world["intervals"][0] is None                            # o schedule aplica 10 a 25


def test_pedido_de_busca_imediata_roda_na_hora_com_o_motivo(env, monkeypatch):
    (env / "x_state.json").write_text("{}")
    calls = _patch(monkeypatch, [{"ok": True}], normal_at=lambda: now() + timedelta(hours=1))
    world["requests"] = ["restam 29 não lidas (abaixo de 30)"]
    asyncio.run(_run_for(0.4))
    assert len(calls) == 1                                          # a busca normal só seria daqui a 1 h
    assert run_kwargs[0]["why"] == "restam 29 não lidas (abaixo de 30)"
    assert run_kwargs[0]["start_url"] == runner.HOME_URL
    assert _status(env)["last_trigger"].startswith("restam 29")


def test_horario_antecipado_pela_api_e_adotado(env, monkeypatch):
    (env / "x_state.json").write_text("{}")
    calls = _patch(monkeypatch, [{"ok": True}], normal_at=lambda: now() + timedelta(hours=1))
    world["next"] = {"state": "scheduled", "mode": "normal", "at": (now() + timedelta(seconds=0.1)).isoformat()}
    asyncio.run(_run_for(0.4))
    assert len(calls) >= 1                                          # foi antes da 1 h sorteada


def test_horario_antecipado_ignora_a_verificacao_de_perfis_e_a_parada_da_madrugada(env, monkeypatch):
    (env / "x_state.json").write_text("{}")
    calls = _patch(monkeypatch, [{"ok": True}], normal_at=lambda: now() + timedelta(hours=1))
    world["next"] = {"state": "scheduled", "mode": "profiles", "at": (now() + timedelta(seconds=0.1)).isoformat()}
    asyncio.run(_run_for(0.3))
    assert calls == []
    monkeypatch.setattr(robot_main.schedule, "allowed", lambda last, when: False)       # cairia na parada da madrugada
    world["next"] = {"state": "scheduled", "mode": "normal", "at": (now() + timedelta(seconds=0.1)).isoformat()}
    asyncio.run(_run_for(0.3))
    assert calls == []


def test_verificacao_de_perfis_usa_a_url_propria_e_nao_mexe_na_base_da_busca_normal(env, monkeypatch):
    (env / "x_state.json").write_text("{}")
    antes = now() - timedelta(minutes=5)
    (env / "status.json").write_text(json.dumps({"last_run_at": antes.isoformat(), "last_following_at": now().isoformat()}))
    ja = iter([True])
    calls = _patch(monkeypatch, [{"ok": True}], normal_at=lambda: now() + timedelta(hours=1),
                   profiles_at=lambda: now() if next(ja, False) else now() + timedelta(days=1))
    asyncio.run(_run_for(0.4))
    assert len(calls) == 1
    assert run_kwargs[0]["start_url"] == runner.PROFILES_URL and run_kwargs[0]["timeout_s"] == runner.PROFILES_TIMEOUT_S
    st = _status(env)
    assert st["last_mode"] == "profiles" and st["last_profiles_at"]
    assert st["last_run_at"] == antes.isoformat()                   # a base da busca normal não andou
    assert published[0][1] == "profiles"


def test_busca_profunda_do_feed_tem_url_e_prazo_proprios(env, monkeypatch):
    (env / "x_state.json").write_text("{}")
    calls = _patch(monkeypatch, [{"ok": True}])
    seq = iter([True, False])
    monkeypatch.setattr(robot_main.schedule, "is_deep", lambda last, when: next(seq, False))
    asyncio.run(_run_for(0.3))
    assert run_kwargs[0]["start_url"] == runner.DEEP_URL and run_kwargs[0]["timeout_s"] == runner.DEEP_TIMEOUT_S
    assert run_kwargs[1]["start_url"] == runner.HOME_URL and run_kwargs[1]["timeout_s"] == runner.NORMAL_TIMEOUT_S
    assert runner.PROFILES_TIMEOUT_S > runner.DEEP_TIMEOUT_S > runner.NORMAL_TIMEOUT_S


def test_sessao_enviada_pelo_navegador_tira_o_robo_da_pausa_e_grava_o_arquivo(env, monkeypatch):
    (env / "x_state.json").write_text("{}")
    calls = _patch(monkeypatch, [{"ok": False, "error": "login", "login": True}, {"ok": True}])

    async def scenario():
        task = asyncio.create_task(robot_main.main())
        await REAL_SLEEP(0.3)
        assert len(calls) == 1 and _status(env)["paused"] is True        # sessão expirada: pausou
        world["session"] = {"auth_token": "a" * 40, "ct0": "b" * 40}      # o dono clicou no botão do menu
        await REAL_SLEEP(0.4)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    asyncio.run(scenario())
    assert len(calls) >= 2 and _status(env)["paused"] is False            # voltou a rodar sozinho
    state = json.loads((env / "x_state.json").read_text())
    names = {c["name"]: c for c in state["cookies"]}
    assert names["auth_token"]["value"] == "a" * 40 and names["auth_token"]["httpOnly"] is True
    assert names["ct0"]["value"] == "b" * 40 and names["ct0"]["domain"] == ".x.com"
    assert oct((env / "x_state.json").stat().st_mode & 0o777) == "0o600"


def test_sem_sessao_o_robo_comeca_quando_o_navegador_envia(env, monkeypatch):
    calls = _patch(monkeypatch, [{"ok": True}])

    async def scenario():
        task = asyncio.create_task(robot_main.main())
        await REAL_SLEEP(0.2)
        assert calls == [] and _status(env)["waiting_session"] is True
        world["session"] = {"auth_token": "c" * 40, "ct0": "d" * 40}
        await REAL_SLEEP(0.4)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    asyncio.run(scenario())
    assert len(calls) >= 1 and (env / "x_state.json").exists()


def test_sessao_incompleta_da_api_e_ignorada(env, monkeypatch):
    _patch(monkeypatch, [{"ok": True}])
    world["session"] = {"auth_token": "curto", "ct0": "x"}
    asyncio.run(_run_for(0.2))
    assert not (env / "x_state.json").exists()


def test_reiniciar_o_conteiner_retoma_mesmo_com_pausa_gravada(env, monkeypatch):
    (env / "x_state.json").write_text("{}")
    (env / "status.json").write_text(json.dumps({"paused": True, "consecutive_failures": 3, "paused_reason": "failures",
                                                  "last_error": "travou: sem progresso por 5 min"}))
    calls = _patch(monkeypatch, [{"ok": True}])
    asyncio.run(_run_for(0.3))
    assert len(calls) >= 1 and _status(env)["paused"] is False


def test_pausa_por_falhas_tenta_sozinha_de_novo_e_a_de_login_nao(env, monkeypatch):
    (env / "x_state.json").write_text("{}")
    calls = _patch(monkeypatch, [{"ok": False, "error": "travou"}] * 3 + [{"ok": True}])
    monkeypatch.setattr(robot_main, "RETRY_AFTER_S", 0.3)
    asyncio.run(_run_for(1.0))
    st = _status(env)
    assert len(calls) >= 4 and st["paused"] is False and st["consecutive_failures"] == 0     # voltou e deu certo
    # já a pausa por LOGIN não tenta sozinha
    calls = _patch(monkeypatch, [{"ok": False, "error": "login", "login": True}, {"ok": True}])
    monkeypatch.setattr(robot_main, "RETRY_AFTER_S", 0.1)
    (env / "status.json").write_text("{}")
    asyncio.run(_run_for(0.8))
    st = _status(env)
    assert len(calls) == 1 and st["paused"] is True and st["paused_reason"] == "login" and st["retry_at"] is None


def test_nova_tentativa_depois_da_pausa_que_falha_de_novo_pausa_de_novo(env, monkeypatch):
    (env / "x_state.json").write_text("{}")
    calls = _patch(monkeypatch, [{"ok": False, "error": "travou"}])
    monkeypatch.setattr(robot_main, "RETRY_AFTER_S", 0.25)
    asyncio.run(_run_for(0.45))                                        # 3 falhas, pausa, UMA tentativa aos 0,25 s, pausa de novo
    st = _status(env)
    assert len(calls) == 4 and st["paused"] is True and st["paused_reason"] == "failures"


def test_busca_pedida_pelo_celular_ignora_o_intervalo_minimo_usa_o_modo_e_publica_o_estado(env, monkeypatch):
    (env / "x_state.json").write_text("{}")
    calls = _patch(monkeypatch, [{"ok": True, "created": 2}], normal_at=lambda: now() + timedelta(hours=1))
    world["requests"] = [{"reason": "busca pedida pelo celular", "manual": True, "mode": "deep"}]
    asyncio.run(_run_for(0.4))
    assert len(calls) == 1
    assert run_kwargs[0]["start_url"] == runner.DEEP_URL and run_kwargs[0]["timeout_s"] == runner.DEEP_TIMEOUT_S
    assert world["running"][0] == (False, None, None)                       # ao iniciar, limpa o "rodando" de uma queda
    assert (True, "deep", None) in world["running"] and (False, "deep", True) in world["running"]
    assert _status(env)["last_mode"] == "deep"


def test_busca_manual_logo_apos_outra_nao_espera_os_tres_minutos(env, monkeypatch):
    (env / "x_state.json").write_text("{}")
    calls = _patch(monkeypatch, [{"ok": True}])                              # a normal roda já; depois vem o pedido manual
    monkeypatch.setattr(robot_main, "MIN_GAP_S", 3600)                       # um pedido AUTOMÁTICO esperaria 1 h
    world["requests"] = []

    async def scenario():
        task = asyncio.create_task(robot_main.main())
        await REAL_SLEEP(0.2)
        n = len(calls)
        world["requests"].append({"reason": "manual", "manual": True, "mode": "normal"})
        await REAL_SLEEP(0.3)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        return n
    n = asyncio.run(scenario())
    assert len(calls) > n


def test_limpeza_diaria_roda_uma_vez_por_data_depois_das_6h(env, monkeypatch):
    (env / "x_state.json").write_text("{}")
    _patch(monkeypatch, [{"ok": True}], normal_at=lambda: now() + timedelta(hours=1))
    manha = datetime(2026, 10, 18, 9, 0, tzinfo=robot_main.schedule.TZ)
    class Rel(datetime):
        @classmethod
        def now(cls, tz=None):
            return manha.astimezone(tz) if tz else manha
    monkeypatch.setattr(robot_main, "datetime", Rel)
    asyncio.run(_run_for(0.4))
    assert world["purges"] == [7]
    assert _status(env)["last_purge_date"] == "2026-10-18"


def test_limpeza_diaria_nao_roda_antes_das_6h(env, monkeypatch):
    (env / "x_state.json").write_text("{}")
    _patch(monkeypatch, [{"ok": True}], normal_at=lambda: now() + timedelta(hours=1))
    cedo = datetime(2026, 10, 18, 4, 0, tzinfo=robot_main.schedule.TZ)
    class Rel(datetime):
        @classmethod
        def now(cls, tz=None):
            return cedo.astimezone(tz) if tz else cedo
    monkeypatch.setattr(robot_main, "datetime", Rel)
    asyncio.run(_run_for(0.3))
    assert world["purges"] == []


def test_antes_dos_perfis_relê_a_lista_de_quem_voce_segue(env, monkeypatch):
    (env / "x_state.json").write_text("{}")
    calls = _patch(monkeypatch, [{"ok": True}], normal_at=lambda: now() + timedelta(hours=3), profiles_at=lambda: now())
    asyncio.run(_run_for(0.5))
    urls = [k["start_url"] for k in run_kwargs]
    assert urls[:2] == [runner.FOLLOWING_URL, runner.PROFILES_URL]               # lista primeiro, perfis logo depois
    assert (True, "following", None) in world["running"] and (True, "profiles", None) in world["running"]
    assert _status(env)["last_following_at"]


def test_lista_ja_relida_na_noite_nao_e_relida_de_novo_antes_dos_perfis(env, monkeypatch):
    (env / "x_state.json").write_text("{}")
    (env / "status.json").write_text(json.dumps({"last_following_at": now().isoformat()}))
    _patch(monkeypatch, [{"ok": True}], normal_at=lambda: now() + timedelta(hours=3), profiles_at=lambda: now())
    asyncio.run(_run_for(0.3))
    assert runner.FOLLOWING_URL not in [k["start_url"] for k in run_kwargs]
    assert run_kwargs[0]["start_url"] == runner.PROFILES_URL


def test_depois_da_busca_da_madrugada_relê_a_lista(env, monkeypatch):
    (env / "x_state.json").write_text("{}")
    _patch(monkeypatch, [{"ok": True}])
    madrugada = datetime(2026, 10, 19, 2, 0, tzinfo=robot_main.schedule.TZ).astimezone(timezone.utc)
    class Rel(datetime):
        @classmethod
        def now(cls, tz=None):
            return madrugada.astimezone(tz) if tz else madrugada
    monkeypatch.setattr(robot_main, "datetime", Rel)
    monkeypatch.setattr(robot_main.schedule, "in_night", lambda t: True)
    monkeypatch.setattr(robot_main.schedule, "following_fresh", lambda last, nw: last is not None)
    asyncio.run(_run_for(0.4))
    urls = [k["start_url"] for k in run_kwargs]
    assert urls[0] == runner.HOME_URL and runner.FOLLOWING_URL in urls[1:3]


def test_falha_na_releitura_nao_pausa_e_segue_para_os_perfis(env, monkeypatch):
    (env / "x_state.json").write_text("{}")
    n = []

    async def fake_run(**kw):
        run_kwargs.append(kw)
        n.append(1)
        return runner.RunResult(ok=kw["start_url"] != runner.FOLLOWING_URL, error="x")
    _patch(monkeypatch, [{"ok": True}], normal_at=lambda: now() + timedelta(hours=3), profiles_at=lambda: now())
    monkeypatch.setattr(runner, "run_once", fake_run)
    asyncio.run(_run_for(0.4))
    urls = [k["start_url"] for k in run_kwargs]
    assert urls[:2] == [runner.FOLLOWING_URL, runner.PROFILES_URL]
    assert _status(env)["paused"] is False


def test_falha_que_o_script_nao_registrou_vai_para_o_historico(env, monkeypatch):
    (env / "x_state.json").write_text("{}")
    got = []

    async def fake_report(api_base, key, kind, error, trigger=None):
        got.append((kind, error))
    _patch(monkeypatch, [{"ok": False, "error": "travou: sem progresso por 5 min", "stalled": True, "skipped_stalled": 4}])
    monkeypatch.setattr(robot_main.notify, "report_failure", fake_report)
    asyncio.run(_run_for(0.2))
    assert got and got[0][0] == "normal" and "travou" in got[0][1] and "4 perfis pulados" in got[0][1]


def test_verificacao_de_perfis_desligada_nunca_agenda_nem_roda(env, monkeypatch):
    (env / "x_state.json").write_text("{}")
    monkeypatch.setattr(robot_main, "PROFILES_ENABLED", False)
    _patch(monkeypatch, [{"ok": True}], profiles_at=lambda: now())          # o horário dos perfis seria "já"
    asyncio.run(_run_for(0.3))
    urls = [k["start_url"] for k in run_kwargs]
    assert urls and runner.PROFILES_URL not in urls and runner.FOLLOWING_URL not in urls[:1]
    assert _status(env)["profiles_target"] is None

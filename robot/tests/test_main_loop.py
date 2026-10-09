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
    world.update(policy=None, next=None, requests=[], intervals=[])

    async def fake_publish(api_base, key, when, mode, state, unread=None):
        published.append((when, mode, state))

    async def fake_policy(api_base, key):
        return world["policy"]

    async def fake_next(api_base, key):
        return world["next"]

    async def fake_take(api_base, key):
        return {"pending": True, "reason": world["requests"].pop(0)} if world["requests"] else None

    def fake_next_run(last, nw, rng, interval=None):
        world["intervals"].append(interval)
        return normal_at() if normal_at else nw

    monkeypatch.setattr(robot_main.notify, "publish_next", fake_publish)
    monkeypatch.setattr(robot_main.notify, "fetch_policy", fake_policy)
    monkeypatch.setattr(robot_main.notify, "fetch_next", fake_next)
    monkeypatch.setattr(robot_main.notify, "take_request", fake_take)
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
    (env / "status.json").write_text(json.dumps({"last_run_at": antes.isoformat()}))
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

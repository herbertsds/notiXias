"""O laço principal com o navegador e o relógio simulados: roda, registra, pausa em falha de sessão e retoma."""
import asyncio
import json
import os
from datetime import datetime, timezone

import pytest

from app import main as robot_main
from app import runner


REAL_SLEEP = asyncio.sleep


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


def _patch(monkeypatch, results):
    calls = []

    async def fake_run(**kw):
        calls.append(1)
        await real_sleep(0.01)  # o navegador de verdade leva tempo; sem isto o laço nunca cederia ao relógio
        return runner.RunResult(results[min(len(calls) - 1, len(results) - 1)])

    real_sleep = asyncio.sleep
    monkeypatch.setattr(runner, "run_once", fake_run)
    monkeypatch.setattr(robot_main.schedule, "next_run", lambda last, now, rng: now)
    monkeypatch.setattr(robot_main.asyncio, "sleep", lambda s: real_sleep(min(s, 0.02)))
    return calls


def test_sem_sessao_nao_roda_e_avisa(env, monkeypatch):
    calls = _patch(monkeypatch, [{"ok": True}])
    asyncio.run(_run_for(0.3))
    assert calls == []
    assert json.loads((env / "status.json").read_text())["waiting_session"] is True


def test_roda_e_registra_sucesso(env, monkeypatch):
    (env / "x_state.json").write_text("{}")
    calls = _patch(monkeypatch, [{"ok": True, "created": 3}])
    asyncio.run(_run_for(0.3))
    assert len(calls) >= 2
    st = json.loads((env / "status.json").read_text())
    assert st["consecutive_failures"] == 0 and st["last_result"]["created"] == 3 and st["last_ok_at"]


def test_sessao_expirada_pausa_e_retoma_com_sessao_nova(env, monkeypatch):
    (env / "x_state.json").write_text("{}")
    calls = _patch(monkeypatch, [{"ok": False, "error": "login", "login": True}, {"ok": True}])
    # a pausa checa o arquivo a cada 60 s no código real; aqui o sleep é encurtado
    async def scenario():
        task = asyncio.create_task(robot_main.main())
        await REAL_SLEEP(0.3)
        assert len(calls) == 1                          # tentou uma vez e parou
        st = json.loads((env / "status.json").read_text())
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
    assert json.loads((env / "status.json").read_text())["paused"] is False


def test_tres_falhas_seguidas_pausam(env, monkeypatch):
    (env / "x_state.json").write_text("{}")
    calls = _patch(monkeypatch, [{"ok": False, "error": "x"}])
    asyncio.run(_run_for(0.4))
    assert len(calls) == robot_main.MAX_FAILURES
    assert json.loads((env / "status.json").read_text())["paused"] is True

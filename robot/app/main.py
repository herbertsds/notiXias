"""Laço principal do robô: decide quando buscar (schedule.py), executa (runner.py) e guarda o estado."""
import asyncio
import json
import logging
import os
import random
import sys
from datetime import datetime, timezone
from pathlib import Path

from . import notify, runner, schedule

log = logging.getLogger("robot")
MAX_FAILURES = 3  # falhas seguidas antes de parar de insistir (protege a conta)


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return default


def save_json(path: Path, data) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def read_api_key() -> str:
    path = os.environ.get("API_KEY_FILE")
    if path:
        return Path(path).read_text(encoding="utf-8").strip()
    return os.environ["API_KEY"].strip()


async def sleep_until(when: datetime) -> None:
    while True:
        left = (when - datetime.now(timezone.utc)).total_seconds()
        if left <= 0:
            return
        await asyncio.sleep(min(left, 30))


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stdout)
    data = Path(os.environ.get("DATA_DIR", "/data"))
    data.mkdir(parents=True, exist_ok=True)
    state_path = data / "x_state.json"      # sessão do X (cookies); gerada por scripts/robot_login.sh no seu computador
    status_path = data / "status.json"
    api_base = os.environ.get("API_BASE_URL", "http://api:8000")
    bundle = Path(os.environ.get("BUNDLE_PATH", "/robot/notixias.user.js")).read_text(encoding="utf-8")

    status = load_json(status_path, {})
    last_run = datetime.fromisoformat(status["last_run_at"]) if status.get("last_run_at") else None
    failures = int(status.get("consecutive_failures", 0))
    paused_at_mtime = None
    log.info("robô iniciado (última busca: %s, falhas seguidas: %s)", last_run, failures)

    while True:
        if failures >= MAX_FAILURES or status.get("paused"):
            # Parado de propósito: só volta quando você enviar uma sessão nova (x_state.json mudar) ou reiniciar.
            mtime = state_path.stat().st_mtime if state_path.exists() else 0
            if paused_at_mtime is None:
                paused_at_mtime = mtime
                status.update(paused=True, next_run_at=None)
                save_json(status_path, status)
                log.error("PAUSADO após %s falhas seguidas (%s). Envie uma sessão nova ou reinicie o contêiner.", failures, status.get("last_error"))
                await notify.publish_next(api_base, read_api_key(), None, False, "paused")
            if mtime != paused_at_mtime:
                log.info("sessão nova detectada: retomando")
                failures, paused_at_mtime = 0, None
                status.update(paused=False, consecutive_failures=0)
                continue
            await asyncio.sleep(60)
            continue

        if not state_path.exists():
            if not status.get("waiting_session"):
                log.error("sem sessão do X em %s: rode scripts/robot_login.sh e depois scripts/robot_install_session.sh no seu computador", state_path)
                await notify.publish_next(api_base, read_api_key(), None, False, "waiting_session")
            status.update(waiting_session=True, next_run_at=None)
            save_json(status_path, status)
            await asyncio.sleep(60)
            continue
        status["waiting_session"] = False

        now = datetime.now(timezone.utc)
        # O sorteio dos 10–25 min é feito UMA vez, logo depois da busca anterior, e guardado: um reinício do contêiner
        # não sorteia de novo (e o horário já foi informado à API para o menu mostrar).
        base = status.get("last_run_at")
        plan = status.get("plan")
        if plan and plan.get("base") == base and datetime.fromisoformat(plan["when"]) > now:
            when, deep = datetime.fromisoformat(plan["when"]), bool(plan["deep"])
        else:
            when, deep = schedule.plan(last_run, now, random)
            status["plan"] = {"base": base, "when": when.isoformat(), "deep": deep}
        status["next_run_at"] = when.astimezone(schedule.TZ).isoformat()
        status["next_mode"] = "deep" if deep else "normal"
        save_json(status_path, status)
        log.info("próxima busca: %s (%s)", status["next_run_at"], status["next_mode"])
        await notify.publish_next(api_base, read_api_key(), when, deep, "scheduled")
        await sleep_until(when)

        log.info("buscando novas (%s)…", "profunda" if deep else "normal")
        try:
            res = await runner.run_once(
                api_base=api_base, api_key=read_api_key(), bundle=bundle, state_path=state_path,
                start_url=runner.DEEP_URL if deep else runner.HOME_URL,
            )
        except Exception as e:  # noqa: BLE001
            res = runner.RunResult(ok=False, error=f"erro inesperado: {str(e)[:200]}")
        last_run = datetime.now(timezone.utc)
        status.update(last_run_at=last_run.isoformat(), last_mode="deep" if deep else "normal", last_result=dict(res))
        if res.get("ok"):
            failures = 0
            status.update(consecutive_failures=0, last_error=None, last_ok_at=last_run.isoformat())
            log.info("ok: %s", dict(res))
        else:
            failures += 1
            status.update(consecutive_failures=failures, last_error=res.get("error"))
            log.error("falhou (%s/%s): %s", failures, MAX_FAILURES, dict(res))
            if res.get("login"):
                failures = MAX_FAILURES  # sessão expirada: insistir não adianta
                status["consecutive_failures"] = failures
        save_json(status_path, status)


if __name__ == "__main__":
    asyncio.run(main())

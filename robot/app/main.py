"""Laço principal do robô: decide o que rodar e quando (schedule.py), executa (runner.py) e guarda o estado.

Três tipos de execução:
- normal: busca novas (intervalo sorteado conforme as não lidas);
- deep: busca profunda do FEED (a primeira a partir das 05:10 e das 12:30);
- profiles: verificação dos PERFIS de quem você segue (uma por dia, sorteada entre 03:00 e 03:30).
Também atende a pedidos de busca imediata feitos pela API (a leitura atravessou 30, 15 ou 6 não lidas) e adota o horário
antecipado pela API quando a faixa de intervalo muda."""
import asyncio
import json
import logging
import os
import random
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import notify, runner, schedule

log = logging.getLogger("robot")
MAX_FAILURES = 3          # falhas seguidas antes de parar de insistir (protege a conta)
POLL_S = 15               # de quanto em quanto tempo, enquanto espera, olha a API (pedido de busca / horário antecipado)
MIN_GAP_S = 180           # intervalo mínimo entre o fim de uma execução e o início de uma por pedido
MODE_OF = {"normal": "normal", "deep": "deep", "profiles": "profiles"}


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


def parse_dt(value) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


def run_params(kind: str) -> tuple[str, int]:
    return {
        "normal": (runner.HOME_URL, runner.NORMAL_TIMEOUT_S),
        "deep": (runner.DEEP_URL, runner.DEEP_TIMEOUT_S),
        "profiles": (runner.PROFILES_URL, runner.PROFILES_TIMEOUT_S),
    }[kind]


async def wait_for_turn(status, status_path, api_base, key, when, kind, last_run, last_finished):
    """Espera até `when`. Devolve ("due", when, None) | ("request", when, motivo) e atualiza o horário se a API o antecipar."""
    while True:
        now = datetime.now(timezone.utc)
        left = (when - now).total_seconds()
        if left <= 0:
            return "due", when, None
        await asyncio.sleep(min(left, POLL_S))
        # pedido de busca imediata (a leitura atravessou 30/15/6 não lidas)
        req = await notify.take_request(api_base, key)
        if req:
            wait = MIN_GAP_S - (time.time() - last_finished) if last_finished else 0
            if wait > 0:
                await asyncio.sleep(wait)
            return "request", when, req.get("reason")
        # horário antecipado pela API (a faixa de intervalo diminuiu): só vale para a busca normal e se couber nas regras
        if kind != "profiles":
            nxt = await notify.fetch_next(api_base, key)
            if nxt and nxt.get("state") == "scheduled" and nxt.get("at") and nxt.get("mode") != "profiles":
                new_at = datetime.fromisoformat(nxt["at"])
                if (when - new_at).total_seconds() > 5 and schedule.allowed(last_run, new_at):
                    when = new_at
                    plan = status.get("plan") or {}
                    plan.update(when=when.isoformat(), deep=schedule.is_deep(last_run, when))
                    status.update(plan=plan, next_run_at=when.astimezone(schedule.TZ).isoformat(), next_mode="deep" if plan["deep"] else "normal")
                    kind = "deep" if plan["deep"] else "normal"
                    save_json(status_path, status)
                    log.info("horário antecipado pela API (menos não lidas): %s", status["next_run_at"])


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stdout)
    data = Path(os.environ.get("DATA_DIR", "/data"))
    data.mkdir(parents=True, exist_ok=True)
    state_path = data / "x_state.json"      # sessão do X (cookies); gerada por scripts/robot_login.sh no seu computador
    status_path = data / "status.json"
    api_base = os.environ.get("API_BASE_URL", "http://api:8000")
    bundle = Path(os.environ.get("BUNDLE_PATH", "/robot/notixias.user.js")).read_text(encoding="utf-8")

    status = load_json(status_path, {})
    last_run = parse_dt(status.get("last_run_at"))           # última busca normal/profunda do feed (base do sorteio)
    last_profiles = parse_dt(status.get("last_profiles_at"))  # última verificação de perfis
    last_finished = 0.0
    failures = int(status.get("consecutive_failures", 0))
    paused_at_mtime = None
    log.info("robô iniciado (última busca: %s, perfis: %s, falhas seguidas: %s)", last_run, last_profiles, failures)

    while True:
        key = read_api_key()
        if failures >= MAX_FAILURES or status.get("paused"):
            # Parado de propósito: só volta quando você enviar uma sessão nova (x_state.json mudar) ou reiniciar.
            mtime = state_path.stat().st_mtime if state_path.exists() else 0
            if paused_at_mtime is None:
                paused_at_mtime = mtime
                status.update(paused=True, next_run_at=None)
                save_json(status_path, status)
                log.error("PAUSADO após %s falhas seguidas (%s). Envie uma sessão nova ou reinicie o contêiner.", failures, status.get("last_error"))
                await notify.publish_next(api_base, key, None, "normal", "paused")
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
                await notify.publish_next(api_base, key, None, "normal", "waiting_session")
            status.update(waiting_session=True, next_run_at=None)
            save_json(status_path, status)
            await asyncio.sleep(60)
            continue
        status["waiting_session"] = False

        now = datetime.now(timezone.utc)
        # --- próxima busca normal/profunda do feed: o sorteio é feito UMA vez e guardado (reinício não sorteia de novo) ---
        base = status.get("last_run_at")
        plan = status.get("plan")
        if plan and plan.get("base") == base and parse_dt(plan["when"]) > now:
            when_n, deep = parse_dt(plan["when"]), bool(plan["deep"])
            unread = plan.get("unread")
        else:
            pol = await notify.fetch_policy(api_base, key)
            interval = (pol["min_minutes"], pol["max_minutes"]) if pol else None
            unread = pol["unread"] if pol else None
            when_n, deep = schedule.plan(last_run, now, random, interval)
            plan = {"base": base, "when": when_n.isoformat(), "deep": deep, "unread": unread,
                    "interval": list(interval) if interval else None}
            status["plan"] = plan
        # --- próxima verificação de perfis (uma por dia, 03:00-03:30) ---
        when_p = schedule.next_profiles(last_profiles, now, random, parse_dt(status.get("profiles_target")))
        status["profiles_target"] = when_p.isoformat()

        if when_p < when_n:
            kind, when = "profiles", when_p
        else:
            kind, when = ("deep" if deep else "normal"), when_n
        status["next_run_at"] = when.astimezone(schedule.TZ).isoformat()
        status["next_mode"] = kind
        save_json(status_path, status)
        log.info("próxima busca: %s (%s%s)", status["next_run_at"], kind, f", {unread} não lidas" if unread is not None else "")
        await notify.publish_next(api_base, key, when, MODE_OF[kind], "scheduled", unread)

        outcome, when, why = await wait_for_turn(status, status_path, api_base, key, when, kind, last_run, last_finished)
        if outcome == "request":
            # busca pedida pela leitura: normal (ou profunda do feed, se for a primeira depois de 05:10/12:30)
            kind = "deep" if schedule.is_deep(last_run, datetime.now(timezone.utc)) else "normal"
            log.info("busca pedida pela leitura: %s", why)
        elif kind != "profiles" and (status.get("plan") or {}).get("deep") is not None:
            kind = "deep" if status["plan"]["deep"] else "normal"

        url, timeout_s = run_params(kind)
        log.info("buscando novas (%s)…", kind)
        try:
            res = await runner.run_once(api_base=api_base, api_key=key, bundle=bundle, state_path=state_path,
                                        start_url=url, timeout_s=timeout_s, why=why)
        except Exception as e:  # noqa: BLE001
            res = runner.RunResult(ok=False, error=f"erro inesperado: {str(e)[:200]}")
        finished = datetime.now(timezone.utc)
        last_finished = time.time()
        if kind == "profiles":
            last_profiles = finished
            status.update(last_profiles_at=finished.isoformat(), profiles_target=None)
        else:
            last_run = finished
            status.update(last_run_at=finished.isoformat())
        status.update(last_mode=kind, last_trigger=why, last_result=dict(res))
        if res.get("ok"):
            failures = 0
            status.update(consecutive_failures=0, last_error=None, last_ok_at=finished.isoformat())
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

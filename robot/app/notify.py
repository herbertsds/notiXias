"""Avisa a API quando será a próxima busca do robô (o userscript mostra isso em Menu -> Execuções)."""
import logging
from datetime import datetime

import httpx

log = logging.getLogger("robot")


def _headers(api_key: str) -> dict:
    return {"Authorization": f"Bearer {api_key}"}


async def publish_next(api_base: str, api_key: str, when: datetime | None, mode: str, state: str, unread: int | None = None) -> None:
    """`mode`: "normal" | "deep" (busca profunda do feed) | "profiles" (verificação dos perfis)."""
    body = {"at": when.isoformat() if when else None, "mode": mode, "state": state, "unread": unread}
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.put(f"{api_base}/api/v1/robot/next", json=body, headers={"Authorization": f"Bearer {api_key}"})
            r.raise_for_status()
    except Exception as e:  # noqa: BLE001  (informativo: nunca derruba o robô)
        log.warning("não consegui informar a próxima busca à API: %s", str(e)[:150])


async def _get(api_base: str, api_key: str, path: str, method: str = "GET"):
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.request(method, f"{api_base}/api/v1{path}", headers=_headers(api_key))
            r.raise_for_status()
            return r.json()
    except Exception as e:  # noqa: BLE001  (informativo: o robô segue com o que já sabe)
        log.warning("API %s %s falhou: %s", method, path, str(e)[:120])
        return None


async def fetch_policy(api_base: str, api_key: str) -> dict | None:
    """{unread, tier, min_minutes, max_minutes} (faixa de intervalo pelas não lidas) ou None se a API não respondeu."""
    return await _get(api_base, api_key, "/robot/policy")


async def fetch_next(api_base: str, api_key: str) -> dict | None:
    """O horário que a API guarda (pode ter sido antecipado quando você leu mensagens e a faixa mudou)."""
    return await _get(api_base, api_key, "/robot/next")


async def take_request(api_base: str, api_key: str) -> dict | None:
    """Há pedido de busca imediata (leitura atravessou 30/15/6 não lidas)? Se houver, já o confirma e devolve o motivo."""
    pending = await _get(api_base, api_key, "/robot/request")
    if not pending or not pending.get("pending"):
        return None
    got = await _get(api_base, api_key, "/robot/request/ack", method="POST")
    return got if got and got.get("pending") else None

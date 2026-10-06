"""Avisa a API quando será a próxima busca do robô (o userscript mostra isso em Menu -> Execuções)."""
import logging
from datetime import datetime

import httpx

log = logging.getLogger("robot")


async def publish_next(api_base: str, api_key: str, when: datetime | None, deep: bool, state: str) -> None:
    body = {"at": when.isoformat() if when else None, "mode": "deep" if deep else "normal", "state": state}
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.put(f"{api_base}/api/v1/robot/next", json=body, headers={"Authorization": f"Bearer {api_key}"})
            r.raise_for_status()
    except Exception as e:  # noqa: BLE001  (informativo: nunca derruba o robô)
        log.warning("não consegui informar a próxima busca à API: %s", str(e)[:150])

"""Ponta a ponta SEM o X de verdade: um "x.com" falso (rota interceptada) com posts sintéticos, o userscript real
injetado e a API de desenvolvimento. Confere que o robô captura, não mexe na posição de leitura e relata o resultado.
"""
import asyncio
import json
import os
import time
from pathlib import Path

import httpx
import pytest

from app import runner

API = os.environ.get("API_BASE_URL", "http://api:8000")
KEY = os.environ.get("E2E_API_KEY", "")
BUNDLE = Path(os.environ.get("BUNDLE_PATH", "/robot/notixias.user.js")).read_text(encoding="utf-8")


def article(i, author="conta_a"):
    return (
        f'<div data-testid="cellInnerDiv"><article data-testid="tweet" role="article">'
        f'<div data-testid="User-Name"><a href="/{author}"><span>{author}</span></a></div>'
        f'<a href="/{author}/status/{i}" role="link"><time datetime="2026-10-06T10:00:00.000Z">10:00</time></a>'
        f'<div data-testid="tweetText"><span>texto</span></div></article></div>'
    )


def fake_home(ids):
    cells = "\n".join(article(i) for i in ids)
    return (
        '<!doctype html><html lang="pt"><head><title>X</title></head><body><main>'
        '<div role="tablist"><div role="tab" aria-selected="false">Para você</div><div role="tab" aria-selected="true">Seguindo</div></div>'
        f'<div data-testid="primaryColumn">{cells}</div></main></body></html>'
    )


@pytest.fixture
def key():
    if not KEY:
        pytest.skip("defina E2E_API_KEY (chave da API de desenvolvimento)")
    return KEY


def api(path, method="GET", **kw):
    r = httpx.request(method, f"{API}/api/v1{path}", headers={"Authorization": f"Bearer {KEY}"}, timeout=20, **kw)
    r.raise_for_status()
    return r.json()


def make_hook(ids_holder):
    async def hook(context):
        async def handle(route):
            await route.fulfill(status=200, content_type="text/html; charset=utf-8", body=fake_home(ids_holder["ids"]))
        await context.route("https://x.com/**", handle)
    return hook


def test_captura_sem_mexer_na_posicao(key, tmp_path):
    base = 2108000000000000000 + (int(time.time()) % 1_000_000) * 1000          # ids novos a cada execução do teste
    base_ids = [str(base + n) for n in range(30, 0, -1)]            # mais novo primeiro
    holder = {"ids": base_ids}
    st0 = api("/state")
    res = asyncio.run(runner.run_once(api_base=API, api_key=KEY, bundle=BUNDLE, state_path=tmp_path / "s.json",
                                      timeout_s=45, route_hook=make_hook(holder)))
    assert res["ok"] is True, res
    assert res["created"] >= 30 or st0["cursor_seq"] is not None
    st1 = api("/state")
    assert st1["cursor_seq"] == st0["cursor_seq"], "o robô não pode mover a posição de leitura"
    # segunda busca com 2 posts novos no topo
    holder["ids"] = [str(base + 40), str(base + 35)] + base_ids
    res2 = asyncio.run(runner.run_once(api_base=API, api_key=KEY, bundle=BUNDLE, state_path=tmp_path / "s.json",
                                       timeout_s=45, route_hook=make_hook(holder)))
    assert res2["ok"] is True and res2["created"] == 2, res2
    assert api("/state")["cursor_seq"] == st0["cursor_seq"]


def test_pagina_de_login_vira_erro_de_sessao(key, tmp_path):
    async def hook(context):
        async def handle(route):
            await route.fulfill(status=200, content_type="text/html", body="<html><body>login</body></html>")
        await context.route("https://x.com/**", handle)
    res = asyncio.run(runner.run_once(api_base=API, api_key=KEY, bundle=BUNDLE, state_path=tmp_path / "s.json",
                                      timeout_s=20, start_url="https://x.com/i/flow/login", route_hook=hook))
    assert res["ok"] is False and res.get("login") is True


def test_execucao_profunda_entra_no_historico_como_automatica(key, tmp_path):
    base = 2109000000000000000 + (int(time.time()) % 1_000_000) * 1000
    holder = {"ids": [str(base + n) for n in range(10, 0, -1)]}
    res = asyncio.run(runner.run_once(api_base=API, api_key=KEY, bundle=BUNDLE, state_path=tmp_path / "s.json",
                                      timeout_s=60, start_url=runner.DEEP_URL, route_hook=make_hook(holder)))
    assert res["ok"] is True, res
    last = api("/runs?limit=1")["items"][0]
    assert (last["source"], last["mode"], last["ok"]) == ("robot", "deep", True)

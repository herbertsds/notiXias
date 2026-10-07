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


# ---------- profunda: feed até a fronteira + perfil de cada conta seguida (Posts e Respostas) ----------
def snow(ms):
    return str((int(ms) - 1288834974657) << 22)


def art(ms, author, reply_to=None):
    i = snow(ms)
    return (
        f'<div data-testid="cellInnerDiv"><article data-testid="tweet" role="article">'
        f'<div data-testid="User-Name"><a href="/{author}"><span>{author}</span></a></div>'
        f'<a href="/{author}/status/{i}" role="link"><time datetime="2026-10-06T10:00:00.000Z">x</time></a>'
        f'<div data-testid="tweetText"><span>t</span></div></article></div>'
    )


def page(cells, tabs=False):
    tl = ('<div role="tablist"><div role="tab" aria-selected="false">Para você</div>'
          '<div role="tab" aria-selected="true">Seguindo</div></div>') if tabs else ""
    return f'<!doctype html><html lang="pt"><body><main>{tl}<div data-testid="primaryColumn">{"".join(cells)}</div></main></body></html>'


def test_profunda_percorre_feed_e_perfis_e_registra_uma_execucao(key, tmp_path):
    now = time.time() * 1000
    H = 3600 * 1000
    uniq = int(time.time()) % 100000                                   # ids novos a cada rodada do teste
    off = uniq % 50                                                    # ms de diferença entre rodadas (ids únicos)
    api("/accounts/following", "PUT", json={"accounts": [{"handle": "conta_a"}, {"handle": "conta_b"}]})
    deep_last = api("/runs/deep-last")["started_at"]
    boundary = max(now - 24 * H, __import__("datetime").datetime.fromisoformat(deep_last).timestamp() * 1000 if deep_last else 0)
    span = now - boundary                                                  # posts "novos" ficam entre a fronteira e agora
    def new_at(frac):
        return boundary + span * frac - off
    feed = [art(new_at(0.95), "conta_c"), art(new_at(0.90), "conta_c")]
    feed += [art(boundary - n * 60000 - off, "conta_c") for n in range(1, 6)]                 # antigos: fronteira
    profiles = {
        "/conta_a": [art(new_at(0.85), "conta_a"), art(new_at(0.80), "conta_a")]
                    + [art(boundary - (60 + n) * 60000 - off, "conta_a") for n in range(1, 8)],
        "/conta_a/with_replies": [art(new_at(0.75), "conta_a"), art(new_at(0.70), "outra")]
                                 + [art(boundary - (60 + n) * 60000 - off, "conta_a") for n in range(1, 8)],
        "/conta_b": [art(new_at(0.65), "conta_b")] + [art(boundary - (60 + n) * 60000 - off, "conta_b") for n in range(1, 8)],
        "/conta_b/with_replies": [],
    }
    visited = []

    async def hook(context):
        async def handle(route):
            path = route.request.url.split("x.com", 1)[1].split("?")[0].rstrip("/") or "/"
            if route.request.resource_type == "document":
                visited.append(path)
            if path == "/home":
                body = page(feed, tabs=True)
            elif path in profiles:
                body = page(profiles[path])
            else:
                body = page([])
            await route.fulfill(status=200, content_type="text/html; charset=utf-8", body=body)
        await context.route("https://x.com/**", handle)

    st0 = api("/state")
    res = asyncio.run(runner.run_once(api_base=API, api_key=KEY, bundle=BUNDLE, state_path=tmp_path / "s.json",
                                      timeout_s=300, start_url=runner.DEEP_URL, route_hook=hook))
    assert res["ok"] is True, res
    assert res["profiles_done"] == 2 and res["profile_created"] == 4, res            # a:2 posts + 1 resposta, b:1
    assert [v for v in visited if v != "/home"] == ["/conta_a", "/conta_a/with_replies", "/conta_b", "/conta_b/with_replies"]
    run = api("/runs?limit=1")["items"][0]
    assert (run["source"], run["mode"], run["profiles_done"]) == ("robot", "deep", 2) and run["reason"] == "time_boundary"
    assert api("/runs/deep-last")["started_at"] is not None
    assert api("/state")["cursor_seq"] == st0["cursor_seq"]                           # não mexeu na posição de leitura


def test_profunda_pula_perfil_travado_e_comeca_mesmo_sem_evento_load(key, tmp_path):
    """Uma página que nunca responde (navegação pendurada) não pode prender o robô: ele pula a conta. E uma página cujo
    evento `load` nunca dispara (recurso pendurado) ainda roda o script."""
    now = time.time() * 1000
    span_start = max(now - 24 * 3600 * 1000, 0)
    last = api("/runs/deep-last")["started_at"]
    if last:
        span_start = max(span_start, __import__("datetime").datetime.fromisoformat(last).timestamp() * 1000)
    boundary = span_start
    off = (int(time.time()) % 50) + 100
    api("/accounts/following", "PUT", json={"accounts": [{"handle": "conta_a"}, {"handle": "conta_hang"}, {"handle": "conta_b"}]})
    feed = [art(boundary + (now - boundary) * 0.9 - off, "conta_c")] + [art(boundary - n * 60000 - off, "conta_c") for n in range(1, 6)]
    old = [art(boundary - (60 + n) * 60000 - off, "conta_a") for n in range(1, 8)]
    old_b = [art(boundary - (60 + n) * 60000 - off, "conta_b") for n in range(1, 8)]
    profiles = {
        "/conta_a": [art(boundary + (now - boundary) * 0.8 - off, "conta_a")] + old,
        "/conta_a/with_replies": [],
        "/conta_b": [art(boundary + (now - boundary) * 0.7 - off, "conta_b")] + old_b,
        "/conta_b/with_replies": [],
    }
    visited = []

    async def hook(context):
        async def handle(route):
            path = route.request.url.split("x.com", 1)[1].split("?")[0].rstrip("/") or "/"
            if route.request.resource_type == "document":
                visited.append(path)
            if path == "/hang.png" or path.startswith("/conta_hang"):
                await asyncio.sleep(3600)                                  # nunca responde
                return
            if path == "/home":
                body = page(feed, tabs=True)
            elif path == "/conta_b":
                body = page(profiles[path]).replace("</main>", '<img src="https://x.com/hang.png"></main>')   # `load` nunca dispara
            else:
                body = page(profiles.get(path, []))
            await route.fulfill(status=200, content_type="text/html; charset=utf-8", body=body)
        await context.route("https://x.com/**", handle)

    res = asyncio.run(runner.run_once(api_base=API, api_key=KEY, bundle=BUNDLE, state_path=tmp_path / "s.json",
                                      timeout_s=300, stall_s=25, start_url=runner.DEEP_URL, route_hook=hook))
    assert res["ok"] is True, res
    assert res["profiles_done"] == 2 and res["profiles_skipped"] == 1 and res["profile_created"] == 2, res
    assert "/conta_hang" in visited and visited.count("/conta_b") >= 1


def test_travamento_fora_dos_perfis_encerra_a_execucao_com_erro(key, tmp_path):
    async def hook(context):
        async def handle(route):
            await asyncio.sleep(3600)
        await context.route("https://x.com/**", handle)
    res = asyncio.run(runner.run_once(api_base=API, api_key=KEY, bundle=BUNDLE, state_path=tmp_path / "s.json",
                                      timeout_s=300, stall_s=10, route_hook=hook, start_url="https://x.com/home?nx=update"))
    assert res["ok"] is False and res.get("error")

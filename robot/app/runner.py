"""Uma execução: abre o X (sessão do dono) num Chromium sem tela, injeta o userscript e espera o resultado."""
import asyncio
import json
import logging
import os
import secrets
import time
from pathlib import Path
from urllib.parse import urlparse

import httpx
from playwright.async_api import async_playwright

log = logging.getLogger("robot")

HOME_URL = "https://x.com/home?nx=update"
DEEP_URL = "https://x.com/home?nx=deep"
# Parecido com um Chrome comum de computador (sem "HeadlessChrome").
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
VIEWPORT = {"width": 1280, "height": 1400}
SHIM_PATH = Path(__file__).with_name("shim.js")


class RunResult(dict):
    """{ok: bool, error?: str, login?: bool, created?, updated?, gap?, reason?, steps?, duration_s}"""


def build_init_script(bundle: str, names: dict) -> str:
    shim = SHIM_PATH.read_text(encoding="utf-8")
    return shim.replace("__NX_BINDINGS__", json.dumps(names)).replace("__BUNDLE__", bundle)


def bot_config(api_base: str, api_key: str) -> dict:
    return {
        "apiBaseUrl": api_base,
        "apiKey": "chave-no-servidor",  # marcador: a chave de verdade só é colocada pelo Python (nx_http)
        "bot": True,
        "autoResume": False,
        "internalNav": True,
        "hideXBar": False,
    }


async def run_once(
    *,
    api_base: str,
    api_key: str,
    bundle: str,
    state_path: Path,
    timeout_s: int = 25 * 60,
    start_url: str = HOME_URL,
    headless: bool = True,
    route_hook=None,
) -> RunResult:
    """`route_hook(context)` existe só para os testes (simular o X)."""
    t0 = time.monotonic()
    store: dict[str, str] = {"nx_cfg": json.dumps(bot_config(api_base, api_key))}
    real_auth = f"Bearer {api_key}"
    api_host = urlparse(api_base)

    async def nx_get(key):
        return store.get(key) if isinstance(key, str) and key.startswith("nx_") else None

    async def nx_set(key, value):
        if isinstance(key, str) and key.startswith("nx_") and isinstance(value, str) and len(value) < 500_000:
            store[key] = value

    async def nx_http(req):
        # Só fala com a API do notiXias: nada que a página do X peça pode usar o servidor para outros destinos.
        u = urlparse(str(req.get("url", "")))
        if (u.scheme, u.netloc) != (api_host.scheme, api_host.netloc):
            return {"error": "destino não permitido"}
        try:
            headers = {k: v for k, v in (req.get("headers") or {}).items() if k.lower() != "authorization"}
            headers["Authorization"] = real_auth
            async with httpx.AsyncClient(timeout=req.get("timeout", 30000) / 1000) as c:
                r = await c.request(str(req.get("method", "GET")), str(req["url"]), headers=headers, content=req.get("data"))
            return {"status": r.status_code, "text": r.text}
        except httpx.TimeoutException:
            return {"error": "timeout"}
        except Exception as e:  # noqa: BLE001
            return {"error": str(e)[:200]}

    names = {k: "_nx" + secrets.token_hex(8) for k in ("get", "set", "http")}
    result = RunResult(ok=False, error="não terminou")
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=headless, args=["--disable-blink-features=AutomationControlled"])
        try:
            ctx_args = dict(
                user_agent=USER_AGENT, viewport=VIEWPORT, locale="pt-BR", timezone_id="America/Sao_Paulo",
                extra_http_headers={"Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8"},
            )
            if state_path.exists():
                ctx_args["storage_state"] = str(state_path)
            context = await browser.new_context(**ctx_args)
            await context.expose_function(names["get"], nx_get)
            await context.expose_function(names["set"], nx_set)
            await context.expose_function(names["http"], nx_http)
            await context.add_init_script(build_init_script(bundle, names))
            # vídeo não é necessário para ler o feed e pesa; o resto carrega normalmente
            await context.route("**/*", lambda route: route.abort() if route.request.resource_type == "media" else route.fallback())
            if route_hook:
                await route_hook(context)
            page = await context.new_page()
            console: list[str] = []
            page.on("console", lambda m: console.append(f"{m.type}: {m.text[:200]}"))
            page.on("pageerror", lambda e: console.append(f"pageerror: {str(e)[:300]}"))
            try:
                await page.goto(start_url, wait_until="domcontentloaded", timeout=60_000)
            except Exception as e:  # noqa: BLE001
                result = RunResult(ok=False, error=f"não abriu o X: {str(e)[:150]}")
                return result
            deadline = time.monotonic() + timeout_s
            while time.monotonic() < deadline:
                await asyncio.sleep(2)
                if "/i/flow/login" in page.url or page.url.rstrip("/").endswith("/login"):
                    result = RunResult(ok=False, error="sessão do X expirada (tela de login)", login=True)
                    break
                try:
                    r = await page.evaluate("window.__nxBotResult || null")
                except Exception:  # noqa: BLE001  (a página está navegando: tenta de novo)
                    continue
                if r:
                    result = RunResult(r)
                    break
            else:
                result = RunResult(ok=False, error=f"tempo esgotado ({timeout_s // 60} min)")
                try:  # diagnóstico: onde a página parou (sem texto de posts: só o início do corpo)
                    body = (await page.evaluate("document.body ? document.body.innerText.slice(0, 300) : ''")).replace("\n", " ")
                    ui = await page.evaluate(
                        "[...document.querySelectorAll('*')].filter(e=>e.shadowRoot).map(e=>[...e.shadowRoot.children].filter(c=>c.tagName!=='STYLE').map(c=>c.textContent).join(' ').replace(/\\s+/g,' ').slice(0,300))"
                    )
                    result["diag"] = {"url": page.url, "ui": ui, "body": body[:120], "console": console[-8:]}
                except Exception:  # noqa: BLE001
                    result["diag"] = {"url": page.url, "console": console[-8:]}
            if result.get("ok"):
                # guarda os cookies renovados (o X rotaciona alguns)
                try:
                    await context.storage_state(path=str(state_path))
                    os.chmod(state_path, 0o600)
                except Exception as e:  # noqa: BLE001
                    log.warning("não consegui salvar a sessão: %s", e)
            return result
        finally:
            await browser.close()
            result["duration_s"] = round(time.monotonic() - t0, 1)

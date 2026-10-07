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
NORMAL_TIMEOUT_S = 25 * 60
DEEP_TIMEOUT_S = 120 * 60  # feed (até 45 min) + perfil de cada conta seguida, aba Posts e aba Respostas
# Parecido com um Chrome comum de computador (sem "HeadlessChrome").
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
VIEWPORT = {"width": 1280, "height": 1400}
SHIM_PATH = Path(__file__).with_name("shim.js")


STALL_S = 300  # sem sinal de progresso do script por tanto tempo = travou
MAX_STALL_SKIPS = 4  # perfis que o robô pula (por travamento) antes de desistir da execução


def skip_profile(phase: dict) -> dict:
    """Fase 'profiles' com a conta atual pulada (a página dela travou): segue para a próxima conta, na aba Posts."""
    q = dict(phase)
    q.update(nav=0, skipped=int(phase.get("skipped", 0)) + 1, tab="posts", i=int(phase["i"]) + 1,
             failRun=int(phase.get("failRun", 0)) + 1, at=int(time.time() * 1000))
    return q


def profile_url(phase: dict) -> str:
    if phase["i"] >= len(phase["handles"]):
        return "https://x.com/home"
    return "https://x.com/" + phase["handles"][phase["i"]] + ("/with_replies" if phase.get("tab") == "replies" else "")


async def bounded_eval(page, expr: str, timeout: float = 10):
    """`page.evaluate` com prazo: numa página travada ele pode nunca voltar (foi o que prendeu o robô por horas)."""
    try:
        return await asyncio.wait_for(page.evaluate(expr), timeout)
    except Exception:  # noqa: BLE001
        return None


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
    timeout_s: int = NORMAL_TIMEOUT_S,
    stall_s: int = STALL_S,
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
            skips = 0
            kick = time.time()  # último momento em que o robô mexeu na página (conta como sinal de vida)
            while time.monotonic() < deadline:
                await asyncio.sleep(2)
                url = page.url
                if "/i/flow/login" in url or url.rstrip("/").endswith("/login"):
                    result = RunResult(ok=False, error="sessão do X expirada (tela de login)", login=True)
                    break
                r = await bounded_eval(page, "window.__nxBotResult || null")
                if r:
                    result = RunResult(r)
                    break
                try:
                    beat = int(store.get("nx_beat") or 0) / 1000
                except ValueError:
                    beat = 0
                if time.time() - max(beat, kick) <= stall_s:
                    continue
                # Sem sinal de progresso: a página travou (navegação pendurada, script que não iniciou...).
                phase = {}
                try:
                    phase = json.loads(store.get("nx_phase") or "{}")
                except ValueError:
                    pass
                if phase.get("name") == "profiles" and skips < MAX_STALL_SKIPS:
                    skips += 1
                    nxt = skip_profile(phase)
                    store["nx_phase"] = json.dumps(nxt)
                    log.warning("sem progresso há %ss em %s: pulando @%s", stall_s, url, phase["handles"][phase["i"]] if phase["i"] < len(phase["handles"]) else "?")
                    kick = time.time()
                    try:
                        await asyncio.wait_for(page.goto(profile_url(nxt), wait_until="domcontentloaded", timeout=45_000), 60)
                    except Exception:  # noqa: BLE001
                        pass
                    continue
                result = RunResult(ok=False, error=f"travou: sem progresso por {stall_s // 60} min", stalled=True, skipped_stalled=skips)
                break
            else:
                result = RunResult(ok=False, error=f"tempo esgotado ({timeout_s // 60} min)")
            if not result.get("ok"):
                # diagnóstico: onde a página parou (sem texto de posts: só o início do corpo); cada leitura com prazo
                body = await bounded_eval(page, "document.body ? document.body.innerText.slice(0, 200) : ''")
                ui = await bounded_eval(
                    page,
                    "[...document.querySelectorAll('*')].filter(e=>e.shadowRoot).map(e=>[...e.shadowRoot.children].filter(c=>c.tagName!=='STYLE').map(c=>c.textContent).join(' ').replace(/\\s+/g,' ').slice(0,300))",
                )
                result["diag"] = {"url": page.url, "ui": ui, "body": (body or "").replace("\n", " ")[:120], "console": console[-8:]}
            if result.get("ok"):
                # guarda os cookies renovados (o X rotaciona alguns)
                try:
                    await context.storage_state(path=str(state_path))
                    os.chmod(state_path, 0o600)
                except Exception as e:  # noqa: BLE001
                    log.warning("não consegui salvar a sessão: %s", e)
            return result
        finally:
            try:
                await asyncio.wait_for(browser.close(), 30)
            except Exception:  # noqa: BLE001  (navegador pendurado: o contêiner do robô o encerra ao reiniciar)
                pass
            result["duration_s"] = round(time.monotonic() - t0, 1)

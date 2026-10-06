"""Login MANUAL no X para o robô (rode no SEU computador; nada é automatizado).

Abre um Chromium com janela; você entra na conta normalmente (usuário, senha, verificação). Quando a página inicial
carregar, a sessão (cookies) é salva em .secrets/x_state.json e a janela fecha. Depois: scripts/robot_install_session.sh
"""
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

OUT = Path(__file__).resolve().parent.parent / ".secrets" / "x_state.json"


def main() -> int:
    OUT.parent.mkdir(exist_ok=True)
    with sync_playwright() as pw:
        # Usa o Google Chrome instalado (não o Chromium do Playwright, que o Google e o X reconhecem como automatizado)
        # e sem a marca de automação. Perfil temporário: nada do seu Chrome de uso diário é tocado.
        profile = tempfile.mkdtemp(prefix="notixias-login-")
        try:
            ctx = pw.chromium.launch_persistent_context(
                profile, channel="chrome", headless=False, no_viewport=True, chromium_sandbox=True,
                ignore_default_args=["--enable-automation"], args=["--disable-blink-features=AutomationControlled"],
            )
        except Exception as e:  # noqa: BLE001
            print(f"Não consegui abrir o Google Chrome ({str(e)[:120]}). Ele está instalado em /Applications?", file=sys.stderr)
            return 1
        browser = ctx
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto("https://x.com/login")
        print("Entre na conta do X na janela que abriu. Tenho 10 minutos; ao chegar na página inicial eu salvo e fecho.")
        deadline = time.time() + 600
        while time.time() < deadline:
            time.sleep(2)
            try:
                logged = page.url.split("?")[0].rstrip("/") == "https://x.com/home" and any(
                    c["name"] == "auth_token" for c in ctx.cookies("https://x.com")
                )
            except Exception:  # noqa: BLE001
                continue
            if logged:
                time.sleep(3)  # deixa o X terminar de gravar os cookies
                ctx.storage_state(path=str(OUT))
                OUT.chmod(0o600)
                print(f"Sessão salva em {OUT}")
                browser.close()
                return 0
        print("Tempo esgotado sem concluir o login.", file=sys.stderr)
        browser.close()
        return 1


if __name__ == "__main__":
    sys.exit(main())

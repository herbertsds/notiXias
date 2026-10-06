#!/usr/bin/env python3
"""Monta .secrets/x_state.json a partir de dois cookies copiados do SEU Chrome (sem navegador automatizado).

Como pegar (no Chrome onde você já está logado no X):
  1. abra https://x.com/home, aperte F12 (ou Cmd+Option+I) -> aba "Application" (Aplicativo)
  2. à esquerda: Storage -> Cookies -> https://x.com
  3. copie o VALOR de `auth_token` e o de `ct0` (clique na linha; o valor aparece embaixo)
Os valores são lidos com a digitação oculta e gravados só no arquivo local (permissão 600, fora do Git).
Atenção: é a MESMA sessão do seu Chrome; se você sair da conta ("Sair") lá, a do robô também cai.
"""
import getpass
import json
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / ".secrets" / "x_state.json"


def cookie(name: str, value: str, http_only: bool) -> dict:
    return {
        "name": name, "value": value, "domain": ".x.com", "path": "/", "expires": -1,
        "httpOnly": http_only, "secure": True, "sameSite": "None" if name == "auth_token" else "Lax",
    }


def build_state(auth_token: str, ct0: str) -> dict:
    auth_token, ct0 = auth_token.strip(), ct0.strip()
    if not auth_token or not ct0:
        raise ValueError("auth_token e ct0 são obrigatórios")
    if any(c.isspace() for c in auth_token + ct0) or len(auth_token) < 20 or len(ct0) < 20:
        raise ValueError("os valores parecem incompletos (copie o valor inteiro, sem espaços)")
    return {"cookies": [cookie("auth_token", auth_token, True), cookie("ct0", ct0, False)], "origins": []}


def main() -> int:
    print(__doc__.split("Como pegar")[0].strip(), "\n")
    auth = getpass.getpass("Cole o valor de auth_token (não aparece na tela): ")
    ct0 = getpass.getpass("Cole o valor de ct0 (não aparece na tela): ")
    try:
        state = build_state(auth, ct0)
    except ValueError as e:
        print(f"Erro: {e}", file=sys.stderr)
        return 1
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(state), encoding="utf-8")
    OUT.chmod(0o600)
    print(f"Sessão gravada em {OUT}. Agora rode: scripts/robot_install_session.sh")
    return 0


if __name__ == "__main__":
    sys.exit(main())

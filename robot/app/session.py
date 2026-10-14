"""Monta o arquivo de sessão do Playwright (storage_state) a partir dos dois cookies de login do X."""


def cookie(name: str, value: str, http_only: bool) -> dict:
    return {
        "name": name, "value": value, "domain": ".x.com", "path": "/", "expires": -1,
        "httpOnly": http_only, "secure": True, "sameSite": "None" if name == "auth_token" else "Lax",
    }


def session_state(auth_token: str, ct0: str) -> dict:
    auth_token, ct0 = auth_token.strip(), ct0.strip()
    if len(auth_token) < 20 or len(ct0) < 20 or any(c.isspace() for c in auth_token + ct0):
        raise ValueError("cookies incompletos")
    return {"cookies": [cookie("auth_token", auth_token, True), cookie("ct0", ct0, False)], "origins": []}

import hashlib
import hmac
import logging

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

log = logging.getLogger("notixias.security")

_bearer = HTTPBearer(auto_error=False)


def hash_key(key: str) -> str:
    return "sha256:" + hashlib.sha256(key.encode()).hexdigest()


def require_key(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> None:
    """Resposta idêntica (401) para chave ausente, malformada ou errada."""
    expected = request.app.state.settings.api_key_hash
    ok = False
    if creds is not None and expected:
        ok = hmac.compare_digest(hash_key(creds.credentials), expected)
    if not ok:
        host = request.client.host if request.client else "?"
        log.warning("tentativa de acesso recusada ip=%s path=%s", host, request.url.path)
        raise HTTPException(status_code=401, detail="unauthorized", headers={"WWW-Authenticate": "Bearer"})

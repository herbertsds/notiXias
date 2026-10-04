#!/usr/bin/env python3
"""Gera uma chave de API aleatória e o hash para API_KEY_HASH. Não grava nada em disco."""
import hashlib
import secrets

key = secrets.token_urlsafe(32)
print(f"Chave (guarde no gerenciador de scripts, NUNCA no Git): {key}")
print(f"API_KEY_HASH=sha256:{hashlib.sha256(key.encode()).hexdigest()}")

#!/usr/bin/env bash
# Teste de contrato: cliente JS do userscript <-> API real, em banco descartável (notixias_e2e).
# Não toca no banco de desenvolvimento. Requer `docker compose up -d mongo` (ou api) já rodando.
set -euo pipefail
cd "$(dirname "$0")/.."
KEY="e2e-key-0123456789"
HASH=$(printf %s "$KEY" | shasum -a 256 | cut -d' ' -f1)
NET=notixias_notixias_net
docker rm -f nx-e2e-api >/dev/null 2>&1 || true
docker compose up -d mongo >/dev/null
docker run -d --name nx-e2e-api --network "$NET" -v "$PWD/api:/app" \
  -e ENV=dev -e MONGO_URL=mongodb://mongo:27017 -e MONGO_DB=notixias_e2e -e "API_KEY_HASH=sha256:$HASH" \
  "$(docker compose images api -q 2>/dev/null | head -1 || echo notixias-api)" >/dev/null 2>&1 \
  || docker run -d --name nx-e2e-api --network "$NET" -v "$PWD/api:/app" \
     -e ENV=dev -e MONGO_URL=mongodb://mongo:27017 -e MONGO_DB=notixias_e2e -e "API_KEY_HASH=sha256:$HASH" notixias-api >/dev/null
trap 'docker rm -f nx-e2e-api >/dev/null 2>&1; docker compose exec -T mongo mongosh --quiet --eval "db.getSiblingDB(\"notixias_e2e\").dropDatabase().ok" >/dev/null' EXIT
sleep 4
docker run --rm --network "$NET" -v "$PWD/userscript:/work" -w /work/e2e node:22-alpine node contract.e2e.js

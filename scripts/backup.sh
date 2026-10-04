#!/usr/bin/env bash
# Backup diário do Mongo de produção (mongodump compactado). Rodar no servidor, na pasta do projeto.
# Retenção: os 14 mais recentes. Destino padrão: ~/backups/notixias (mude com BACKUP_DIR).
# Restauração:  docker compose -f docker-compose.prod.yml exec -T mongo mongorestore --archive --gzip --drop \
#                 -u "$MONGO_ROOT_USER" -p "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin < arquivo.archive.gz
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
# shellcheck disable=SC1091
. ./.env
set +a
DEST="${BACKUP_DIR:-$HOME/backups/notixias}"
mkdir -p "$DEST"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$DEST/notixias-$STAMP.archive.gz"
docker compose -f docker-compose.prod.yml exec -T mongo mongodump --archive --gzip \
  -u "$MONGO_ROOT_USER" -p "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin --db "$MONGO_DB" > "$OUT"
# um dump vazio/pequeno demais é falha silenciosa: não vale como backup
if [ "$(wc -c < "$OUT")" -lt 200 ]; then
  echo "backup suspeito (muito pequeno): $OUT" >&2
  rm -f "$OUT"
  exit 1
fi
ls -1t "$DEST"/notixias-*.archive.gz | tail -n +15 | xargs -r rm -f
echo "ok: $OUT"

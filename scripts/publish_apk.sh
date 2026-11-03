#!/usr/bin/env bash
# Publica o APK compilado no servidor para o app se atualizar sozinho (GET /api/v1/app/version e /app/apk).
# Uso: docker compose --profile build run --rm android-build && ./scripts/publish_apk.sh
set -euo pipefail
cd "$(dirname "$0")/.."
APK=android/app/build/outputs/apk/debug/app-debug.apk
[ -f "$APK" ] || { echo "APK não encontrado: compile antes (android-build)"; exit 1; }
CODE=$(sed -n "s/.*versionCode \([0-9]*\).*/\1/p" android/app/build.gradle | head -1)
NAME=$(sed -n "s/.*versionName '\([^']*\)'.*/\1/p" android/app/build.gradle | head -1)
mkdir -p android-dist
cp "$APK" android-dist/notixias.apk
printf '{"versionCode": %s, "versionName": "%s"}\n' "$CODE" "$NAME" > android-dist/notixias.json
HOST=${NX_SSH_HOST:-OracleCloud}
ssh "$HOST" 'mkdir -p ~/projetos/notixias/android-dist'
# o JSON vai por último: o servidor só anuncia a versão depois que o APK inteiro chegou
scp -q android-dist/notixias.apk "$HOST":projetos/notixias/android-dist/notixias.apk
scp -q android-dist/notixias.json "$HOST":projetos/notixias/android-dist/notixias.json
echo "publicado: $NAME (versionCode $CODE)"

#!/usr/bin/env bash
# Envia a sessão do X (.secrets/x_state.json) para o servidor, onde o robô a lê. Se o robô estava pausado por sessão
# expirada, ele percebe o arquivo novo e retoma sozinho em até 1 minuto.
# Uso:  scripts/robot_install_session.sh [host-ssh]   (padrão: OracleCloud)
set -euo pipefail
cd "$(dirname "$0")/.."
HOST="${1:-OracleCloud}"
SRC=".secrets/x_state.json"
[ -s "$SRC" ] || { echo "Falta $SRC: rode scripts/robot_login.sh antes." >&2; exit 1; }
scp -q "$SRC" "$HOST:projetos/notixias/robot_data/x_state.json.new"
ssh "$HOST" 'cd ~/projetos/notixias/robot_data && chmod 600 x_state.json.new && mv -f x_state.json.new x_state.json' < /dev/null
echo "Sessão enviada para $HOST."

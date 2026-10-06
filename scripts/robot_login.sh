#!/usr/bin/env bash
# Login manual no X para o robô (no seu computador). Instala o Playwright num ambiente isolado na primeira vez.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -d .venv-robot ]; then
  python3 -m venv .venv-robot
  .venv-robot/bin/pip install --quiet playwright==1.49.1
  .venv-robot/bin/playwright install chromium
fi
.venv-robot/bin/python robot/login.py

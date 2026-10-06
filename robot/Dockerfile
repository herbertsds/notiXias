# Robô do notiXias: navegador sem tela (Chromium via Playwright) que abre o X com a SUA sessão e roda o userscript
# para buscar novas de tempos em tempos. Imagem multi-arquitetura (o servidor é aarch64).
# Contexto de build: a raiz do repositório (precisa de userscript/notixias.user.js).
FROM mcr.microsoft.com/playwright/python:v1.49.1-jammy
WORKDIR /robot
COPY robot/requirements.txt robot/requirements-dev.txt ./
ARG INSTALL_DEV=0
RUN pip install --no-cache-dir -r $([ "$INSTALL_DEV" = "1" ] && echo requirements-dev.txt || echo requirements.txt)
COPY robot/app ./app
COPY robot/tests ./tests
COPY userscript/notixias.user.js ./notixias.user.js
ENV PYTHONUNBUFFERED=1 PYTHONPATH=/robot BUNDLE_PATH=/robot/notixias.user.js DATA_DIR=/data
CMD ["python", "-m", "app.main"]

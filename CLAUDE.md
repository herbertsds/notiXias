# CLAUDE.md — notiXias

Leia `README.md` e `docs/` antes de qualquer trabalho. Os documentos refletem decisões já tomadas pelo dono; não as rediscuta sem motivo novo.

## Regras do projeto

- Implementação local das Fases 0–4 feita (ver `docs/STATUS.md`). **Fases 5–7 (refinos, deploy, iPhone) só com pedido explícito do dono.**
- Desenvolvimento **local** (Docker no Mac). Só mexer no servidor Oracle quando o dono pedir, e então apenas o que for do notiXias.
- **Nunca tocar** nos containers/volumes/redes de outros projetos no servidor (`contagem_carboidratos_*`, `keycloak*`, `nginx_proxy_manager`, `portainer`). Mongo do notiXias é **sempre um container próprio**.
- **Nunca** versionar segredos (`.env`, chave de API, chaves SSH). O userscript não contém a chave; ela vive no armazenamento do gerenciador de scripts.
- Nenhuma automação de login no X. O dono se autentica manualmente (no navegador, ou em `scripts/robot_login.sh` para o robô do servidor).
- Robô de busca no servidor (`robot/`, ver `docs/11-robo.md`): autorizado pelo dono em 2026-10-06, aceitando o risco para a conta. Só busca novas; nunca lê entradas nem mexe na posição.
- Não guardar texto de posts nem mídia; apenas IDs, links, autor e metadados de captura.

## Stack decidida

- Backend: Python + FastAPI, MongoDB, tudo em Docker (imagens multi-arquitetura: o servidor é ARM/aarch64).
- Cliente: userscript (Tampermonkey no Chrome do Mac; app Userscripts no Safari do iPhone), usando `GM_xmlhttpRequest` e `GM_setValue/GM_getValue`.

## Convenções sugeridas (confirmar com o dono)

- Documentação e textos de interface em português do Brasil.
- Identificadores de código (variáveis, funções, campos JSON) em inglês.
- Seletores do X: ancorar em padrões de URL (`/usuario/status/ID`), nunca em classes CSS geradas.

## Comandos

```bash
docker compose up -d                                          # API (127.0.0.1:8010) + Mongo
docker compose --profile test run --rm api-test               # testes da API
docker compose --profile test run --rm userscript-test       # testes do userscript
docker compose --profile test run --rm userscript-test sh -c "node build.js"   # regenera notixias.user.js
./scripts/e2e.sh                                              # contrato cliente JS <-> API
docker compose --profile test run --rm robot-test            # testes do robô (agenda, laço; e2e se E2E_API_KEY estiver definida)
```

- Depois de editar `userscript/src/*`, **sempre** regenerar `userscript/notixias.user.js` (há um teste que falha se estiver desatualizado).
- O código da API é montado por volume no compose de dev; `docker run` avulso da imagem usa o código antigo da build.
- As fixtures de DOM dos testes são sintéticas; não tratá-las como a estrutura real do X.

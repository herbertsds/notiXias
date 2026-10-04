# CLAUDE.md — notiXias

Leia `README.md` e `docs/` antes de qualquer trabalho. Os documentos refletem decisões já tomadas pelo dono; não as rediscuta sem motivo novo.

## Regras do projeto

- **Não escreva código de implementação até o dono pedir explicitamente.** A fase atual é documentação/planejamento.
- Desenvolvimento **local** (Docker no Mac). Só mexer no servidor Oracle quando o dono pedir, e então apenas o que for do notiXias.
- **Nunca tocar** nos containers/volumes/redes de outros projetos no servidor (`contagem_carboidratos_*`, `keycloak*`, `nginx_proxy_manager`, `portainer`). Mongo do notiXias é **sempre um container próprio**.
- **Nunca** versionar segredos (`.env`, chave de API, chaves SSH). O userscript não contém a chave; ela vive no armazenamento do gerenciador de scripts.
- Nenhuma automação de login no X. O dono se autentica manualmente no navegador.
- Não guardar texto de posts nem mídia; apenas IDs, links, autor e metadados de captura.

## Stack decidida

- Backend: Python + FastAPI, MongoDB, tudo em Docker (imagens multi-arquitetura: o servidor é ARM/aarch64).
- Cliente: userscript (Tampermonkey no Chrome do Mac; app Userscripts no Safari do iPhone), usando `GM_xmlhttpRequest` e `GM_setValue/GM_getValue`.

## Convenções sugeridas (confirmar com o dono)

- Documentação e textos de interface em português do Brasil.
- Identificadores de código (variáveis, funções, campos JSON) em inglês.
- Seletores do X: ancorar em padrões de URL (`/usuario/status/ID`), nunca em classes CSS geradas.

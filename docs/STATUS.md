# STATUS — o que foi feito, testado e o que falta validar

Atualizado em 2026-10-04. Escopo executado: **Fases 0 a 4** + **ajustes de layout mobile (userscript 0.2.0)**, somente local. Nada foi feito no servidor Oracle, no Chrome ou no X.

## Resumo

| Fase | Situação | Verificação |
|---|---|---|
| 0 — Ambiente Docker local | Concluída | `docker compose up` sobe API + Mongo; testes rodam em container |
| 1 — API + Mongo | Concluída | **59 testes** automatizados passando |
| 2 — Userscript: leitura | Código escrito | Partes puras testadas; **fluxo no navegador não validado** |
| 3 — Userscript: captura/busca | Código escrito | Scanner testado com feed simulado; **não validado no X real** |
| 4 — Threads/respostas | Código escrito | Lógica de decisão testada; **não validado no X real** |
| 5, 6, 7 (refinos, deploy, iPhone) | Não iniciadas | Fora do escopo desta rodada |

Commits (um por fase): `git log --oneline`.

## Como rodar

```bash
# subir API + Mongo (API em http://127.0.0.1:8010, docs em /docs)
docker compose up -d

# testes da API (usa o banco notixias_test; nunca toca no banco de uso)
docker compose --profile test run --rm api-test

# testes do userscript (instala jsdom no container na primeira vez)
docker compose --profile test run --rm userscript-test

# regenerar o userscript depois de editar userscript/src/*
docker compose --profile test run --rm userscript-test sh -c "node build.js"

# teste de contrato: cliente JS real contra a API real, em banco descartável
./scripts/e2e.sh
```

## Segredos locais (fora do Git)

- `.env` (hash da chave: `API_KEY_HASH`) e `.secrets/dev_api_key.txt` (a chave em claro, só para você colar no script). Ambos estão no `.gitignore`; confirme com `git check-ignore -v .env .secrets`.
- A chave é **de teste local**. Gere outra para produção com `python3 scripts/gen_key.py`.

## O que foi implementado

### API (`api/`)
- FastAPI + pymongo, Docker (Python 3.12, usuário não-root, imagens ARM/x86).
- Autenticação por chave (hash SHA-256, comparação em tempo constante, 401 idêntico para qualquer falha).
- Rotas de `docs/04-api.md`: `state`, `queue`, `queue/anchor`, `queue/append`, `entries`, `entries/cover`, `entries/uncover`, `views`, `health/skeleton`, `export`, `/healthz`.
- Regras: ordem por `seq`, dedupe por chave de aparição, merge de reposts não lidos, repost de lido = nova entrada, `gap_before`, idempotência por `batch_id`, visualização única por entrada, cobertura restrita a não lidas do mesmo autor, remoção só lógica.
- `/docs` e `/openapi.json` desligados com `ENV=prod`.

### Userscript (`userscript/`)
- `src/core.js` (lógica pura), `src/xdom.js` (único módulo que conhece o X), `src/scanner.js`, `src/api.js`, `src/ui.js` (Shadow DOM), `src/main.js` (orquestração), `build.js` → `notixias.user.js` (gerado; **este é o arquivo a instalar**).
- Âncora de posts por URL `/usuario/status/ID` + `<time>`; repostador pelo href do perfil; esqueleto de falha **sem texto**.
- Chave e URL da API ficam em `GM_setValue`; comunicação com a API via `GM_xmlhttpRequest`. O bundle não usa o armazenamento do x.com (testado).
- O bundle não contém ação de escrita no X; o único clique programático em elemento do X é o da aba "Seguindo" (testado).

## O que foi testado

- **API (59 testes, Mongo real em container):** autenticação; ordem de leitura; ordem por captura (não por ID); dedupe; merge de reposts; repost de lido vira nova entrada; "já visto" entre entradas do mesmo post; `gap_before`; idempotência; âncoras; paginação `after/before`; validação de entradas inválidas; estado com concorrência otimista; cursor inexistente; visualizações únicas e cobertura automática; cobertura (só não lidas, mesmo autor, sem maiúsculas); reabrir cobertas; remoção lógica; skeleton; export; healthz 503; `/docs` desligado em prod; escritas concorrentes (160 entradas em 8 threads sem colisão de `seq`; mesma aparição em 6 threads sem duplicar).
- **Userscript (67 testes, jsdom/Node; os 46 iniciais + barra, etiquetas e detecção da barra do X):** parse de URLs; reposter pelos dois formatos de markup; anúncio ignorado; citação; thread (cadeia contígua do mesmo autor, ID crescente, posts independentes não agrupados); etiquetas e formatação de data; scanner com feed virtualizado simulado (âncora, backfill, fim do feed, limites, cancelamento, sem duplicar); cliente da API; UI (botões, menu, overlays); esqueleto sem texto/ID/handle; bundle atualizado e sem segredos.
- **Contrato (`scripts/e2e.sh`):** o cliente JS conversando com a API real num fluxo completo (primeira busca, leitura, visualização, cobertura, segunda busca com âncora, repost de post lido com etiqueta, 401, export).

## O que NÃO foi testado (precisa de você, no X, com a sua conta)

Tudo abaixo depende do X real. As fixtures dos testes são HTML **sintético** que imita a estrutura conhecida do X, não capturas reais.

### Instalação
1. `docker compose up -d`.
2. Chrome: instalar a extensão Tampermonkey. Se o Chrome pedir, habilitar "Permitir scripts de usuário" (ou modo desenvolvedor) nos detalhes da extensão.
3. Criar um script novo no Tampermonkey e colar o conteúdo de `userscript/notixias.user.js`.
4. Abrir `https://x.com/home` logado. O script pergunta a URL da API (`http://localhost:8010`) e a chave (conteúdo de `.secrets/dev_api_key.txt`). Aceitar o pedido de permissão de conexão do Tampermonkey (`@connect localhost`).

### Checklist de validação
- [ ] **Selecionar "Seguindo":** em `/home` o script clica a 2ª aba por posição. Confirmar que é "Seguindo" (se a ordem das abas for outra, ajustar `tab_index` pelo menu "Trocar feed…").
- [ ] **Primeira busca** (fila vazia): a tela escura cobre tudo, o contador sobe, termina em ~40 posts e abre o mais antigo. Você não rola nada.
- [ ] **Reconhecimento de posts:** os posts capturados correspondem ao que aparece no feed (conferir 5 ao acaso pelo link).
- [ ] **Repost:** a etiqueta "↻ @conta repostou" aparece e a conta é a certa.
- [ ] **Navegação interna** (`go()`): "Próxima" troca de post sem recarregar? Se a página recarregar ou travar, desligar em menu → "Navegação interna: não" e me avisar.
- [ ] **Rolagem ao topo** da página do post: revela o post respondido/a cadeia acima; para de rolar quando você mexe.
- [ ] **Próxima/Anterior:** posição "n / total" correta; fechar e reabrir o navegador retoma no mesmo post (abrindo `x.com/home`).
- [ ] **Já visto:** depois de avançar, um post repostado de novo mostra "👁 Visto em dd/mm/aaaa às hh:mm".
- [ ] **Segunda busca:** ao acabar a fila (ou menu → "Buscar novas agora"), o script rola até reencontrar o último post guardado e traz só o novo. Verificar se avisa lacuna quando deveria.
- [ ] **Thread real** (3+ posts): abre o 1º, salta para o último e rola ao topo; "⛓ inclui N posts" bate com o que aparece. Posts seguidos **independentes** do mesmo autor NÃO devem ser agrupados.
- [ ] **"Reabrir posts cobertos"** devolve os pedaços (use ◀ para vê-los).
- [ ] **Falha de captura:** (opcional) simular desligando a internet ou mudando `feed` para uma página sem posts; deve aparecer "⚠ A captura falhou" com "Copiar esqueleto".
- [ ] Observar se o X exibe qualquer verificação/aviso durante a rolagem; se sim, parar e me contar.

### Riscos de ajuste mais prováveis (por ordem)
1. **Reconhecimento do repostador** (`data-testid="socialContext"` e link de perfil): suposição sobre o markup atual do X.
2. **Seleção da aba "Seguindo" por posição** em `/home`.
3. **Navegação interna** com `pushState` + `popstate`: pode não ser aceita pelo roteador do X; o fallback abre a página normal depois de 7 s (se não, desligar no menu).
4. **Tempos de espera** (2 s antes de olhar a thread, 3 s de "rolar ao topo") talvez precisem de ajuste.
5. **Thread**: a página do X pode esconder respostas atrás de "mostrar mais"; nesse caso o último pedaço visível não é o último real.

## Decisões minhas durante a implementação (confirme ou mande mudar)

- **Porta local da API: 8010** (a 8000 do seu Mac já estava ocupada por outro serviço; não mexi nele). Configurável por `API_HOST_PORT`.
- **Índice único em `appearance_keys`** (o doc previa multikey simples): impede duplicar a mesma aparição mesmo em escritas concorrentes.
- **`POST /views` marca também as entradas cobertas** pela entrada vista (antes o doc deixava isso para o cliente).
- **Campos novos na API:** `next_seq` e `position` no estado, `covered_count` na entrada, `before` na fila, rota `entries/uncover` (documentados em `04-api.md`).
- **Retomada automática:** abrir `x.com/home` (o feed configurado) com a fila ativa leva direto ao post atual (ou ao próximo, ou dispara busca). Desligável pelo menu ("Retomar automaticamente").
- **Cursor guardado no servidor**, não no navegador (sincroniza entre aparelhos desde já). O navegador guarda só configuração, a fase da busca e o post em exibição.
- **Atalhos:** Alt+→ (próxima) e Alt+← (anterior).
- **Sem deslizar com o dedo** nesta versão (conflita com a rolagem).
- Aviso do `httpx`/`starlette` nos testes ("use httpx2") é só deprecação de biblioteca, sem efeito.

## Atualização 0.2.0: layout mobile (pedido do dono)

Implementado e coberto por testes (jsdom), **não validado no X real**:

- Barra inferior **40% / 20% / 40%** que substitui a do X, **reservando espaço** na página; barra do X escondida por heurística.
- Centro com posição + avisos; **toque** alterna leitura/navegação (🏠 🔔 ✉️ e ⋯); **pressão longa** abre o menu.
- **Mão** (ambas / esquerda / direita, ~65%) e **botões** (ambos / só avançar / só voltar) no menu ⋯.
- **Etiquetas dentro do post** da fila (primeiro filho) e **aviso de repost** no topo do primeiro post da tela quando o repostado vem depois.
- **Não feito (inviável):** "sempre redirecionar para a versão mobile". O X decide o layout pela largura da janela; no iPhone já é o padrão. Em `docs/03-userscript.md`.

**Reinstalar o script:** `pbcopy < userscript/notixias.user.js`, abra o script no Tampermonkey, apague tudo, cole (versão 0.2.0) e salve. Suas configurações (API/chave) ficam guardadas.

Checklist extra (janela estreita do Chrome, ~400px de largura, ou o iPhone depois):
- [ ] A barra de navegação inferior do X **some** e a nossa aparece no lugar; o fim da página não fica escondido atrás dela.
- [ ] Tocar no centro alterna entre ◀ ▶ e ⋯ 🏠 🔔 ✉️; pressão longa abre o menu.
- [ ] Menu → "Mão": esquerda/direita deixa a barra com ~65% de largura colada ao lado; "Botões": só avançar / só voltar.
- [ ] Avisos ("N novos", "Você está em dia") aparecem no centro e somem sozinhos.
- [ ] A etiqueta aparece **dentro do post da fila**, antes do perfil/foto, e não some quando o X redesenha.
- [ ] Post repostado com cadeia acima: o primeiro post da tela mostra "↻ uma mensagem dessa thread foi repostada por @…".
- [ ] 🏠 volta ao feed (e a leitura retoma): é o comportamento que você quer?

## Pendências herdadas (ver `09-decisoes-e-pendencias.md`)

P1 (transição visual do salto de thread), P2 (navegação interna funciona?), P3 (respostas entre contas diferentes, desligado), P5 a P8 (deploy e iPhone), P9 (abas de `/home`), P10 (`reply`/`quote`).

## Próximos passos sugeridos

1. Você rodar o checklist acima e me mandar o que falhou (e o esqueleto, se houver).
2. Eu ajustar `xdom.js`/tempos com base no que o X realmente entrega; trocar as fixtures sintéticas por reais anonimizadas.
3. Só então: refinos (Fase 5), deploy (Fase 6) e iPhone (Fase 7).

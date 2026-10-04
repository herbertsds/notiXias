# 03 — Userscript

Arquivo único (inicialmente): `userscript/notixias.user.js`. Roda em `https://x.com/*` (e `twitter.com`, que redireciona).

## Ambiente

| Plataforma | Gerenciador | Observação |
|---|---|---|
| Chrome (Mac) | Tampermonkey | Primeira plataforma de desenvolvimento e teste. Pode ser necessário habilitar o modo desenvolvedor / "permitir scripts de usuário" no Chrome. |
| Safari (iPhone) | App **Userscripts** | Fase posterior. Chrome do iOS não aceita extensões. |

### Metadados e permissões

- `@match`: `https://x.com/*`, `https://twitter.com/*`
- `@run-at`: `document-idle`
- `@grant`: `GM_xmlhttpRequest`, `GM_setValue`, `GM_getValue`, `GM_deleteValue`
- `@connect`: host da API (`localhost` no desenvolvimento; o domínio do servidor depois)

**Por quê `GM_xmlhttpRequest`:** a política de segurança do x.com bloqueia `fetch` da página para outros domínios. O `GM_xmlhttpRequest` roda fora do alcance da página e não sofre esse bloqueio. Também mantém a chave de API fora do alcance de qualquer código do X.

**Por quê `GM_setValue/GM_getValue`:** o armazenamento é do gerenciador de scripts, não do `localStorage` do x.com. Ali ficam a chave da API e a URL da API.

> Consequência: com `@grant` ativo, o script roda em um sandbox. Ele **lê o DOM normalmente**, mas não intercepta `fetch`/XHR da página. Isso é compatível com a decisão de não usar o JSON interno do X.

## Configuração

| Chave | Padrão | Descrição |
|---|---|---|
| `apiBaseUrl` | `http://localhost:8010` | Base da API. Pedido na primeira execução. |
| `apiKey` | — | Chave da API. Pedida na primeira execução; **nunca** escrita no arquivo. |
| `feedUrl` | `https://x.com/home` | Feed. Para uma Lista: `https://x.com/i/lists/<ID>`. |
| `feedTabIndex` | `1` | Aba (0-based) a selecionar em `/home`. `1` = "Seguindo". `null` para listas. |
| `initialBackfill` | `40` | Posts a capturar na primeira busca, quando a fila está vazia. |
| `maxSteps` | `150` | Máximo de passos de rolagem por busca. |
| `maxCollect` | `400` | Máximo de aparições por busca. |
| `stepDelayMs` | `[900, 1700]` | Pausa aleatória entre passos. |
| `stepSize` | `0.7 × altura da janela` | Distância de cada rolagem. |
| `anchorDepth` | `10` | Quantas entradas finais da fila fornecem âncoras. |
| `prefetch` | desligado | Reservado (cartão próprio / imagens), fora do escopo inicial. |

Trocar o feed deve ser um menu simples ("Trocar feed…") que grava `feedUrl`/`feedTabIndex`. Selecionar a aba "Seguindo" por **posição** (não por texto) evita depender do idioma.

## Módulos

Manter a dependência da estrutura do X isolada:

1. **`x-dom` (único módulo que conhece o X):** leitura de posts, reposters, abas, esqueleto.
2. **`scanner`:** rolagem e coleta.
3. **`queue`:** lógica de posição, próxima/anterior, cobertura de threads.
4. **`api`:** cliente da API (via `GM_xmlhttpRequest`).
5. **`ui`:** tela de busca, barra flutuante, menus, avisos.
6. **`state`:** máquina de fases e persistência local mínima.

## `x-dom`: como reconhecer posts

### Princípio

Ancorar no que é visível e estável para o usuário, **nunca em classes CSS** (geradas, mudam a cada versão).

### Âncoras, da mais para a menos estável

1. **Link do post:** `<a href="/<usuario>/status/<ID>">` que contenha um `<time>`. Padrão de caminho: `^/([^/]+)/status/(\d+)$`.
2. **Elemento `<time>`** dentro do link (distingue o post de links soltos no texto).
3. **`article[data-testid="tweet"]`** como contêiner (pista, não requisito).
4. **`article`** semântico como reserva.

Em cada `article`, o **primeiro** link que cumpre (1)+(2) é o post principal; links posteriores pertencem a posts citados dentro dele.

### Dados extraídos por post

| Campo | Fonte |
|---|---|
| `tweet_id` | grupo numérico do link do post |
| `author` | primeiro segmento do caminho do link |
| `url` | `https://x.com/<author>/status/<tweet_id>` |
| `reposter` | link de perfil (`^/[^/]+$`) dentro de `[data-testid="socialContext"]`, se diferente de `author` |
| `kind` | `repost` se há `reposter`; senão `post` (refinar depois: `reply`, `quote`) |
| `appearance_key` | `<tweet_id>\|<reposter em minúsculas ou vazio>` |

O repostador é lido pelo **href do perfil**, não pelo texto da frase ("fulano repostou"), para independer de idioma. Se o contexto social não tiver link de perfil (ex.: "Fixado"), não é repost.

Anúncios não têm link de post com `<time>` e são descartados naturalmente.

### Verificador de saúde

Falha se:
- o feed não mostra nenhum `article` em até ~15 s; ou
- existem `article`s, mas nenhum deles resulta em post reconhecido; ou
- uma busca termina com zero aparições e a fila local estava vazia.

Ao falhar: interrompe a fase de busca, gera o **esqueleto** do primeiro `article` (tags, `data-testid`, `role`, padrão de `href` com IDs/usuários mascarados; **sem texto**, profundidade ≤ 14, ≤ 400 nós), envia a `POST /health/skeleton` e mostra um aviso com botão "copiar esqueleto". Nunca falhar em silêncio.

## `scanner`: busca de novas

```
entrada: chaves âncora (últimas N entradas)
saída:   sequência de aparições (do mais novo ao mais antigo), anchorFound
```

1. Rola ao topo; espera ~800 ms.
2. Em cada passo, lê os posts visíveis em ordem de DOM; para cada um:
   - se já visto neste scan, ignora;
   - se a `appearance_key` está nas âncoras → `anchorFound = true`, para;
   - senão, adiciona à sequência.
3. Condições de parada: âncora encontrada; (fila vazia e `initialBackfill` atingido); `maxCollect`; fim do feed (altura estável por 3 passos); `maxSteps`.
4. Rola `stepSize` e espera um tempo aleatório em `stepDelayMs`.
5. Mostra progresso na tela própria; botão "Cancelar".

O feed é virtualizado (só os posts perto da tela estão no DOM), por isso a leitura é feita **a cada passo**.

## `queue`: leitura e cobertura

- **Posição:** vem da API (`GET /state`) e é atualizada em cada mudança de entrada.
- **Próxima:** marca visualização da atual e das cobertas por ela; vai para a próxima não coberta; se não houver, dispara busca.
- **Anterior:** volta à entrada anterior não coberta (não desfaz visualizações).
- **Entradas cobertas** são puladas na navegação.

### Threads e respostas (cobertura)

Preferência do dono: abrir o **último post** da thread; o mesmo para respostas (a resposta mostra o post respondido acima). A tela sempre rola ao topo para revelar a cadeia.

Verificação na hora de exibir a entrada `E`:

1. Aguarda a página de `E` renderizar (`article` presente) e ~2 s adicionais.
2. Lê, em ordem de DOM, os posts da página. A partir do post focal (`E.tweet_id`), percorre os seguintes **enquanto o autor for o mesmo** (cadeia contígua do autor).
3. Se há pelo menos um pedaço após o focal, o **último** da cadeia é o destino: navega para ele e rola ao topo.
4. Depois de a página de destino renderizar, coleta os IDs de posts **efetivamente presentes** no DOM. Para cada entrada **não lida** da fila com esse ID e mesmo autor: `covered = true`, `covered_by = <entrada de destino>`.
5. A barra mostra "inclui N posts desta thread".

Regras de segurança contra pular posts:

- **Só a conversa conta.** `xdom.pageItems` lê apenas a coluna principal e **para no primeiro título de seção** depois do primeiro post ("Descubra mais"...). Tudo depois é recomendação do X, mesmo do mesmo autor e com ID maior (causa do bug visto em 2026-10-04: saltava para um post de outra conversa e o marcava como coberto/visto).

- **Nunca** agrupar por vizinhança na lista (mesmo autor/horário). Só o que aparece encadeado na página.
- Só marcar como coberto o que está **no DOM** da página final.
- Pedaços escondidos por "mostrar mais" **não** são cobertos e permanecem na fila.
- Cobertura é **reversível** (menu "reabrir cobertos").
- Respostas entre contas **diferentes**: absorção opcional, **desligada por padrão**.
- Pedaço novo de thread já lida → nova entrada, com a etiqueta de continuação.

> A experiência do salto (mostrar brevemente o post 1 ou uma tela de "carregando") fica como pendência para ajuste na prática.

## Navegação

- **Objetivo:** não recarregar o código do X a cada post.
- **Mecanismo 1 (preferencial):** navegação interna do roteador do X (por exemplo, mudar o histórico e notificar o roteador). **Precisa ser validado na prática**; pode não funcionar de forma confiável.
- **Mecanismo 2 (fallback):** `location.assign(url)`. Como a página recarrega e o script reinicia, **o estado de fase precisa ser persistente** (API + cache mínimo do gerenciador), para retomar sozinho.
- A decisão entre 1 e 2 é encapsulada numa função `go(url)`, para trocar sem tocar no resto.

### Pós-carregamento de uma página de post

- Esperar o `article` principal; rolar ao topo repetidamente por ~3 s a cada ~150 ms, **parando assim que o dono interagir** (roda, toque, tecla, clique), para não brigar com ele nem com o X (que rola até o post focal sozinho).

## Máquina de fases

| Fase | Significado |
|---|---|
| `idle` | Lendo normalmente. |
| `fetching` | Em busca de novas (tela própria visível, feed sendo rolado). |
| `error` | Verificador de saúde falhou; aguardando ação do dono. |

Transições: `idle → fetching` (fila acabou ou "Buscar novas"); `fetching → idle` (sucesso); `fetching → error` (falha); `error → idle` (dono resolve/cancela). Se a fase for `fetching` mas a página atual não for o feed, mostra botão "Continuar busca" (nunca redireciona em loop).

Se a página for de login (`/i/flow/login`, `/login`), o script não age.

## UI (versão 0.2)

### Barra inferior (substitui a barra de navegação do X)

- Fica fixa no rodapé e **reserva espaço** no fim da página (`padding-bottom` no `<html>`, medido por `ResizeObserver`), então não tapa conteúdo.
- A barra de navegação inferior do X é **escondida** (menu "Barra do X"). Ela é reconhecida pelo comportamento, não por classe: um `<nav>` dentro de um contêiner `position: fixed`, colado embaixo e largo (`xdom.findBottomBars`).
- **Modo leitura:** `◀` 40% · centro 20% · `▶` 40%. O centro mostra a posição ("4 / 9") e, acima dela, o aviso do momento ("12 novos · ⚠ pode haver lacuna", "Você está em dia"), que some em ~6 s.
- **Modo navegação:** `⋯` · 🏠 · centro · 🔔 · ✉️ (cada 20%). 🏠 volta ao feed (e a retomada automática reabre a leitura).
- **Alternar o modo:** tocar no centro. **Pressão longa** no centro abre o menu em qualquer modo.
- Quando a fila acaba, `▶` vira `⟳` (buscar novas).

### Configurações (salvas no gerenciador de scripts; menu `⋯`)

| Opção | Valores | Efeito |
|---|---|---|
| Mão | ambas (largura total) · esquerda · direita | Nas duas últimas a barra ocupa ~65% da largura, colada ao lado escolhido (uso com uma mão). |
| Botões | ambos · só avançar · só voltar | Com um só botão: 80% / centro 20%. |
| Barra do X | escondida · visível | |
| Retomar automaticamente, Navegação interna | sim · não | |

### Etiquetas dentro da página (`src/labels.js`)

Estilo do "fulano repostou" nativo do X: **texto cinza discreto, largura inteira, acima do avatar e do nome**, sem fundo colorido; `@fulano` é link para o perfil.

- **Faixa do post da fila:** "↻ repostado por @…", "👁 Visto em…", "⛓ inclui N posts desta thread", "⚠ pode haver posts não capturados…" (esta em âmbar).
- **Aviso de repost no topo da tela:** se o post repostado **não** é o primeiro da página (há cadeia acima), o primeiro post ganha "↻ uma mensagem dessa thread foi repostada por @fulano". Se o primeiro já é o repostado, só a faixa dele aparece.
- **Posição no DOM:** a faixa é **irmã imediatamente anterior ao `<article>`**, e não filha. Os filhos do `article` do X ficam lado a lado, então um filho novo virava uma coluna estreita (defeito visto na 0.2.0 e corrigido na 0.2.1).
- O X redesenha posts o tempo todo: um `MutationObserver` reexecuta `Labels.sync`, que é **idempotente** (só escreve no DOM se algo mudou), então não há laço de mutação.
- A página sempre abre e rola ao topo (`pinTop`).

### Datas

Formato brasileiro: `dd/mm/aaaa às hh:mm`, fuso do aparelho. A API guarda em UTC.

### Fora do escopo: "sempre abrir a versão mobile"

O X escolhe o layout mobile pela **largura da janela**; um userscript não consegue alterar a largura nem o user-agent. No iPhone o layout mobile já é o padrão. No computador, é preciso uma janela estreita.

## Discrição e ritmo

- Rolagem só quando o dono dispara (fila acabou ou botão).
- Passos moderados, pausas aleatórias, limites de passos e posts.
- Somente leitura: nunca clicar em curtir, repostar, seguir ou postar.
- Nunca automatizar login; o dono entra manualmente no X.
- Se o X exibir verificação, captcha ou aviso, **parar** e avisar. Nunca tentar contornar.

## Comunicação com a API

- Toda chamada via `GM_xmlhttpRequest`, com `Authorization: Bearer <apiKey>` e `Content-Type: application/json`.
- Erros 401 → pedir a chave de novo. Erros de rede → aviso e nova tentativa manual; a leitura local atual continua possível.
- Idempotência: reenviar o mesmo lote não duplica (ver `04-api.md`).

## Testes do userscript

- **Unitários (sem navegador):** funções puras (parse de href, chaves de aparição, ordenação, cálculo de próxima/cobertas) isoladas em funções testáveis.
- **Fixtures de DOM:** HTML de `article` anonimizado, guardado em `userscript/tests/fixtures`, para testar o `x-dom` offline.
- **Manual, com a conta do dono:** checklist em `08-roteiro.md`.

## Iphone (fase posterior)

- Instalar o app **Userscripts**, habilitar a extensão no Safari, apontar a pasta de scripts.
- `@connect` para o domínio HTTPS do servidor (o Safari bloqueia conteúdo misto).
- Verificar compatibilidade de `GM_xmlhttpRequest` e `GM_setValue` no Userscripts.
- Aba precisa ficar em primeiro plano durante a busca.

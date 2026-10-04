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
3. Condições de parada: **`knownRun` (5) itens conhecidos consecutivos _e_ `minKnown` (25) conhecidos no total** (ou todas as âncoras, se forem menos); a varredura profunda (menu) usa `minKnown` 100; (fila vazia e `initialBackfill` atingido); `maxCollect`; fim do feed (altura estável por 3 passos); `maxSteps`.
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
- Respostas entre contas **diferentes**: ao abrir uma resposta, **todos os posts acima dela** na conversa (de qualquer autor) que ainda estão por ler na fila viram o **mesmo registro** (`ancestor_ids` do `cover`); a tela já mostra a cadeia de cima para baixo. Descendentes de outro autor **não** são cobertos (podem ser ramos irmãos).
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


## Busca: por que não para no primeiro item conhecido (0.3.0)

O X **reagrupa conversas**: quando um post antigo ganha respostas, ele sobe no feed junto delas, ficando *acima* de posts novos. Parar no primeiro item conhecido fazia a busca perder tudo que ficava abaixo dele (6 posts reais foram perdidos assim em 2026-10-04). Agora:

- a busca só termina após `knownRun` conhecidos seguidos **e** `minKnown` conhecidos no total (cobre conversas que sobem abaixo de uma sequência longa de conhecidos);
- as âncoras são as últimas **100** entradas; o scanner devolve também os itens conhecidos (contexto para reconhecer conversas);
- se o X demora a desenhar, o scanner espera alguns instantes antes de rolar mais (não pula posts);
- menu "Buscar novas (varredura profunda)" para recuperar lacunas antigas.

### Conversas no feed

`Core.clusterize`: corrida de itens **consecutivos, sem reposts, com ID crescente de cima para baixo** = conversa (raiz, respostas). Verificado com o Seguindo real: `[703, RicardoPF, venecasagrande]` e `[militaofernand, flamengomeumund, flamengomeumund]` aparecem assim. Cada conversa vira **um registro** com a última resposta como referência; ao abrir a página da referência o script cobre os posts acima dela (`ancestor_ids`) e chama `settle` para confirmar o que a página mostra e soltar o resto.


## Ordem padrão da fila (0.3.1)

- A fila **não segue o reagrupamento do X** para o que você ainda não leu: se o post do João (10h) não foi lido e o José responde às 12h, o registro continua na posição das 10h; só o **link** passa a abrir a resposta do José (a conversa inteira aparece, de cima para baixo).
- **Exceção:** se o post do João **já foi lido**, a resposta do José entra como registro novo no fim da fila (com o "Visto em" do que você já tinha visto).
- O script abre a página de `open_id` (a resposta mais recente), reconhece essa página como "da fila" e rotula/cobre a partir dela.


## 0.4.0: nome de quem repostou e ordem por horário

- A etiqueta mostra o **nome de exibição** de quem repostou (link para o perfil). O nome é lido do elemento com `dir` dentro do contexto social do post (`<span dir="ltr">Nome</span> repostou`), então independe do idioma; sem ele, aparece o `@`.
- Novas entradas entram **entre as não lidas, pelo horário do tweet original** (ver `04-api.md`, "Posição na fila"). O script só pergunta "qual é a próxima" e abre a primeira não lida depois do cursor.


## 0.5.0: contas seguidas

- **Leitura completa (uma vez):** o script abre `x.com/<seu usuário>/following`, rola até o fim da lista (esperando a rolagem infinita carregar) e envia a lista para a API. Dispara sozinho na primeira busca, se a lista nunca foi lida e não falhou nas últimas 24 h, e a qualquer hora pelo menu **Atualizar contas seguidas**. A lista só substitui a anterior se a leitura **terminou**; cancelar ou estourar o limite não sobrescreve nada. Seu @ vem do link do perfil na navegação do X (`AppTabBar_Profile_Link`); o guardado só vale se a página não o mostrar.
- **Ao vivo:** o script observa os botões `data-testid="<id>-follow|unfollow"`. Depois de um clique (e, para deixar de seguir, depois de confirmar na janela do X), espera o **resultado** (o botão trocar de "seguir" para "seguindo" ou o contrário) e só então envia `add`/`remove` para a API. Cancelar a confirmação não registra nada. O @ vem do cartão do usuário, do cartão que aparece ao passar o mouse ou da URL do perfil; se não der para saber, marca a lista como possivelmente desatualizada (⚠ no menu) em vez de adivinhar. Operações que falham ficam numa fila local e são reenviadas depois.
- **Lembretes:** a barra avisa quando a lista nunca foi lida ou tem mais de 30 dias.
- Mudanças feitas **fora** do script (app do X no celular, outro navegador) não são vistas: use o botão do menu.
- Nunca clica em nada: só lê a página e escuta os cliques seus.


## 0.5.1: lacunas e "Ver novos posts" na busca

O que foi confirmado na página real: o botão do topo é `<button>` com `data-testid="pillLabel"` ("Ver novos posts"); o "Mostrar mais" que aparece é `tweet-text-show-more-link` e fica **dentro** de um post (só expande texto longo, não esconde posts). **Células de lacuna entre posts não puderam ser reproduzidas** (a conta de teste segue poucas contas), então o tratamento é genérico e conservador:

- No início da busca, clica em **"Ver novos posts"** se existir (inclui o que chegou depois de o feed carregar).
- Durante a rolagem, se há na tela uma **célula sem post, sem usuário, sem links e com UM botão** de texto curto que bate numa lista fechada (`Mostrar mais`, `Show more`, `Ver mais`, `Load more`, `Mostrar N posts`...), clica nele e **relê o mesmo trecho** antes de rolar. Nunca clica em promoções ("Inscrever-se"), "Quem seguir", botões de seguir, células com links, nem no "Mostrar mais" de dentro de um post.
- Até 40 cliques por busca. Se uma lacuna **não puder ser aberta** (limite), a busca marca `anchor_found = false`: a primeira entrada nova recebe `gap_before` e a barra avisa "pode haver lacuna" — nada é pulado em silêncio.
- Os posts de uma lacuna recém-aberta entram **no meio**, na ordem do feed (cada item novo é inserido junto do vizinho que o X mostra acima dele).
- Se o X usar outro texto/estrutura para a lacuna, o botão não é reconhecido e a busca segue como antes; nesse caso mande o esqueleto/captura para eu incluir.


## 0.6.0: comandos pela URL (atalho do iPhone, favoritos)

O script entende o parâmetro `nx` na URL do X e executa o comando assim que a página carrega (e limpa o parâmetro da barra de endereço, então recarregar a página não repete a ação). O comando vale por 2 minutos depois da abertura.

| URL | Efeito |
|---|---|
| `https://x.com/home?nx=update` | Busca novas (igual a "Buscar novas agora"). |
| `https://x.com/home?nx=deep` | Busca com varredura profunda. |
| `https://x.com/home?nx=following` | Lê/atualiza as contas seguidas. |
| `https://x.com/home?nx=read` | Continua a leitura. |

Valores desconhecidos são ignorados (e removidos da URL). Todos só fazem o que você já faria pelo menu; nada é destrutivo.

### Atalho no iPhone (app Atalhos)
1. Atalhos → **+** → ação **Abrir URLs** → URL `x-safari-https://x.com/home?nx=update`.
2. Dar um nome (ex.: "Atualizar notícias") → ⓘ → **Adicionar à Tela de Início**.
3. Opcional: **Automação** → "Hora do dia" → **Executar o Atalho** (sem pedir confirmação, se o iOS permitir) nos horários desejados.

Por que `x-safari-https://` e não `https://`: um link `https://x.com/...` aberto de outro app costuma ir para o **app do X** (links universais), onde o script não roda. O esquema `x-safari-https://` força o **Safari**. Se o iOS não aceitar, alternativas: um favorito do Safari com a URL (abre direto no Safari) ou colar a URL no Safari.

O script só roda no Safari (extensão Userscripts), não no app do X nem em aplicativos "adicionados à Tela de Início" como web app.

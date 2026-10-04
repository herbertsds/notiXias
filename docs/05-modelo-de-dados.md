# 05 — Modelo de dados (MongoDB)

Banco: `notixias`. Nenhum texto ou mídia de post é guardado (RNF7).

## Coleções

### `entries` — fila de leitura

Uma entrada por post original (com possíveis reposters). A ordem de leitura é `seq` crescente.

| Campo | Tipo | Descrição |
|---|---|---|
| `_id` | ObjectId | |
| `seq` | int (único) | Posição na fila; atribuída por contador atômico. Cresce na ordem de leitura. |
| `tweet_id` | string | ID do post original. |
| `url` | string | `https://x.com/<author>/status/<tweet_id>` |
| `author` | string | Autor do post original. |
| `reposters` | array\<string\> | Contas que repostaram (sem repetição). |
| `appearance_keys` | array\<string\> | Chaves `tweet_id\|reposter` já vistas nesta entrada. |
| `author_lc` | string | Autor em minúsculas (uso interno, comparação de cobertura). Não é exposto. |
| `kind` | string | `post` \| `repost` (refinável: `reply`, `quote`). |
| `captured_at` | date | Quando foi capturada. |
| `read_at` | date \| null | Preenchido ao sair com "próxima" (primeira vez). |
| `covered` | bool | Parte de outra entrada (thread). |
| `covered_by` | int \| null | `seq` da entrada que a cobre. |
| `members` | array\<string\> | Só na referência de uma conversa: `tweet_id` dos demais membros (inclusive já lidos); alimenta o "Visto em". |
| `cover_tentative` | bool | Cobertura ainda não confirmada pela página da referência (`settle`). |
| `gap_before` | bool | Pode haver posts não capturados antes desta. |
| `removed` | bool | Remoção lógica. |

Índices:
- `{ seq: 1 }` único
- `{ appearance_keys: 1 }` **único** (multikey) — dedupe e âncoras; garante que uma mesma aparição nunca pertença a duas entradas, mesmo com escritas concorrentes
- `{ tweet_id: 1, read_at: 1 }` — para merge com entradas não lidas
- `{ removed: 1, covered: 1, seq: 1 }` — para listar a fila

### `views` — histórico de visualizações

| Campo | Tipo | Descrição |
|---|---|---|
| `_id` | ObjectId | |
| `entry_seq` | int | Entrada em que foi visto. |
| `tweet_id` | string | Para consultar "já vi este post?" entre entradas distintas (reposts). |
| `viewed_at` | date | UTC. |

Índices: `{ tweet_id: 1, viewed_at: -1 }`, `{ entry_seq: 1 }` único (uma visualização por entrada; ver regra abaixo).

### `state` — estado de leitura (documento único `_id: "main"`)

| Campo | Tipo | Descrição |
|---|---|---|
| `cursor_seq` | int \| null | Entrada atual. |
| `feed` | objeto | `{ url, tab_index }` |
| `version` | int | Incrementado a cada alteração (concorrência otimista). |
| `updated_at` | date | |

### `counters` — contadores atômicos

`{ _id: "entries_seq", value: <int> }`, incrementado com `$inc` (`findOneAndUpdate`) para atribuir `seq` sem colisão entre aparelhos.

### `batches` — idempotência dos lotes

`{ _id: batch_id, result: {...}, created_at }`. TTL de 7 dias em `created_at`.

### `skeletons` — relatórios de falha de captura

| Campo | Tipo |
|---|---|
| `created_at` | date |
| `page` | string |
| `user_agent` | string |
| `skeleton` | string (≤ 200 KB, sem texto de posts) |
| `note` | string |

TTL de 90 dias.

## Regras de negócio

### Ordem

- `seq` representa a ordem de leitura. É atribuída ao criar a entrada, **na ordem em que o lote é processado** (do mais antigo ao mais novo).
- Não se usa o ID do post para ordenar. Reposts carregam o ID original, que é anterior.

### Chave de aparição

`appearance_key = tweet_id + "|" + lower(reposter ou "")`.

### Dedupe

Uma aparição cuja chave já está em `appearance_keys` de qualquer entrada é descartada (`skipped`).

### Merge de reposts

Para cada aparição nova (processada do mais antigo ao mais novo):

1. Procurar entrada com mesmo `tweet_id`, `read_at = null`, `removed = false` (preferir a de menor `seq` ainda não lida).
2. Se existe: `$addToSet` da chave em `appearance_keys` e do reposter em `reposters`. Não cria entrada.
3. Se não existe (ou a existente já foi lida): cria nova entrada, com `reposters = [reposter]` se houver.

**Repost de post já visto (regra das 2 horas):** se não há entrada não lida do tweet, olha-se a **última visualização** do `tweet_id`:
- há **mais de 2 h** (`REVISIT_AFTER_MINUTES`, padrão 120): o tweet volta como **nova entrada**; a etiqueta "Visto em…" vem das `views` do `tweet_id`;
- há **menos de 2 h**: **não** volta à fila. A aparição (`appearance_key`) e o reposter são registrados na entrada **mais recente** do tweet (`absorbed` na resposta), e a etiqueta "repostado por" os mostra (`all_reposters`).

### Visualizações

- Ao registrar `views`, cria uma visualização por `entry_seq` apenas se a entrada ainda não tem `read_at`; então define `read_at`.
- Reabrir uma entrada já lida (por "anterior") e sair de novo **não** cria visualização adicional.
- Entradas cobertas recebem visualização no mesmo momento da entrada que as cobre.
- "Já visto" de uma entrada = visualizações com mesmo `tweet_id` e `entry_seq` diferente do atual, ou do próprio se `read_at` existe. A API devolve a lista ordenada por data decrescente e a contagem.

### Cobertura (threads)

- `covered = true` só para entradas **não lidas**, do mesmo autor da entrada de destino, cujo `tweet_id` foi reportado como **presente no DOM** da página de destino.
- Reabrir: `covered = false` e `covered_by = null`.
- Entradas cobertas são ignoradas por `unread_after`, pela navegação e pelo total exibido.

### Lacunas

- `gap_before = true` na primeira entrada criada por um lote com `anchor_found = false`, quando a fila já tinha entradas.
- Nunca é limpo automaticamente; serve de registro.

### Remoção lógica

`removed = true` oculta a entrada de tudo (fila, contagens, merge). Nada é apagado. Operação restrita ao dono, via `PATCH`.

## Crescimento esperado

Algumas centenas de entradas por dia, ~200 bytes cada: ordem de dezenas de MB por ano. Sem necessidade de particionamento. Política de arquivamento fica fora do escopo inicial.

## Backup

Ver `07-ambiente-e-infra.md` (dump diário). O conteúdo é pequeno e valioso (histórico de leitura); o backup deve ser testado com restauração.

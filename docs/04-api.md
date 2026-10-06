# 04 — API (FastAPI)

Prefixo: `/api/v1`. JSON em UTF-8. Datas em ISO 8601 UTC.

## Autenticação

Toda rota, exceto `GET /healthz`, exige:

```
Authorization: Bearer <chave>
```

- A chave é comparada com o **hash** guardado em variável de ambiente (`API_KEY_HASH`), com comparação em tempo constante.
- Falha → `401 {"detail":"unauthorized"}` (resposta idêntica para chave ausente, malformada ou errada).
- Detalhes em `06-seguranca.md`.

## Convenções

- Erros: `{"detail": "<mensagem>"}`; validação (422) no formato padrão do FastAPI.
- IDs de post (`tweet_id`) são **strings numéricas** (`^\d{1,25}$`); nunca inteiros (excedem a precisão de JavaScript).
- `author` e `reposter`: `^[A-Za-z0-9_]{1,15}$` (handle do X), guardados como recebidos e comparados em minúsculas.
- Limites: lote máximo de 1000 aparições por requisição; corpo máximo ~1 MB.
- Sem exclusão física. Remoção = `removed: true`.

## Rotas

### `GET /healthz`

Sem autenticação. `200 {"status":"ok"}` se a API responde e consegue pingar o Mongo.

### `GET /api/v1/state`

Estado de leitura e resumo da fila.

```json
{
  "cursor_seq": 118,
  "current": { "...entrada com views e covered_count..." },
  "next_seq": 119,
  "position": 104,
  "unread_after": 14,
  "total_visible": 132,
  "feed": { "url": "https://x.com/home", "tab_index": 1 },
  "version": 57,
  "updated_at": "2026-10-04T12:00:00Z"
}
```

- `cursor_seq`: `seq` da entrada atual (`null` se ainda não começou a ler).
- `next_seq`: primeira entrada visível (não coberta, não removida) depois do cursor; `null` se não há.
- `position`: quantas entradas visíveis existem até o cursor (inclusive); `total_visible` é o total visível.
- `unread_after`: entradas não cobertas, não removidas, com `seq` maior que o cursor.

### `PUT /api/v1/state`

Atualiza cursor e/ou feed. Concorrência otimista pela `version`.

```json
{ "cursor_seq": 119, "feed": {"url":"...","tab_index":1}, "expected_version": 57 }
```

- `409` se `expected_version` não confere (outro aparelho avançou). Corpo: `{"detail": "version_conflict", "state": {...estado atual...}}`; o cliente decide (padrão: aceitar o estado do servidor se ele estiver à frente).
- `feed.url` só aceita `https://x.com/...` ou `https://twitter.com/...`.
- `cursor_seq` deve existir; caso contrário `422`.

### Contas seguidas — `/api/v1/accounts/following`

A lista exata de quem você segue; é ela que diz quem conta como "seguido" no horário de uma conversa (ver "Posição na fila"). Enquanto a leitura completa nunca foi feita, vale o que foi aprendido pelo feed.

- `GET ?include=true` → `{ count, last_full_at, updated_at, accounts?: [{handle, name}] }`. O `/state` traz o mesmo resumo em `following`.
- `PUT` `{ accounts: [{handle, name?}] }` → **substitui** a lista pela lida na página de Seguindo e grava `last_full_at`.
- `POST /add` `{ handle, name? }` e `POST /remove` `{ handle }` → atualização ao vivo, idempotentes (um `add` repetido sem nome não apaga o nome).

### `GET /api/v1/queue/anchor?depth=10`

Chaves de aparição das últimas `depth` entradas (por `seq` decrescente, incluindo cobertas).

```json
{ "keys": ["1840000000000000001|", "1840000000000000002|fulano"], "last_seq": 118 }
```

### `GET /api/v1/queue/gap?depth=25&max_age_days=3`

A lacuna aberta mais antiga ainda alcançável: `{ seq, keys, reason }` (`keys` = aparições das `depth` entradas capturadas antes dela; `seq: null` se não houver). `POST /queue/append` aceita `gap_seq`: uma busca que reencontrou esse "outro lado" fecha a lacuna; uma parcial a desloca para antes do item mais antigo que criou. (Preparado na API; o script ainda não usa.)

### `POST /api/v1/queue/append`

Recebe um lote de aparições em **ordem do feed** (mais nova primeiro), exatamente como o scanner as viu.

```json
{
  "items": [
    { "tweet_id": "1840000000000000009", "author": "conta_a", "reposter": null,    "kind": "post" },
    { "tweet_id": "1840000000000000004", "author": "conta_b", "reposter": "conta_c", "reposter_name": "Nome de Exibição", "kind": "repost" },
    { "tweet_id": "1840000000000000011", "author": "conta_d", "cluster": 1 },
    { "tweet_id": "1840000000000000012", "author": "conta_e", "cluster": 1 }
  ],
  "anchor_found": true,
  "batch_id": "b-2026-10-04T12:00:00Z-ab12",
  "scan": { "reason": "anchor", "steps": 42, "collected": 87, "gap_unresolved": 0 }
}
```

Comportamento (todas as regras em `05-modelo-de-dados.md`):

1. Inverte a ordem (processa do mais antigo ao mais novo).
2. Descarta aparições cuja `appearance_key` já existe em alguma entrada.
3. Se o tweet foi visto **há menos de 2 h** (`REVISIT_AFTER_MINUTES`) e não há entrada não lida: a aparição e o reposter são registrados na entrada mais recente do tweet e **não** se cria entrada (`absorbed`). Só quando a última visualização é mais antiga que isso o repost volta à fila (item 4).
3. Se existe entrada **não lida** (e não removida) com o mesmo `tweet_id`: acrescenta a chave e o reposter a ela (merge) e não cria nova.
4. Caso contrário cria nova entrada com `seq` do contador atômico.
5. Se `anchor_found = false` e a fila já tinha entradas, marca `gap_before = true` na primeira entrada criada e grava nela `gap_reason` (o `scan.reason` informado: `max_steps`, `max_collect`, `end`, `gap_unresolved`...). `scan` (opcional) é diagnóstico: por que a busca parou, quantos passos, quantos itens; fica no lote.
6. **Idempotente** por `batch_id` (reenvio devolve o mesmo resultado, sem duplicar).

Resposta:

```json
{ "created": 12, "merged": 2, "absorbed": 1, "updated": 1, "skipped": 3, "first_new_seq": 119, "gap": false }
```

**Posição na fila (`ord`).** `seq` é a identidade da entrada e nunca muda; a ordem de leitura é `ord`. Uma entrada **nova** entra **entre as não lidas depois do cursor, pelo horário do tweet** (o ID do X cresce com o tempo): antes da primeira não lida mais nova que ela; se não houver, no fim. Nunca entra antes do cursor nem entre as já lidas. **Repost:** se o **dono do tweet está na lista de seguidos**, entra pelo horário do tweet **original** (pode ir para a frente); se o dono **não é seguido**, o tweet fica **onde o X o mostra no feed** (horário do tweet comum vizinho mais antigo no lote, ficando logo depois dele; sem vizinho mais antigo, o mais novo), sem mexer na ordem. **Horário da conversa:** o do post mais ao topo que seja de conta **seguida** e **novo** (contas seguidas são aprendidas pelo próprio Seguindo: quem tem post próprio, quem reposta e quem responde dentro de uma conversa; a raiz de uma conversa não conta). Raiz de conta não seguida ou já lida não define o horário.

**Regra de ordem (padrão).** Uma conversa que já tem algum membro **na fila e não lido** NÃO muda de posição quando ganha respostas: o registro continua no `seq` do membro não lido mais antigo e só muda o link a abrir (`open_id`/`url` passam a ser os da resposta mais recente; nunca volta a uma mais antiga). Resposta: `updated` = registros que só trocaram o link. **Exceção:** se os membros conhecidos já foram **lidos**, a conversa volta ao fim da fila como registro novo (para ver a resposta), com o "Visto em" dos que já tinham sido vistos.

**Conversas (`cluster`).** O feed mostra uma conversa como raiz, resposta 1, resposta 2..., com IDs *crescentes* de cima para baixo (o contrário do normal). O cliente numera esses itens consecutivos com o mesmo `cluster`. Para cada conversa o servidor cria **um registro**, tendo a **última resposta** (maior ID) como **referência**; os demais membros ainda não lidos ficam **cobertos de forma provisória** (`cover_tentative`) e a página da referência os confirma ou solta (`POST /entries/settle`). Membros que já estavam lidos não são cobertos; seus "Visto em" aparecem na referência (`members`). Os itens enviados incluem também os já conhecidos (contexto da conversa); os conhecidos fora de conversa são ignorados. Resposta: `linked` = membros ligados à referência.

### `POST /api/v1/entries/settle`

`{ "covered_by": 120, "present_ids": ["..."] }`. Para as entradas cobertas **provisoriamente** por `covered_by`: as que aparecem em `present_ids` (o que a página da referência realmente mostra) são **confirmadas**; as demais **voltam à fila** (depois da referência). Resposta `{ "confirmed": N, "released": M }`. Coberturas provisórias **não** contam como vistas ao registrar `POST /views`.

### `GET /api/v1/entries/{seq}`

Entrada com suas visualizações anteriores.

```json
{
  "seq": 119,
  "tweet_id": "1840000000000000004",
  "open_id": "1840000000000000004",
  "url": "https://x.com/conta_b/status/1840000000000000004",
  "author": "conta_b",
  "reposters": ["conta_c"],
  "reposter_names": {"conta_c": "Nome de Exibição"},
  "all_reposters": ["conta_c"],
  "all_reposter_names": {"conta_c": "Nome de Exibição"},
  "members": [],
  "kind": "repost",
  "captured_at": "2026-10-04T12:00:00Z",
  "covered": false,
  "covered_by": null,
  "gap_before": false,
  "read_at": null,
  "views": [ { "viewed_at": "2026-10-03T21:14:00Z" } ],
  "view_count": 1,
  "covered_count": 0
}
```

`all_reposters` = quem repostou este tweet em **qualquer** entrada não removida (lida ou não), sem repetir; é o que a etiqueta "Fulano repostou" mostra, inclusive em entradas já vistas. `views` = visualizações do **mesmo `tweet_id`** (inclui outras entradas, ex.: repost anterior).

### `GET /api/v1/queue?after=118&limit=20`

Lista entradas com `seq` > `after`, em ordem crescente, ignorando removidas. Com `before=N` (em vez de `after`) lista as de `seq` < N em ordem **decrescente** (a mais próxima primeiro), útil para "anterior". `after` e `before` juntos → 422. Parâmetro `include_covered=false` por padrão. Resposta: `{"items": [...], "has_more": bool}`.

### `PATCH /api/v1/entries/{seq}`

Campos permitidos:

```json
{ "covered": true, "covered_by": 120 }
```
ou `{ "covered": false }` (reabrir) ou `{ "removed": true }`.

Operação em lote: `POST /api/v1/entries/cover` com `{"covered_by": 120, "tweet_ids": [...], "ancestor_ids": [...]}` (ao menos uma lista). Marca como cobertas entradas **não lidas**:
- `tweet_ids`: só as do mesmo `author` (sem distinguir maiúsculas) da entrada `covered_by` — pedaços de thread;
- `ancestor_ids`: posts que estão **acima** do post aberto na conversa (resposta → original), de **qualquer autor**, que ainda não estejam cobertas por outra entrada.
Resposta `{"covered": N}`.

Reabrir: `POST /api/v1/entries/uncover` com `{"covered_by": 120}` — devolve à fila todas as cobertas por essa entrada. Resposta `{"reopened": N}`.

### `POST /api/v1/views`

Registra que o dono viu entradas (ao sair com "próxima").

```json
{ "seqs": [119, 118], "viewed_at": "2026-10-04T12:05:00Z" }
```

- Cria uma visualização por `seq`, **uma só vez por entrada** (`read_at` da entrada é preenchido; repetir não duplica).
- Entradas **cobertas** pelas informadas também são marcadas como vistas no mesmo momento.
- Se algum `seq` não existe → `404` e nada é gravado.
- `viewed_at` opcional (padrão: agora do servidor).

### `POST /api/v1/health/skeleton`

Guarda o esqueleto enviado quando a captura quebra.

```json
{ "page": "home", "user_agent": "...", "skeleton": "article[data-testid=tweet]\n  div ...", "note": "nenhum post reconhecido" }
```
Limite de 200 KB. `GET /api/v1/health/skeleton?limit=5` devolve os últimos (para diagnóstico).

### `GET /api/v1/export`

Exporta fila, visualizações e estado em JSON (backup manual, auditoria).

## Documentação interativa

`/docs` (Swagger) ativo apenas em desenvolvimento local (`ENV=dev`, em `http://127.0.0.1:8010/docs`); **desligado em produção** (`ENV=prod`), assim como `/openapi.json`.

## CORS

Não é necessário: o userscript usa `GM_xmlhttpRequest`, que não passa por CORS. Manter CORS **desabilitado** por padrão.

## Testes de API (mínimo)

- Autenticação: sem chave, chave errada, chave certa.
- `append`: ordem, merge de repost, repost de lido (nova entrada), idempotência por `batch_id`, `gap_before`.
- `views`: contagem e unicidade por entrada.
- `state`: concorrência otimista, cursor inexistente.
- Validação: `tweet_id` não numérico, handle inválido, lote acima do limite.

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

### `GET /api/v1/queue/anchor?depth=10`

Chaves de aparição das últimas `depth` entradas (por `seq` decrescente, incluindo cobertas).

```json
{ "keys": ["1840000000000000001|", "1840000000000000002|fulano"], "last_seq": 118 }
```

### `POST /api/v1/queue/append`

Recebe um lote de aparições em **ordem do feed** (mais nova primeiro), exatamente como o scanner as viu.

```json
{
  "items": [
    { "tweet_id": "1840000000000000009", "author": "conta_a", "reposter": null,    "kind": "post" },
    { "tweet_id": "1840000000000000004", "author": "conta_b", "reposter": "conta_c", "kind": "repost" }
  ],
  "anchor_found": true,
  "batch_id": "b-2026-10-04T12:00:00Z-ab12"
}
```

Comportamento (todas as regras em `05-modelo-de-dados.md`):

1. Inverte a ordem (processa do mais antigo ao mais novo).
2. Descarta aparições cuja `appearance_key` já existe em alguma entrada.
3. Se existe entrada **não lida** (e não removida) com o mesmo `tweet_id`: acrescenta a chave e o reposter a ela (merge) e não cria nova.
4. Caso contrário cria nova entrada com `seq` do contador atômico.
5. Se `anchor_found = false` e a fila já tinha entradas, marca `gap_before = true` na primeira entrada criada.
6. **Idempotente** por `batch_id` (reenvio devolve o mesmo resultado, sem duplicar).

Resposta:

```json
{ "created": 12, "merged": 2, "skipped": 3, "first_new_seq": 119, "gap": false }
```

### `GET /api/v1/entries/{seq}`

Entrada com suas visualizações anteriores.

```json
{
  "seq": 119,
  "tweet_id": "1840000000000000004",
  "url": "https://x.com/conta_b/status/1840000000000000004",
  "author": "conta_b",
  "reposters": ["conta_c"],
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

`views` = visualizações do **mesmo `tweet_id`** (inclui outras entradas, ex.: repost anterior).

### `GET /api/v1/queue?after=118&limit=20`

Lista entradas com `seq` > `after`, em ordem crescente, ignorando removidas. Com `before=N` (em vez de `after`) lista as de `seq` < N em ordem **decrescente** (a mais próxima primeiro), útil para "anterior". `after` e `before` juntos → 422. Parâmetro `include_covered=false` por padrão. Resposta: `{"items": [...], "has_more": bool}`.

### `PATCH /api/v1/entries/{seq}`

Campos permitidos:

```json
{ "covered": true, "covered_by": 120 }
```
ou `{ "covered": false }` (reabrir) ou `{ "removed": true }`.

Operação em lote: `POST /api/v1/entries/cover` com `{"covered_by": 120, "tweet_ids": ["...","..."]}` — marca como cobertas as entradas **não lidas** com esses IDs e `author` igual (sem distinguir maiúsculas) ao de `covered_by`. Resposta `{"covered": N}`.

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

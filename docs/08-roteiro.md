# 08 — Roteiro de desenvolvimento

Nenhuma fase começa sem o dono pedir. Cada fase termina com critérios de aceite verificáveis.

## Fase 0 — Esqueleto do ambiente local

**Entregas:** `docker-compose.yml` (api + mongo), `Dockerfile` da API, `.env.example`, `.gitignore`, rota `/healthz`, `pytest` rodando em container.

**Aceite:**
- [ ] `docker compose up` sobe API e Mongo no Mac, com portas só em `127.0.0.1`.
- [ ] `GET /healthz` responde `ok` e falha se o Mongo estiver fora.
- [ ] Testes rodam em container.
- [ ] Nenhum segredo no repositório.

## Fase 1 — API e dados

**Entregas:** autenticação por chave (hash), modelos Pydantic, índices, rotas de `04-api.md` (`state`, `queue/anchor`, `queue/append`, `entries`, `views`, `health/skeleton`, `export`), contador atômico, idempotência por `batch_id`.

**Aceite (testes automatizados):**
- [ ] 401 idêntico para chave ausente/errada.
- [ ] `append`: ordem correta (mais antigo primeiro no `seq`); dedupe por chave; merge de repost em entrada não lida; **repost de lido cria nova entrada**; `gap_before` quando `anchor_found=false`; reenvio com o mesmo `batch_id` não duplica.
- [ ] `views`: uma por entrada; `read_at` definido; contagem correta no GET da entrada.
- [ ] `state`: `409` com `expected_version` errado; cursor inexistente → 422.
- [ ] Cobertura em lote só marca entradas não lidas do mesmo autor.
- [ ] Concorrência: dois `append` simultâneos não geram `seq` duplicado.

## Fase 2 — Userscript: leitura

**Entregas:** módulos `x-dom`, `api`, `queue`, `ui` (barra flutuante), `state`; navegação `go(url)` (com teste da navegação interna e fallback); rolagem ao topo; etiquetas de repost e de visto.

**Aceite (manual, Chrome do Mac com a conta do dono):**
- [ ] Com entradas semeadas na API, o script abre a entrada atual e a barra aparece.
- [ ] "Próxima" registra a visualização, avança o cursor e abre a seguinte.
- [ ] "Anterior" volta sem duplicar visualizações.
- [ ] Fechar e reabrir o navegador retoma na mesma entrada.
- [ ] Etiquetas "Fulano repostou" e "Visto em dd/mm/aaaa às hh:mm" corretas.
- [ ] Página de post sempre rola ao topo; para de rolar se o dono interagir.
- [ ] Decisão registrada: navegação interna do X funciona ou fica o fallback.

## Fase 3 — Userscript: captura e busca automática

**Entregas:** `scanner`, tela de busca por cima, verificador de saúde, esqueleto, menu (buscar, trocar feed, copiar esqueleto), `anchorDepth`, limites e pausas aleatórias.

**Aceite (manual):**
- [ ] Primeira busca com fila vazia captura ≈ `initialBackfill` posts, em ordem de leitura.
- [ ] Busca seguinte para ao reencontrar a âncora e acrescenta só o novo.
- [ ] O dono **não rola nada**; a tela própria cobre o feed durante toda a busca.
- [ ] Âncora não reencontrada → aviso de lacuna e entrada com `gap_before`.
- [ ] Repost e original aparecem corretamente; anúncios ignorados.
- [ ] Forçando falha (seletor inválido proposital em teste), o verificador para, avisa e envia esqueleto sem texto.
- [ ] Troca do feed para uma Lista funciona só alterando a configuração.

## Fase 4 — Threads e respostas

**Entregas:** verificação na leitura, salto para o último pedaço, cobertura, "reabrir cobertos", etiqueta de thread.

**Aceite (manual, com casos reais):**
- [ ] Thread real de 3+ posts: abre o primeiro, salta para o último, rola ao topo; cadeia visível de cima para baixo.
- [ ] Pedaços presentes na tela e na fila ficam cobertos; os não visíveis permanecem na fila.
- [ ] Posts independentes seguidos do mesmo autor **não** são cobertos.
- [ ] "Reabrir cobertos" restaura a fila.
- [ ] Continuação de thread já lida gera nova entrada com etiqueta correspondente.
- [ ] Decisão registrada sobre a transição visual do salto (mostrar post 1 ou "carregando").

## Fase 5 — Refinos locais

Ajustes vindos do uso real: ritmo da rolagem, tempos de espera, atalhos, respostas entre contas (opcional), estatísticas simples. Cartão próprio e pré-carga de imagens **só se a fluidez incomodar** (ver `09`).

## Fase 6 — Deploy no servidor

Somente com a aplicação aprovada localmente. Seguir o plano de `07-ambiente-e-infra.md` e o checklist de `06-seguranca.md`: domínio, HTTPS no NPM, rede interna, Mongo com autenticação, backup + restauração testada.

**Aceite:**
- [ ] Acesso de fora pelo domínio, com HTTPS válido.
- [ ] Sem chave → 401; `/docs` desativado.
- [ ] Mongo e API sem portas publicadas no host.
- [ ] Nenhum container do outro projeto alterado ou reiniciado.
- [ ] Backup roda e a restauração foi testada.

## Fase 7 — iPhone

Instalar o app Userscripts, habilitar no Safari, configurar a API pelo domínio HTTPS, validar `GM_xmlhttpRequest`/`GM_setValue`, comportamento com a aba em primeiro plano, atalho para o feed.

**Aceite:**
- [ ] Leitura contínua e posição sincronizada entre Mac e iPhone.
- [ ] Busca completa funciona com a aba visível.
- [ ] Botões utilizáveis com o dedo.

## Checklist manual recorrente (a cada mudança no script)

1. Abrir o X logado; a barra aparece.
2. Buscar novas com fila vazia e com fila existente.
3. Avançar 5 posts; conferir etiquetas.
4. Fechar/reabrir; posição preservada.
5. Verificar que nenhuma ação de escrita é feita no X (sem curtir/repostar/seguir).

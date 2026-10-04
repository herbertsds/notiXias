# 02 — Arquitetura

## Visão geral

```
┌──────────────────────────── Navegador (Mac / iPhone) ───────────────────────────┐
│  x.com (sessão logada do dono)                                                  │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │ Userscript notiXias                                                       │  │
│  │  • captura posts (âncora: /usuario/status/ID)                             │  │
│  │  • rola o feed por baixo de uma tela própria                              │  │
│  │  • barra flutuante: anterior / próxima / etiquetas                        │  │
│  │  • navega entre páginas de posts                                          │  │
│  └───────────────┬───────────────────────────────────────────────────────────┘  │
└──────────────────┼──────────────────────────────────────────────────────────────┘
                   │ GM_xmlhttpRequest  (HTTPS + Bearer <chave>)
                   ▼
        ┌─────────────────────┐        ┌───────────────┐
        │  API FastAPI        │ ─────▶ │   MongoDB 7   │
        │  (container)        │        │  (container)  │
        └─────────────────────┘        └───────────────┘
```

Três peças, todas minhas:

1. **Userscript** — único componente que toca o X. Roda na sessão já logada do dono.
2. **API** — guarda fila, posição e histórico; aplica as regras de merge; autentica por chave.
3. **MongoDB** — persistência, em container próprio e isolado.

O servidor nunca fala com o X. O X só é acessado pelo navegador do dono, com ele presente.

## Fluxos

### F1 — Abrir e continuar a leitura

1. O dono abre uma página do X (qualquer uma) ou o atalho para o feed.
2. O userscript consulta `GET /state` e obtém a entrada atual e a fila restante.
3. Se existe entrada atual, navega para a página dela (navegação interna do X; fallback: abrir a URL).
4. A página carrega, o script rola ao topo e mostra a barra com as etiquetas.

### F2 — Próxima

1. O dono aperta "próxima".
2. O script registra a visualização da entrada atual (`POST /views`) e das cobertas por ela.
3. Calcula a próxima entrada não coberta e atualiza o cursor (`PUT /state`).
4. Navega até ela. Se não existir próxima, segue para F3.

### F3 — Buscar novas (fila acabou, ou pedido manual)

1. O script mostra uma **tela própria em tela cheia** ("buscando novas…") e vai para o feed configurado.
2. Obtém as chaves âncora (`GET /queue/anchor`).
3. Rola o feed em passos moderados, lendo os posts visíveis em cada passo, até **reencontrar uma âncora**, ou até um limite de passos/posts, ou o fim do feed.
4. Envia o lote capturado, em ordem de aparição no feed (do mais novo ao mais antigo), para `POST /queue/append`. A API inverte para a ordem de leitura, aplica as regras de merge e devolve o resumo.
5. Se houve entradas novas, vai para a primeira nova. Se não, avisa "você está em dia" e volta ao último post.
6. Se a âncora não foi reencontrada, a primeira entrada nova é marcada com `gap_before` e a UI avisa.

### F4 — Thread (verificação na hora da leitura)

1. O dono chega a uma entrada cuja página mostra, logo abaixo do post focal, posts **do mesmo autor encadeados** (respostas do autor a si mesmo).
2. O script identifica o **último** post dessa sequência visível e navega até ele, rolando ao topo (a cadeia aparece de cima para baixo).
3. Os IDs dos pedaços **realmente presentes no DOM** da página de destino, que estejam na fila e não lidos, são marcados como cobertos (`PATCH /entries/{id}`).
4. Posts independentes do mesmo autor (sem encadeamento) **não** aparecem na página e, portanto, **nunca** são cobertos.

### F5 — Falha de captura

1. Se há conteúdo no feed mas nenhum post foi reconhecido, o verificador de saúde interrompe.
2. O script gera o **esqueleto** da estrutura (sem texto), envia a `POST /health/skeleton` e mostra um aviso.
3. O dono (ou a IA que o ajuda) usa o esqueleto para ajustar o módulo de seletores.

## Decisões de arquitetura (resumo)

| Decisão | Motivo |
|---|---|
| Coleta pelo navegador do dono | Sem API paga; menor risco com o X (uso humano, IP residencial, dono presente). |
| Userscript, não extensão própria | Mais simples; roda também no Safari do iPhone via app Userscripts. |
| Tela própria por cima durante a busca | O dono nunca vê nem rola o feed; atende ao requisito central. |
| Página real do post como "exibição" | Traz comentários e mídia sem reimplementar o X. |
| Ordem = sequência de captura, não ID do post | Reposts carregam o ID original (mais antigo); o ID não reflete a ordem da timeline. |
| Merge de reposts e cobertura no servidor | Consistência entre aparelhos; uma única fonte de regras. |
| Verificação de threads na leitura | Funciona só com URL e DOM; evita depender do JSON interno do X. |
| FastAPI + Mongo, em containers | Escolha do dono; mesma stack local e no servidor. |
| Chave de API única | Sistema de um usuário; simples e suficiente (ver `06-seguranca.md`). |

## Alternativas consideradas e descartadas

| Alternativa | Por que foi descartada |
|---|---|
| API oficial do X | Paga; o dono não pode custear. |
| Navegador sem tela no servidor, agendado | Automação contra os termos, maior risco de bloqueio, IP de datacenter, exige credencial no servidor. |
| Conta secundária lendo uma lista pública | Desnecessária com o desenho atual (dono presente, sessão própria). |
| Dono rolar o X para alimentar o leitor | Invalida o propósito do projeto. |
| Guardar o HTML das páginas para pré-carregar | O X é SPA: o HTML retornado é uma casca vazia; renderizar exigiria abas escondidas, que navegadores pausam; estilos se perdem. |
| Ler as respostas JSON internas do X | Formato muda e quebra; mais frágil que âncoras de URL. Pode voltar como complemento. |
| Tweet de referência para recalibrar seletores | O dono preferiu não usar. Substituído por verificador de saúde + esqueleto. |
| Keycloak para autenticação | Pesado para um usuário; usar o do outro projeto seria mexer nele. |
| Cartão próprio instantâneo + pré-carga de imagens | Adiado; só a navegação interna entra agora (ver `09`). |
| Agrupar threads por proximidade na lista (mesmo autor/horário) | Pularia posts independentes seguidos. |

## Limitações conhecidas

- O script só roda em **navegador**, nunca dentro do app do X.
- A aba precisa estar **visível** durante a busca (navegadores pausam abas em segundo plano).
- O X só carrega uma janela recente do feed; ausências longas em feeds movimentados podem deixar **lacunas** (sinalizadas).
- É uma **zona cinzenta** dos termos de uso do X (ver `06-seguranca.md`).

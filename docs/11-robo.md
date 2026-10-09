# 11 — Robô de busca automática (servidor)

Decisão do dono (2026-10-06): aceitar o risco de uma automação no servidor que busca novas de tempos em tempos, usando a conta dele. Se a conta cair, ele cria outra e volta a fazer a captura pelo computador. **Isso substitui a decisão anterior de "sem navegador sem tela no servidor".**

## O que é

Um contêiner `robot` (docker-compose.prod.yml) com Chromium sem tela (Playwright). A cada execução ele:

1. abre `https://x.com/home?nx=update` com a **sua sessão** (cookies de `robot_data/x_state.json`);
2. injeta o **mesmo userscript** que roda no navegador (`notixias.user.js`), com `GM_*` simulados (`robot/app/shim.js`);
3. o script rola o Seguindo, envia o que achou para a API (rede interna `http://api:8000`) e avisa que terminou;
4. o robô fecha o navegador, grava a sessão renovada e agenda a próxima.

Modo robô (`cfg.bot` no script): **não abre nem lê entradas** e portanto não registra visualização nem mexe na posição de leitura; não lê a lista de contas seguidas sozinho; aceita rolar até 400 passos.

## Horários (`robot/app/schedule.py`, fuso America/Sao_Paulo)

**Busca normal** — a cada X minutos, X sorteado **a cada execução**, com a faixa conforme quantas mensagens ainda não foram lidas (a API calcula, `GET /robot/policy`):

| Não lidas | Intervalo |
|---|---|
| menos de 50 | 10 a 25 min |
| de 50 a 99 | 30 a 45 min |
| 100 ou mais | 45 a 60 min |

(Os valores exatos 50 e 100 caem na faixa de cima; o pedido dizia "mais de"/"menos de" sem tratar a igualdade.)

**Madrugada** — a primeira execução que cairia entre **01:00 e 05:10** roda (é a **única** da madrugada); depois disso nada até **05:10**.

**Busca profunda do feed** — a primeira busca a partir das **05:10** e a primeira a partir das **12:30** (todo dia). Lê o Seguindo até a fronteira de tempo (a última profunda do feed, no máximo 24 h). **Não entra mais nos perfis.**

**Verificação dos perfis** — **uma por dia**, num horário sorteado entre **03:00 e 03:30** (um sorteio por dia, guardado). Roda dentro da parada da madrugada e **não conta** como a busca única dela. Abre o perfil de cada conta seguida (aba Posts e aba Respostas). Se o robô estiver parado nessa janela, a verificação **não é recuperada fora de hora**: fica para o dia seguinte.

**Reinício do contêiner** — não "recupera" horários perdidos (roda na hora se já passou da vez); respeita a regra da madrugada. Primeira vez (sem histórico): roda assim que houver sessão.

### Reação à leitura (a API vigia a contagem de não lidas)

Toda vez que você avança (ou cobre/descobre posts, ou chegam novos), a API compara a contagem com a anterior. Só quando ela **diminui**:

1. **Mudou para uma faixa de intervalo menor** (de 100+ para 50-99, ou para menos de 50) e o horário da próxima busca está **mais longe que o máximo da nova faixa**: a API sorteia um novo horário dentro da nova faixa, a partir de agora, e registra "Próxima busca antecipada" no histórico. O robô adota o horário novo em até 15 s (só se ele respeitar a parada da madrugada; a verificação de perfis nunca é antecipada).
2. **Atravessou 30, 15 ou 6 para baixo** (30→29, 15→14, 6→5): a API **pede ao robô uma busca imediata** e registra "Busca solicitada (leitura)" com o motivo ("restam 29 não lidas (abaixo de 30)"). O robô confere a cada 15 s, roda a busca (normal, ou profunda do feed se for a primeira depois das 05:10/12:30) e guarda o motivo na execução ("Motivo: …"). Intervalo mínimo de 3 min depois de outra execução.

## Busca profunda do feed e verificação dos perfis

Desde 2026-10-09 são **duas execuções separadas**. A profunda do feed (acima) só lê o Seguindo. A verificação dos perfis **entra no perfil de cada conta seguida** (aba Posts e aba Respostas) e inclui o que faltar na fila: ~2 páginas por conta (hoje ~57 contas, mais de 110 páginas), **uma vez por dia**, de madrugada. É o trecho de maior risco para a conta. Cada uma tem a sua fronteira de tempo (última concluída, máximo 24 h). Detalhes em `docs/03-userscript.md` (0.9.0 e 0.10.0).

## Proteções

- Falhas seguidas: após **3**, o robô **pausa** (não insiste na conta). Sessão expirada (tela de login) pausa na hora.
- Pausado volta sozinho quando você envia uma **sessão nova** (o arquivo `x_state.json` muda; checagem a cada 60 s) ou ao reiniciar o contêiner.
- Tempo máximo por execução: 25 min (profunda do feed: 60 min; verificação de perfis: 120 min).
- **Vigia de travamento (desde 2026-10-07):** o script emite um batimento a cada passo; se o robô não vê progresso por **5 min**, a página travou. Na verificação de perfis ele **pula a conta travada** (até 4 por execução) e segue para a próxima; fora disso encerra a execução com erro "travou". Todas as leituras do navegador têm prazo, para um navegador pendurado nunca prender o robô. O script também começa sem esperar o evento `load` da página.
- A chave da API **não passa pela página**: o Python coloca o cabeçalho; a rede do robô só alcança a API do notiXias; as funções expostas têm nome aleatório por execução.
- Sem login automático: você entra **manualmente** (passo abaixo).

## Colocar para funcionar (uma vez)

No seu Mac:

```bash
scripts/robot_login.sh              # abre um Chromium; entre na conta do X normalmente (com verificação, se pedir)
scripts/robot_install_session.sh    # envia .secrets/x_state.json para o servidor
```

No servidor o contêiner já fica de pé esperando o arquivo; ao chegar, a primeira busca roda na hora.

## Acompanhar

```bash
ssh OracleCloud 'cd ~/projetos/notixias && docker compose -f docker-compose.prod.yml logs --tail 50 robot'
ssh OracleCloud 'cat ~/projetos/notixias/robot_data/status.json'
```

`status.json`: `last_run_at`, `last_ok_at`, `last_result` (criados, atualizados, se ficou lacuna, por que parou), `next_run_at`, `consecutive_failures`, `paused`, `waiting_session`.

Quando algo falha por tempo esgotado, `last_result.diag` traz a URL, o texto da barra do notiXias e o console (nunca o texto dos posts).

## Sessão e conta

Os cookies do X rotacionam; o robô regrava `x_state.json` a cada execução bem-sucedida. Entrar de outro IP (o do servidor) pode fazer o X pedir verificação ou invalidar a sessão: nesse caso o robô pausa e registra "sessão do X expirada"; rode de novo `robot_login.sh` + `robot_install_session.sh`.

## Decisões da profunda (2026-10-07, revisar)

1. "Vai parar quando achar post antes da última profunda": uso **3 posts comuns seguidos** (não 1) no feed, por causa de raízes antigas de conversas.
2. "Não vai incluir post depois da última verificação… para quando achar 5 anteriores": li como **não incluir post ANTERIOR à última verificação** (a frase dizia "depois"; o resto só faz sentido assim).
3. Nos perfis, **reposts e o post fixado não entram nem contam**; o post respondido (de outra conta) também não.
4. Janela máxima de **24 h** mesmo que a última profunda seja mais antiga.
5. Limite de passos removido; ficam o fim do feed, 900 posts e 45 min no feed (e 150 passos por aba de perfil).
6. Âncora **50** só serve de contexto; não encerra a profunda.

## Decisões tomadas sem perguntar (revisar)

1. **Fuso** America/Sao_Paulo para os horários.
2. **"Depois de 1h roda uma única vez"**: roda a primeira execução sorteada que cair após 01:00 (não exatamente 01:00).
3. **Busca normal** (não profunda) a cada execução; o limite de rolagem do robô é 400 passos.
4. **Pausa após 3 falhas** (e na hora se a sessão expirar); sem aviso externo (e-mail, push): só log e `status.json`.
5. **Viewport** de 1280×1400 e user-agent de Chrome para Linux; vídeos bloqueados.
6. A **conta** é a que você usar no `robot_login.sh` (a mesma da leitura, a menos que você escolha outra).
7. O robô **não** lê a lista de contas seguidas sozinho: use o menu ⋯ do script (ou o atalho `?nx=following`) de vez em quando.
8. Executa **uma busca por vez**; se você estiver lendo no celular ao mesmo tempo, não há conflito (o robô só acrescenta à fila).

## Histórico de execuções

Menu ⋯ do notiXias → **Execuções…**: tela cheia com rolagem, a mais recente no topo. Cada linha mostra data e hora, se foi **Manual** ou **Automática** (robô), **Normal** ou **Profunda**, quantos posts novos, se ficou lacuna e por que a busca parou. Falhas aparecem em vermelho. Fica na API (`GET /runs`, coleção `runs`, guardada por 90 dias); execuções canceladas por você não são registradas.

### Próxima execução automática

O sorteio dos 10–25 minutos é feito **logo depois de cada busca** (e guardado em `robot_data/status.json`, campo `plan`: um reinício não sorteia de novo). O robô informa à API o horário e o tipo (`PUT /robot/next`), e o topo da tela **Execuções…** mostra "Próxima automática: dd/mm/aaaa hh:mm · Normal|Profunda" com o tempo que falta. Se o robô estiver pausado ou sem sessão, a linha avisa isso; se o horário já passou há mais de 10 min, aparece "atrasada: confira o robô".

## Incidente de 2026-10-07 (profunda travada)

A profunda das 12:50 travou em torno da 13:00 (cerca da conta 27 de 57, página que nunca terminou de carregar) e o robô ficou **mais de 2 horas** parado nela, sem erro nem registro: o prazo de 120 min foi vencido, mas a leitura de diagnóstico (`page.evaluate`) também ficou pendurada. Corrigido com o vigia de travamento, prazos em todas as leituras e início do script sem depender do evento `load`.

## Decisões de 2026-10-09 (revisar)

1. Faixas de não lidas: 100 e 50 exatos caem na faixa de cima (45–60 e 30–45).
2. A contagem de não lidas é a "depois da posição atual" (`unread_after`), sem as cobertas.
3. O horário antecipado é sorteado dentro da nova faixa **a partir de agora** (não "o menor entre o atual e o máximo").
4. A verificação de perfis perdida (robô parado entre 03:00 e 03:30) **não é recuperada**: vai para o dia seguinte.
5. O pedido de busca por limiar (30/15/6) respeita um intervalo mínimo de 3 minutos depois de outra execução, e vira a profunda do feed se for a primeira depois de 05:10/12:30.
6. Os três limiares só disparam ao **diminuir** a contagem (voltar uma mensagem ou chegarem novas não pedem busca); um salto grande que atravessa dois limiares gera um único pedido (o motivo cita o menor).
7. A verificação de perfis é um horário próprio e **não conta** como "busca única depois de 01:00".

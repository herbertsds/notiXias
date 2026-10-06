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

- A cada **X minutos**, X sorteado entre 30 e 45 **a cada execução**.
- Madrugada: a primeira execução que cairia entre **01:00 e 04:45** roda (é a **única** da madrugada); depois disso nada até **04:45**, quando volta a buscar e retoma o ritmo normal. **A primeira busca a partir das 04:45 é PROFUNDA** (rola mais, comparando com as últimas 100 entradas) para recuperar algo que tenha ficado para trás; as seguintes são normais.
- Reinício do contêiner: não "recupera" horários perdidos (roda na hora se já passou da vez); respeita a regra da madrugada (se já rodou naquela madrugada, espera 04:45).
- Primeira vez (sem histórico): roda assim que houver sessão.

## Proteções

- Falhas seguidas: após **3**, o robô **pausa** (não insiste na conta). Sessão expirada (tela de login) pausa na hora.
- Pausado volta sozinho quando você envia uma **sessão nova** (o arquivo `x_state.json` muda; checagem a cada 60 s) ou ao reiniciar o contêiner.
- Tempo máximo por execução: 25 min.
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

# App Android (primeira versão)

Um app mínimo (`android/`, Kotlin) que abre o X (`https://x.com/home`) num WebView do sistema e injeta o userscript antes de cada página (`addDocumentStartJavaScript`), no mesmo princípio do robô (`robot/app/shim.js`).

## O que ele faz
- **Ponte nativa** (`Bridge.kt`, `addWebMessageListener` restrito a `https://x.com`, objeto com nome aleatório por execução): `GM_getValue/GM_setValue` (armazenamento do app, só chaves `nx_*`), `GM_xmlhttpRequest` (OkHttp; só o servidor da API configurado) e `GM_cookie.list` (cookies de x.com, inclusive o login HttpOnly → o menu "Enviar sessão do X para o robô" funciona).
- **Chave da API nunca na página:** ao configurar (menu ⋯ → "Configurar API…"), o app guarda a chave e devolve ao script só um marcador (`chave-no-app`); o cabeçalho `Authorization` é posto no código nativo.
- **Script atualizado pelo servidor:** a cada abertura (e ao voltar ao app, no máximo a cada 30 min) o app pede em segundo plano `GET /api/v1/userscript` com `If-None-Match` (ETag). `304` ou falha → continua com a cópia local (a baixada, ou a que vem dentro do APK). `200` → grava a nova cópia, registra de novo o script e recarrega a página ("notiXias: script atualizado"). A API serve `userscript/notixias.user.js` (volume `./userscript:/userscript` no compose); depois de `node build.js` + `git pull` no servidor, o app recebe a versão nova sozinho.
- Links fora do X abrem no navegador do aparelho; `prompt()/confirm()/alert()` do script viram diálogos; vídeo em tela cheia e botão voltar tratados.

## Compilar (sem instalar nada no Mac)
```bash
docker compose --profile build run --rm android-build      # gera android/app/build/outputs/apk/debug/app-debug.apk
```
(Imagem amd64; no Apple Silicon roda emulada. O primeiro build baixa o SDK.) O APK sai assinado com a chave de debug: serve para instalar direto (ativar "instalar apps desconhecidos").

## Instalar e configurar
1. Passe o APK para o celular e instale.
2. Abra o app, entre no X (login manual, com e-mail/senha; o login pelo Google é bloqueado em WebView).
3. O endereço da API (`https://notixias.163.176.176.10.nip.io`) já vem no APK; a chave também, se existir `.secrets/prod_api_key.txt` na hora de compilar (arquivo fora do git). **Esse APK contém a chave: não o compartilhe.** Sem o arquivo, use Menu ⋯ → "Configurar API…".

## Limites conhecidos / a validar no aparelho
- Não testado num aparelho ainda (nesta máquina só há compilação). Pontos a validar: login no X dentro do WebView, vídeo em tela cheia, botão voltar, barra inferior, envio de sessão.
- Ainda sem tela cheia imersiva (barras do sistema visíveis). Ícone: o passarinho azul do antigo logo do Twitter (ícone adaptativo, `res/drawable/ic_launcher_foreground.xml`).

## Tela do celular (0.1.3)
O WebView pede "tela acesa" sozinho enquanto qualquer vídeo toca (inclusive os mudos do feed). O app desfaz isso (varredura a cada 1 s em `MainActivity.applyAwake`) e só mantém a tela acesa quando o script avisa (`nx_awake`, via ponte) que há vídeo **tocando em tela cheia**, ou quando o WebView está em tela cheia nativa. Fora disso vale o tempo de tela do sistema.

## Zoom do texto (0.1.4)

`WebSettings.textZoom = 105` (era 110 até a 0.1.4): textos 5% maiores em todo o X (inclui a barra do notiXias). Mudar o valor em `MainActivity.kt`.

## Controle (gamepad, 0.1.5)

`MainActivity.dispatchKeyEvent`: **A** e **R2** avançam, **B** e **L2** voltam um post. O app injeta `Alt + seta direita/esquerda` na página (o atalho que o script já tem, `onNext`/`onPrev`) e consome o botão, para o Android não usá-lo (ex.: B como "voltar"). Se o controle estiver em outro modo (ex.: layout Nintendo, que troca A e B), os códigos mudam.

**Cruzeta (0.1.6):** cima/baixo rolam a página 40% da altura da tela (suave; segurar repete). Atende tanto `KEYCODE_DPAD_UP/DOWN` quanto o eixo `AXIS_HAT_Y` (`dispatchGenericMotionEvent`), conforme o modo do controle. Esquerda/direita não fazem nada.

**0.1.7:** R1/L1 trocados por **R2/L2** (tecla `BUTTON_R2/L2` ou eixo analógico `RTRIGGER/GAS`, `LTRIGGER/BRAKE` a partir de 50%).

**0.1.8:** botão **X** do controle manda Alt+seta para cima; o script (0.16.20) abre em tela cheia o vídeo visível (botão de tela cheia do player) ou, sem vídeo, a foto mais visível.

**0.1.9:** o botão **X** manda ao WebView a tecla **F9 de verdade** (`web.dispatchKeyEvent`), que dá gesto do usuário à página; o script (0.16.27) responde com `requestFullscreen` no player do vídeo visível (tela cheia real, com `onShowCustomView`). Sem vídeo, abre a foto mais visível.

**0.1.10:** cruzeta e analógico (esquerdo `AXIS_Y`, direito `AXIS_RZ`) rolam **um passo por toque**; só segurando repete (1º repique após 450 ms, depois a cada 250 ms). Os eventos do analógico são consumidos (antes o WebView rolava sem parar).

**0.1.11:** botão X: com a tela cheia aberta (`customView`), chama `document.exitFullscreen()`; senão pergunta ao script `window.nxVideoCenter()` e dá um **toque real** (`dispatchTouchEvent`) no vídeo — o toque no vídeo entra em tela cheia com gesto válido (a tecla F9 não foi confiável). Sem vídeo, manda Alt+seta para cima (foto). Diagnóstico temporário: botões de controle sem função mostram um aviso com o nome do código.

**0.1.12:** tela cheia de vídeo em modo imersivo (`immersive()`: esconde barra de status/navegação e usa o recorte da câmera; volta ao sair). Voltar com a tela cheia aberta também pede `exitFullscreen` à página.

**0.1.13:** ao entrar em tela cheia, o app lê `videoWidth x videoHeight` do vídeo (`lockOrientationToVideo`): mais alto que largo → `SCREEN_ORIENTATION_SENSOR_PORTRAIT`; senão `SENSOR_LANDSCAPE`. Se o vídeo ainda não carregou (0x0), tenta até 8 vezes a cada 300 ms. Ao sair, `UNSPECIFIED` (volta a seguir o celular).

**0.1.14:** a orientação do vídeo agora é pedida **antes** de entrar em tela cheia (girar depois fazia a página sair dela): o script envia `nx_orient` (`portrait`/`landscape`/`auto`) pela ponte e espera a tela girar (até 1,5 s; o gesto do toque dura alguns segundos). Ao sair da tela cheia o app repinta/remede o WebView (tela preta) e volta a orientação para `auto`.

**0.1.15:** sem mudança de código nativo; recompilado para levar de fábrica o script 0.16.36 (a cópia de fábrica do 0.1.14 era a 0.16.31, ainda com o toque no vídeo que abria a tela cheia).

**0.1.16:** botão X = **aperta o botão "Tela cheia" do próprio player** (achado pelo diagnóstico: `aria-label="Tela cheia"` em `videoPlayer`) com um toque de verdade; antes gira a tela para a orientação do vídeo (espera 900 ms) e pergunta de novo onde está o botão. Sem o botão na tela, avisa para tocar no vídeo e mostrar os controles.

**0.1.17:** sem mudança nativa; recompilado para levar de fábrica o script 0.16.38 (toque no vídeo = mesmo caminho do botão X).

**0.1.18:** botão X = toque no vídeo (mesmo caminho do dedo; a orientação agora é tratada pelo script, via `nx_orient`). O app reafirma a orientação pedida por 1,6 s depois de entrar em tela cheia (o X tenta travar em deitado). Script de fábrica 0.16.39.

**0.1.19:** sem mudança nativa; script de fábrica 0.16.41 (tela cheia em retrato).

**0.1.20:** barras de status e de navegação (inclusive a de gestos) seguem o modo claro/escuro do celular: fundo preto e ícones claros no escuro, fundo branco e ícones escuros no claro; muda na hora quando o modo do celular muda. Script de fábrica 0.16.45.

**0.2.0:** até três WebViews para a fila, empilhadas: a da frente e duas atrás com o post anterior e o próximo já abertos (criadas na primeira vez que o script publica os vizinhos). Passar de post troca as telas na hora; a que saiu da frente fica atrás com o post dela, pronta para voltar sem recarregar. Links para fora da fila abrem numa quarta WebView por cima; voltar (gesto, B/L2, seta do X) a fecha e mostra o post da fila como estava; A/R2 fecha e avança. Controle, tela cheia, orientação e tela acesa valem só para a tela visível. Se o processo das páginas cair (memória), o app recomeça sozinho em vez de fechar. Script de fábrica 0.17.0.

**0.3.0:** até 7 WebViews da fila (a da frente + 3 seguintes + 3 anteriores). Cada tela guarda se já terminou de abrir o post; ao trocar, o app conta quantas das 4 da janela não carregaram e, se forem 3 ou mais, manda o script mostrar a tela de carregamento até todas carregarem. Script de fábrica 0.18.0. Memória: são muitas páginas do X ao mesmo tempo; `PRELOAD_EACH_WAY` (MainActivity.kt) controla quantas por lado.

**0.4.0:** player de vídeo próprio (`PlayerOverlay.kt`, ExoPlayer/Media3, mp4 e HLS). Tela cheia por cima de tudo, na maior qualidade; botão de qualidade troca no meio do vídeo; gira para o formato do vídeo (em pé/deitado) e o trava nele mesmo com o celular na outra posição (cadeado solta); abre mudo ou com som como o vídeo da página e começa onde ele estava. Botões grandes que aparecem ao carregar e somem em 3 s; toque mostra/esconde; segurar acelera 2x enquanto segurar; ⏪/⏩ 10 s e barra de tempo; o vídeo repete. Controle: A toca/pausa, B ou X fecham, cruzeta ←/→ avança/volta 10 s. Voltar do Android fecha. Os links vêm do captador no `shim.js` (respostas da API do X). Script de fábrica 0.19.0.

**0.4.1:** player mais discreto (botões quase transparentes com fio branco, texto no lugar de emojis coloridos). Botão de velocidade no player, com os mesmos valores do script (0,1x a 3x; segurar a tela continua em 2x e volta à velocidade escolhida). Início mais rápido: buffer mínimo de 0,5 s e, se o vídeo não começar em 4 s, cai para a próxima qualidade. Ao fechar, a página é recentrada no vídeo. Script de fábrica 0.19.1.

**0.5.0:** vídeos das telas vizinhas baixados para o armazenamento (`VideoCache.kt`, Media3 `SimpleCache`). A cada 3 s o app pergunta às telas da janela (frente + 3 de cada lado) quais vídeos o post delas tem (`__nxMediaDump`, no `shim.js`) e baixa a melhor qualidade em mp4, até 5 minutos por vídeo. O player lê pelo mesmo cache e abre na hora. Quando o post sai da janela, o vídeo é cancelado e apagado; o cache inteiro é apagado ao abrir o app. Só mp4 (HLS não é guardado).

**0.5.1:** em rede com franquia (dados móveis; `isActiveNetworkMetered`) o app guarda só 10 s de cada vídeo; no Wi-Fi continuam 5 min. Se a rede mudar para Wi-Fi enquanto o post ainda está sendo olhado (as buscas de vídeo duram ~30 s por post), o download completa o que faltar. Nova permissão: `ACCESS_NETWORK_STATE`.

**0.5.2:** os botões do player voltam a ser ícones, desenhados no código (`IconView`): fechar, play/pause, voltar/avançar 10 s, som/mudo, cadeado. Círculos quase transparentes, sem borda, traço fino branco. Qualidade e velocidade seguem como texto (são valores).

**0.5.3:** ao fechar o player, a tela volta para a orientação de antes de abrir (retrato/paisagem) e depois de 1,5 s volta ao modo anterior do app. Script de fábrica 0.19.2 (telas de trás ficam no topo).

**0.6.0:** o app se atualiza pelo servidor (`AppUpdater.kt`, `Net.appInfo/downloadApk`, `FileProvider`, permissão `REQUEST_INSTALL_PACKAGES`). Ao abrir, confere se há `versionCode` maior no servidor, pergunta "Atualizar agora?" (com "Depois" até a próxima abertura), baixa mostrando o progresso, confere o sha256 e abre o instalador do Android. Publicar: ver `docs/10-deploy.md`. Esta versão precisa ser instalada à mão uma vez; as seguintes chegam pelo servidor.

**0.7.0:** energia e vídeos no padrão do X. Saíram o player próprio (`PlayerOverlay.kt`, Media3), o cache de vídeo (`VideoCache.kt`), o captador de links no `shim.js`, o botão X do controle (e o aviso "Botão: …"), a orientação pedida pelo script e a permissão de estado da rede; o APK caiu de 5,5 MB para 2,2 MB. A tela só fica acesa com vídeo em tela cheia do X (o "tela acesa" que o WebView pede sozinho continua desfeito). Telas da fila: a da frente, 3 seguintes e 1 anterior (5 no total); para trás, o carregamento só aparece se o anterior não estiver pronto. Tela de trás pronta fica invisível (não é desenhada; a página fica escondida). Fora de foco: `pauseTimers()` congela o JavaScript de todas as telas e, depois de 3 min, as telas de trás viram `about:blank` (reabrem quando o app volta); com pouca memória (`onTrimMemory`) isso acontece na hora. Telemetria e contadores do X recusados no app e no service worker: `/jot/`, `client_event`, `badge_count`, `dm/user_updates`, `dm/inbox_initial_state`, `live_pipeline`.

**0.7.1:** a pergunta de atualização não apareceu na 0.6.0. Pelos registros do servidor, o app consultou a versão (00:15:11 UTC, 1 s depois da publicação da 0.7.0) junto com o download do script 0.20.0, que recarregava as 7 telas de uma vez; o app aparentemente recomeçou e a pergunta sumiu. Correções: o `AppUpdater` guarda a versão achada e pergunta de novo assim que der (a cada 15 s enquanto houver tela por cima ou tela cheia, e ao voltar ao app); confere ao abrir, ao voltar e a cada 10 min com o app aberto (antes, só a cada 30 min ao voltar, e a hora da consulta era marcada mesmo quando ela falhava). Script novo recarrega só a tela da frente (e a por cima); as de trás esvaziam e reabrem quando a da frente avisa os vizinhos.

**0.8.0:** 5 telas à frente (e 1 atrás; 7 no total). Tela de carregamento ao avançar só quando menos de 2 das telas da frente estão prontas, e então até a que veio para a frente e a seguinte ficarem prontas (para trás: só se o anterior não estiver pronto). `nx_gone`: a tela de trás cujo post foi apagado fica livre e recebe outro post. Script de fábrica 0.21.0.

**0.8.1:** tela de carregamento ao passar de post só se a tela que vem ainda não está pronta, e só até ela ficar pronta. `nx_ready_count`: quantos dos posts pedidos já estão prontos em telas de trás (o script usa para segurar o ▶). Script de fábrica 0.21.1.

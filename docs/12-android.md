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

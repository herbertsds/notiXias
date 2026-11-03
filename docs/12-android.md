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

`MainActivity.dispatchKeyEvent`: **A** e **R1** avançam, **B** e **L1** voltam um post. O app injeta `Alt + seta direita/esquerda` na página (o atalho que o script já tem, `onNext`/`onPrev`) e consome o botão, para o Android não usá-lo (ex.: B como "voltar"). Se o controle estiver em outro modo (ex.: layout Nintendo, que troca A e B), os códigos mudam.

**Cruzeta (0.1.6):** cima/baixo rolam a página 40% da altura da tela (suave; segurar repete). Atende tanto `KEYCODE_DPAD_UP/DOWN` quanto o eixo `AXIS_HAT_Y` (`dispatchGenericMotionEvent`), conforme o modo do controle. Esquerda/direita não fazem nada.

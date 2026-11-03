package br.notixias.app

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.Toast
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.security.SecureRandom
import java.util.concurrent.Executors

/** notiXias: o X (x.com) num WebView com o userscript injetado antes de cada página. */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var root: FrameLayout
    private lateinit var store: Store
    private lateinit var net: Net
    private lateinit var scripts: ScriptStore
    private val bridgeName = "_nx" + ByteArray(8).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
    private var startScript: ScriptHandler? = null
    private var customView: View? = null
    private var customCallback: WebChromeClient.CustomViewCallback? = null
    private val io = Executors.newSingleThreadExecutor()
    private var scriptAwake = false      // o script avisou: vídeo tocando em tela cheia
    private val ui = Handler(Looper.getMainLooper())
    private val sweeper = object : Runnable {
        override fun run() { applyAwake(); ui.postDelayed(this, 1000) }
    }

    /** A tela do celular só fica acesa com vídeo tocando em tela cheia; fora disso vale o tempo de tela do sistema. */
    private fun applyAwake() {
        val allowed = scriptAwake || customView != null
        if (allowed) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            // o WebView pede "tela acesa" por conta própria enquanto qualquer vídeo toca (inclusive os mudos do feed): desfaz
            if (::web.isInitialized) clearKeepOn(web)
        }
    }

    private fun clearKeepOn(v: View) {
        if (v.keepScreenOn) v.keepScreenOn = false
        if (v is ViewGroup) for (i in 0 until v.childCount) clearKeepOn(v.getChildAt(i))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = Store(this)
        store.seedDefaults()
        Toast.makeText(this, "notiXias app ${BuildConfig.VERSION_NAME} · API ${if (store.apiBase().isNotEmpty()) "ok" else "sem endereço"} · chave ${if (store.apiKey().isNotEmpty()) "ok" else "ausente"}", Toast.LENGTH_LONG).show()
        net = Net(store)
        scripts = ScriptStore(this)
        root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        web = WebView(this)
        root.addView(web, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        setContentView(root)

        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            AlertDialog.Builder(this).setTitle("WebView desatualizado")
                .setMessage("Atualize o \"Android System WebView\" (e o Chrome) na Play Store e abra o app de novo.")
                .setPositiveButton("OK") { _, _ -> finish() }.setCancelable(false).show()
            return
        }

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            setSupportMultipleWindows(false)
            cacheMode = WebSettings.LOAD_DEFAULT
            textZoom = 105   // textos 5% maiores
        }
        CookieManager.getInstance().apply { setAcceptCookie(true); setAcceptThirdPartyCookies(web, true) }
        WebViewCompat.addWebMessageListener(web, bridgeName, setOf("https://x.com"), Bridge(store, net, { on -> runOnUiThread { scriptAwake = on; applyAwake() } }, { v -> runOnUiThread { setOrientation(v) } }))
        installScript()

        web.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                scriptAwake = false   // página nova: o script avisa de novo se houver vídeo em tela cheia
                applyAwake()
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                val host = u.host ?: ""
                if (u.scheme == "https" && (host == "x.com" || host.endsWith(".x.com"))) return false
                // fora do X (links de notícias etc.): abre no navegador do aparelho
                try { startActivity(Intent(Intent.ACTION_VIEW, u)) } catch (e: Exception) { /* sem app para abrir */ }
                return true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onJsAlert(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
                AlertDialog.Builder(this@MainActivity).setMessage(message).setPositiveButton("OK") { _, _ -> result.confirm() }
                    .setOnCancelListener { result.cancel() }.show()
                return true
            }
            override fun onJsConfirm(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
                AlertDialog.Builder(this@MainActivity).setMessage(message)
                    .setPositiveButton("OK") { _, _ -> result.confirm() }.setNegativeButton("Cancelar") { _, _ -> result.cancel() }
                    .setOnCancelListener { result.cancel() }.show()
                return true
            }
            override fun onJsPrompt(view: WebView, url: String?, message: String?, defaultValue: String?, result: JsPromptResult): Boolean {
                val input = EditText(this@MainActivity).apply { setText(defaultValue ?: "") }
                AlertDialog.Builder(this@MainActivity).setMessage(message).setView(input)
                    .setPositiveButton("OK") { _, _ -> result.confirm(input.text.toString()) }
                    .setNegativeButton("Cancelar") { _, _ -> result.cancel() }
                    .setOnCancelListener { result.cancel() }.show()
                return true
            }
            // vídeo em tela cheia
            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                if (customView != null) { callback.onCustomViewHidden(); return }
                customView = view
                customCallback = callback
                root.addView(view, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                web.visibility = View.GONE
                immersive(true)
                // O X tenta travar a tela em deitado ao entrar em tela cheia (vídeo em pé saía de lado): reafirma a do vídeo.
                if (wantedOrientation != "auto") listOf(250L, 800L, 1600L).forEach { ms -> ui.postDelayed({ if (customView != null) setOrientation(wantedOrientation) }, ms) }
            }
            override fun onHideCustomView() {
                customView?.let { root.removeView(it) }
                customView = null
                customCallback?.onCustomViewHidden()
                customCallback = null
                web.visibility = View.VISIBLE
                immersive(false)
                wantedOrientation = "auto"
                requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                // Evita a tela preta ao voltar: força nova medida/desenho do WebView e avisa a página do novo tamanho.
                web.requestLayout()
                web.invalidate()
                ui.postDelayed({
                    web.requestLayout()
                    web.invalidate()
                    web.evaluateJavascript("window.dispatchEvent(new Event('resize'))", null)
                }, 250)
            }
        }

        if (savedInstanceState != null) web.restoreState(savedInstanceState) else web.loadUrl("https://x.com/home")
        checkScriptUpdate(force = true)
    }

    /** (Re)registra o script que roda antes de cada página do X. */
    private fun installScript() {
        startScript?.remove()
        val shim = assets.open("shim.js").bufferedReader(Charsets.UTF_8).use { it.readText() }
            .replace("__NX_BRIDGE__", bridgeName)
            .replace("__BUNDLE__", scripts.current())
        startScript = WebViewCompat.addDocumentStartJavaScript(web, shim, setOf("https://x.com"))
    }

    /** Em segundo plano: busca o script mais novo no servidor; se mudou, guarda e recarrega a página com ele. */
    private fun checkScriptUpdate(force: Boolean = false) {
        val now = System.currentTimeMillis()
        if (!force && now - store.lastCheckAt < 30 * 60 * 1000) return
        store.lastCheckAt = now
        io.execute {
            val novo = net.fetchScript() ?: return@execute
            scripts.save(novo)
            runOnUiThread {
                installScript()
                web.reload()
                Toast.makeText(this, "notiXias: script atualizado", Toast.LENGTH_SHORT).show()
            }
        }
    }

    override fun onResume() {
        super.onResume()
        if (::web.isInitialized) { web.onResume(); checkScriptUpdate(); ui.post(sweeper) }
    }

    override fun onPause() {
        ui.removeCallbacks(sweeper)
        if (::web.isInitialized) { web.onPause(); CookieManager.getInstance().flush() }
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        super.onPause()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (::web.isInitialized) web.saveState(outState)
    }

    // Rolagem pelo controle (cruzeta e analógico): um toque rola um passo (40% da altura da tela); só segurando repete
    // (primeiro depois de HOLD_FIRST_MS, depois a cada HOLD_EVERY_MS). A cruzeta pode vir como teclas (DPAD_UP/DOWN) ou como
    // eixo (HAT_Y), e o analógico como AXIS_Y (esquerdo) ou AXIS_RZ (direito): cada fonte guarda a sua direção (-1, 0, 1) e vale
    // a primeira diferente de 0. Os eventos do analógico são consumidos, para o WebView não rolar sozinho sem parar.
    private fun scrollPage(down: Boolean) {
        if (!::web.isInitialized) return
        val sign = if (down) "" else "-"
        web.evaluateJavascript("window.scrollBy({top:${sign}Math.round(window.innerHeight*0.4),behavior:'smooth'})", null)
    }

    private var keyDir = 0
    private var hatDir = 0
    private var stickDir = 0
    private var heldDir = 0
    private val holdRepeat = object : Runnable {
        override fun run() {
            if (heldDir == 0) return
            scrollPage(heldDir > 0)
            ui.postDelayed(this, HOLD_EVERY_MS)
        }
    }

    private fun updateScroll() {
        val d = if (keyDir != 0) keyDir else if (hatDir != 0) hatDir else stickDir
        if (d == heldDir) return
        heldDir = d
        ui.removeCallbacks(holdRepeat)
        if (d != 0) {
            scrollPage(d > 0)
            ui.postDelayed(holdRepeat, HOLD_FIRST_MS)
        }
    }

    private var rTrig = false
    private var lTrig = false

    // Gatilhos R2/L2: há controles que mandam tecla (BUTTON_R2/L2) e outros só o eixo analógico (RTRIGGER/GAS, LTRIGGER/BRAKE);
    // o eixo vale a partir de 50% do curso, uma vez por aperto.
    private fun triggerAxes(event: MotionEvent) {
        val r = maxOf(event.getAxisValue(MotionEvent.AXIS_RTRIGGER), event.getAxisValue(MotionEvent.AXIS_GAS)) > 0.5f
        val l = maxOf(event.getAxisValue(MotionEvent.AXIS_LTRIGGER), event.getAxisValue(MotionEvent.AXIS_BRAKE)) > 0.5f
        if (r && !rTrig) sendNav("ArrowRight")
        if (l && !lTrig) sendNav("ArrowLeft")
        rTrig = r
        lTrig = l
    }

    private fun sendNav(dir: String) {
        if (!::web.isInitialized) return
        web.evaluateJavascript(
            "window.dispatchEvent(new KeyboardEvent('keydown',{key:'$dir',altKey:true,bubbles:true,cancelable:true}))", null
        )
    }

    override fun dispatchGenericMotionEvent(event: MotionEvent): Boolean {
        if ((event.source and android.view.InputDevice.SOURCE_JOYSTICK) != 0 && event.action == MotionEvent.ACTION_MOVE) {
            triggerAxes(event)
            val hat = event.getAxisValue(MotionEvent.AXIS_HAT_Y)
            hatDir = if (hat > 0.5f) 1 else if (hat < -0.5f) -1 else 0
            val stick = if (Math.abs(event.getAxisValue(MotionEvent.AXIS_Y)) >= Math.abs(event.getAxisValue(MotionEvent.AXIS_RZ)))
                event.getAxisValue(MotionEvent.AXIS_Y) else event.getAxisValue(MotionEvent.AXIS_RZ)
            stickDir = if (stick > 0.6f) 1 else if (stick < -0.6f) -1 else 0
            updateScroll()
            return true
        }
        return super.dispatchGenericMotionEvent(event)
    }

    /**
     * O script lê o formato do vídeo e pede a orientação ANTES de entrar em tela cheia (girar depois fazia a página sair da tela
     * cheia na hora): "portrait" trava em pé, "landscape" trava deitado (o sensor ainda vira de cabeça para baixo), "auto" volta
     * a seguir o celular.
     */
    private var wantedOrientation = "auto"

    private fun setOrientation(v: String) {
        wantedOrientation = if (v.contains("portrait")) "portrait" else if (v.contains("landscape")) "landscape" else "auto"
        // Se a tela cheia não abrir em 6 s, a trava de orientação é solta (não deixar o celular preso em pé ou deitado).
        if (wantedOrientation != "auto") ui.postDelayed({ if (customView == null && wantedOrientation != "auto") setOrientation("auto") }, 6000)
        requestedOrientation = when {
            v.contains("portrait") -> android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
            v.contains("landscape") -> android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            else -> android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        }
    }

    /** Tela cheia de vídeo cobre tudo, inclusive a barra de status (hora, bateria) e o recorte da câmera; ao sair, volta ao normal. */
    @Suppress("DEPRECATION")
    private fun immersive(on: Boolean) {
        if (android.os.Build.VERSION.SDK_INT >= 28) {
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode = if (on) WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
                else WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT
            }
        }
        window.decorView.systemUiVisibility = if (on) {
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        } else View.SYSTEM_UI_FLAG_VISIBLE
    }

    // Botão X: em tela cheia, sai (exitFullscreen na página); fora dela, pergunta ao script um ponto do vídeo visível e dá ali um
    // TOQUE de verdade: é o mesmo caminho do toque do dedo (o script aperta o botão "Tela cheia" do player, girando a tela antes
    // para a posição do vídeo). Sem vídeo na tela, manda Alt+seta para cima (o script abre a foto).
    private fun toggleVideoFullscreen() {
        if (!::web.isInitialized) return
        if (customView != null) {
            web.evaluateJavascript("document.exitFullscreen&&document.exitFullscreen()", null)
            return
        }
        web.evaluateJavascript("(window.nxVideoCenter?window.nxVideoCenter():'')") { raw ->
            val json = raw?.trim('"')?.replace("\\\"", "\"") ?: ""
            if (json.isEmpty() || json == "null") {
                web.evaluateJavascript("window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',altKey:true,bubbles:true,cancelable:true}))", null)
                return@evaluateJavascript
            }
            val o = org.json.JSONObject(json)
            val d = resources.displayMetrics.density
            tap(o.getDouble("x").toFloat() * d, o.getDouble("y").toFloat() * d)
        }
    }

    private fun tap(x: Float, y: Float) {
        val t = android.os.SystemClock.uptimeMillis()
        val down = MotionEvent.obtain(t, t, MotionEvent.ACTION_DOWN, x, y, 0).apply { source = android.view.InputDevice.SOURCE_TOUCHSCREEN }
        web.dispatchTouchEvent(down)
        down.recycle()
        ui.postDelayed({
            val t2 = android.os.SystemClock.uptimeMillis()
            val up = MotionEvent.obtain(t, t2, MotionEvent.ACTION_UP, x, y, 0).apply { source = android.view.InputDevice.SOURCE_TOUCHSCREEN }
            web.dispatchTouchEvent(up)
            up.recycle()
        }, 60)
    }

    // Controle (gamepad): A e R2 avançam, B e L2 voltam um post. O script já atende Alt+seta direita/esquerda; o app só manda
    // essa tecla para a página. Consome o botão (descer e subir) para o Android não tratá-lo (ex.: B como "voltar").
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode == KeyEvent.KEYCODE_DPAD_UP || event.keyCode == KeyEvent.KEYCODE_DPAD_DOWN) {
            val d = if (event.keyCode == KeyEvent.KEYCODE_DPAD_DOWN) 1 else -1
            if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) keyDir = d
            else if (event.action == KeyEvent.ACTION_UP && keyDir == d) keyDir = 0
            updateScroll()
            return true
        }
        val dir = when (event.keyCode) {
            KeyEvent.KEYCODE_BUTTON_A, KeyEvent.KEYCODE_BUTTON_R2 -> "ArrowRight"
            KeyEvent.KEYCODE_BUTTON_B, KeyEvent.KEYCODE_BUTTON_L2 -> "ArrowLeft"
            KeyEvent.KEYCODE_BUTTON_X -> {
                if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) toggleVideoFullscreen()
                return true
            }
            else -> {
                // Diagnóstico: mostra o código dos botões do controle que o app não usa (para achar o que o "X" manda de fato).
                if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0 && KeyEvent.isGamepadButton(event.keyCode))
                    Toast.makeText(this, "Botão: " + KeyEvent.keyCodeToString(event.keyCode), Toast.LENGTH_SHORT).show()
                return super.dispatchKeyEvent(event)
            }
        }
        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) sendNav(dir)
        return true
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        when {
            customView != null -> { web.evaluateJavascript("document.exitFullscreen&&document.exitFullscreen()", null); web.webChromeClient?.onHideCustomView() }
            ::web.isInitialized && web.canGoBack() -> web.goBack()
            else -> @Suppress("DEPRECATION") super.onBackPressed()
        }
    }

    companion object {
        private const val HOLD_FIRST_MS = 450L
        private const val HOLD_EVERY_MS = 250L
    }
}

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
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.Toast
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.security.SecureRandom
import java.util.concurrent.Executors
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit

/**
 * notiXias: o X (x.com) em WebViews com o userscript injetado antes de cada página.
 *
 * Telas (WebViews) da fila: até [MAX_QUEUE_VIEWS], empilhadas. A da frente ("active") mostra o post atual; as de trás
 * ("standby") já abrem os 5 seguintes e o anterior (o script da frente avisa quais são: `nx_neighbors`). Passar de post
 * (`nx_swap`) só traz para a frente a tela que já tem o post, e a que saiu da frente fica atrás com o post dela, pronta para
 * voltar. Um link para fora da fila abre numa tela por cima ("detached", `nx_detach`); fechá-la mostra de novo o post da fila,
 * que nunca saiu do lugar.
 *
 * Energia: tela de trás que já abriu o post fica invisível (o Android não a desenha e a página fica "escondida"); fora de foco,
 * o JavaScript de todas as telas é congelado (`pauseTimers`) e, depois de [UNLOAD_AFTER_MS], as telas de trás são esvaziadas
 * (voltam a abrir quando o app volta). A telemetria e os contadores do X (notificações, mensagens, números ao vivo) são recusados.
 */
class MainActivity : Activity() {
    private class Slot(val web: WebView, var role: String) {
        var entry: JSONObject? = null   // entrada da fila que esta tela tem aberta (ou está abrindo)
        var seq = -1L
        var dir = "fwd"
        var ready = false               // o script terminou de abrir o post nesta tela
        var script: ScriptHandler? = null
    }

    private lateinit var root: FrameLayout
    private lateinit var store: Store
    private lateinit var net: Net
    private lateinit var scripts: ScriptStore
    private lateinit var bridge: Bridge
    private lateinit var active: Slot
    private val slots = mutableListOf<Slot>()   // telas da fila (inclui a da frente)
    private var detached: Slot? = null           // tela por cima, fora da fila
    private var nextList = listOf<JSONObject>()  // seguintes na fila (até 5), do mais próximo ao mais longe
    private var gateSeqs = listOf<Long>()        // telas que a tela de carregamento espera (a que veio para a frente e a seguinte)
    private var prevList = listOf<JSONObject>()  // anterior na fila
    private var emptied = false                  // telas de trás esvaziadas (fora de foco por muito tempo / pouca memória)
    private val bridgeName = "_nx" + ByteArray(8).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
    private var shimText = ""
    private var customView: View? = null
    private var customCallback: WebChromeClient.CustomViewCallback? = null
    private var customOwner: WebView? = null
    private val io = Executors.newSingleThreadExecutor()
    private var restarting = false
    private val ui = Handler(Looper.getMainLooper())
    private val sweeper = object : Runnable {
        override fun run() { applyAwake(); ui.postDelayed(this, 2000) }
    }
    private val emptyBehind = Runnable { emptyStandby() }

    private val updater by lazy { AppUpdater(this, net) { detached == null && customView == null } }

    private val ready get() = ::active.isInitialized
    /** A tela que o dono está vendo: a de cima, se houver, ou a da frente da fila. */
    private fun top(): WebView? = detached?.web ?: if (ready) active.web else null
    private fun allSlots(): List<Slot> = slots + listOfNotNull(detached)
    private fun slotOf(view: WebView): Slot? = allSlots().firstOrNull { it.web === view }

    /** A tela do celular só fica acesa com vídeo em tela cheia; fora disso vale o tempo de tela do sistema. */
    private fun applyAwake() {
        val allowed = customView != null
        if (allowed) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            // o WebView pede "tela acesa" por conta própria enquanto qualquer vídeo toca (inclusive os mudos do feed): desfaz
            allSlots().forEach { clearKeepOn(it.web) }
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
        setContentView(root)
        applySystemBars()

        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            AlertDialog.Builder(this).setTitle("WebView desatualizado")
                .setMessage("Atualize o \"Android System WebView\" (e o Chrome) na Play Store e abra o app de novo.")
                .setPositiveButton("OK") { _, _ -> finish() }.setCancelable(false).show()
            return
        }

        CookieManager.getInstance().setAcceptCookie(true)
        // o service worker do X também faz pedidos: a mesma recusa da telemetria vale para ele
        android.webkit.ServiceWorkerController.getInstance().setServiceWorkerClient(object : android.webkit.ServiceWorkerClient() {
            override fun shouldInterceptRequest(request: WebResourceRequest): WebResourceResponse? = if (isNoise(request.url)) noContent() else null
        })
        bridge = Bridge(store, net) { view, key, value -> onApp(view, key, value) }
        buildShim()
        active = createSlot("active", onTop = true)
        slots.add(active)

        if (savedInstanceState != null) active.web.restoreState(savedInstanceState) else active.web.loadUrl("https://x.com/home")
        checkScriptUpdate(force = true)
    }

    override fun onDestroy() {
        if (ready) updater.onDestroy()
        allSlots().forEach { s -> root.removeView(s.web); s.web.destroy() }
        slots.clear()
        detached = null
        super.onDestroy()
    }

    private fun buildShim() {
        shimText = assets.open("shim.js").bufferedReader(Charsets.UTF_8).use { it.readText() }
            .replace("__NX_BRIDGE__", bridgeName)
            .replace("__BUNDLE__", scripts.current())
    }

    /** Uma tela do X com o script. A da fila nova fica atrás de todas; a da frente e a "por cima" ficam em cima. */
    private fun createSlot(role: String, onTop: Boolean): Slot {
        val w = WebView(this)
        val s = Slot(w, role)
        w.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            setSupportMultipleWindows(false)
            cacheMode = WebSettings.LOAD_DEFAULT
            textZoom = 105   // textos 5% maiores
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(w, true)
        WebViewCompat.addWebMessageListener(w, bridgeName, setOf("https://x.com"), bridge)
        s.script = WebViewCompat.addDocumentStartJavaScript(w, shimText, setOf("https://x.com"))
        w.webViewClient = webClient
        w.webChromeClient = chromeFor(w)
        val lp = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        if (onTop) root.addView(w, lp) else root.addView(w, 0, lp)
        return s
    }

    /**
     * Pedidos do X que não servem ao notiXias e só gastam rádio/bateria: telemetria (`jot`, `client_event`), contadores de
     * notificações e mensagens (`badge_count`, `dm/…`) e a conexão de números ao vivo (`live_pipeline`). Respondidos vazios aqui.
     */
    private fun isNoise(u: Uri): Boolean {
        val host = u.host ?: return false
        if (!(host == "x.com" || host.endsWith(".x.com") || host.endsWith("twitter.com"))) return false
        val p = u.path ?: return false
        return NOISE.any { p.contains(it) }
    }

    private fun noContent() = WebResourceResponse(
        "text/plain", "utf-8", 204, "No Content",
        mapOf("Access-Control-Allow-Origin" to "https://x.com", "Access-Control-Allow-Credentials" to "true"),
        java.io.ByteArrayInputStream(ByteArray(0)),
    )

    private val webClient = object : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
            if (isNoise(request.url)) noContent() else null
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val u = request.url
            val host = u.host ?: ""
            if (u.scheme == "https" && (host == "x.com" || host.endsWith(".x.com"))) return false
            // fora do X (links de notícias etc.): abre no navegador do aparelho
            try { startActivity(Intent(Intent.ACTION_VIEW, u)) } catch (e: Exception) { /* sem app para abrir */ }
            return true
        }
        // Todas as telas dividem o mesmo processo de página: se ele cair (ex.: falta de memória), recomeça o app em vez de fechar.
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (!restarting) {
                restarting = true
                startActivity(Intent(this@MainActivity, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
                finish()
            }
            return true
        }
    }

    private fun chromeFor(w: WebView) = object : WebChromeClient() {
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
            if (customView != null || w !== top()) { callback.onCustomViewHidden(); return }
            customView = view
            customCallback = callback
            customOwner = w
            root.addView(view, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            w.visibility = View.GONE
            immersive(true)
            applyAwake()
        }
        override fun onHideCustomView() { hideCustom() }
    }

    private fun hideCustom() {
        val v = customView ?: return
        root.removeView(v)
        customView = null
        customCallback?.onCustomViewHidden()
        customCallback = null
        val w = customOwner
        customOwner = null
        immersive(false)
        applyAwake()
        if (w == null) return
        w.visibility = View.VISIBLE
        // Evita a tela preta ao voltar: força nova medida/desenho do WebView e avisa a página do novo tamanho.
        w.requestLayout()
        w.invalidate()
        ui.postDelayed({
            w.requestLayout()
            w.invalidate()
            w.evaluateJavascript("window.dispatchEvent(new Event('resize'))", null)
        }, 250)
    }

    private fun exitFullscreenNow() {
        customOwner?.evaluateJavascript("document.exitFullscreen&&document.exitFullscreen()", null)
        hideCustom()
    }

    // ---------- ordens do script (Bridge, fora da linha principal) ----------
    private fun <T> onUi(f: () -> T): T? {
        val task = FutureTask(f)
        runOnUiThread(task)
        return try { task.get(3, TimeUnit.SECONDS) } catch (e: Exception) { null }
    }

    private fun onApp(view: WebView, key: String, value: String): Any? = when (key) {
        "nx_role" -> onUi { roleOf(view) }
        "nx_swap" -> onUi { swap(view, JSONObject(value)) } ?: 0
        "nx_neighbors" -> { runOnUiThread { assignNeighbors(view, JSONObject(value)) }; true }
        "nx_ready" -> {
            val seq = JSONObject(value).optLong("seq", -1)
            runOnUiThread { slotOf(view)?.let { if (it.seq == seq || it === active) { it.seq = seq; it.ready = true; applyVisibility() } } }
            true
        }
        "nx_window" -> onUi { unloadedInWindow() } ?: 0
        "nx_gone" -> {
            val seq = JSONObject(value).optLong("seq", -1)
            runOnUiThread { freeSlot(view, seq) }
            true
        }
        "nx_detach" -> { runOnUiThread { if (ready && view === active.web) detach(JSONObject(value).optString("url")) }; true }
        "nx_back" -> { runOnUiThread { if (view === detached?.web) detachedBack() }; true }
        "nx_nav" -> {
            runOnUiThread {
                if (view === detached?.web) {
                    closeDetached()
                    if (JSONObject(value).optString("dir") == "fwd") sendNav("ArrowRight")
                }
            }
            true
        }
        else -> null
    }

    private fun roleOf(view: WebView): String {
        val s = slotOf(view) ?: return JSONObject().put("role", "active").toString()
        val o = JSONObject().put("role", s.role)
        if (s.role == "standby" && s.entry != null) o.put("entry", s.entry).put("dir", s.dir)
        return o.toString()
    }

    private fun push(s: Slot, o: JSONObject) {
        s.web.evaluateJavascript("window.nxSlot&&window.nxSlot(" + JSONObject.quote(o.toString()) + ")", null)
    }

    private fun isXUrl(url: String): Boolean {
        val u = Uri.parse(url)
        val host = u.host ?: ""
        return u.scheme == "https" && (host == "x.com" || host.endsWith(".x.com"))
    }

    /** Passar de post: traz para a frente a tela de trás que já tem o post. false: nenhuma tem (o script abre do jeito normal). */
    private fun swap(view: WebView, o: JSONObject): Int {
        if (!ready || view !== active.web) return 0
        val e = o.optJSONObject("entry") ?: return 0
        val seq = e.optLong("seq", -1)
        val s = slots.firstOrNull { it !== active && it.seq == seq } ?: return 0
        // Regra do carregamento: para frente, se menos de 2 das telas da frente (a que vem e as seguintes) estão prontas, cobre
        // com carregamento até a que vem e a seguinte ficarem prontas. Para trás, só há o anterior: cobre se ele não está pronto.
        val back = o.optString("dir") == "back"
        val isReady = { sq: Long -> slots.firstOrNull { it.seq == sq }?.ready == true }
        val win = (if (back) prevList.take(PRELOAD_BACK) else nextList.take(PRELOAD_FWD))
            .filter { isXUrl(it.optString("url")) }.map { it.optLong("seq", -1) }
        val gate = if (back) !isReady(seq) else win.isNotEmpty() && win.count(isReady) < minOf(2, win.size)
        gateSeqs = if (back) listOf(seq) else (listOf(seq) + win.filter { it != seq }).take(2)
        if (customView != null) exitFullscreenNow()
        val old = active
        old.role = "standby"
        s.role = "active"
        s.entry = e
        active = s
        applyVisibility()
        s.web.bringToFront()
        detached?.web?.bringToFront()
        push(s, o.put("role", "active").put("gate", gate))
        push(old, JSONObject().put("role", "standby"))
        return if (gate) 2 else 1
    }

    /** Quantas das telas que a tela de carregamento espera (a da frente e a seguinte) ainda não terminaram de abrir o post. */
    private fun unloadedInWindow(): Int {
        if (!ready) return 0
        return gateSeqs.count { sq -> slots.firstOrNull { it.seq == sq }?.ready != true }
    }

    /** O post de uma tela de trás foi apagado (o script já o tirou da fila): a tela fica livre e a da frente manda os vizinhos de novo. */
    private fun freeSlot(view: WebView, seq: Long) {
        val s = slots.firstOrNull { it.web === view } ?: return
        if (s === active || s.seq != seq) return
        s.seq = -1
        s.entry = null
        s.ready = false
        applyVisibility()
        active.web.evaluateJavascript("window.nxRefreshNeighbors&&window.nxRefreshNeighbors()", null)
    }

    private fun entries(a: org.json.JSONArray?): List<JSONObject> =
        if (a == null) emptyList() else (0 until a.length()).mapNotNull { a.optJSONObject(it) }.filter { isXUrl(it.optString("url")) }

    /**
     * A tela da frente avisou o post atual e os vizinhos: os [PRELOAD_FWD] seguintes e os [PRELOAD_BACK] anteriores mais próximos
     * ficam em telas de trás, abertos desde já (reaproveita a tela que já tem o post; as que saíram da janela são reusadas).
     */
    private fun assignNeighbors(view: WebView, o: JSONObject) {
        if (!ready || view !== active.web) return
        o.optJSONObject("cur")?.let { active.entry = it; active.seq = it.optLong("seq", -1); active.ready = true }
        nextList = entries(o.optJSONArray("next"))
        prevList = entries(o.optJSONArray("prev"))
        fillNeighbors()
    }

    private fun fillNeighbors() {
        emptied = false
        // os da frente primeiro: são os que o leitor vai ver antes
        val want = nextList.take(PRELOAD_FWD).map { it to "fwd" } + prevList.take(PRELOAD_BACK).map { it to "back" }
        val wantSeqs = want.map { it.first.optLong("seq", -1) }.toSet()
        for ((e, d) in want) {
            val sq = e.optLong("seq", -1)
            if (sq == active.seq) continue
            val have = slots.firstOrNull { it !== active && it.seq == sq }
            if (have != null) { have.dir = d; continue }
            val free = slots.firstOrNull { it !== active && it.seq !in wantSeqs }
                ?: (if (slots.size < MAX_QUEUE_VIEWS) createSlot("standby", onTop = false).also { slots.add(it) } else null)
                ?: continue
            free.role = "standby"
            free.entry = e
            free.seq = sq
            free.dir = d
            free.ready = false
            free.web.visibility = View.VISIBLE   // abrindo: tem de estar "visível" para o X montar a página
            val u = free.web.url
            if (u.isNullOrEmpty() || u == "about:blank") free.web.loadUrl(e.optString("url"))
            else push(free, JSONObject().put("role", "standby").put("entry", e).put("dir", d))
        }
        applyVisibility()
    }

    /** Tela de trás que já abriu o post fica invisível: o Android não a desenha e, para a página, ela está escondida. */
    private fun applyVisibility() {
        for (s in slots) {
            if (s.web === customOwner) continue
            val v = if (s === active || (!s.ready && s.seq >= 0)) View.VISIBLE else View.INVISIBLE
            if (s.web.visibility != v) s.web.visibility = v
        }
    }

    /** Esvazia as telas de trás (página em branco): sem rede nem memória do X. Voltam a abrir com o app em foco. */
    private fun emptyStandby() {
        if (!ready) return
        for (s in slots) if (s !== active && s.seq >= 0) {
            s.web.stopLoading()
            s.web.loadUrl("about:blank")
            s.seq = -1
            s.entry = null
            s.ready = false
        }
        applyVisibility()
        emptied = true
    }

    /** Link para fora da fila: abre na tela por cima (a da fila fica parada no post). */
    private fun detach(url: String) {
        if (!isXUrl(url)) return
        if (customView != null) exitFullscreenNow()
        val d = detached ?: createSlot("detached", onTop = true).also { detached = it }
        d.web.bringToFront()
        d.web.loadUrl(url)
    }

    private fun closeDetached() {
        val d = detached ?: return
        if (customOwner === d.web) exitFullscreenNow()
        detached = null
        root.removeView(d.web)
        d.script?.remove()
        d.web.destroy()
        applyAwake()
    }

    private fun detachedBack() {
        val d = detached ?: return
        if (d.web.canGoBack()) d.web.goBack() else closeDetached()
    }

    /** Em segundo plano: busca o script mais novo no servidor; se mudou, guarda e recarrega as telas com ele. */
    private fun checkScriptUpdate(force: Boolean = false) {
        val now = System.currentTimeMillis()
        if (!force && now - store.lastCheckAt < 30 * 60 * 1000) return
        store.lastCheckAt = now
        io.execute {
            val novo = net.fetchScript() ?: return@execute
            scripts.save(novo)
            runOnUiThread {
                buildShim()
                allSlots().forEach { s ->
                    s.script?.remove()
                    s.script = WebViewCompat.addDocumentStartJavaScript(s.web, shimText, setOf("https://x.com"))
                }
                // Recarregar todas as telas de uma vez pesava a ponto de o app recomeçar (e a pergunta de atualização do app
                // sumia junto): só a da frente (e a por cima) recarregam; as de trás esvaziam e reabrem quando a da frente
                // avisar os vizinhos de novo.
                emptyStandby()
                (listOf(active) + listOfNotNull(detached)).forEach { s -> if (!s.web.url.isNullOrEmpty()) s.web.reload() }
                Toast.makeText(this, "notiXias: script atualizado", Toast.LENGTH_SHORT).show()
            }
        }
    }

    override fun onResume() {
        super.onResume()
        ui.removeCallbacks(emptyBehind)
        if (ready) {
            active.web.resumeTimers()   // vale para todas as telas
            allSlots().forEach { it.web.onResume() }
            if (emptied) fillNeighbors()
            checkScriptUpdate(); updater.onResume(); ui.post(sweeper)
        }
    }

    override fun onPause() {
        ui.removeCallbacks(sweeper)
        if (ready) {
            updater.onPause()
            allSlots().forEach { it.web.onPause() }
            active.web.pauseTimers()   // congela o JavaScript de todas as telas (o X e o script) até o app voltar
            CookieManager.getInstance().flush()
            ui.postDelayed(emptyBehind, UNLOAD_AFTER_MS)
        }
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        super.onPause()
    }

    // Pouca memória: as telas de trás são as primeiras a sair.
    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        @Suppress("DEPRECATION")
        if (level == TRIM_MEMORY_RUNNING_CRITICAL || level >= TRIM_MEMORY_MODERATE) { ui.removeCallbacks(emptyBehind); emptyStandby() }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (ready) active.web.saveState(outState)
    }

    // Rolagem pelo controle (cruzeta e analógico): um toque rola um passo (40% da altura da tela); só segurando repete
    // (primeiro depois de HOLD_FIRST_MS, depois a cada HOLD_EVERY_MS). A cruzeta pode vir como teclas (DPAD_UP/DOWN) ou como
    // eixo (HAT_Y), e o analógico como AXIS_Y (esquerdo) ou AXIS_RZ (direito): cada fonte guarda a sua direção (-1, 0, 1) e vale
    // a primeira diferente de 0. Os eventos do analógico são consumidos, para o WebView não rolar sozinho sem parar.
    private fun scrollPage(down: Boolean) {
        val sign = if (down) "" else "-"
        top()?.evaluateJavascript("window.scrollBy({top:${sign}Math.round(window.innerHeight*0.4),behavior:'smooth'})", null)
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

    // Avançar/voltar vai para a tela da fila. Com a tela por cima aberta: voltar só a fecha (volta ao post); avançar a fecha e
    // passa para o próximo.
    private fun sendNav(dir: String) {
        if (!ready) return
        if (detached != null) {
            closeDetached()
            if (dir != "ArrowRight") return
        }
        active.web.evaluateJavascript(
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
        } else barFlags()
    }

    private fun isNight() =
        (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) ==
            android.content.res.Configuration.UI_MODE_NIGHT_YES

    // Barras de status e de navegação (inclusive a de gestos) seguem o modo claro/escuro do celular.
    @Suppress("DEPRECATION")
    private fun barFlags(): Int =
        if (isNight()) View.SYSTEM_UI_FLAG_VISIBLE
        else View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR

    @Suppress("DEPRECATION")
    private fun applySystemBars() {
        val bg = if (isNight()) Color.BLACK else Color.WHITE
        window.statusBarColor = bg
        window.navigationBarColor = bg
        if (android.os.Build.VERSION.SDK_INT >= 28) window.navigationBarDividerColor = bg
        if (customView == null) window.decorView.systemUiVisibility = barFlags()
    }

    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
        super.onConfigurationChanged(newConfig)
        applySystemBars()
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
            else -> return super.dispatchKeyEvent(event)
        }
        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) sendNav(dir)
        return true
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        when {
            customView != null -> exitFullscreenNow()
            detached != null -> detachedBack()
            // na tela da fila, voltar é navegação do script (não abre a tela por cima)
            ready && active.web.canGoBack() -> active.web.evaluateJavascript("window.nxBack?window.nxBack():history.back()", null)
            else -> @Suppress("DEPRECATION") super.onBackPressed()
        }
    }

    companion object {
        private const val HOLD_FIRST_MS = 450L
        private const val HOLD_EVERY_MS = 250L
        private const val PRELOAD_FWD = 5
        private const val PRELOAD_BACK = 1
        private const val MAX_QUEUE_VIEWS = 1 + PRELOAD_FWD + PRELOAD_BACK
        private const val UNLOAD_AFTER_MS = 3 * 60 * 1000L
        // trechos de caminho dos pedidos recusados (ver isNoise)
        private val NOISE = listOf("/jot/", "client_event", "/badge_count/", "/dm/user_updates", "/dm/inbox_initial_state", "/live_pipeline/")
    }
}

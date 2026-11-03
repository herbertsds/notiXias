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
 * ("standby") já abrem os 3 anteriores e os 3 seguintes (o script da frente avisa quais são: `nx_neighbors`). Passar de post
 * (`nx_swap`) só traz para a frente a tela que já tem o post, e a que saiu da frente fica atrás com o post dela, pronta para
 * voltar. Um link para fora da fila abre numa tela por cima ("detached", `nx_detach`); fechá-la mostra de novo o post da fila,
 * que nunca saiu do lugar.
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
    private var player: PlayerOverlay? = null    // player de vídeo do app, por cima de tudo
    private var nextList = listOf<JSONObject>()  // seguintes na fila (até 4), do mais próximo ao mais longe
    private var prevList = listOf<JSONObject>()  // anteriores na fila (até 4), do mais próximo ao mais longe
    private val bridgeName = "_nx" + ByteArray(8).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
    private var shimText = ""
    private var customView: View? = null
    private var customCallback: WebChromeClient.CustomViewCallback? = null
    private var customOwner: WebView? = null
    private val io = Executors.newSingleThreadExecutor()
    private var scriptAwake = false      // o script avisou: vídeo tocando em tela cheia
    private var restarting = false
    private val ui = Handler(Looper.getMainLooper())
    private val sweeper = object : Runnable {
        override fun run() { applyAwake(); ui.postDelayed(this, 1000) }
    }

    private val vcache by lazy { VideoCache.get(this) }
    private val mediaDumps = HashMap<Long, Int>()   // seq -> quantas vezes já se procurou vídeo nessa tela

    // A cada 3 s pergunta às telas da janela (frente + vizinhas) quais vídeos o post delas tem e manda baixar (até 5 min cada).
    private val videoScan = object : Runnable {
        override fun run() {
            if (ready) for (s in slots.toList()) {
                val sq = s.seq
                if (!s.ready || sq < 0 || (mediaDumps[sq] ?: 0) >= MAX_MEDIA_SCANS) continue
                mediaDumps[sq] = (mediaDumps[sq] ?: 0) + 1
                s.web.evaluateJavascript("(window.__nxMediaDump?window.__nxMediaDump():'[]')") { raw -> queueVideos(sq, raw) }
            }
            ui.postDelayed(this, 3000)
        }
    }

    private fun queueVideos(seq: Long, raw: String?) {
        if (raw == null || raw == "null") return
        try {
            val list = org.json.JSONArray(JSONObject("{\"v\":$raw}").getString("v"))
            if (slots.none { it.seq == seq }) return
            for (i in 0 until list.length()) {
                val m = list.getJSONObject(i)
                val best = m.optJSONArray("variants")?.optJSONObject(0) ?: continue
                val url = best.optString("url")
                if (url.startsWith("https://")) vcache.fetch(url, seq, best.optLong("bitrate"), m.optLong("duration"))
            }
        } catch (e: Exception) { /* resposta inesperada: tenta de novo na próxima volta */ }
    }

    private val ready get() = ::active.isInitialized
    /** A tela que o dono está vendo: a de cima, se houver, ou a da frente da fila. */
    private fun top(): WebView? = detached?.web ?: if (ready) active.web else null
    private fun allSlots(): List<Slot> = slots + listOfNotNull(detached)
    private fun slotOf(view: WebView): Slot? = allSlots().firstOrNull { it.web === view }

    /** A tela do celular só fica acesa com vídeo tocando em tela cheia; fora disso vale o tempo de tela do sistema. */
    private fun applyAwake() {
        val allowed = scriptAwake || customView != null || player != null
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
        bridge = Bridge(store, net) { view, key, value -> onApp(view, key, value) }
        buildShim()
        active = createSlot("active", onTop = true)
        slots.add(active)

        if (savedInstanceState != null) active.web.restoreState(savedInstanceState) else active.web.loadUrl("https://x.com/home")
        checkScriptUpdate(force = true)
    }

    override fun onDestroy() {
        player?.close()
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

    private val webClient = object : WebViewClient() {
        override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
            if (view === top()) {
                scriptAwake = false   // página nova: o script avisa de novo se houver vídeo em tela cheia
                applyAwake()
            }
        }
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
            // O X tenta travar a tela em deitado ao entrar em tela cheia (vídeo em pé saía de lado): reafirma a do vídeo.
            if (wantedOrientation != "auto") listOf(250L, 800L, 1600L).forEach { ms -> ui.postDelayed({ if (customView != null) setOrientation(wantedOrientation) }, ms) }
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
        wantedOrientation = "auto"
        requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
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
        // o script avisa se há vídeo tocando em tela cheia (só então a tela do celular fica acesa)
        "nx_awake" -> { runOnUiThread { if (view === top()) { scriptAwake = value == "true"; applyAwake() } }; true }
        // o script pede a orientação ("portrait", "landscape" ou "auto") antes de entrar em tela cheia
        "nx_orient" -> { runOnUiThread { if (view === top()) setOrientation(value) }; true }
        "nx_role" -> onUi { roleOf(view) }
        "nx_swap" -> onUi { swap(view, JSONObject(value)) } ?: 0
        "nx_neighbors" -> { runOnUiThread { assignNeighbors(view, JSONObject(value)) }; true }
        "nx_ready" -> {
            val seq = JSONObject(value).optLong("seq", -1)
            runOnUiThread { slotOf(view)?.let { if (it.seq == seq || it === active) { it.seq = seq; it.ready = true } } }
            true
        }
        "nx_window" -> onUi { unloadedInWindow(JSONObject(value).optString("dir")) } ?: 0
        "nx_player" -> { runOnUiThread { if (view === top()) openPlayer(JSONObject(value)) }; true }
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
        // Regra do carregamento: janela = a tela que vem + 3 além dela na direção; só cobre com carregamento se 3 das 4 não carregaram.
        val list = if (o.optString("dir") == "back") prevList else nextList
        val win = list.take(4).filter { isXUrl(it.optString("url")) }
        val unloaded = win.count { e -> slots.firstOrNull { it.seq == e.optLong("seq", -1) }?.ready != true }
        val gate = win.isNotEmpty() && unloaded >= minOf(3, win.size)
        if (customView != null) exitFullscreenNow()
        val old = active
        old.role = "standby"
        s.role = "active"
        s.entry = e
        active = s
        s.web.bringToFront()
        detached?.web?.bringToFront()
        push(s, o.put("role", "active").put("gate", gate))
        push(old, JSONObject().put("role", "standby"))
        return if (gate) 2 else 1
    }

    /** Quantas das telas da janela (a da frente e as 3 seguintes na direção `dir`) ainda não terminaram de abrir o post. */
    private fun unloadedInWindow(dir: String): Int {
        if (!ready) return 0
        val list = if (dir == "back") prevList else nextList
        val seqs = listOf(active.seq) + list.take(3).filter { isXUrl(it.optString("url")) }.map { it.optLong("seq", -1) }
        return seqs.count { sq -> slots.firstOrNull { it.seq == sq }?.ready != true }
    }

    private fun entries(a: org.json.JSONArray?): List<JSONObject> =
        if (a == null) emptyList() else (0 until a.length()).mapNotNull { a.optJSONObject(it) }.filter { isXUrl(it.optString("url")) }

    /**
     * A tela da frente avisou o post atual e os vizinhos (até 4 de cada lado): os [PRELOAD_EACH_WAY] mais próximos de cada lado
     * ficam em telas de trás, abertos desde já (reaproveita a tela que já tem o post; as que saíram da janela são reusadas).
     */
    private fun assignNeighbors(view: WebView, o: JSONObject) {
        if (!ready || view !== active.web) return
        o.optJSONObject("cur")?.let { active.entry = it; active.seq = it.optLong("seq", -1); active.ready = true }
        nextList = entries(o.optJSONArray("next"))
        prevList = entries(o.optJSONArray("prev"))
        // os da frente primeiro: são os que o leitor vai ver antes
        val want = nextList.take(PRELOAD_EACH_WAY).map { it to "fwd" } + prevList.take(PRELOAD_EACH_WAY).map { it to "back" }
        val wantSeqs = want.map { it.first.optLong("seq", -1) }.toSet()
        // vídeos de posts que saíram da janela: apagados do armazenamento
        vcache.retain(wantSeqs + active.seq)
        mediaDumps.keys.retainAll(wantSeqs + active.seq)
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
            if (free.web.url.isNullOrEmpty()) free.web.loadUrl(e.optString("url"))
            else push(free, JSONObject().put("role", "standby").put("entry", e).put("dir", d))
        }
    }

    /** Player de vídeo do app: tela cheia por cima de tudo, no formato do vídeo. O vídeo da página fica parado atrás. */
    private fun openPlayer(info: JSONObject) {
        player?.close()
        if (customView != null) exitFullscreenNow()
        val p = PlayerOverlay(this, root, info, { player = null; immersive(false); applyAwake(); top()?.evaluateJavascript("window.nxPlayerClosed&&window.nxPlayerClosed()", null) }, { immersive(true) }, vcache.factory)
        player = p
        if (!p.start()) { player = null; Toast.makeText(this, "Esse vídeo não tem arquivo para tocar", Toast.LENGTH_SHORT).show(); return }
        immersive(true)
        applyAwake()
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
        scriptAwake = false
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
                    if (!s.web.url.isNullOrEmpty()) s.web.reload()
                }
                Toast.makeText(this, "notiXias: script atualizado", Toast.LENGTH_SHORT).show()
            }
        }
    }

    override fun onResume() {
        super.onResume()
        if (ready) { allSlots().forEach { it.web.onResume() }; checkScriptUpdate(); ui.post(sweeper); ui.post(videoScan) }
    }

    override fun onPause() {
        ui.removeCallbacks(sweeper)
        ui.removeCallbacks(videoScan)
        player?.pause()
        if (ready) { allSlots().forEach { it.web.onPause() }; CookieManager.getInstance().flush() }
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        super.onPause()
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
        if (player != null) return
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
        if (!ready || player != null) return
        if (detached != null) {
            closeDetached()
            if (dir != "ArrowRight") return
        }
        active.web.evaluateJavascript(
            "window.dispatchEvent(new KeyboardEvent('keydown',{key:'$dir',altKey:true,bubbles:true,cancelable:true}))", null
        )
    }

    override fun dispatchGenericMotionEvent(event: MotionEvent): Boolean {
        if (player != null && (event.source and android.view.InputDevice.SOURCE_JOYSTICK) != 0) return true
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
        if (customView == null && player == null) window.decorView.systemUiVisibility = barFlags()
    }

    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
        super.onConfigurationChanged(newConfig)
        applySystemBars()
    }

    // Botão X: com o player aberto, fecha; senão pede ao script para abrir o vídeo mais visível no player (sem vídeo na tela,
    // manda Alt+seta para cima: o script abre a foto).
    private fun toggleVideoFullscreen() {
        if (player != null) { player?.close(); return }
        if (customView != null) {
            customOwner?.evaluateJavascript("document.exitFullscreen&&document.exitFullscreen()", null)
            return
        }
        val w = top() ?: return
        w.evaluateJavascript("(window.nxPlayVisible?window.nxPlayVisible():false)") { raw ->
            if (raw?.trim() != "true")
                w.evaluateJavascript("window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',altKey:true,bubbles:true,cancelable:true}))", null)
        }
    }

    // Controle (gamepad): A e R2 avançam, B e L2 voltam um post. O script já atende Alt+seta direita/esquerda; o app só manda
    // essa tecla para a página. Consome o botão (descer e subir) para o Android não tratá-lo (ex.: B como "voltar").
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        player?.let { p ->
            if (event.keyCode == KeyEvent.KEYCODE_VOLUME_UP || event.keyCode == KeyEvent.KEYCODE_VOLUME_DOWN) return super.dispatchKeyEvent(event)
            return p.onKey(event)
        }
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
            player != null -> player?.close()
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
        private const val PRELOAD_EACH_WAY = 3
        private const val MAX_MEDIA_SCANS = 10
        private const val MAX_QUEUE_VIEWS = 1 + 2 * PRELOAD_EACH_WAY
    }
}

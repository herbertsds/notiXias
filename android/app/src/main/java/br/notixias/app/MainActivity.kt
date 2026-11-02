package br.notixias.app

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
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
        }
        CookieManager.getInstance().apply { setAcceptCookie(true); setAcceptThirdPartyCookies(web, true) }
        WebViewCompat.addWebMessageListener(web, bridgeName, setOf("https://x.com"), Bridge(store, net) { on -> runOnUiThread { scriptAwake = on; applyAwake() } })
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
            }
            override fun onHideCustomView() {
                customView?.let { root.removeView(it) }
                customView = null
                customCallback?.onCustomViewHidden()
                customCallback = null
                web.visibility = View.VISIBLE
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

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        when {
            customView != null -> web.webChromeClient?.onHideCustomView()
            ::web.isInitialized && web.canGoBack() -> web.goBack()
            else -> @Suppress("DEPRECATION") super.onBackPressed()
        }
    }
}

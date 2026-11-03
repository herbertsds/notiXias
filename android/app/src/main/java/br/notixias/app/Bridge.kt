package br.notixias.app

import android.net.Uri
import android.webkit.CookieManager
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * Ponte entre a página (https://x.com) e o app: armazenamento, rede e cookies do script. As chaves de [APP_KEYS] não vão para o
 * armazenamento: são ordens para o app (tela acesa, orientação, troca de telas da fila...), atendidas por [app] com a tela
 * (WebView) que mandou; o que [app] devolve volta para o script.
 */
class Bridge(private val store: Store, private val net: Net, private val app: (WebView, String, String) -> Any?) : WebViewCompat.WebMessageListener {
    private val pool = Executors.newFixedThreadPool(4)

    override fun onPostMessage(view: WebView, message: WebMessageCompat, sourceOrigin: Uri, isMainFrame: Boolean, replyProxy: JavaScriptReplyProxy) {
        val text = message.data ?: return
        pool.execute {
            var id = 0
            val result: Any? = try {
                val m = JSONObject(text)
                id = m.optInt("id")
                handle(view, m)
            } catch (e: Exception) {
                JSONObject().put("error", (e.message ?: "erro").take(200))
            }
            replyProxy.postMessage(JSONObject().put("id", id).put("result", result ?: JSONObject.NULL).toString())
        }
    }

    private fun handle(view: WebView, m: JSONObject): Any? = when (m.optString("op")) {
        // "nx_role": o papel desta tela (frente, trás ou por cima) e o post que ela deve abrir
        "get" -> if (m.optString("key") == "nx_role") app(view, "nx_role", "") else store.get(m.optString("key"))
        "set" -> {
            val k = m.optString("key")
            if (k in APP_KEYS) app(view, k, m.optString("value")) ?: true
            else { store.set(k, m.optString("value")); true }
        }
        "http" -> net.http(m.getJSONObject("req"))
        "cookies" -> cookies()
        else -> JSONObject().put("error", "operação desconhecida")
    }

    companion object {
        // nx_awake: vídeo tocando em tela cheia (tela acesa); nx_orient: orientação antes da tela cheia; nx_swap: trazer para a
        // frente a tela que já tem o post; nx_neighbors: anterior/próximo a abrir atrás; nx_detach: abrir link por cima;
        // nx_back / nx_nav: fechar a tela por cima (e passar de post).
        val APP_KEYS = setOf("nx_awake", "nx_orient", "nx_swap", "nx_neighbors", "nx_detach", "nx_back", "nx_nav")
    }

    /** Cookies de x.com no formato que o script espera (name/value/domain). Inclui os HttpOnly. */
    private fun cookies(): JSONArray {
        val out = JSONArray()
        val raw = CookieManager.getInstance().getCookie("https://x.com") ?: return out
        for (part in raw.split(";")) {
            val i = part.indexOf('=')
            if (i <= 0) continue
            out.put(JSONObject().put("name", part.substring(0, i).trim()).put("value", part.substring(i + 1).trim()).put("domain", ".x.com"))
        }
        return out
    }
}

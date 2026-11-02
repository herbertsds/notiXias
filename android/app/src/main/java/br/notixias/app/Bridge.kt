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

/** Ponte entre a página (https://x.com) e o app: armazenamento, rede e cookies do script. */
class Bridge(private val store: Store, private val net: Net) : WebViewCompat.WebMessageListener {
    private val pool = Executors.newFixedThreadPool(4)

    override fun onPostMessage(view: WebView, message: WebMessageCompat, sourceOrigin: Uri, isMainFrame: Boolean, replyProxy: JavaScriptReplyProxy) {
        val text = message.data ?: return
        pool.execute {
            var id = 0
            val result: Any? = try {
                val m = JSONObject(text)
                id = m.optInt("id")
                handle(m)
            } catch (e: Exception) {
                JSONObject().put("error", (e.message ?: "erro").take(200))
            }
            replyProxy.postMessage(JSONObject().put("id", id).put("result", result ?: JSONObject.NULL).toString())
        }
    }

    private fun handle(m: JSONObject): Any? = when (m.optString("op")) {
        "get" -> store.get(m.optString("key"))
        "set" -> { store.set(m.optString("key"), m.optString("value")); true }
        "http" -> net.http(m.getJSONObject("req"))
        "cookies" -> cookies()
        else -> JSONObject().put("error", "operação desconhecida")
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

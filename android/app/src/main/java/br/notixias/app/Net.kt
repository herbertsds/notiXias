package br.notixias.app

import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.net.SocketTimeoutException
import java.net.URI
import java.util.concurrent.TimeUnit

/** Chamadas à API do notiXias. Só o servidor configurado é alcançado e a chave é posta aqui (nunca passa pela página). */
class Net(private val store: Store) {
    private val client = OkHttpClient.Builder()
        .callTimeout(60, TimeUnit.SECONDS)
        .build()

    private fun allowed(url: String): Boolean {
        val base = store.apiBase()
        if (base.isEmpty()) return false
        return try {
            val a = URI(url)
            val b = URI(base)
            a.scheme == b.scheme && a.host.equals(b.host, true) && a.port == b.port
        } catch (e: Exception) { false }
    }

    /** req: {method,url,headers,data,timeout} -> {status,text} ou {error}. */
    fun http(req: JSONObject): JSONObject {
        val url = req.optString("url")
        if (!allowed(url)) return JSONObject().put("error", "destino não permitido")
        return try {
            val method = req.optString("method", "GET").uppercase()
            val builder = Request.Builder().url(url)
            val headers = req.optJSONObject("headers")
            var contentType = "application/json"
            headers?.keys()?.forEach { k ->
                if (k.equals("authorization", true)) return@forEach
                if (k.equals("content-type", true)) contentType = headers.getString(k)
                builder.header(k, headers.getString(k))
            }
            builder.header("Authorization", "Bearer " + store.apiKey())
            val data = if (req.isNull("data")) null else req.optString("data")
            val body = if (method == "GET" || method == "HEAD") null
                else (data ?: "").toRequestBody(contentType.toMediaTypeOrNull())
            builder.method(method, body)
            val call = client.newBuilder()
                .callTimeout(req.optLong("timeout", 30000), TimeUnit.MILLISECONDS).build().newCall(builder.build())
            call.execute().use { r -> JSONObject().put("status", r.code).put("text", r.body?.string() ?: "") }
        } catch (e: SocketTimeoutException) {
            JSONObject().put("error", "timeout")
        } catch (e: java.io.InterruptedIOException) {
            JSONObject().put("error", "timeout")
        } catch (e: Exception) {
            JSONObject().put("error", (e.message ?: "erro").take(200))
        }
    }

    /** Baixa o script mais novo do servidor (ETag). Devolve o texto novo, ou null se não mudou / não deu. */
    fun fetchScript(): String? {
        val base = store.apiBase()
        if (base.isEmpty() || store.apiKey().isEmpty()) return null
        return try {
            val rb = Request.Builder().url("$base/api/v1/userscript").header("Authorization", "Bearer " + store.apiKey())
            store.etag?.let { rb.header("If-None-Match", it) }
            client.newCall(rb.build()).execute().use { r ->
                if (r.code != 200) return null
                val text = r.body?.string() ?: return null
                if (!text.contains("==UserScript==")) return null   // resposta estranha: não troca o que funciona
                store.etag = r.header("ETag")
                text
            }
        } catch (e: Exception) { null }
    }
}

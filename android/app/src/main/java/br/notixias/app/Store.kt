package br.notixias.app

import android.content.Context
import org.json.JSONObject

/** Armazenamento do script (GM_getValue/GM_setValue). A chave da API fica à parte e nunca volta para a página. */
class Store(context: Context) {
    private val prefs = context.getSharedPreferences("nx", Context.MODE_PRIVATE)

    fun get(key: String): String? = if (key.startsWith("nx_")) prefs.getString("v_$key", null) else null

    fun set(key: String, value: String) {
        if (!key.startsWith("nx_") || value.length > 500_000) return
        var v = value
        if (key == "nx_cfg") {
            // a página entrega a configuração com a chave; o app guarda a chave e devolve só um marcador
            try {
                val o = JSONObject(value)
                val k = o.optString("apiKey", "")
                if (k.isNotEmpty() && k != MARKER) prefs.edit().putString("api_key", k).apply()
                o.put("apiKey", if (apiKey().isNotEmpty()) MARKER else "")
                v = o.toString()
            } catch (e: Exception) { /* guarda como veio */ }
        }
        prefs.edit().putString("v_$key", v).apply()
    }

    /** Primeira abertura (ou configuração incompleta): preenche o endereço da API e a chave que vieram no APK. */
    fun seedDefaults() {
        val cfg = try { JSONObject(get("nx_cfg") ?: "{}") } catch (e: Exception) { JSONObject() }
        var changed = false
        if (apiBase().isEmpty() && BuildConfig.DEFAULT_API_URL.isNotEmpty()) { cfg.put("apiBaseUrl", BuildConfig.DEFAULT_API_URL); changed = true }
        if (apiKey().isEmpty() && BuildConfig.DEFAULT_API_KEY.isNotEmpty()) { cfg.put("apiKey", BuildConfig.DEFAULT_API_KEY); changed = true }
        if (changed) set("nx_cfg", cfg.toString())
    }

    fun apiKey(): String = prefs.getString("api_key", "") ?: ""

    /** Endereço da API (ex.: https://servidor), sem barra no fim; vazio se ainda não configurado. */
    fun apiBase(): String = try {
        JSONObject(get("nx_cfg") ?: "{}").optString("apiBaseUrl", "").trimEnd('/')
    } catch (e: Exception) { "" }

    var etag: String?
        get() = prefs.getString("script_etag", null)
        set(v) { prefs.edit().putString("script_etag", v).apply() }

    var lastCheckAt: Long
        get() = prefs.getLong("script_checked_at", 0)
        set(v) { prefs.edit().putLong("script_checked_at", v).apply() }

    companion object { const val MARKER = "chave-no-app" }
}

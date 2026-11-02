package br.notixias.app

import android.content.Context
import java.io.File

/** O userscript: a cópia baixada do servidor (se houver) ou a que vem dentro do app. */
class ScriptStore(private val context: Context) {
    private val local = File(context.filesDir, "notixias.user.js")

    fun current(): String =
        if (local.isFile && local.length() > 0) local.readText(Charsets.UTF_8)
        else context.assets.open("notixias.user.js").bufferedReader(Charsets.UTF_8).use { it.readText() }

    fun save(text: String) {
        val tmp = File(context.filesDir, "notixias.user.js.new")
        tmp.writeText(text, Charsets.UTF_8)
        tmp.renameTo(local)
    }
}

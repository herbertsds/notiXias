package br.notixias.app

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.widget.Toast
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

/**
 * Atualização do próprio app pelo servidor: confere (ao abrir, no máximo a cada 30 min) se o servidor tem um APK de versionCode
 * maior, pergunta, baixa (confere o sha256) e entrega ao instalador do Android, que ainda pede a confirmação. Na primeira vez o
 * Android pede para permitir "instalar apps desconhecidos" ao notiXias; ao voltar da configuração a instalação segue sozinha.
 */
class AppUpdater(private val act: Activity, private val net: Net, private val canAsk: () -> Boolean) {
    private val io = Executors.newSingleThreadExecutor()
    private var lastCheckAt = 0L
    private var declined = -1L          // versão que o dono recusou nesta abertura do app
    private var busy = false
    private var waitingPermission: File? = null
    private var progress: AlertDialog? = null

    init { File(act.cacheDir, "update").deleteRecursively() }   // APK de uma atualização anterior

    private fun currentCode(): Long = try {
        act.packageManager.getPackageInfo(act.packageName, 0).longVersionCode
    } catch (e: Exception) { Long.MAX_VALUE }

    /** Chamar no onResume. */
    fun onResume() {
        waitingPermission?.let { f ->
            if (act.packageManager.canRequestPackageInstalls()) { waitingPermission = null; install(f) }
            return
        }
        check()
    }

    private fun check() {
        val now = System.currentTimeMillis()
        if (busy || now - lastCheckAt < CHECK_EVERY_MS) return
        lastCheckAt = now
        io.execute {
            val info = net.appInfo() ?: return@execute
            val code = info.optLong("versionCode", 0)
            if (code <= currentCode() || code == declined) return@execute
            act.runOnUiThread { ask(info) }
        }
    }

    private fun ask(info: JSONObject) {
        if (act.isFinishing || busy || !canAsk()) { lastCheckAt = 0; return }   // tenta de novo na próxima vez
        val code = info.optLong("versionCode")
        val mb = "%.1f".format(info.optLong("size") / 1048576.0)
        AlertDialog.Builder(act)
            .setTitle("Atualização do notiXias")
            .setMessage("Versão ${info.optString("versionName")} disponível ($mb MB). Atualizar agora?")
            .setPositiveButton("Atualizar") { _, _ -> download(info) }
            .setNegativeButton("Depois") { _, _ -> declined = code }
            .setCancelable(false)
            .show()
    }

    private fun download(info: JSONObject) {
        busy = true
        val size = info.optLong("size")
        val dlg = AlertDialog.Builder(act).setTitle("Baixando a atualização").setMessage("0%").setCancelable(false).create()
        progress = dlg
        dlg.show()
        val dest = File(act.cacheDir, "update/notixias.apk")
        io.execute {
            dest.delete()
            val sha = net.downloadApk(dest) { got ->
                if (size > 0) act.runOnUiThread { dlg.setMessage((got * 100 / size).coerceAtMost(100).toString() + "%") }
            }
            act.runOnUiThread {
                dlg.dismiss(); progress = null; busy = false
                if (sha == null || !sha.equals(info.optString("sha256"), true)) {
                    dest.delete()
                    lastCheckAt = 0
                    Toast.makeText(act, "Não consegui baixar a atualização", Toast.LENGTH_LONG).show()
                } else install(dest)
            }
        }
    }

    private fun install(apk: File) {
        if (!act.packageManager.canRequestPackageInstalls()) {
            waitingPermission = apk
            Toast.makeText(act, "Permita instalar apps do notiXias e volte", Toast.LENGTH_LONG).show()
            act.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + act.packageName)))
            return
        }
        val uri = FileProvider.getUriForFile(act, act.packageName + ".files", apk)
        act.startActivity(
            Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        )
    }

    companion object { private const val CHECK_EVERY_MS = 30 * 60 * 1000L }
}

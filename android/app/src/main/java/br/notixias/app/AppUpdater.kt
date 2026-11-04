package br.notixias.app

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.widget.Toast
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

/**
 * Atualização do próprio app pelo servidor: confere se o servidor tem um APK de versionCode maior, pergunta, baixa (confere o
 * sha256) e entrega ao instalador do Android, que ainda pede a confirmação. Na primeira vez o Android pede para permitir
 * "instalar apps desconhecidos" ao notiXias; ao voltar da configuração a instalação segue sozinha.
 *
 * Confere ao abrir e ao voltar ao app (no máximo a cada [CHECK_EVERY_MS]) e, com o app aberto, a cada [CHECK_EVERY_MS]. A versão
 * achada fica guardada: se a pergunta não pôde aparecer (tela por cima, vídeo em tela cheia, app fora de foco) ou sumiu (o app
 * recomeçou), ela é feita de novo assim que der, sem esperar a próxima consulta.
 */
class AppUpdater(private val act: Activity, private val net: Net, private val canAsk: () -> Boolean) {
    private val io = Executors.newSingleThreadExecutor()
    private val ui = Handler(Looper.getMainLooper())
    private var lastCheckAt = 0L
    private var declined = -1L          // versão que o dono recusou nesta abertura do app
    private var busy = false
    private var resumed = false
    private var offer: JSONObject? = null   // versão nova achada e ainda não perguntada
    private var dialog: AlertDialog? = null
    private var waitingPermission: File? = null

    init { File(act.cacheDir, "update").deleteRecursively() }   // APK de uma atualização anterior

    private fun currentCode(): Long = try {
        act.packageManager.getPackageInfo(act.packageName, 0).longVersionCode
    } catch (e: Exception) { Long.MAX_VALUE }

    private val periodic = object : Runnable {
        override fun run() { check(); ui.postDelayed(this, CHECK_EVERY_MS) }
    }
    private val retryAsk = Runnable { tryAsk() }

    /** Chamar no onResume. */
    fun onResume() {
        resumed = true
        waitingPermission?.let { f ->
            if (act.packageManager.canRequestPackageInstalls()) { waitingPermission = null; install(f) }
            return
        }
        if (offer != null) tryAsk()
        ui.removeCallbacks(periodic)
        ui.post(periodic)
    }

    /** Chamar no onPause. */
    fun onPause() {
        resumed = false
        ui.removeCallbacks(periodic)
        ui.removeCallbacks(retryAsk)
    }

    private fun check() {
        val now = System.currentTimeMillis()
        if (busy || now - lastCheckAt < CHECK_EVERY_MS) return
        io.execute {
            val info = net.appInfo() ?: return@execute          // sem rede: tenta de novo na próxima volta ao app
            act.runOnUiThread {
                lastCheckAt = System.currentTimeMillis()
                val code = info.optLong("versionCode", 0)
                if (code > currentCode() && code != declined) { offer = info; tryAsk() }
            }
        }
    }

    private fun tryAsk() {
        val info = offer ?: return
        if (busy || dialog?.isShowing == true) return
        if (!resumed || act.isFinishing || !canAsk()) {
            // agora não dá (tela por cima, tela cheia...): pergunta de novo em instantes, enquanto o app estiver aberto
            ui.removeCallbacks(retryAsk)
            if (resumed) ui.postDelayed(retryAsk, RETRY_ASK_MS)
            return
        }
        val code = info.optLong("versionCode")
        val mb = "%.1f".format(info.optLong("size") / 1048576.0)
        dialog = AlertDialog.Builder(act)
            .setTitle("Atualização do notiXias")
            .setMessage("Versão ${info.optString("versionName")} disponível ($mb MB). Atualizar agora?")
            .setPositiveButton("Atualizar") { _, _ -> offer = null; download(info) }
            .setNegativeButton("Depois") { _, _ -> offer = null; declined = code }
            .setCancelable(false)
            .show()
    }

    private fun download(info: JSONObject) {
        busy = true
        val size = info.optLong("size")
        val dlg = AlertDialog.Builder(act).setTitle("Baixando a atualização").setMessage("0%").setCancelable(false).create()
        dlg.show()
        val dest = File(act.cacheDir, "update/notixias.apk")
        io.execute {
            dest.delete()
            val sha = net.downloadApk(dest) { got ->
                if (size > 0) act.runOnUiThread { dlg.setMessage((got * 100 / size).coerceAtMost(100).toString() + "%") }
            }
            act.runOnUiThread {
                try { dlg.dismiss() } catch (e: Exception) { /* a tela já fechou */ }
                busy = false
                if (sha == null || !sha.equals(info.optString("sha256"), true)) {
                    dest.delete()
                    offer = info   // pergunta de novo na próxima vez
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

    /** Ao fechar a tela: não deixa a pergunta "vazar" da janela que fechou. */
    fun onDestroy() {
        ui.removeCallbacksAndMessages(null)
        try { dialog?.dismiss() } catch (e: Exception) { /* já fechada */ }
        dialog = null
    }

    companion object {
        private const val CHECK_EVERY_MS = 10 * 60 * 1000L
        private const val RETRY_ASK_MS = 15_000L
    }
}

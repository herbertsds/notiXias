package br.notixias.app

import android.content.Context
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.CacheWriter
import androidx.media3.datasource.cache.NoOpCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import java.io.File
import java.util.concurrent.Executors

/**
 * Vídeos das telas da fila, baixados para o armazenamento do app enquanto o leitor ainda não chegou neles: até [MAX_SECONDS]
 * de cada vídeo (só [MOBILE_SECONDS] em dados móveis) (na melhor qualidade em mp4). O player do app lê pelo mesmo cache, então abre na hora. Cada vídeo é apagado
 * quando o post dele sai da janela de telas abertas, e o cache inteiro é apagado quando o app abre.
 */
class VideoCache(ctx: Context) {
    private class Job(val url: String, val owner: Long, val secs: Long) { @Volatile var writer: CacheWriter? = null; @Volatile var cancelled = false }

    private val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as android.net.ConnectivityManager
    private val dir = File(ctx.cacheDir, "videos")
    private val cache: SimpleCache
    val factory: DataSource.Factory
    private val pool = Executors.newFixedThreadPool(2)
    private val jobs = HashMap<String, Job>()   // por url; só mexe a thread principal

    init {
        dir.deleteRecursively()
        cache = SimpleCache(dir, NoOpCacheEvictor(), StandaloneDatabaseProvider(ctx))
        factory = CacheDataSource.Factory().setCache(cache)
            .setUpstreamDataSourceFactory(DefaultDataSource.Factory(ctx))
            .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)
    }

    fun has(url: String) = jobs.containsKey(url)

    /** Começa a baixar [url] (dono: o `seq` do post) até [seconds] segundos, se não houver já. */
    fun fetch(url: String, owner: Long, bitrate: Long, durationMs: Long) {
        // Dados móveis (rede com franquia): só 10 s de cada vídeo; no Wi-Fi, até 5 min. Se voltar ao Wi-Fi, completa o que faltar.
        val cap = if (metered()) MOBILE_SECONDS else MAX_SECONDS
        val secs = if (durationMs > 0) minOf(durationMs / 1000 + 1, cap) else cap
        val old = jobs[url]
        if (old != null && old.secs >= secs) return
        old?.let { it.cancelled = true; try { it.writer?.cancel() } catch (e: Exception) { /* já terminou */ } }
        val job = Job(url, owner, secs)
        jobs[url] = job
        val rate = if (bitrate > 0) bitrate / 8 else DEFAULT_BYTES_PER_SEC
        val limit = rate * secs
        pool.execute {
            if (job.cancelled) return@execute
            try {
                val w = CacheWriter(factory.createDataSource() as CacheDataSource, DataSpec.Builder().setUri(url).setLength(limit).build(), null, null)
                job.writer = w
                if (!job.cancelled) w.cache()
            } catch (e: Exception) { /* cancelado ou sem rede: o player baixa sozinho quando abrir */ }
        }
    }

    private fun metered(): Boolean = try { cm.isActiveNetworkMetered } catch (e: Exception) { true }

    /** Apaga os vídeos de todo post cujo `seq` não está em [keep]. */
    fun retain(keep: Set<Long>) {
        val gone = jobs.values.filter { it.owner !in keep }
        for (j in gone) {
            j.cancelled = true
            try { j.writer?.cancel() } catch (e: Exception) { /* já terminou */ }
            jobs.remove(j.url)
            pool.execute { try { cache.removeResource(j.url) } catch (e: Exception) { /* nada guardado */ } }
        }
    }

    companion object {
        private const val MAX_SECONDS = 300L
        private const val MOBILE_SECONDS = 10L
        private const val DEFAULT_BYTES_PER_SEC = 400_000L   // ~3 Mbps, quando o X não diz o bitrate
        @Volatile private var instance: VideoCache? = null
        fun get(ctx: Context): VideoCache = instance ?: synchronized(this) { instance ?: VideoCache(ctx.applicationContext).also { instance = it } }
    }
}

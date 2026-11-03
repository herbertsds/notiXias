package br.notixias.app

import android.app.Activity
import android.app.AlertDialog
import android.content.pm.ActivityInfo
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.SeekBar
import android.widget.TextView
import android.widget.Toast
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import org.json.JSONObject

/**
 * Player de vídeo do notiXias: tela cheia por cima de tudo, com o arquivo do vídeo (o script acha os links nas respostas do X).
 *
 *  - abre na melhor qualidade (a lista vem da maior para a menor; o botão de qualidade troca no meio do vídeo);
 *  - gira para o formato do vídeo (em pé / deitado) e o trava nele, mesmo com o celular na outra posição; o cadeado solta;
 *  - abre mudo ou com som conforme o vídeo da página estava, e começa onde ele estava;
 *  - controles grandes: aparecem quando o vídeo carrega, somem em 3 s; toque na tela mostra/esconde; segurar avança em 2x.
 */
class PlayerOverlay(
    private val act: Activity,
    private val parent: FrameLayout,
    info: JSONObject,
    private val onClosed: () -> Unit,
    private val reimmerse: () -> Unit,
) {
    private class Variant(val url: String, val label: String)

    private val ui = Handler(Looper.getMainLooper())
    private val density = act.resources.displayMetrics.density
    private fun dp(v: Int) = (v * density).toInt()

    private val variants: List<Variant>
    private var quality = 0
    private var muted = info.optBoolean("muted", true)
    private var lockOn = true
    private var wantPortrait: Boolean? = null
    private var closed = false
    private var dragging = false
    private var controlsOn = false
    private var firstReady = false
    private var longHeld = false
    private var startMs = 0L
    private var resumeAfterHold = false
    private var speed = 1f
    private var stallToken = 0

    private val root = FrameLayout(act).apply { setBackgroundColor(Color.BLACK) }
    // Começa a tocar com pouco buffer (0,5 s), em vez dos 2,5 s padrão.
    private val player: ExoPlayer = ExoPlayer.Builder(act)
        .setLoadControl(DefaultLoadControl.Builder().setBufferDurationsMs(15_000, 50_000, 500, 1_500).build())
        .build()
    private val surface = PlayerView(act)
    private val touchLayer = View(act)
    private val controls = FrameLayout(act)
    private val spinner = ProgressBar(act)
    private val badge: TextView
    private val playBtn: TextView
    private val muteBtn: TextView
    private val lockBtn: TextView
    private val qualityBtn: TextView
    private val speedBtn: TextView
    private val seek = SeekBar(act)
    private val posText: TextView
    private val durText: TextView

    init {
        val raw = info.optJSONArray("variants")
        val list = ArrayList<Variant>()
        if (raw != null) for (i in 0 until raw.length()) {
            val v = raw.optJSONObject(i) ?: continue
            val url = v.optString("url")
            if (url.startsWith("https://")) list.add(Variant(url, labelOf(url, v.optLong("bitrate"), v.optBoolean("hls"))))
        }
        variants = list

        val w = info.optInt("w")
        val h = info.optInt("h")
        if (w > 0 && h > 0) wantPortrait = h > w

        surface.useController = false
        surface.resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
        surface.keepScreenOn = true
        surface.player = player
        root.addView(surface, FrameLayout.LayoutParams(-1, -1))

        touchLayer.setOnTouchListener(::onTouch)
        root.addView(touchLayer, FrameLayout.LayoutParams(-1, -1))

        spinner.isIndeterminate = true
        root.addView(spinner, FrameLayout.LayoutParams(dp(56), dp(56), Gravity.CENTER))

        badge = label("2x  ▶▶", 18f).apply {
            setPadding(dp(18), dp(8), dp(18), dp(8))
            background = pill()
            visibility = View.GONE
        }
        root.addView(badge, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply { topMargin = dp(24) })

        // ---- controles ----
        val top = LinearLayout(act).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        top.addView(button("✕", 56) { close() })
        top.addView(View(act), LinearLayout.LayoutParams(0, 1, 1f))
        qualityBtn = button(variants.firstOrNull()?.label ?: "", 56, wide = true) { pickQuality() }
        top.addView(qualityBtn, LinearLayout.LayoutParams(-2, dp(56)).apply { rightMargin = dp(12) })
        speedBtn = button("1x", 56, wide = true) { pickSpeed() }
        top.addView(speedBtn, LinearLayout.LayoutParams(-2, dp(56)).apply { rightMargin = dp(12) })
        muteBtn = button(if (muted) "Mudo" else "Som", 56, wide = true) { toggleMute() }
        top.addView(muteBtn, LinearLayout.LayoutParams(-2, dp(56)).apply { rightMargin = dp(12) })
        lockBtn = button("Fixo", 56, wide = true) { toggleLock() }
        top.addView(lockBtn, LinearLayout.LayoutParams(-2, dp(56)))
        controls.addView(top, FrameLayout.LayoutParams(-1, -2, Gravity.TOP))

        val mid = LinearLayout(act).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
        mid.addView(button("⟲ 10", 64, wide = true) { seekBy(-10_000) }, LinearLayout.LayoutParams(-2, dp(64)).apply { rightMargin = dp(28) })
        playBtn = button(PAUSE, 88) { togglePlay() }
        mid.addView(playBtn, LinearLayout.LayoutParams(dp(88), dp(88)))
        mid.addView(button("10 ⟳", 64, wide = true) { seekBy(10_000) }, LinearLayout.LayoutParams(-2, dp(64)).apply { leftMargin = dp(28) })
        controls.addView(mid, FrameLayout.LayoutParams(-1, -2, Gravity.CENTER))

        posText = label("0:00", 14f)
        durText = label("0:00", 14f)
        val bottom = LinearLayout(act).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        bottom.addView(posText)
        seek.setPadding(dp(14), dp(10), dp(14), dp(10))
        seek.progressTintList = android.content.res.ColorStateList.valueOf(Color.WHITE)
        seek.thumbTintList = android.content.res.ColorStateList.valueOf(Color.WHITE)
        seek.progressBackgroundTintList = android.content.res.ColorStateList.valueOf(0x66FFFFFF)
        bottom.addView(seek, LinearLayout.LayoutParams(0, dp(48), 1f))
        bottom.addView(durText)
        controls.addView(bottom, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM).apply { bottomMargin = dp(8) })
        controls.visibility = View.VISIBLE
        controls.alpha = 1f
        controlsOn = true
        controls.setPadding(dp(16), dp(12), dp(16), dp(12))
        root.addView(controls, FrameLayout.LayoutParams(-1, -1))

        // O recorte da câmera/cantos arredondados não podem cobrir os botões.
        root.setOnApplyWindowInsetsListener { _, ins ->
            var l = dp(16); var t = dp(12); var r = dp(16); var b = dp(12)
            if (android.os.Build.VERSION.SDK_INT >= 28) ins.displayCutout?.let {
                l = maxOf(l, it.safeInsetLeft); t = maxOf(t, it.safeInsetTop); r = maxOf(r, it.safeInsetRight); b = maxOf(b, it.safeInsetBottom)
            }
            controls.setPadding(l, t, r, b)
            ins
        }

        seek.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(s: SeekBar, p: Int, fromUser: Boolean) { if (fromUser) posText.text = fmt(p.toLong()) }
            override fun onStartTrackingTouch(s: SeekBar) { dragging = true; ui.removeCallbacks(hide) }
            override fun onStopTrackingTouch(s: SeekBar) { dragging = false; player.seekTo(s.progress.toLong()); scheduleHide() }
        })

        // ---- reprodução ----
        player.setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(), true)
        player.repeatMode = Player.REPEAT_MODE_ONE
        player.volume = if (muted) 0f else 1f
        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                spinner.visibility = if (state == Player.STATE_BUFFERING) View.VISIBLE else View.GONE
                if (state == Player.STATE_READY) {
                    durText.text = fmt(player.duration)
                    seek.max = player.duration.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
                    if (!firstReady) { firstReady = true; showControls() }   // aparecem quando o vídeo carrega e somem em seguida
                }
            }
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                playBtn.text = if (isPlaying) PAUSE else PLAY
                if (isPlaying) scheduleHide() else { ui.removeCallbacks(hide); if (firstReady && !longHeld) showControls() }
            }
            override fun onVideoSizeChanged(size: VideoSize) {
                if (size.width <= 0 || size.height <= 0) return
                val swap = size.unappliedRotationDegrees == 90 || size.unappliedRotationDegrees == 270
                val w = size.width * size.pixelWidthHeightRatio
                val h = size.height.toFloat()
                wantPortrait = if (swap) w > h else h > w
                applyOrientation()
            }
            override fun onPlayerError(error: PlaybackException) {
                if (quality + 1 < variants.size) {
                    Toast.makeText(act, "Qualidade indisponível, tentando outra…", Toast.LENGTH_SHORT).show()
                    setQuality(quality + 1)
                } else {
                    Toast.makeText(act, "Não consegui reproduzir o vídeo", Toast.LENGTH_LONG).show()
                    close()
                }
            }
        })

        startMs = (info.optDouble("time", 0.0) * 1000).toLong()
    }

    /** Mostra o player e começa a tocar (depois de construído, para os campos de baixo já existirem). false: sem arquivo de vídeo. */
    fun start(): Boolean {
        if (variants.isEmpty()) return false
        parent.addView(root, ViewGroup.LayoutParams(-1, -1))
        applyOrientation()
        player.setMediaItem(MediaItem.fromUri(variants[0].url), startMs)
        player.prepare()
        player.playWhenReady = true
        watchStall()
        ui.post(ticker)
        return true
    }

    // ---------- interface ----------
    // Discreto: quase transparente, com um fio branco fino.
    private fun pill() = GradientDrawable().apply {
        setColor(0x1FFFFFFF); setStroke(dp(1), 0x66FFFFFF); cornerRadius = dp(28).toFloat()
    }

    private fun label(text: String, size: Float) = TextView(act).apply {
        this.text = text
        setTextColor(0xF2FFFFFF.toInt())
        textSize = size
        gravity = Gravity.CENTER
        setPadding(dp(6), 0, dp(6), 0)
    }

    private fun button(text: String, size: Int, wide: Boolean = false, onClick: () -> Unit) = label(text, if (size >= 80) 30f else 16f).apply {
        background = pill()
        if (wide) setPadding(dp(16), 0, dp(16), 0)
        minimumWidth = dp(size)
        minimumHeight = dp(size)
        setOnClickListener { onClick(); if (!closed) scheduleHide() }
    }

    private val hide = Runnable { hideControls() }

    private fun showControls() {
        if (closed) return
        controlsOn = true
        controls.visibility = View.VISIBLE
        controls.animate().cancel()
        controls.animate().alpha(1f).setDuration(150).start()
        scheduleHide()
    }

    private fun hideControls() {
        if (closed || dragging || !player.isPlaying) return
        controlsOn = false
        controls.animate().cancel()
        controls.animate().alpha(0f).setDuration(250).withEndAction { if (!controlsOn) controls.visibility = View.GONE }.start()
    }

    private fun scheduleHide() {
        ui.removeCallbacks(hide)
        if (player.isPlaying && controlsOn) ui.postDelayed(hide, HIDE_AFTER_MS)
    }

    // Toque: mostra/esconde os controles. Segurar (sem mexer o dedo): 2x enquanto estiver segurando.
    private var downX = 0f
    private var downY = 0f
    private var moved = false
    private val longPress = Runnable {
        longHeld = true
        resumeAfterHold = !player.isPlaying
        player.setPlaybackSpeed(HOLD_SPEED)
        if (resumeAfterHold) player.play()
        badge.visibility = View.VISIBLE
    }

    private fun onTouch(v: View, e: MotionEvent): Boolean {
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = e.x; downY = e.y; moved = false; longHeld = false
                ui.postDelayed(longPress, HOLD_MS)
            }
            MotionEvent.ACTION_MOVE -> if (!moved && Math.hypot((e.x - downX).toDouble(), (e.y - downY).toDouble()) > dp(14)) {
                moved = true
                if (!longHeld) ui.removeCallbacks(longPress)
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                ui.removeCallbacks(longPress)
                if (longHeld) {
                    player.setPlaybackSpeed(speed)
                    if (resumeAfterHold) player.pause()
                    badge.visibility = View.GONE
                    longHeld = false
                } else if (e.actionMasked == MotionEvent.ACTION_UP && !moved) {
                    if (controlsOn) { ui.removeCallbacks(hide); hideControls() } else showControls()
                }
            }
        }
        return true
    }

    private val ticker = object : Runnable {
        override fun run() {
            if (closed) return
            if (!dragging && controlsOn) {
                val p = player.currentPosition
                posText.text = fmt(p)
                seek.progress = p.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
                seek.secondaryProgress = player.bufferedPosition.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
            }
            ui.postDelayed(this, 250)
        }
    }

    private fun fmt(ms: Long): String {
        if (ms < 0) return "0:00"
        val s = ms / 1000
        return if (s >= 3600) "%d:%02d:%02d".format(s / 3600, s / 60 % 60, s % 60) else "%d:%02d".format(s / 60, s % 60)
    }

    // ---------- ações ----------
    fun togglePlay() { if (player.isPlaying) player.pause() else player.play() }

    fun seekBy(deltaMs: Long) {
        val dur = if (player.duration > 0) player.duration else Long.MAX_VALUE
        player.seekTo((player.currentPosition + deltaMs).coerceIn(0L, dur))
        if (!controlsOn) showControls()
    }

    private fun toggleMute() {
        muted = !muted
        player.volume = if (muted) 0f else 1f
        muteBtn.text = if (muted) "Mudo" else "Som"
    }

    // Formato do vídeo (em pé/deitado) travado; o sensor ainda deixa virar de cabeça para baixo. O cadeado solta (segue o celular).
    private fun applyOrientation() {
        act.requestedOrientation = when {
            !lockOn || wantPortrait == null -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            wantPortrait == true -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
            else -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        }
    }

    private fun toggleLock() {
        lockOn = !lockOn
        lockBtn.text = if (lockOn) "Fixo" else "Livre"
        applyOrientation()
        Toast.makeText(act, if (lockOn) "Girar: fixo no formato do vídeo" else "Girar: livre (segue o celular)", Toast.LENGTH_SHORT).show()
    }

    private fun setQuality(i: Int) {
        if (i !in variants.indices) return
        val pos = player.currentPosition
        val playing = player.playWhenReady
        quality = i
        qualityBtn.text = variants[i].label
        player.setMediaItem(MediaItem.fromUri(variants[i].url), pos)
        player.prepare()
        player.playWhenReady = playing
        if (!firstReady) watchStall()
    }

    private fun pickSpeed() {
        ui.removeCallbacks(hide)
        val idx = SPEEDS.indexOf(speed).coerceAtLeast(0)
        AlertDialog.Builder(act).setTitle("Velocidade")
            .setSingleChoiceItems(SPEEDS.map { fmtSpeed(it) }.toTypedArray(), idx) { d, i ->
                d.dismiss()
                speed = SPEEDS[i]
                player.setPlaybackSpeed(speed)
                speedBtn.text = fmtSpeed(speed)
            }
            .setOnDismissListener { reimmerse(); scheduleHide() }
            .show()
    }

    private fun fmtSpeed(r: Float) = r.toString().removeSuffix(".0").replace('.', ',') + "x"

    // Vídeo que não começa em 4 s na qualidade escolhida: cai para a próxima (o X costuma ter uma menor já em cache).
    private fun watchStall() {
        val token = ++stallToken
        ui.postDelayed({
            if (closed || token != stallToken || firstReady) return@postDelayed
            if (player.playbackState == Player.STATE_BUFFERING && quality + 1 < variants.size) {
                Toast.makeText(act, "Carregando devagar: tentando " + variants[quality + 1].label, Toast.LENGTH_SHORT).show()
                setQuality(quality + 1)
            }
        }, STALL_MS)
    }

    private fun pickQuality() {
        if (variants.size < 2) { Toast.makeText(act, "Só há uma qualidade", Toast.LENGTH_SHORT).show(); return }
        ui.removeCallbacks(hide)
        AlertDialog.Builder(act).setTitle("Qualidade")
            .setSingleChoiceItems(variants.map { it.label }.toTypedArray(), quality) { d, i -> d.dismiss(); if (i != quality) setQuality(i) }
            .setOnDismissListener { reimmerse(); scheduleHide() }
            .show()
    }

    private fun labelOf(url: String, bitrate: Long, hls: Boolean): String {
        if (hls) return "Automática"
        val m = Regex("/(\\d{3,4})x(\\d{3,4})/").find(url)
        if (m != null) return minOf(m.groupValues[1].toInt(), m.groupValues[2].toInt()).toString() + "p"
        return if (bitrate > 0) "${bitrate / 1000} kbps" else "Original"
    }

    /** Teclas do controle com o player aberto. */
    fun onKey(e: KeyEvent): Boolean {
        if (e.action != KeyEvent.ACTION_DOWN) return true
        when (e.keyCode) {
            KeyEvent.KEYCODE_BUTTON_A, KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> if (e.repeatCount == 0) { togglePlay(); showControls() }
            KeyEvent.KEYCODE_BUTTON_B, KeyEvent.KEYCODE_BUTTON_X, KeyEvent.KEYCODE_BACK -> if (e.repeatCount == 0) close()
            KeyEvent.KEYCODE_DPAD_LEFT -> seekBy(-10_000)
            KeyEvent.KEYCODE_DPAD_RIGHT -> seekBy(10_000)
        }
        return true
    }

    fun pause() { if (!closed) player.pause() }

    fun close() {
        if (closed) return
        closed = true
        ui.removeCallbacksAndMessages(null)
        try { player.release() } catch (e: Exception) { /* já liberado */ }
        parent.removeView(root)
        act.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        onClosed()
    }

    companion object {
        private const val HIDE_AFTER_MS = 3000L
        private const val HOLD_MS = 350L
        private const val HOLD_SPEED = 2f
        private const val STALL_MS = 4000L
        private const val PLAY = "▶\uFE0E"
        private const val PAUSE = "❚❚"
        // Mesmos valores do botão de velocidade do script (Core.SPEEDS).
        private val SPEEDS = listOf(0.1f, 0.25f, 0.5f, 0.75f, 1f, 1.25f, 1.5f, 1.75f, 2f, 2.5f, 2.75f, 3f)
    }
}

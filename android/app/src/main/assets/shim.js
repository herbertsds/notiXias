// Faz o userscript rodar dentro do app: GM_* viram mensagens para o código nativo (Bridge.kt). Só atua em x.com.
// O objeto de ponte tem nome aleatório por execução do app e a chave da API nunca passa pela página (o nativo a põe no
// cabeçalho); a rede só alcança a API do notiXias.
(function () {
  if (!/(^|\.)x\.com$/i.test(location.hostname)) return;
  const port = window['__NX_BRIDGE__'];
  if (!port) return;
  try { Object.defineProperty(window, '__NX_BRIDGE__', { enumerable: false }); } catch (e) { /* segue */ }
  const pending = new Map();
  let seq = 0;
  port.onmessage = (ev) => {
    try {
      const m = JSON.parse(ev.data);
      const f = pending.get(m.id);
      if (f) { pending.delete(m.id); f(m.result); }
    } catch (e) { /* mensagem inválida: ignora */ }
  };
  const call = (op, args) => new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    port.postMessage(JSON.stringify(Object.assign({ id, op }, args)));
  });
  const GM_getValue = (k) => call('get', { key: k });
  const GM_setValue = (k, v) => call('set', { key: k, value: v });
  const GM = { getValue: GM_getValue, setValue: GM_setValue };
  const GM_xmlhttpRequest = (o) => {
    call('http', { req: { method: o.method, url: o.url, headers: o.headers || {}, data: o.data === undefined ? null : o.data, timeout: o.timeout || 30000 } })
      .then((r) => (r.error ? (r.error === 'timeout' && o.ontimeout ? o.ontimeout() : o.onerror && o.onerror(r)) : o.onload && o.onload({ status: r.status, responseText: r.text })))
      .catch((e) => o.onerror && o.onerror(e));
  };
  // Cookies de x.com (inclusive o login, que é HttpOnly): é isto que permite "Enviar sessão do X para o robô" no celular.
  const GM_cookie = { list: (d, cb) => call('cookies', {}).then((l) => cb(l || [], null)).catch((e) => cb([], String(e))) };
  // Arquivos dos vídeos: o X já manda, nas respostas da API (fetch/XHR), as variantes de cada vídeo (mp4 em várias qualidades e HLS).
  // Aqui só se guarda o que a resposta traz (nenhuma chamada nova ao X); o player do app usa isso para tocar o vídeo no lugar do
  // player do X. Vem antes de qualquer código da página (injeção no início do documento).
  const mediaById = new Map();    // id da mídia -> { id, tweet, type, thumb, w, h, duration, variants }
  const mediaByTweet = new Map(); // id do post -> [ mídias de vídeo ]
  const addMedia = (m, tweetId) => {
    if (!m || !m.video_info || !Array.isArray(m.video_info.variants)) return;
    const mp4 = m.video_info.variants.filter((v) => v && v.url && /mp4/i.test(v.content_type || '') && !/^hls/i.test(v.content_type || ''))
      .map((v) => ({ url: v.url, bitrate: v.bitrate || 0 })).sort((a, b) => b.bitrate - a.bitrate);
    const hls = m.video_info.variants.filter((v) => v && v.url && /mpegurl/i.test(v.content_type || '')).map((v) => ({ url: v.url, bitrate: 0, hls: true }));
    const oi = m.original_info || {};
    const e = {
      id: String(m.id_str || ''), tweet: tweetId || null, type: m.type || 'video', thumb: m.media_url_https || '',
      w: oi.width || 0, h: oi.height || 0, duration: m.video_info.duration_millis || 0, variants: mp4.concat(hls),
    };
    if (e.id) mediaById.set(e.id, e);
    if (tweetId) {
      const l = mediaByTweet.get(tweetId) || [];
      if (!l.some((x) => x.id === e.id)) l.push(e);
      mediaByTweet.set(tweetId, l);
    }
  };
  const walkMedia = (o, tweetId, depth) => {
    if (!o || typeof o !== 'object' || depth > 40) return;
    if (Array.isArray(o)) { for (const x of o) walkMedia(x, tweetId, depth + 1); return; }
    const tid = o.rest_id && o.legacy ? String(o.rest_id) : tweetId;
    if (o.extended_entities && Array.isArray(o.extended_entities.media)) for (const m of o.extended_entities.media) addMedia(m, tid);
    for (const k in o) { const v = o[k]; if (v && typeof v === 'object') walkMedia(v, tid, depth + 1); }
  };
  const scanMedia = (text) => {
    if (typeof text !== 'string' || text.indexOf('"video_info"') < 0) return;
    setTimeout(() => { try { walkMedia(JSON.parse(text), null, 0); } catch (e) { /* resposta que não é JSON */ } }, 0);
  };
  const isApiUrl = (u) => /\/i\/api\/|\/graphql\//.test(u || '');
  try {
    const realFetch = window.fetch;
    window.fetch = function () {
      const p = realFetch.apply(this, arguments);
      try { p.then((r) => { if (r && isApiUrl(r.url)) r.clone().text().then(scanMedia, () => {}); }, () => {}); } catch (e) { /* segue */ }
      return p;
    };
    const realOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, url) {
      try {
        if (isApiUrl(String(url))) this.addEventListener('load', () => { try { if (!this.responseType || this.responseType === 'text') scanMedia(this.responseText); } catch (e) { /* segue */ } });
      } catch (e) { /* segue */ }
      return realOpen.apply(this, arguments);
    };
  } catch (e) { /* sem captura: o player do app não será usado */ }
  // Mídia de um <video> da página: pelo pôster (traz o id da mídia) ou, sem ele, pelo post (o `index`-ésimo vídeo dele).
  const mediaFor = (poster, tweetId, index) => {
    for (const id of String(poster || '').match(/\d{12,}/g) || []) if (mediaById.has(id)) return mediaById.get(id);
    const l = (tweetId && mediaByTweet.get(String(tweetId)) || []).filter((m) => m.type === 'video');
    return l[index || 0] || l[0] || null;
  };
  try { Object.defineProperty(window, '__nxMediaFor', { value: mediaFor, enumerable: false }); } catch (e) { /* segue */ }

  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    setTimeout(() => {
      (function (GM_xmlhttpRequest, GM_getValue, GM_setValue, GM, GM_cookie) {
__BUNDLE__
      })(GM_xmlhttpRequest, GM_getValue, GM_setValue, GM, GM_cookie);
    }, 800);
  };
  if (document.readyState !== 'loading') start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
  setTimeout(start, 20000);
})();

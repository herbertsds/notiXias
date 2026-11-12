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
  // Compartilhar: o WebView não tem `navigator.share`, e sem ele o X só oferece "Copiar link". Aqui ele abre a folha de
  // compartilhar do Android (o app recebe `nx_share`). Vem antes do código da página, para o X já o encontrar.
  try {
    if (!navigator.share) {
      const share = function (d) {
        d = d || {};
        const value = JSON.stringify({ title: String(d.title || ''), text: String(d.text || ''), url: String(d.url || '') });
        return call('set', { key: 'nx_share', value }).then(() => undefined);
      };
      Object.defineProperty(share, '__nx', { value: true });
      Object.defineProperty(Navigator.prototype, 'share', { value: share, configurable: true, writable: true });
      if (!navigator.canShare) Object.defineProperty(Navigator.prototype, 'canShare', { value: () => true, configurable: true, writable: true });
    }
  } catch (e) { /* sem compartilhar nativo */ }
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

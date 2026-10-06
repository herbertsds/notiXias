// Faz o userscript rodar fora do Tampermonkey: GM_* implementados sobre funções expostas pelo Playwright.
// GM_* ficam em variáveis LOCAIS (não em window). As funções expostas pelo Playwright não podem ser apagadas de window
// (o Playwright as consulta a cada chamada), então têm nome aleatório por execução e ficam não enumeráveis; além disso
// a chave da API nunca passa pela página (o Python a coloca no cabeçalho) e a rede só alcança a API do notiXias.
(function () {
  if (!/(^|\.)x\.com$/i.test(location.hostname)) return;
  const names = __NX_BINDINGS__; // { get, set, http }: nomes aleatórios desta execução
  const b = {};
  for (const k of ['get', 'set', 'http']) {
    b[k] = window[names[k]];
    try { Object.defineProperty(window, names[k], { enumerable: false }); } catch (e) { /* segue */ }
  }
  const GM_getValue = (k) => b.get(k);
  const GM_setValue = (k, v) => b.set(k, v);
  const GM = { getValue: GM_getValue, setValue: GM_setValue };
  const GM_xmlhttpRequest = (o) => {
    b.http({ method: o.method, url: o.url, headers: o.headers || {}, data: o.data === undefined ? null : o.data, timeout: o.timeout || 30000 })
      .then((r) => (r.error ? (r.error === 'timeout' && o.ontimeout ? o.ontimeout() : o.onerror && o.onerror(r)) : o.onload && o.onload({ status: r.status, responseText: r.text })))
      .catch((e) => o.onerror && o.onerror(e));
  };
  const start = () => setTimeout(() => {
    (function (GM_xmlhttpRequest, GM_getValue, GM_setValue, GM) {
__BUNDLE__
    })(GM_xmlhttpRequest, GM_getValue, GM_setValue, GM);
  }, 800);
  if (document.readyState === 'complete') start(); else window.addEventListener('load', start, { once: true });
})();

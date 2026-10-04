// ==UserScript==
// @name         notiXias
// @namespace    notixias
// @version      0.1.0
// @description  Leitor sequencial da timeline do X com posição salva (uso pessoal).
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      localhost
// @connect      127.0.0.1
// ==/UserScript==

(function () {
'use strict';

// ---- core.js ----
// core: funções puras (sem DOM, sem rede). Testáveis em Node.
const Core = (function () {
  const STATUS_RE = /^\/([^/]+)\/status\/(\d+)$/;
  const PROFILE_RE = /^\/([A-Za-z0-9_]{1,15})$/;
  const RESERVED = new Set([
    'home', 'explore', 'notifications', 'messages', 'search', 'settings',
    'compose', 'i', 'login', 'signup', 'tos', 'privacy',
  ]);
  const HOST_RE = /(^|\.)(x|twitter)\.com$/i;

  function toUrl(href, origin) {
    try {
      return new URL(href, origin);
    } catch (e) {
      return null;
    }
  }

  // "/usuario/status/123" -> { author, id }. Qualquer sufixo (ex.: /photo/1) não casa.
  function parseStatusPath(pathname) {
    const m = STATUS_RE.exec(pathname || '');
    return m ? { author: m[1], id: m[2] } : null;
  }

  function parseStatusHref(href, origin) {
    const u = toUrl(href, origin);
    if (!u || !HOST_RE.test(u.hostname)) return null;
    return parseStatusPath(u.pathname);
  }

  // "/fulano" -> "fulano" (perfil). Rotas reservadas do X não são perfis.
  function parseProfileHref(href, origin) {
    const u = toUrl(href, origin);
    if (!u || !HOST_RE.test(u.hostname)) return null;
    const m = PROFILE_RE.exec(u.pathname.replace(/\/+$/, ''));
    if (!m || RESERVED.has(m[1].toLowerCase())) return null;
    return m[1];
  }

  function appearanceKey(id, reposter) {
    return id + '|' + (reposter || '').toLowerCase();
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  // dd/mm/aaaa às hh:mm, no fuso do aparelho.
  function formatDateBR(input) {
    const d = input instanceof Date ? input : new Date(input);
    if (isNaN(d.getTime())) return '';
    return (
      pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() +
      ' às ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    );
  }

  // Thread: depois do post focal, posts do MESMO autor em sequência contígua, com IDs crescentes.
  // `items` = posts da página, em ordem de DOM: [{id, author}].
  // Devolve { target, chain } (target = último da cadeia) ou null.
  function pickThreadTarget(items, focalId, focalAuthor) {
    const idx = items.findIndex((i) => i.id === focalId);
    if (idx < 0) return null;
    const author = (focalAuthor || items[idx].author).toLowerCase();
    const chain = [];
    let prev = BigInt(focalId);
    for (let j = idx + 1; j < items.length; j++) {
      const it = items[j];
      if (it.author.toLowerCase() !== author) break;
      const cur = BigInt(it.id);
      if (cur <= prev) break;
      chain.push(it);
      prev = cur;
    }
    if (!chain.length) return null;
    return { target: chain[chain.length - 1], chain };
  }

  // Etiquetas exibidas na barra para uma entrada (formato da API).
  function buildBadges(entry, fmt) {
    const f = fmt || formatDateBR;
    const out = [];
    if (!entry) return out;
    if (entry.reposters && entry.reposters.length) {
      out.push('↻ repostado por ' + entry.reposters.map((r) => '@' + r).join(', '));
    }
    if (entry.view_count > 0 && entry.views && entry.views.length) {
      let t = '👁 já visto em ' + f(entry.views[0].viewed_at);
      if (entry.view_count > 1) t += ' (' + entry.view_count + ' vezes)';
      out.push(t);
    }
    if (entry.covered_count > 0) {
      out.push('⛓ inclui ' + entry.covered_count + (entry.covered_count === 1 ? ' post' : ' posts') + ' desta thread');
    }
    if (entry.gap_before) out.push('⚠ pode haver posts não capturados antes deste');
    return out;
  }

  function normPath(p) {
    return (p || '').replace(/\/+$/, '') || '/';
  }

  function isFeedPath(feedUrl, pathname) {
    const u = toUrl(feedUrl, 'https://x.com');
    return !!u && normPath(u.pathname) === normPath(pathname);
  }

  function toApiItem(item) {
    return {
      tweet_id: item.id,
      author: item.author,
      reposter: item.reposter || null,
      kind: item.reposter ? 'repost' : 'post',
    };
  }

  function newBatchId() {
    return 'b-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  return {
    parseStatusPath, parseStatusHref, parseProfileHref, appearanceKey, formatDateBR,
    pickThreadTarget, buildBadges, isFeedPath, toApiItem, newBatchId,
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Core;

// ---- xdom.js ----
// xdom: ÚNICO módulo que conhece a estrutura do X. Todas as funções recebem `root` (document ou elemento)
// para poderem ser testadas com jsdom. Âncora principal: link /usuario/status/ID com <time>.
const Xdom = (function () {
  const C = () => (typeof Core !== 'undefined' ? Core : require('./core.js'));
  const ARTICLE_SEL = 'article[data-testid="tweet"]';
  const ORIGIN = 'https://x.com';

  function articles(root) {
    let list = Array.from(root.querySelectorAll(ARTICLE_SEL));
    if (!list.length) list = Array.from(root.querySelectorAll('article'));
    return list;
  }

  // Primeiro link de post com <time> dentro do article = post principal (citados vêm depois).
  function primaryStatus(art) {
    const links = art.querySelectorAll('a[href*="/status/"]');
    for (const a of links) {
      if (!a.querySelector('time')) continue;
      const p = C().parseStatusHref(a.getAttribute('href'), ORIGIN);
      if (p) return p;
    }
    return null;
  }

  // Quem repostou: link de perfil dentro do contexto social. Lido pelo href, não pelo texto.
  function reposterOf(art, author) {
    const cell = art.closest('[data-testid="cellInnerDiv"]');
    const sc =
      art.querySelector('[data-testid="socialContext"]') ||
      (cell && cell.querySelector('[data-testid="socialContext"]'));
    if (!sc) return null;
    const a = sc.closest('a') || sc.querySelector('a[href]');
    if (!a) return null;
    const handle = C().parseProfileHref(a.getAttribute('href'), ORIGIN);
    if (!handle || handle.toLowerCase() === author.toLowerCase()) return null;
    return handle;
  }

  function parseArticle(art) {
    const st = primaryStatus(art);
    if (!st) return null; // anúncios e cartões sem link de post caem aqui
    const reposter = reposterOf(art, st.author);
    return {
      id: st.id,
      author: st.author,
      reposter,
      key: C().appearanceKey(st.id, reposter),
      url: ORIGIN + '/' + st.author + '/status/' + st.id,
    };
  }

  // Posts visíveis, em ordem de DOM.
  function readItems(root) {
    const out = [];
    for (const art of articles(root)) {
      const it = parseArticle(art);
      if (it) out.push(it);
    }
    return out;
  }

  // Posts de uma página de post (cadeia acima, focal, respostas), únicos por ID, em ordem de DOM.
  function pageItems(root) {
    const seen = new Set();
    const out = [];
    for (const it of readItems(root)) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      out.push({ id: it.id, author: it.author });
    }
    return out;
  }

  function hasStatus(root, id) {
    return readItems(root).some((i) => i.id === id);
  }

  function hasArticles(root) {
    return articles(root).length > 0;
  }

  // Seleciona a aba por POSIÇÃO (independe de idioma).
  function selectTab(root, index) {
    const tl = root.querySelector('[role="tablist"]');
    if (!tl) return { found: false, clicked: false };
    const tab = tl.querySelectorAll('[role="tab"]')[index];
    if (!tab) return { found: false, clicked: false };
    if (tab.getAttribute('aria-selected') === 'true') return { found: true, clicked: false };
    tab.click();
    return { found: true, clicked: true };
  }

  function maskHref(h) {
    try {
      const p = new URL(h, ORIGIN).pathname;
      return p
        .replace(/\d+/g, 'N')
        .replace(/^\/[^/]+(?=\/status\/)/, '/@u')
        .replace(/^\/[^/]+$/, '/@u');
    } catch (e) {
      return '?';
    }
  }

  // Esqueleto estrutural SEM TEXTO: tags, data-testid, role, padrão de href mascarado.
  function skeleton(el, depth, ctx) {
    depth = depth || 0;
    ctx = ctx || { n: 0 };
    if (!el || ctx.n >= 400 || depth > 14) return '';
    ctx.n++;
    let line = '  '.repeat(depth) + el.tagName.toLowerCase();
    for (const a of ['data-testid', 'role']) {
      const v = el.getAttribute(a);
      if (v) line += ' ' + a + '=' + v;
    }
    if (el.tagName === 'A' && el.getAttribute('href')) line += ' href~' + maskHref(el.getAttribute('href'));
    if (el.tagName === 'TIME') line += ' [datetime]';
    const kids = [];
    for (const c of el.children) {
      const s = skeleton(c, depth + 1, ctx);
      if (s) kids.push(s);
    }
    return kids.length ? line + '\n' + kids.join('\n') : line;
  }

  function isLoginPath(pathname) {
    return /^\/(i\/flow\/login|login)(\/|$)/.test(pathname || '');
  }

  return {
    articles, parseArticle, readItems, pageItems, hasStatus, hasArticles,
    selectTab, skeleton, isLoginPath,
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Xdom;

// ---- scanner.js ----
// scanner: rola o feed e coleta aparições até reencontrar uma âncora. Todo efeito colateral passa por `env`
// (rolagem, leitura do DOM, tempo), o que permite simular um feed nos testes.
const Scanner = (function () {
  const DEFAULTS = {
    initialBackfill: 40,
    maxSteps: 150,
    maxCollect: 400,
    stepDelayMs: [900, 1700],
    stepFraction: 0.7,
    settleMs: 800,
  };

  // env: { readItems(), scrollToTop(), scrollBy(px), scrollHeight(), viewportHeight(), atBottom(),
  //        sleep(ms), rand(a,b), onProgress(n, steps), isCancelled() }
  // Devolve { seq (do mais novo ao mais antigo), anchorFound, reason, steps }
  async function run(env, options, anchorKeys) {
    const o = Object.assign({}, DEFAULTS, options || {});
    const anchors = new Set(anchorKeys || []);
    const seen = new Set();
    const seq = [];
    let anchorFound = false;
    let stagnant = 0;
    let steps = 0;
    let reason = '';

    env.scrollToTop();
    await env.sleep(o.settleMs);

    for (;;) {
      for (const it of env.readItems()) {
        if (seen.has(it.key)) continue;
        if (anchors.has(it.key)) {
          anchorFound = true;
          break;
        }
        seen.add(it.key);
        seq.push(it);
      }
      env.onProgress(seq.length, steps);

      if (anchorFound) { reason = 'anchor'; break; }
      if (env.isCancelled()) { reason = 'cancelled'; break; }
      if (anchors.size === 0 && seq.length >= o.initialBackfill) { reason = 'backfill'; break; }
      if (seq.length >= o.maxCollect) { reason = 'max_collect'; break; }
      if (steps >= o.maxSteps) { reason = 'max_steps'; break; }

      const before = env.scrollHeight();
      env.scrollBy(Math.round(env.viewportHeight() * o.stepFraction));
      await env.sleep(env.rand(o.stepDelayMs[0], o.stepDelayMs[1]));
      steps++;
      if (env.atBottom() && env.scrollHeight() === before) {
        if (++stagnant >= 3) { reason = 'end'; break; }
      } else {
        stagnant = 0;
      }
    }
    return { seq, anchorFound, reason, steps };
  }

  return { run, DEFAULTS };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Scanner;

// ---- api.js ----
// api: cliente da API do notiXias. `request` é injetado (GM_xmlhttpRequest no navegador, fake nos testes).
const Api = (function () {
  class ApiError extends Error {
    constructor(status, body, message) {
      super(message || 'API respondeu ' + status);
      this.name = 'ApiError';
      this.status = status;
      this.body = body;
    }
  }

  function qs(params) {
    const parts = [];
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null) continue;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    }
    return parts.length ? '?' + parts.join('&') : '';
  }

  // request({method, url, headers, body}) -> Promise<{status, json}>
  function create({ request, getConfig }) {
    async function call(method, path, { params, body } = {}) {
      const cfg = getConfig();
      const url = cfg.apiBaseUrl.replace(/\/+$/, '') + '/api/v1' + path + qs(params);
      const headers = { Authorization: 'Bearer ' + cfg.apiKey, Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await request({
        method,
        url,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status >= 200 && res.status < 300) return res.json;
      throw new ApiError(res.status, res.json);
    }

    return {
      state: () => call('GET', '/state'),
      putState: (body) => call('PUT', '/state', { body }),
      anchor: (depth) => call('GET', '/queue/anchor', { params: { depth } }),
      append: (body) => call('POST', '/queue/append', { body }),
      queue: (params) => call('GET', '/queue', { params }),
      entry: (seq) => call('GET', '/entries/' + seq),
      patchEntry: (seq, body) => call('PATCH', '/entries/' + seq, { body }),
      cover: (body) => call('POST', '/entries/cover', { body }),
      uncover: (body) => call('POST', '/entries/uncover', { body }),
      views: (body) => call('POST', '/views', { body }),
      skeleton: (body) => call('POST', '/health/skeleton', { body }),
      exportAll: () => call('GET', '/export'),
    };
  }

  return { create, ApiError };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Api;

// ---- ui.js ----
// ui: barra flutuante e tela de busca. Tudo dentro de Shadow DOM, para os estilos do X não vazarem.
const Ui = (function () {
  const BAR_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, system-ui, "Segoe UI", sans-serif; }
    .bar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483646;
      background: rgba(15,20,25,.96); color: #e7e9ea; padding: 8px 10px calc(8px + env(safe-area-inset-bottom));
      border-top: 1px solid #2f3336; }
    .badges { font-size: 13px; line-height: 1.4; margin: 0 2px 6px; }
    .badges div { margin: 1px 0; }
    .row { display: flex; gap: 8px; align-items: center; }
    .pos { flex: 1; text-align: center; font-size: 14px; color: #71767b; }
    button { appearance: none; border: 1px solid #536471; background: #16181c; color: #e7e9ea;
      border-radius: 999px; padding: 12px 16px; font-size: 16px; min-height: 44px; cursor: pointer; }
    button.primary { background: #1d9bf0; border-color: #1d9bf0; color: #fff; font-weight: 600; }
    button:disabled { opacity: .35; cursor: default; }
    .menu { position: absolute; right: 10px; bottom: calc(100% + 6px); background: #16181c;
      border: 1px solid #536471; border-radius: 12px; padding: 4px; min-width: 240px; }
    .menu button { display: block; width: 100%; text-align: left; border: 0; border-radius: 8px; background: transparent; }
    .menu button:hover { background: #1f2327; }
  `;
  const OVERLAY_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, system-ui, "Segoe UI", sans-serif; }
    .ov { position: fixed; inset: 0; z-index: 2147483647; background: #0b0e11; color: #e7e9ea;
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 24px; text-align: center; }
    .ov h1 { font-size: 22px; margin: 0; }
    .ov p { margin: 0; color: #9aa0a6; max-width: 34em; line-height: 1.5; }
    .ov.error h1 { color: #f4212e; }
    .btns { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; }
    button { appearance: none; border: 1px solid #536471; background: #16181c; color: #e7e9ea;
      border-radius: 999px; padding: 12px 20px; font-size: 16px; min-height: 44px; cursor: pointer; }
  `;

  function el(doc, tag, props, ...kids) {
    const e = doc.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') e.className = v;
      else if (k === 'onclick') e.addEventListener('click', v);
      else if (k === 'disabled') e.disabled = !!v;
      else e.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) e.append(kid);
    return e;
  }

  function makeHost(doc, id, css) {
    const host = doc.createElement('div');
    host.id = id;
    const root = host.attachShadow({ mode: 'open' });
    root.append(el(doc, 'style', {}, css));
    return { host, root };
  }

  function create(doc) {
    const bar = makeHost(doc, 'notixias-bar', BAR_CSS);
    const ov = makeHost(doc, 'notixias-overlay', OVERLAY_CSS);
    let barNode = null;
    let ovNode = null;
    let menuOpen = false;
    let lastBarModel = null;

    function attach(h) {
      if (!h.host.isConnected) (doc.body || doc.documentElement).append(h.host);
    }

    // m: { badges[], position, total, menuItems[{label,onClick}], onPrev, onNext, nextLabel, busy }
    function renderBar(m) {
      lastBarModel = m;
      attach(bar);
      if (barNode) barNode.remove();
      const badges = el(doc, 'div', { class: 'badges' }, (m.badges || []).map((b) => el(doc, 'div', {}, b)));
      const pos = el(doc, 'div', { class: 'pos' }, m.position != null && m.total != null ? m.position + ' / ' + m.total : '');
      const prev = el(doc, 'button', { 'data-act': 'prev', disabled: !m.onPrev || m.busy, onclick: () => m.onPrev && m.onPrev() }, '◀');
      const more = el(doc, 'button', {
        'data-act': 'menu',
        onclick: () => { menuOpen = !menuOpen; renderBar(lastBarModel); },
      }, '⋯');
      const next = el(doc, 'button', {
        class: 'primary', 'data-act': 'next', disabled: !m.onNext || m.busy,
        onclick: () => m.onNext && m.onNext(),
      }, m.nextLabel || 'Próxima ▶');
      const menu = menuOpen
        ? el(doc, 'div', { class: 'menu' }, (m.menuItems || []).map((it) =>
            el(doc, 'button', { onclick: () => { menuOpen = false; renderBar(lastBarModel); it.onClick(); } }, it.label)))
        : null;
      barNode = el(doc, 'div', { class: 'bar' }, menu, badges, el(doc, 'div', { class: 'row' }, prev, pos, more, next));
      bar.root.append(barNode);
    }

    function hideBar() {
      if (barNode) barNode.remove();
      barNode = null;
      menuOpen = false;
    }

    // o: { title, detail, error, buttons[{label,onClick}] }
    function showOverlay(o) {
      attach(ov);
      if (ovNode) ovNode.remove();
      ovNode = el(doc, 'div', { class: 'ov' + (o.error ? ' error' : '') },
        el(doc, 'h1', {}, o.title || ''),
        o.detail ? el(doc, 'p', {}, o.detail) : null,
        el(doc, 'div', { class: 'btns' }, (o.buttons || []).map((b) => el(doc, 'button', { onclick: b.onClick }, b.label))));
      ov.root.append(ovNode);
    }

    function hideOverlay() {
      if (ovNode) ovNode.remove();
      ovNode = null;
    }

    return { renderBar, hideBar, showOverlay, hideOverlay, _bar: bar, _ov: ov };
  }

  return { create };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Ui;

// ---- main.js ----
// main: orquestração no navegador (GM_*, navegação, fases). Não é coberto por testes unitários;
// ver o checklist manual em docs/08-roteiro.md.
function startApp() {
  const DEFAULTS = { apiBaseUrl: 'http://localhost:8010', apiKey: '', autoResume: true, internalNav: true };
  const SCAN = { initialBackfill: 40, maxSteps: 150, maxCollect: 400, stepDelayMs: [900, 1700], stepFraction: 0.7, anchorDepth: 10 };
  const FETCH_STALE_MS = 30 * 60 * 1000;
  const ERROR_STALE_MS = 5 * 60 * 1000;

  // ---------- armazenamento do gerenciador de scripts (nunca o armazenamento do próprio x.com) ----------
  const gm = {
    get(k, d) {
      try {
        const raw = GM_getValue(k);
        return raw === undefined || raw === null || raw === '' ? d : JSON.parse(raw);
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try { GM_setValue(k, JSON.stringify(v)); } catch (e) { /* sem armazenamento */ }
    },
  };
  let cfg = Object.assign({}, DEFAULTS, gm.get('nx_cfg', {}));
  const saveCfg = () => gm.set('nx_cfg', cfg);

  function gmRequest({ method, url, headers, body }) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method, url, headers, data: body, timeout: 30000,
        onload: (r) => {
          let json = null;
          try { json = JSON.parse(r.responseText); } catch (e) { /* corpo não-JSON */ }
          resolve({ status: r.status, json });
        },
        onerror: () => reject(new Error('Sem conexão com a API (' + url.split('/api/')[0] + ')')),
        ontimeout: () => reject(new Error('A API demorou demais para responder')),
      });
    });
  }

  const api = Api.create({ request: gmRequest, getConfig: () => cfg });
  const ui = Ui.create(document);

  // ---------- utilidades ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  async function waitFor(fn, timeout, every) {
    const t0 = Date.now();
    while (Date.now() - t0 < (timeout || 8000)) {
      const v = fn();
      if (v) return v;
      await sleep(every || 250);
    }
    return null;
  }

  let routeToken = 0;
  let lastHref = '';
  let cancelled = false;
  let busy = false;
  let feed = { url: 'https://x.com/home', tab_index: 1 };

  const getPhase = () => {
    const p = gm.get('nx_phase', { name: 'idle' });
    const age = Date.now() - (p.at || 0);
    if (p.name === 'fetching' && age > FETCH_STALE_MS) return { name: 'idle' };
    if (p.name === 'error' && age > ERROR_STALE_MS) return { name: 'idle' };
    return p;
  };
  const setPhase = (name, extra) => gm.set('nx_phase', Object.assign({ name, at: Date.now() }, extra || {}));

  // ---------- navegação ----------
  // Preferencial: navegação interna do X (sem recarregar). Se não renderizar em 7 s, abre a página normalmente.
  function go(url) {
    if (cfg.internalNav) {
      try {
        const u = new URL(url, location.href);
        if (u.origin === location.origin) {
          history.pushState({}, '', u.pathname + u.search + u.hash);
          window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
          verifyNavigation(u);
          return;
        }
      } catch (e) { /* cai no fallback */ }
    }
    location.assign(url);
  }

  async function verifyNavigation(u) {
    const st = Core.parseStatusPath(u.pathname);
    const ok = await waitFor(
      () => (st ? Xdom.hasStatus(document, st.id) : Xdom.hasArticles(document)),
      7000,
      300
    );
    if (!ok && location.pathname === u.pathname) location.assign(u.href);
  }

  // Rola ao topo por alguns segundos, parando assim que o dono interage.
  function pinTop(ms) {
    let stop = false;
    const off = () => { stop = true; };
    ['wheel', 'touchstart', 'keydown', 'mousedown'].forEach((ev) => window.addEventListener(ev, off, { once: true, passive: true }));
    const t0 = Date.now();
    (function tick() {
      if (stop || Date.now() - t0 > (ms || 3000)) return;
      if (window.scrollY > 0) window.scrollTo(0, 0);
      setTimeout(tick, 150);
    })();
  }

  // ---------- leitura ----------
  function menuItems(st) {
    return [
      { label: 'Buscar novas agora', onClick: () => startFetch() },
      { label: 'Trocar feed…', onClick: changeFeed },
      { label: 'Reabrir posts cobertos', onClick: () => reopenCovered(st) },
      { label: 'Copiar esqueleto da última falha', onClick: copySkeleton },
      { label: 'Exportar dados', onClick: exportData },
      { label: 'Configurar API…', onClick: () => promptConfig() },
      { label: 'Retomar automaticamente: ' + (cfg.autoResume ? 'sim' : 'não'), onClick: () => { cfg.autoResume = !cfg.autoResume; saveCfg(); onRoute(); } },
      { label: 'Navegação interna: ' + (cfg.internalNav ? 'sim' : 'não'), onClick: () => { cfg.internalNav = !cfg.internalNav; saveCfg(); onRoute(); } },
    ];
  }

  function renderEntryBar(st, notice) {
    const badges = [];
    if (notice) badges.push(notice);
    badges.push(...Core.buildBadges(st.current));
    ui.renderBar({
      badges,
      position: st.position,
      total: st.total_visible,
      menuItems: menuItems(st),
      onPrev: onPrev,
      onNext: onNext,
      nextLabel: st.unread_after > 0 ? 'Próxima ▶' : 'Buscar novas ▶',
      busy,
    });
  }

  function renderSideBar(message, st) {
    ui.renderBar({
      badges: [message],
      position: null,
      total: null,
      menuItems: menuItems(st || {}),
      onPrev: null,
      onNext: resumeReading,
      nextLabel: 'Voltar à leitura ▶',
      busy,
    });
  }

  async function openEntry(entry) {
    await api.putState({ cursor_seq: entry.seq });
    gm.set('nx_view', { seq: entry.seq, tweetId: entry.tweet_id, targetId: null });
    go(entry.url);
  }

  async function resumeReading() {
    const st = await api.state();
    if (st.current && !st.current.read_at) return openEntry(st.current);
    if (st.next_seq) {
      const q = await api.queue({ after: st.cursor_seq || 0, limit: 1 });
      if (q.items.length) return openEntry(q.items[0]);
    }
    return startFetch();
  }

  async function guarded(fn) {
    if (busy) return;
    busy = true;
    try { await fn(); } catch (e) { handleError(e); } finally { busy = false; }
  }

  const onNext = () => guarded(async () => {
    const st = await api.state();
    const cur = st.current;
    if (!cur) return resumeReading();
    await api.views({ seqs: [cur.seq] });
    const q = await api.queue({ after: cur.seq, limit: 1 });
    if (q.items.length) return openEntry(q.items[0]);
    return startFetch();
  });

  const onPrev = () => guarded(async () => {
    const st = await api.state();
    if (!st.current) return;
    const q = await api.queue({ before: st.current.seq, limit: 1 });
    if (q.items.length) return openEntry(q.items[0]);
    ui.renderBar({ badges: ['Início da fila'], position: st.position, total: st.total_visible, menuItems: menuItems(st), onPrev: null, onNext, nextLabel: 'Próxima ▶' });
  });

  async function onStatusPage(token, status, st) {
    const cur = st.current;
    const view = gm.get('nx_view', null);
    const inQueue = cur && view && view.seq === cur.seq && (status.id === cur.tweet_id || status.id === view.targetId);
    if (!inQueue) { renderSideBar('Fora da fila de leitura', st); return; }

    const notice = gm.get('nx_notice', null);
    if (notice) gm.set('nx_notice', null);
    renderEntryBar(st, notice);
    pinTop(3000);

    const ready = await waitFor(() => Xdom.hasStatus(document, status.id), 10000);
    if (token !== routeToken || !ready) return;
    await sleep(2000);
    if (token !== routeToken) return;

    // Thread: pedaços do mesmo autor encadeados abaixo do post focal -> salta para o último.
    if (!view.targetId) {
      const pick = Core.pickThreadTarget(Xdom.pageItems(document), cur.tweet_id, cur.author);
      if (pick && pick.target.id !== status.id) {
        view.targetId = pick.target.id;
        gm.set('nx_view', view);
        go('https://x.com/' + pick.target.author + '/status/' + pick.target.id);
        return;
      }
    }

    // Cobertura: só o que está de fato desenhado na página.
    const ids = Xdom.pageItems(document).map((i) => i.id).filter((id) => id !== cur.tweet_id);
    if (ids.length) {
      const res = await api.cover({ covered_by: cur.seq, tweet_ids: ids });
      if (token !== routeToken) return;
      if (res.covered > 0) renderEntryBar(await api.state(), notice);
    }
  }

  // ---------- busca de novas ----------
  function startFetch() {
    setPhase('fetching');
    if (Core.isFeedPath(feed.url, location.pathname)) onRoute();
    else go(feed.url);
  }

  async function ensureFeedTab() {
    if (feed.tab_index == null || location.pathname.replace(/\/+$/, '') !== '/home') return;
    const tl = await waitFor(() => document.querySelector('[role="tablist"]'), 10000);
    if (!tl) return;
    const r = Xdom.selectTab(document, feed.tab_index);
    if (r.clicked) await sleep(2000);
  }

  async function failFetch(message, art) {
    setPhase('error');
    const sk = Xdom.skeleton(art || document.querySelector('main') || document.body);
    gm.set('nx_skeleton', sk);
    try {
      await api.skeleton({ page: location.pathname.slice(0, 100), user_agent: navigator.userAgent.slice(0, 300), skeleton: sk, note: message.slice(0, 500) });
    } catch (e) { /* o esqueleto local já foi guardado */ }
    ui.showOverlay({
      title: '⚠ A captura falhou',
      detail: message + ' O X provavelmente mudou a página. Copie o esqueleto (sem texto) e envie para ajustar o capturador.',
      error: true,
      buttons: [
        { label: 'Copiar esqueleto', onClick: copySkeleton },
        { label: 'Voltar', onClick: () => { setPhase('idle'); ui.hideOverlay(); onRoute(); } },
      ],
    });
  }

  async function runFetch(token) {
    cancelled = false;
    const progress = (n, steps) => ui.showOverlay({
      title: 'Buscando novas…',
      detail: n + ' posts lidos · passo ' + steps,
      buttons: [{ label: 'Cancelar', onClick: () => { cancelled = true; } }],
    });
    progress(0, 0);

    await ensureFeedTab();
    const first = await waitFor(() => Xdom.hasArticles(document) && document.querySelector('article'), 15000);
    if (token !== routeToken) return;
    if (!first) return failFetch('Nenhum post carregou no feed.');
    if (!Xdom.readItems(document).length) return failFetch('Há posts na tela, mas nenhum link de post foi reconhecido.', first);

    const anchor = await api.anchor(SCAN.anchorDepth);
    const env = {
      readItems: () => Xdom.readItems(document),
      scrollToTop: () => window.scrollTo(0, 0),
      scrollBy: (px) => window.scrollBy(0, px),
      scrollHeight: () => document.documentElement.scrollHeight,
      viewportHeight: () => window.innerHeight,
      atBottom: () => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4,
      sleep, rand,
      onProgress: progress,
      isCancelled: () => cancelled || token !== routeToken,
    };
    const scan = await Scanner.run(env, SCAN, anchor.keys);
    if (token !== routeToken) return;

    if (scan.reason === 'cancelled') {
      setPhase('idle');
      ui.hideOverlay();
      const st = await api.state();
      if (st.current) { await openEntry(st.current); return; }
      return;
    }
    if (!scan.seq.length && !anchor.keys.length) return failFetch('A busca terminou sem capturar nenhum post.');

    const res = await api.append({
      items: scan.seq.map(Core.toApiItem),
      anchor_found: scan.anchorFound,
      batch_id: Core.newBatchId(),
    });
    setPhase('idle');

    const st = await api.state();
    if (res.created > 0) {
      const q = await api.queue({ after: st.cursor_seq || 0, limit: 1 });
      if (q.items.length) {
        gm.set('nx_notice', res.created + ' novos' + (res.gap ? ' · ⚠ pode haver lacuna' : ''));
        ui.hideOverlay();
        return openEntry(q.items[0]);
      }
    }
    gm.set('nx_notice', 'Você está em dia.');
    ui.hideOverlay();
    if (st.current) return openEntry(st.current);
    ui.showOverlay({ title: 'Nada para ler', detail: 'O feed não trouxe posts.', buttons: [{ label: 'Fechar', onClick: ui.hideOverlay }] });
  }

  // ---------- menu ----------
  function promptConfig() {
    const url = prompt('URL da API do notiXias', cfg.apiBaseUrl);
    if (url === null) return false;
    const key = prompt('Chave da API (fica só no armazenamento do gerenciador de scripts)', cfg.apiKey ? '(manter a atual)' : '');
    if (key === null) return false;
    cfg.apiBaseUrl = url.trim() || cfg.apiBaseUrl;
    if (key.trim() && key !== '(manter a atual)') cfg.apiKey = key.trim();
    saveCfg();
    return !!cfg.apiKey;
  }

  async function changeFeed() {
    const url = prompt('URL do feed (https://x.com/home para "Seguindo", ou https://x.com/i/lists/ID)', feed.url);
    if (!url) return;
    const isHome = /^https:\/\/(x|twitter)\.com\/home\/?$/.test(url.trim());
    await api.putState({ feed: { url: url.trim(), tab_index: isHome ? 1 : null } });
    onRoute();
  }

  async function reopenCovered(st) {
    if (!st.current) return;
    const r = await api.uncover({ covered_by: st.current.seq });
    gm.set('nx_notice', r.reopened + ' posts reabertos (use ◀ para vê-los)');
    onRoute();
  }

  async function copySkeleton() {
    const sk = gm.get('nx_skeleton', '');
    try { await navigator.clipboard.writeText(sk); alert('Esqueleto copiado (' + sk.length + ' caracteres).'); }
    catch (e) { prompt('Copie o esqueleto:', sk.slice(0, 5000)); }
  }

  async function exportData() {
    const data = await api.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'notixias-export-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
  }

  // ---------- roteamento ----------
  function handleError(e) {
    if (e && e.status === 401) {
      if (promptConfig()) onRoute();
      return;
    }
    ui.hideOverlay();
    ui.renderBar({
      badges: ['⚠ ' + (e && e.message ? e.message : 'Erro desconhecido')],
      position: null, total: null,
      menuItems: [{ label: 'Configurar API…', onClick: () => promptConfig() }, { label: 'Tentar de novo', onClick: () => onRoute() }],
      onPrev: null, onNext: null, nextLabel: 'Próxima ▶',
    });
  }

  async function onRoute() {
    const token = ++routeToken;
    try {
      if (Xdom.isLoginPath(location.pathname)) return;
      if (!cfg.apiKey && !promptConfig()) return handleError(new Error('Configure a API para começar'));

      const st = await api.state();
      if (token !== routeToken) return;
      feed = st.feed;
      const phase = getPhase();
      const feedHere = Core.isFeedPath(feed.url, location.pathname);

      if (phase.name === 'fetching') {
        if (feedHere) return runFetch(token);
        return renderSideBar('Busca de novas em andamento', st);
      }
      if (phase.name === 'error') return renderSideBar('A última busca falhou — veja o menu', st);

      if (feedHere && cfg.autoResume) return resumeReading();

      const status = Core.parseStatusPath(location.pathname);
      if (status) return onStatusPage(token, status, st);
      return renderSideBar('Notixias pronto', st);
    } catch (e) {
      handleError(e);
    }
  }

  // Detecta mudança de rota do SPA por polling (independe de eventos internos do X).
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      onRoute();
    }
  }, 300);

  window.addEventListener('keydown', (e) => {
    if (!e.altKey) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); onNext(); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); onPrev(); }
  });

  lastHref = location.href;
  onRoute();
}

if (typeof window !== 'undefined' && typeof GM_xmlhttpRequest !== 'undefined') startApp();

})();

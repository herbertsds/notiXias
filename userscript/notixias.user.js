// ==UserScript==
// @name         notiXias
// @namespace    notixias
// @version      0.2.1
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

  // Aviso no topo da página, quando o post repostado não é o primeiro da tela.
  function buildBannerText(entry) {
    if (!entry || !entry.reposters || !entry.reposters.length) return null;
    return '↻ uma mensagem dessa thread foi repostada por ' + entry.reposters.map((r) => '@' + r).join(', ');
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
    pickThreadTarget, buildBadges, buildBannerText, isFeedPath, toApiItem, newBatchId,
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


  // ---- barra de navegação inferior do X (mobile) ----
  // Reconhecida pelo comportamento, não por classe: um <nav> dentro de um contêiner position:fixed colado
  // no rodapé e largo. Assim não depende de idioma nem de CSS gerado.
  function fixedAncestor(el, win) {
    const stop = win.document.body;
    for (let n = el; n && n !== stop && n !== win.document.documentElement; n = n.parentElement) {
      if (win.getComputedStyle(n).position === 'fixed') return n;
    }
    return null;
  }

  function findBottomBars(root, win) {
    const out = [];
    const vh = win.innerHeight;
    const vw = win.innerWidth;
    for (const nav of root.querySelectorAll('nav, [role="navigation"]')) {
      if (nav.closest('[id^="notixias"]')) continue;
      const box = fixedAncestor(nav, win);
      if (!box || out.includes(box)) continue;
      const r = box.getBoundingClientRect();
      if (r.top >= vh * 0.6 && r.width >= vw * 0.6) out.push(box);
    }
    return out;
  }

  const HIDE_ATTR = 'data-nx-hidden';
  const HIDE_CSS = '[' + HIDE_ATTR + ']{display:none!important}';

  function ensureStyle(doc) {
    if (doc.getElementById('nx-style')) return;
    const st = doc.createElement('style');
    st.id = 'nx-style';
    st.textContent = HIDE_CSS;
    (doc.head || doc.documentElement).append(st);
  }

  // enabled=true: marca as barras inferiores encontradas; false: desfaz tudo.
  function setBottomBarsHidden(root, win, enabled) {
    if (!enabled) {
      root.querySelectorAll('[' + HIDE_ATTR + ']').forEach((n) => n.removeAttribute(HIDE_ATTR));
      return 0;
    }
    ensureStyle(root.ownerDocument || root);
    const bars = findBottomBars(root, win);
    bars.forEach((b) => b.setAttribute(HIDE_ATTR, '1'));
    return bars.length;
  }

  function isLoginPath(pathname) {
    return /^\/(i\/flow\/login|login)(\/|$)/.test(pathname || '');
  }

  return {
    articles, parseArticle, readItems, pageItems, hasStatus, hasArticles,
    selectTab, skeleton, isLoginPath, findBottomBars, setBottomBarsHidden,
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Xdom;

// ---- labels.js ----
// labels: linhas de contexto injetadas NA página do X, no estilo do "fulano repostou" nativo
// (texto cinza, discreto, largura inteira, acima do avatar e do nome).
//  - "label": acima do post da fila;
//  - "banner": acima do primeiro post da tela, quando ele NÃO é o post da fila e este foi repostado.
// A faixa é IRMÃ imediatamente anterior ao <article> (os filhos do article do X ficam lado a lado, então
// um filho novo viraria uma coluna). `sync` é idempotente: só escreve no DOM se algo mudou.
const Labels = (function () {
  const X = () => (typeof Xdom !== 'undefined' ? Xdom : require('./xdom.js'));
  const HANDLE_SPLIT = /(@[A-Za-z0-9_]{1,15})/;
  const BOX = 'box-sizing:border-box;width:100%;flex:0 0 100%;padding:6px 16px 0;margin:0;' +
    'font:700 13px/1.4 -apple-system,system-ui,"Segoe UI",sans-serif;color:#71767b;';
  const LINK = 'color:inherit;text-decoration:none;';
  const WARN = 'color:#f0b429;';

  // A faixa fica logo antes do article.
  function find(art, kind) {
    const p = art.previousElementSibling;
    return p && p.getAttribute('data-nx') === kind ? p : null;
  }

  // "@fulano" vira link para o perfil; o resto é texto puro (nunca HTML).
  function fillLine(doc, row, text) {
    for (const part of text.split(HANDLE_SPLIT)) {
      if (!part) continue;
      if (HANDLE_SPLIT.test(part) && part.startsWith('@')) {
        const a = doc.createElement('a');
        a.href = 'https://x.com/' + part.slice(1);
        a.textContent = part;
        a.setAttribute('style', LINK);
        a.addEventListener('mouseenter', () => { a.style.textDecoration = 'underline'; });
        a.addEventListener('mouseleave', () => { a.style.textDecoration = 'none'; });
        row.append(a);
      } else {
        row.append(doc.createTextNode(part));
      }
    }
  }

  function ensure(doc, art, kind, lines) {
    const text = lines.join('\n');
    let node = find(art, kind);
    if (node && node.getAttribute('data-nx-text') === text) return false;
    if (node) node.remove();
    node = doc.createElement('div');
    node.setAttribute('data-nx', kind);
    node.setAttribute('data-nx-text', text);
    node.setAttribute('style', BOX);
    for (const l of lines) {
      const row = doc.createElement('div');
      if (l.startsWith('⚠')) row.setAttribute('style', WARN);
      fillLine(doc, row, l);
      node.append(row);
    }
    art.parentNode.insertBefore(node, art);
    return true;
  }

  function remove(art, kind) {
    const node = find(art, kind);
    if (node) node.remove();
  }

  // model: { tweetId, lines: string[], bannerText: string|null }
  function sync(root, model) {
    const doc = root.ownerDocument || root;
    const arts = X().articles(root).filter((a) => a.parentNode);
    const first = arts[0] || null;
    const target = arts.find((a) => {
      const p = X().parseArticle(a);
      return p && p.id === model.tweetId;
    }) || null;

    for (const a of arts) {
      if (a !== target || !model.lines.length) remove(a, 'label');
      if (a !== first || a === target || !model.bannerText) remove(a, 'banner');
    }
    if (target && model.lines.length) ensure(doc, target, 'label', model.lines);
    if (first && first !== target && model.bannerText) ensure(doc, first, 'banner', [model.bannerText]);
    return { label: !!(target && model.lines.length), banner: !!(first && first !== target && model.bannerText) };
  }

  function clear(root) {
    for (const n of Array.from(root.querySelectorAll('[data-nx]'))) n.remove();
  }

  return { sync, clear };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Labels;

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
// ui: barra inferior (40% / 20% / 40%) e tela de busca. Tudo em Shadow DOM, para os estilos do X não vazarem.
// A barra reserva espaço no fim da página (padding-bottom no <html>), então não tapa conteúdo.
const Ui = (function () {
  const BAR_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, system-ui, "Segoe UI", sans-serif; }
    .wrap { position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483646; display: flex; pointer-events: none; }
    .wrap.full { justify-content: stretch; }
    .wrap.left { justify-content: flex-start; }
    .wrap.right { justify-content: flex-end; }
    .inner { position: relative; pointer-events: auto; width: 100%; background: rgba(15,20,25,.97); color: #e7e9ea;
      border-top: 1px solid #2f3336; padding: 6px 6px calc(6px + env(safe-area-inset-bottom)); }
    .wrap.left .inner, .wrap.right .inner { width: 65%; border-radius: 14px 14px 0 0; border: 1px solid #2f3336; border-bottom: 0; }
    .row { display: flex; gap: 6px; align-items: stretch; }
    .cell { flex: 0 1 auto; min-width: 0; }
    button { appearance: none; border: 1px solid #536471; background: #16181c; color: #e7e9ea; border-radius: 14px;
      padding: 0 4px; font-size: 22px; min-height: 56px; cursor: pointer; width: 100%; -webkit-tap-highlight-color: transparent; }
    button.primary { background: #1d9bf0; border-color: #1d9bf0; color: #fff; font-weight: 600; }
    button.center { background: transparent; border-color: transparent; font-size: 14px; color: #9aa0a6;
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; line-height: 1.2; padding: 2px; }
    button.center .notice { font-size: 11px; color: #f0b429; white-space: normal; overflow-wrap: anywhere; }
    button.center .pos { font-size: 14px; color: #e7e9ea; }
    button.nav { font-size: 22px; }
    button:disabled { opacity: .3; cursor: default; }
    .menu { position: absolute; right: 6px; left: 6px; bottom: calc(100% + 6px); background: #16181c;
      border: 1px solid #536471; border-radius: 12px; padding: 4px; max-height: 60vh; overflow: auto; }
    .menu button { display: block; text-align: left; border: 0; border-radius: 8px; background: transparent;
      font-size: 16px; min-height: 44px; padding: 8px 12px; }
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
  const LONG_PRESS_MS = 600;

  function el(doc, tag, props, ...kids) {
    const e = doc.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') e.className = v;
      else if (k === 'onclick') e.addEventListener('click', v);
      else if (k === 'disabled') e.disabled = !!v;
      else if (k === 'style') e.style.cssText = v;
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

  // Larguras (em %) das três células do modo leitura, conforme os botões escolhidos.
  function readWidths(buttons) {
    if (buttons === 'next') return { prev: 0, center: 20, next: 80 };
    if (buttons === 'prev') return { prev: 80, center: 20, next: 0 };
    return { prev: 40, center: 20, next: 40 };
  }

  function create(doc) {
    const win = doc.defaultView;
    const bar = makeHost(doc, 'notixias-bar', BAR_CSS);
    const ov = makeHost(doc, 'notixias-overlay', OVERLAY_CSS);
    let wrapNode = null;
    let ovNode = null;
    let menuOpen = false;
    let lastModel = null;
    let observer = null;
    let pressTimer = null;
    let longPressed = false;

    function attach(h) {
      if (!h.host.isConnected) (doc.body || doc.documentElement).append(h.host);
    }

    function reserve(h) {
      const root = doc.documentElement;
      if (h == null) root.style.removeProperty('padding-bottom');
      else root.style.setProperty('padding-bottom', Math.ceil(h) + 'px', 'important');
    }

    function watchHeight(inner) {
      if (observer) observer.disconnect();
      if (!win || typeof win.ResizeObserver === 'undefined') return;
      observer = new win.ResizeObserver((entries) => {
        const e = entries[0];
        const bs = e.borderBoxSize && (e.borderBoxSize[0] || e.borderBoxSize);
        reserve(bs && bs.blockSize != null ? bs.blockSize : e.target.getBoundingClientRect().height);
      });
      observer.observe(inner);
    }

    function cell(node, pct) {
      return el(doc, 'div', { class: 'cell', style: 'flex-basis:' + pct + '%' }, node);
    }

    function centerButton(m) {
      const startPress = () => {
        longPressed = false;
        clearTimeout(pressTimer);
        pressTimer = setTimeout(() => { longPressed = true; menuOpen = !menuOpen; renderBar(lastModel); }, LONG_PRESS_MS);
      };
      const endPress = () => clearTimeout(pressTimer);
      const b = el(doc, 'button', {
        class: 'center', 'data-act': 'toggle', 'aria-label': 'Alternar entre leitura e navegação',
        onclick: () => { if (longPressed) { longPressed = false; return; } m.onToggle && m.onToggle(); },
      },
        m.notice ? el(doc, 'span', { class: 'notice' }, m.notice) : null,
        el(doc, 'span', { class: 'pos' }, m.position != null && m.total != null ? m.position + ' / ' + m.total : '●'));
      b.addEventListener('pointerdown', startPress);
      b.addEventListener('pointerup', endPress);
      b.addEventListener('pointerleave', endPress);
      return b;
    }

    function readRow(m) {
      const w = readWidths(m.buttons);
      const row = el(doc, 'div', { class: 'row' });
      if (w.prev) {
        row.append(cell(el(doc, 'button', {
          'data-act': 'prev', 'aria-label': 'Anterior', disabled: !m.onPrev || m.busy, onclick: () => m.onPrev && m.onPrev(),
        }, '◀'), w.prev));
      }
      row.append(cell(centerButton(m), w.center));
      if (w.next) {
        row.append(cell(el(doc, 'button', {
          class: 'primary', 'data-act': 'next', 'aria-label': 'Próxima', disabled: !m.onNext || m.busy,
          onclick: () => m.onNext && m.onNext(),
        }, m.nextLabel || '▶'), w.next));
      }
      return row;
    }

    // Navegação: ⋯ | item0 | centro | item1 | item2 (cada 20%)
    function navRow(m) {
      const items = m.navItems || [];
      const navBtn = (it, i) => cell(el(doc, 'button', {
        class: 'nav', 'data-act': 'nav-' + i, 'aria-label': it.title || it.label, onclick: () => it.onClick(),
      }, it.label), 20);
      const menuBtn = cell(el(doc, 'button', {
        class: 'nav', 'data-act': 'menu', 'aria-label': 'Menu',
        onclick: () => { menuOpen = !menuOpen; renderBar(lastModel); },
      }, '⋯'), 20);
      const row = el(doc, 'div', { class: 'row' }, menuBtn, items[0] ? navBtn(items[0], 0) : null,
        cell(centerButton(m), 20), items[1] ? navBtn(items[1], 1) : null, items[2] ? navBtn(items[2], 2) : null);
      return row;
    }

    // m: { mode, layout, buttons, position, total, notice, onPrev, onNext, nextLabel, onToggle,
    //      navItems[{label,title,onClick}], menuItems[{label,onClick}], busy }
    function renderBar(m) {
      lastModel = m;
      attach(bar);
      if (wrapNode) wrapNode.remove();
      const menu = menuOpen
        ? el(doc, 'div', { class: 'menu', 'data-menu': '1' }, (m.menuItems || []).map((it) =>
            el(doc, 'button', { onclick: () => { menuOpen = false; renderBar(lastModel); it.onClick(); } }, it.label)))
        : null;
      const inner = el(doc, 'div', { class: 'inner' }, menu, m.mode === 'nav' ? navRow(m) : readRow(m));
      wrapNode = el(doc, 'div', { class: 'wrap ' + (m.layout || 'full') }, inner);
      bar.root.append(wrapNode);
      watchHeight(inner);
    }

    function hideBar() {
      if (wrapNode) wrapNode.remove();
      wrapNode = null;
      menuOpen = false;
      if (observer) observer.disconnect();
      reserve(null);
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

    return { renderBar, hideBar, showOverlay, hideOverlay };
  }

  return { create, readWidths };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Ui;

// ---- main.js ----
// main: orquestração no navegador (GM_*, navegação, fases). Não é coberto por testes unitários;
// ver o checklist manual em docs/STATUS.md.
function startApp() {
  const DEFAULTS = {
    apiBaseUrl: 'http://localhost:8010',
    apiKey: '',
    autoResume: true,
    internalNav: true,
    layout: 'full', // 'full' | 'left' | 'right'  (modo uma mão: botões em ~65% da largura, no lado escolhido)
    buttons: 'both', // 'both' | 'next' | 'prev'
    hideXBar: true, // esconde a barra de navegação inferior do X (mobile)
  };
  const SCAN = { initialBackfill: 40, maxSteps: 150, maxCollect: 400, stepDelayMs: [900, 1700], stepFraction: 0.7, anchorDepth: 10 };
  const FETCH_STALE_MS = 30 * 60 * 1000;
  const ERROR_STALE_MS = 5 * 60 * 1000;
  const NOTICE_MS = 6000;

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

  // ---------- barra do X escondida ----------
  function applyXBar() {
    try { Xdom.setBottomBarsHidden(document, window, cfg.hideXBar); } catch (e) { /* melhor esforço */ }
  }
  setInterval(applyXBar, 1500);

  // ---------- etiquetas dentro da página ----------
  let labelModel = null;
  let labelTimer = null;
  function syncLabels() {
    if (labelModel) Labels.sync(document, labelModel);
  }
  function setLabels(entry) {
    if (!entry) { labelModel = null; Labels.clear(document); return; }
    labelModel = { tweetId: entry.tweet_id, lines: Core.buildBadges(entry), bannerText: Core.buildBannerText(entry) };
    syncLabels();
  }
  // O X redesenha posts o tempo todo; reinserimos as etiquetas quando sumirem (sync é idempotente).
  new MutationObserver(() => {
    if (labelTimer || !labelModel) return;
    labelTimer = setTimeout(() => { labelTimer = null; syncLabels(); }, 200);
  }).observe(document.documentElement, { childList: true, subtree: true });

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
      () => (st ? Xdom.hasStatus(document, st.id) : Xdom.hasArticles(document) || u.pathname !== '/home'),
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

  // ---------- barra ----------
  const CYCLE = {
    layout: { order: ['full', 'left', 'right'], label: { full: 'ambas (largura total)', left: 'esquerda', right: 'direita' } },
    buttons: { order: ['both', 'next', 'prev'], label: { both: 'ambos', next: 'só avançar', prev: 'só voltar' } },
  };
  function cycle(key) {
    const { order } = CYCLE[key];
    cfg[key] = order[(order.indexOf(cfg[key]) + 1) % order.length];
    saveCfg();
    drawBar();
  }

  function menuItems(st) {
    return [
      { label: 'Buscar novas agora', onClick: () => startFetch() },
      { label: 'Mão: ' + CYCLE.layout.label[cfg.layout], onClick: () => cycle('layout') },
      { label: 'Botões: ' + CYCLE.buttons.label[cfg.buttons], onClick: () => cycle('buttons') },
      { label: 'Barra do X: ' + (cfg.hideXBar ? 'escondida' : 'visível'), onClick: () => { cfg.hideXBar = !cfg.hideXBar; saveCfg(); applyXBar(); drawBar(); } },
      { label: 'Ir para Explorar', onClick: () => go('https://x.com/explore') },
      { label: 'Trocar feed…', onClick: changeFeed },
      { label: 'Reabrir posts cobertos', onClick: () => reopenCovered(st) },
      { label: 'Copiar esqueleto da última falha', onClick: copySkeleton },
      { label: 'Exportar dados', onClick: exportData },
      { label: 'Configurar API…', onClick: () => promptConfig() },
      { label: 'Retomar automaticamente: ' + (cfg.autoResume ? 'sim' : 'não'), onClick: () => { cfg.autoResume = !cfg.autoResume; saveCfg(); drawBar(); } },
      { label: 'Navegação interna: ' + (cfg.internalNav ? 'sim' : 'não'), onClick: () => { cfg.internalNav = !cfg.internalNav; saveCfg(); drawBar(); } },
    ];
  }

  const NAV_ITEMS = () => [
    { label: '🏠', title: 'Início', onClick: () => go('https://x.com/home') },
    { label: '🔔', title: 'Notificações', onClick: () => go('https://x.com/notifications') },
    { label: '✉️', title: 'Mensagens', onClick: () => go('https://x.com/messages') },
  ];

  // barState: { st, notice, message }  (message => fora da fila; sem botões de passar)
  let barState = null;
  function toggleMode() {
    gm.set('nx_mode', gm.get('nx_mode', 'read') === 'read' ? 'nav' : 'read');
    drawBar();
  }

  function barModel() {
    const { st, notice, message } = barState;
    const inEntry = !message && st && st.current;
    return {
      mode: gm.get('nx_mode', 'read'),
      layout: cfg.layout,
      buttons: cfg.buttons,
      position: inEntry ? st.position : null,
      total: inEntry ? st.total_visible : null,
      notice: message || notice || null,
      onPrev: inEntry ? onPrev : null,
      onNext: inEntry ? onNext : resumeReading,
      nextLabel: inEntry && st.unread_after === 0 ? '⟳' : '▶',
      onToggle: toggleMode,
      navItems: NAV_ITEMS(),
      menuItems: menuItems(st || {}),
      busy,
    };
  }

  function drawBar() {
    if (barState) ui.renderBar(barModel());
  }

  function showBar(state) {
    barState = state;
    drawBar();
    const n = state.notice;
    if (n) {
      setTimeout(() => {
        if (barState && barState.notice === n) { barState.notice = null; drawBar(); }
      }, NOTICE_MS);
    }
  }

  function renderEntryBar(st, notice) {
    showBar({ st, notice: notice || null });
    setLabels(st.current);
  }

  function renderSideBar(message, st) {
    setLabels(null);
    showBar({ st: st || null, message });
  }

  // ---------- leitura ----------
  async function openEntry(entry) {
    await api.putState({ cursor_seq: entry.seq });
    gm.set('nx_view', { seq: entry.seq, tweetId: entry.tweet_id, targetId: null });
    gm.set('nx_mode', 'read');
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
    drawBar();
    try { await fn(); } catch (e) { handleError(e); } finally { busy = false; drawBar(); }
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
    showBar({ st, notice: 'Início da fila' });
  });

  async function onStatusPage(token, status, st) {
    const cur = st.current;
    const view = gm.get('nx_view', null);
    const inQueue = cur && view && view.seq === cur.seq && (status.id === cur.tweet_id || status.id === view.targetId);
    if (!inQueue) { renderSideBar('Fora da fila', st); return; }

    const notice = gm.get('nx_notice', null);
    if (notice) gm.set('nx_notice', null);
    renderEntryBar(st, notice);
    pinTop(3000);

    const ready = await waitFor(() => Xdom.hasStatus(document, status.id), 10000);
    if (token !== routeToken || !ready) return;
    syncLabels();
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
    ui.hideBar();
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
    gm.set('nx_notice', 'Você está em dia');
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
    setLabels(null);
    showBar({ st: null, message: '⚠ ' + (e && e.message ? e.message : 'Erro desconhecido') });
  }

  async function onRoute() {
    const token = ++routeToken;
    setLabels(null);
    try {
      if (Xdom.isLoginPath(location.pathname)) return;
      if (!cfg.apiKey && !promptConfig()) return handleError(new Error('Configure a API para começar'));

      const st = await api.state();
      if (token !== routeToken) return;
      feed = st.feed;
      const phase = getPhase();
      const feedHere = Core.isFeedPath(feed.url, location.pathname);

      if (phase.name === 'fetching') {
        if (feedHere) return await runFetch(token);
        return renderSideBar('Busca em andamento', st);
      }
      if (phase.name === 'error') return renderSideBar('Última busca falhou — veja o menu ⋯', st);

      if (feedHere && cfg.autoResume) return await resumeReading();

      const status = Core.parseStatusPath(location.pathname);
      if (status) return await onStatusPage(token, status, st);
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
  applyXBar();
  onRoute();
}

if (typeof window !== 'undefined' && typeof GM_xmlhttpRequest !== 'undefined') startApp();

})();

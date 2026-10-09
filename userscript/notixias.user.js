// ==UserScript==
// @name         notiXias
// @namespace    notixias
// @version      0.10.2
// @description  Leitor sequencial da timeline do X com posição salva (uso pessoal). v0.10.2
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM.getValue
// @grant        GM.setValue
// @connect      localhost
// @connect      127.0.0.1
// @connect      notixias.163.176.176.10.nip.io
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

  // Horário de criação (ms desde 1970) a partir do ID do post (snowflake do X); null se o ID for inválido.
  function snowflakeMs(id) {
    try { return Number(BigInt(id) >> 22n) + 1288834974657; } catch (e) { return null; }
  }

  // Idade do post a partir do ID (snowflake: ms desde 2010-11-04 nos 42 bits altos). Sempre "N min" ou "N h", nunca dias.
  function ageLabel(id, nowMs) {
    const created = snowflakeMs(id);
    if (created === null) return '';
    const mins = Math.max(1, Math.floor(((nowMs === undefined ? Date.now() : nowMs) - created) / 60000));
    return mins < 60 ? mins + ' min' : Math.floor(mins / 60) + ' h';
  }

  // Velocidades do vídeo (o X no celular não tem controle): o botão abre um menu com estas opções.
  const SPEEDS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 2.75, 3];
  const formatSpeed = (r) => String(r).replace('.', ',') + 'x';

  // ---- histórico de execuções (menu ⋯ -> Execuções) ----
  const STOP_REASON = {
    anchor: 'chegou ao que já estava salvo',
    backfill: 'primeira carga',
    max_steps: 'parou no limite de rolagem',
    max_collect: 'parou no limite de posts',
    end: 'chegou ao fim do feed',
    gap_unresolved: 'ficou lacuna "Mostrar mais" sem abrir',
    time_boundary: 'chegou à última verificação profunda',
    max_time: 'parou no limite de tempo',
  };

  const MODE_LABEL = { normal: 'Normal', deep: 'Profunda (feed)', profiles: 'Profunda (perfis)' };

  // Uma linha do histórico da API em duas linhas de texto. Pode ser uma execução ({at, source, mode, ok, created, updated,
  // gap, reason, steps, error, trigger}) ou um evento ({kind: 'request'|'reschedule', at, reason}): pedido de busca
  // por causa da leitura, ou horário da próxima busca antecipado. Devolve { main, sub, tone }.
  function formatRun(run) {
    const d = new Date(run.at);
    const when = isNaN(d.getTime()) ? '?' : pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (run.kind === 'request') return { main: when + ' · Busca solicitada (leitura)', sub: 'Motivo: ' + run.reason, tone: 'event' };
    if (run.kind === 'reschedule') return { main: when + ' · Próxima busca antecipada', sub: run.reason, tone: 'event' };
    const main = when + ' · ' + (run.source === 'robot' ? 'Automática' : 'Manual') + ' · ' + (MODE_LABEL[run.mode] || 'Normal');
    const why = run.trigger ? 'Motivo: ' + run.trigger : null;
    if (!run.ok) return { main, sub: [why, '⚠ Falhou: ' + (run.error || 'erro desconhecido')].filter(Boolean).join(' · '), tone: 'error' };
    const parts = [];
    if (why) parts.push(why);
    if (run.created) parts.push(run.created + (run.created === 1 ? ' novo' : ' novos'));
    if (run.updated) parts.push(run.updated + ' com resposta nova');
    if (parts.length === (why ? 1 : 0)) parts.push('nada novo');
    if (run.profiles_done) parts.push(run.profiles_done + ' perfis verificados' + (run.profile_created ? ' (' + run.profile_created + ' novos neles)' : '') + (run.profiles_skipped ? ', ' + run.profiles_skipped + ' sem leitura' : ''));
    if (run.gap) parts.push('⚠ pode haver lacuna');
    const stop = STOP_REASON[run.reason];
    if (stop) parts.push(stop + (run.steps ? ' (' + run.steps + ' passos)' : ''));
    return { main, sub: parts.join(' · '), tone: run.gap ? 'warn' : 'ok' };
  }

  // Linha "próxima execução automática" no topo do histórico. `next` vem de GET /runs ({at, mode, state} ou null).
  function formatNext(next, now) {
    if (!next) return null;
    if (next.state === 'paused') return { main: 'Robô pausado', sub: 'Falhas seguidas ou sessão do X expirada: envie uma sessão nova ou reinicie o contêiner (docs/11-robo.md).', tone: 'error' };
    if (next.state === 'waiting_session') return { main: 'Robô aguardando a sessão do X', sub: 'Rode scripts/robot_login.sh e scripts/robot_install_session.sh no computador.', tone: 'warn' };
    const d = new Date(next.at);
    if (isNaN(d.getTime())) return null;
    const when = pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    const mins = Math.round((d.getTime() - (now || new Date()).getTime()) / 60000);
    const rel = mins >= 60 ? 'em ' + Math.floor(mins / 60) + ' h ' + pad(mins % 60) + ' min' : mins >= 1 ? 'em ' + mins + ' min' : mins > -10 ? 'agora' : 'atrasada ' + Math.abs(mins) + ' min: confira o robô';
    return {
      main: 'Próxima automática: ' + when + ' · ' + (MODE_LABEL[next.mode] || 'Normal'),
      sub: rel + (typeof next.unread === 'number' ? ' · ' + next.unread + ' não lidas' : ''),
      tone: mins <= -10 ? 'warn' : 'next',
    };
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

  // "@ana repostou" / "@ana e @beto repostaram" / "@ana, @beto e @caio repostaram". O @ vira o nome de exibição na tela.
  function repostPhrase(reps) {
    const h = reps.map((r) => '@' + r);
    const who = h.length === 1 ? h[0] : h.slice(0, -1).join(', ') + ' e ' + h[h.length - 1];
    return who + (h.length === 1 ? ' repostou' : ' repostaram');
  }

  // Texto da tela de carregamento ao abrir uma entrada: "Abrindo o post de @ana" / "Abrindo o repost de Beto" (nome de
  // exibição se a API o conhece, senão o @); com vários, "Ana, Beto e Caio" (mais de 3: "Ana, Beto e mais 2").
  function openingLabel(entry) {
    const reps = (entry && entry.reposters) || [];
    if (reps.length) {
      const names = reps.map((r) => ((entry.reposter_names || {})[String(r).toLowerCase()]) || '@' + r);
      const who = names.length === 1 ? names[0]
        : names.length <= 3 ? names.slice(0, -1).join(', ') + ' e ' + names[names.length - 1]
        : names.slice(0, 2).join(', ') + ' e mais ' + (names.length - 2);
      return 'Abrindo o repost de ' + who;
    }
    return entry && entry.author ? 'Abrindo o post de @' + entry.author : 'Abrindo…';
  }

  // Quem repostou o tweet em qualquer entrada (lida ou não); cai para os reposters da própria entrada.
  function repostersOf(entry) {
    if (!entry) return [];
    if (entry.all_reposters && entry.all_reposters.length) return entry.all_reposters;
    return entry.reposters || [];
  }

  // Separa a conversa da página em: posts ACIMA do focal (cadeia de ancestrais, de qualquer autor) e abaixo.
  // `items` = [{id, author}] em ordem de DOM; `focalId` = ID do post da URL.
  function splitConversation(items, focalId) {
    const idx = items.findIndex((i) => i.id === focalId);
    if (idx < 0) return { before: [], after: [] };
    return { before: items.slice(0, idx), after: items.slice(idx + 1) };
  }

  // Etiquetas exibidas na barra para uma entrada (formato da API).
  function buildBadges(entry, fmt) {
    const f = fmt || formatDateBR;
    const out = [];
    if (!entry) return out;
    const reps = repostersOf(entry);
    if (reps.length) {
      out.push('↻ ' + repostPhrase(reps));
    }
    if (entry.view_count > 0 && entry.views && entry.views.length) {
      let t = '👁 Visto em ' + f(entry.views[0].viewed_at);
      if (entry.view_count > 1) t += ' (' + entry.view_count + ' vezes)';
      out.push(t);
    }
    if (entry.covered_count > 0) {
      out.push('⛓ inclui ' + entry.covered_count + (entry.covered_count === 1 ? ' post' : ' posts') + ' desta thread');
    }
    if (entry.gap_before) out.push('⚠ pode haver posts não capturados antes deste');
    return out;
  }

  // Divide as etiquetas: `top` fica acima do post; `seen` ("já visto") vai logo abaixo da data do post.
  function buildLabelParts(entry, fmt) {
    const f = fmt || formatDateBR;
    const parts = { top: [], seen: null };
    if (!entry) return parts;
    const reps = repostersOf(entry);
    if (reps.length) {
      parts.top.push('↻ ' + repostPhrase(reps));
    }
    if (entry.covered_count > 0) {
      parts.top.push('⛓ inclui ' + entry.covered_count + (entry.covered_count === 1 ? ' post' : ' posts') + ' desta thread');
    }
    if (entry.gap_before) parts.top.push('⚠ pode haver posts não capturados antes deste');
    if (entry.view_count > 0 && entry.views && entry.views.length) {
      parts.seen = '👁 Visto em ' + f(entry.views[0].viewed_at) + (entry.view_count > 1 ? ' (' + entry.view_count + ' vezes)' : '');
    }
    return parts;
  }

  // Aviso no topo da página, quando o post repostado não é o primeiro da tela.
  function buildBannerText(entry) {
    const reps = repostersOf(entry);
    if (!reps.length) return null;
    return '↻ ' + repostPhrase(reps) + ' uma mensagem dessa thread';
  }

  // Comando de abertura pela URL (atalho do iPhone, favorito...): `https://x.com/home?nx=update`.
  //   update    -> busca novas;  deep -> busca com varredura profunda;
  //   following -> lê as contas seguidas;  read -> continua a leitura.
  // Devolve o comando (ou null, se ausente/desconhecido) e a query SEM o parâmetro, para limpar a barra de endereço
  // (recarregar a página não repete a ação).
  const LAUNCH_CMDS = ['update', 'deep', 'profiles', 'following', 'read'];
  function parseLaunch(search) {
    const p = new URLSearchParams(search || '');
    const raw = p.get('nx');
    if (raw === null) return { cmd: null, search: search || '' };
    p.delete('nx');
    const rest = p.toString();
    return { cmd: LAUNCH_CMDS.includes(raw) ? raw : null, search: rest ? '?' + rest : '' };
  }

  function normPath(p) {
    return (p || '').replace(/\/+$/, '') || '/';
  }

  function isFeedPath(feedUrl, pathname) {
    const u = toUrl(feedUrl, 'https://x.com');
    return !!u && normPath(u.pathname) === normPath(pathname);
  }

  // Conversas no feed: o X mostra raiz e respostas em sequência, com IDs CRESCENTES de cima para baixo (o
  // contrário do normal, que é do mais novo ao mais antigo). Uma corrida de posts consecutivos, sem reposts,
  // com ID crescente é uma conversa. Devolve cópias com `cluster` (1, 2, ...) nos itens que a formam.
  function clusterize(items) {
    const out = items.map((i) => Object.assign({}, i));
    let n = 0;
    let i = 0;
    while (i < out.length) {
      let j = i;
      if (!out[i].reposter) {
        while (j + 1 < out.length && !out[j + 1].reposter && BigInt(out[j + 1].id) > BigInt(out[j].id)) j++;
      }
      if (j > i) {
        n++;
        for (let k = i; k <= j; k++) out[k].cluster = n;
      }
      i = j + 1;
    }
    return out;
  }

  function toApiItem(item) {
    const o = {
      tweet_id: item.id,
      author: item.author,
      reposter: item.reposter || null,
      kind: item.reposter ? 'repost' : 'post',
    };
    if (item.reposter && item.reposterName) o.reposter_name = item.reposterName;
    if (item.cluster) o.cluster = item.cluster;
    return o;
  }

  function newBatchId() {
    return 'b-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  return {
    parseStatusPath, parseStatusHref, parseProfileHref, appearanceKey, formatDateBR, formatRun, formatNext, ageLabel, snowflakeMs, SPEEDS, formatSpeed,
    pickThreadTarget, splitConversation, clusterize, parseLaunch, buildBadges, buildLabelParts, openingLabel, buildBannerText, isFeedPath, toApiItem, newBatchId,
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

  // Quem repostou: link de perfil dentro do contexto social. O @ vem do href (não do texto); o NOME de exibição
  // vem do elemento com `dir` dentro do contexto ("<span dir=ltr>Nome</span> repostou"), então independe do idioma.
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
    const nameEl = sc.querySelector('[dir]');
    const name = nameEl ? nameEl.textContent.trim() : '';
    return { handle, name: name || null };
  }

  function parseArticle(art) {
    const st = primaryStatus(art);
    if (!st) return null; // anúncios e cartões sem link de post caem aqui
    const rp = reposterOf(art, st.author);
    const reposter = rp ? rp.handle : null;
    const sc = art.querySelector('[data-testid="socialContext"]');
    return {
      pinned: !rp && !!sc && /fixad|pinned/i.test(sc.textContent || ''),
      id: st.id,
      author: st.author,
      reposter,
      reposterName: rp ? rp.name : null,
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

  // Posts da CONVERSA de uma página de post (cadeia acima, focal, respostas), únicos por ID, em ordem de DOM.
  // Só conta o que vem antes do primeiro título de seção depois do primeiro post ("Descubra mais", etc.):
  // tudo que está depois é recomendação do X, mesmo que seja do mesmo autor. A coluna lateral fica de fora.
  function pageItems(root) {
    const scope = root.querySelector('[data-testid="primaryColumn"]') || root;
    const seen = new Set();
    const out = [];
    let started = false;
    for (const n of scope.querySelectorAll('article, [role="heading"], h2')) {
      if (n.tagName === 'ARTICLE') {
        const it = parseArticle(n);
        if (!it) continue;
        started = true;
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        out.push({ id: it.id, author: it.author });
      } else if (started && !n.closest('article')) {
        break;
      }
    }
    return out;
  }

  // Linha da data do post na página de detalhe ("11:50 PM · 3 de out de 2026 · 60 mil Visualizações").
  // Reconhecida pelo <time> do link do post com horário (contém ":"); o layout compacto da timeline
  // mostra só "11 h" e devolve null. Sobe enquanto o pai só tem esse filho, para pegar a linha inteira.
  function findDateRow(art) {
    for (const a of art.querySelectorAll('a[href*="/status/"]')) {
      const t = a.querySelector('time');
      if (!t || !C().parseStatusHref(a.getAttribute('href'), ORIGIN)) continue;
      if (!/\d:\d/.test(t.textContent || '')) return null;
      let node = a.parentElement;
      while (node && node !== art && node.children.length === 1) node = node.parentElement;
      return node && node !== art ? node : null;
    }
    return null;
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

  // Faixa "Abrir no app X" no topo do X mobile. Reconhecida pelo texto (lista fechada) e pelo tamanho: sobe do texto
  // até o maior ancestral que seja uma faixa baixa e larga e que NÃO contenha conteúdo do X (posts, coluna principal).
  const APP_BANNER_RE = /^(abrir|open)\s+(no|in|o|the)?\s*(app|aplicativo)\b/i;
  function findAppBanners(root, win) {
    const out = [];
    const vw = win.innerWidth;
    for (const el of root.querySelectorAll('div, span, a')) {
      if (el.children.length || !APP_BANNER_RE.test((el.textContent || '').trim())) continue;
      let best = null;
      for (let n = el; n && n.parentElement && n !== win.document.body; n = n.parentElement) {
        if (n.querySelector('article, [data-testid="primaryColumn"], [data-testid="cellInnerDiv"], main')) break;
        const r = n.getBoundingClientRect();
        if (r.height > 160) break;
        if (r.width >= vw * 0.9) best = n;
      }
      if (best && !out.includes(best)) out.push(best);
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
    const bars = findBottomBars(root, win).concat(findAppBanners(root, win));
    bars.forEach((b) => b.setAttribute(HIDE_ATTR, '1'));
    return bars.length;
  }

  // ---- página de post que não existe mais ----
  // O X mostra "Esta página não existe" (data-testid="error-detail") ou um estado vazio (conta suspensa/protegida), ou uma
  // célula avisando que o post foi excluído/está indisponível. Texto só vale FORA dos posts (a recomendação de outros posts
  // pode conter qualquer frase) e só quando o post pedido não está na tela (quem chama confere isso antes).
  const MISSING_RE = /(foi exclu[ií]d|n[ãa]o existe|indispon[ií]vel|n[ãa]o est[áa] dispon[ií]vel|was deleted|doesn.t exist|does not exist|is unavailable|not available)/i;
  function pageMissing(root) {
    const col = root.querySelector('[data-testid="primaryColumn"]') || root;
    if (col.querySelector('[data-testid="error-detail"], [data-testid="emptyState"]')) return true;
    for (const cell of col.querySelectorAll('[data-testid="cellInnerDiv"]')) {
      if (cell.querySelector('article')) continue;
      if (MISSING_RE.test((cell.textContent || '').slice(0, 400))) return true;
    }
    return false;
  }

  // ---- vídeo na tela ----
  // O vídeo mais visível (pelo menos 30% da área dentro da janela e largura mínima: ignora ícones/GIFs minúsculos).
  // Devolve { video, rect (parte visível) } ou null.
  function visibleVideo(root, win) {
    let best = null;
    for (const v of root.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      if (!r.width || !r.height || r.width < 150) continue;
      const w = Math.max(0, Math.min(r.right, win.innerWidth) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, win.innerHeight) - Math.max(r.top, 0));
      const share = (w * h) / (r.width * r.height);
      if (share < 0.3) continue;
      if (!best || share > best.share) {
        best = { video: v, share, component: v.closest('[data-testid="videoComponent"]'), rect: { top: Math.max(r.top, 0), left: Math.max(r.left, 0), bottom: Math.min(r.bottom, win.innerHeight), right: Math.min(r.right, win.innerWidth) } };
      }
    }
    return best ? { video: best.video, rect: best.rect, component: best.component } : null;
  }

  // Aplica a velocidade escolhida. Só mexe no vídeo quando a escolha não é 1x OU quando já o tinha mexido (`touched`):
  // escolher 1x depois de outra velocidade tem de devolver o vídeo ao normal, e o padrão (1x, nunca mexido) deixa o X
  // em paz. O navegador pode recusar velocidades baixas demais (o iOS limita): então o vídeo segue como estava.
  function applyPlaybackRate(video, rate, touched) {
    if (rate === 1 && !touched.has(video)) return false;
    if (video.playbackRate !== rate) {
      try { video.playbackRate = rate; } catch (e) { return false; }
    }
    if (rate !== 1) touched.add(video);
    else if (video.playbackRate === 1) touched.delete(video);
    return true;
  }

  // Os controles do X (botão de som) estão aparecendo? Eles surgem e somem com transição de opacidade, dentro do player.
  // Sem botão de som (vídeo sem áudio, GIF) não há como saber: considera visíveis.
  function controlsVisible(component, win) {
    if (!component) return true;
    const btn = component.querySelector('[data-testid="mute-button"]');
    if (!btn) return true;
    let o = 1;
    for (let n = btn; n && n !== component.parentElement; n = n.parentElement) {
      const cs = win.getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      o *= parseFloat(cs.opacity === '' ? '1' : cs.opacity);
    }
    return o > 0.1;
  }

  // ---- "Mostrar mais" do texto dos posts (página de um post) ----
  // Posts longos vêm cortados com um botão "Mostrar mais" que expande no próprio lugar. Devolve os botões ainda
  // fechados de TODOS os posts da conversa (originais acima, o aberto e as respostas), na coluna principal.
  function findTextMoreButtons(root) {
    const scope = root.querySelector('[data-testid="primaryColumn"]') || root;
    const out = [];
    for (const art of scope.querySelectorAll('article[data-testid="tweet"]')) {
      const more = art.querySelector('[data-testid="tweet-text-show-more-link"]');
      if (more) out.push(more);
    }
    return out;
  }

  // ---- idade do post ----
  // Duas disposições do cabeçalho no X, e a idade acompanha cada uma (medido pela posição na tela, não por classe):
  //  - @ na MESMA linha do nome (respostas, feed): "Nome ✓ @usuario · 35 h" -> a idade vai no FIM de tudo;
  //  - @ ABAIXO do nome (post em foco): "Nome ✓ · 35 h" / "@usuario" -> a idade vai logo depois do nome e do selo.
  // O horário próprio do X na linha do @ ("· 5 de out", "· 9 h") é escondido para não duplicar. Estrutura real:
  // [data-testid="User-Name"] > (linha do nome: a > div flex) + (linha do @: div > [@, "·", a > time]).
  function handleOnSameLine(un) {
    const nameLink = un.querySelector('a[href^="/"]');
    const handleLink = un.children[1] && un.children[1].querySelector('a[href^="/"]');
    if (!nameLink || !handleLink || !nameLink.getBoundingClientRect) return false;
    const a = nameLink.getBoundingClientRect();
    const b = handleLink.getBoundingClientRect();
    if (!a.height || !b.height) return false;
    return Math.abs(a.top + a.height / 2 - (b.top + b.height / 2)) < Math.max(a.height, b.height) / 2;
  }

  function setAges(root, win, nowMs) {
    ensureStyle(root.ownerDocument || root);
    const doc = root.ownerDocument || root;
    const scope = root.querySelector('[data-testid="primaryColumn"]') || root;
    let n = 0;
    for (const art of scope.querySelectorAll('article[data-testid="tweet"]')) {
      const un = art.querySelector('[data-testid="User-Name"]');
      const it = parseArticle(art);
      if (!un || !it) continue;
      const label = C().ageLabel(it.id, nowMs);
      if (!label) continue;
      const link = un.querySelector('a[href^="/"]');
      const nameRow = link && link.firstElementChild;
      const handleInner = un.children[1] && un.children[1].firstElementChild;
      const target = handleOnSameLine(un) && handleInner ? handleInner : nameRow;
      if (!target) continue;
      let sp = un.querySelector('[data-nx-age]');
      if (!sp) {
        sp = doc.createElement('span');
        sp.setAttribute('data-nx-age', '1');
        // mesma fonte, tamanho e cor do @ (senão o texto herda a fonte padrão do navegador)
        const ref = (un.children[1] && un.children[1].querySelector('span')) || un.querySelector('span');
        const cs = ref && win && win.getComputedStyle ? win.getComputedStyle(ref) : null;
        sp.style.cssText =
          'margin-left:4px;white-space:nowrap;flex:none;font-weight:400;' +
          (cs && cs.fontFamily ? 'font-family:' + cs.fontFamily + ';' : '') +
          (cs && cs.fontSize ? 'font-size:' + cs.fontSize + ';' : '') +
          (cs && cs.color ? 'color:' + cs.color + ';' : 'color:rgb(113,118,123);');
        if (handleInner) {
          for (const k of Array.from(handleInner.children).slice(1)) {
            if (k.querySelector('time') || k.textContent.trim() === '·') k.setAttribute(HIDE_ATTR, '1');
          }
        }
      }
      if (sp.parentElement !== target) target.append(sp); // a janela mudou de largura: o @ passou para outra linha
      const text = '· ' + label;
      if (sp.textContent !== text) sp.textContent = text;
      n++;
    }
    return n;
  }

  // ---- lacunas e "novos posts" no feed ----
  // Texto de botão que revela posts escondidos ("Mostrar mais", "Show more", "Mostrar 12 posts"...). Lista fechada
  // de propósito: nunca clicar em botões de promoção ("Inscrever-se"), "Quem seguir" etc.
  const GAP_RE = /\b(mostrar|ver|show|load|carregar|cargar)\b[^\n]*\b(mais|more|más|posts?)\b|\b\d+\b[^\n]*\bposts?\b/i;

  // Botões que preenchem uma LACUNA entre posts: célula sem post, sem usuário, sem links e com UM botão de texto
  // curto que bate em GAP_RE. Só os que estão na tela (o X carrega a lacuna ao rolar até ela).
  function findGapButtons(root, win) {
    const scope = root.querySelector('[data-testid="primaryColumn"]') || root;
    const out = [];
    for (const cell of scope.querySelectorAll('[data-testid="cellInnerDiv"]')) {
      if (cell.querySelector('article, [data-testid="UserCell"], a[href]')) continue;
      const btns = Array.from(cell.querySelectorAll('button, [role="button"]')).filter(
        (b) => !/-(un)?follow$/.test(b.getAttribute('data-testid') || '')
      );
      if (btns.length !== 1) continue;
      const b = btns[0];
      const t = (b.innerText || b.textContent || '').trim();
      if (!t || t.length > 40 || !GAP_RE.test(t)) continue;
      if (win && b.getBoundingClientRect) {
        const r = b.getBoundingClientRect();
        if (r.height && (r.bottom < 0 || r.top > win.innerHeight)) continue;
      }
      out.push(b);
    }
    return out;
  }

  // Botão do topo "Ver novos posts" / "Show N posts" (posts que chegaram depois de o feed carregar).
  function findNewPostsPill(root) {
    for (const lab of root.querySelectorAll('[data-testid="pillLabel"]')) {
      const b = lab.closest('button, [role="button"]');
      if (b && /posts?/i.test(b.innerText || b.textContent || '')) return b;
    }
    return null;
  }

  function isLoginPath(pathname) {
    return /^\/(i\/flow\/login|login)(\/|$)/.test(pathname || '');
  }

  return {
    articles, parseArticle, readItems, pageItems, findDateRow, hasStatus, hasArticles,
    selectTab, skeleton, isLoginPath, findBottomBars, findAppBanners, setBottomBarsHidden, setAges, findTextMoreButtons, visibleVideo, controlsVisible, applyPlaybackRate, pageMissing, findGapButtons, findNewPostsPill,
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Xdom;

// ---- labels.js ----
// labels: linhas de contexto injetadas NA página do X, no estilo do "fulano repostou" nativo
// (texto cinza, largura inteira), em três posições:
//  - "label":  acima do post da fila (repostado por, thread, lacuna);
//  - "banner": acima do primeiro post da tela, quando ele NÃO é o post da fila e este foi repostado;
//  - "seen":   ("já visto") logo ABAIXO da linha da data do post da fila. Se a página não mostra essa linha
//              (layout compacto), a informação cai para o fim do "label", para nunca se perder.
// "label" e "banner" são IRMÃS imediatamente anteriores ao <article> (os filhos do article do X ficam lado a
// lado, então um filho novo viraria uma coluna). `sync` é idempotente: só escreve no DOM se algo mudou.
const Labels = (function () {
  const X = () => (typeof Xdom !== 'undefined' ? Xdom : require('./xdom.js'));
  const HANDLE_SPLIT = /(@[A-Za-z0-9_]{1,15})/;
  const ICON_SPLIT = /^([^\p{L}\p{N}\s]+)\s+([\s\S]*)$/u;
  const FONT = 'font:600 16px/1.45 -apple-system,system-ui,"Segoe UI",sans-serif;color:#71767b;';
  const BOX = {
    top: 'box-sizing:border-box;width:100%;flex:0 0 100%;padding:12px 16px 14px;margin:0;' + FONT,
    seen: 'box-sizing:border-box;width:100%;padding:8px 0 4px;margin:0;' + FONT,
  };
  const ICON = 'display:inline-block;width:34px;';
  const ICON_SEEN = 'display:inline-block;margin-right:8px;'; // linha abaixo da data: ícone colado ao texto
  const LINK = 'color:inherit;text-decoration:none;';
  const WARN = 'color:#f0b429;';

  function find(art, kind) {
    if (kind === 'seen') return art.querySelector('[data-nx="seen"]');
    const p = art.previousElementSibling;
    return p && p.getAttribute('data-nx') === kind ? p : null;
  }

  // "@fulano" vira link para o perfil; o resto é texto puro (nunca HTML).
  function fillText(doc, parent, text, names) {
    for (const part of text.split(HANDLE_SPLIT)) {
      if (!part) continue;
      if (part.startsWith('@') && HANDLE_SPLIT.test(part)) {
        const a = doc.createElement('a');
        a.href = 'https://x.com/' + part.slice(1);
        a.textContent = (names && names[part.slice(1).toLowerCase()]) || part; // nome de exibição, se conhecido
        a.setAttribute('style', LINK);
        a.addEventListener('mouseenter', () => { a.style.textDecoration = 'underline'; });
        a.addEventListener('mouseleave', () => { a.style.textDecoration = 'none'; });
        parent.append(a);
      } else {
        parent.append(doc.createTextNode(part));
      }
    }
  }

  // Ícone numa coluna própria, com o texto um pouco mais à direita.
  function fillLine(doc, row, text, kind, names) {
    const m = ICON_SPLIT.exec(text);
    if (m) {
      const icon = doc.createElement('span');
      icon.setAttribute('style', kind === 'seen' ? ICON_SEEN : ICON);
      icon.textContent = m[1];
      row.append(icon);
      fillText(doc, row, m[2], names);
    } else {
      fillText(doc, row, text, names);
    }
  }

  function build(doc, kind, lines, names) {
    const node = doc.createElement('div');
    node.setAttribute('data-nx', kind);
    node.setAttribute('data-nx-text', stamp(lines, names));
    node.setAttribute('style', kind === 'seen' ? BOX.seen : BOX.top);
    for (const l of lines) {
      const row = doc.createElement('div');
      if (l.startsWith('⚠')) row.setAttribute('style', WARN);
      fillLine(doc, row, l, kind, names);
      node.append(row);
    }
    return node;
  }

  // Posição correta de cada tipo em relação ao article.
  function placed(art, kind, node, dateRow) {
    if (kind === 'seen') return !!dateRow && dateRow.nextElementSibling === node;
    return art.previousElementSibling === node;
  }

  // Assinatura do conteúdo (texto + nomes): só reescreve o DOM quando algo mudou.
  function stamp(lines, names) {
    return lines.join('\n') + '\u0001' + JSON.stringify(names || {});
  }

  function ensure(doc, art, kind, lines, dateRow, names) {
    const text = stamp(lines, names);
    let node = find(art, kind);
    if (node && node.getAttribute('data-nx-text') === text && placed(art, kind, node, dateRow)) return false;
    if (node) node.remove();
    node = build(doc, kind, lines, names);
    if (kind === 'seen') dateRow.after(node);
    else art.parentNode.insertBefore(node, art);
    return true;
  }

  function remove(art, kind) {
    const node = find(art, kind);
    if (node) node.remove();
  }

  // model: { tweetId, lines: string[] (topo), seen: string|null, bannerText: string|null }
  function sync(root, model) {
    const doc = root.ownerDocument || root;
    const arts = X().articles(root).filter((a) => a.parentNode);
    const first = arts[0] || null;
    const target = arts.find((a) => {
      const p = X().parseArticle(a);
      return p && p.id === model.tweetId;
    }) || null;
    const dateRow = target && model.seen ? X().findDateRow(target) : null;
    const topLines = model.lines.slice();
    if (model.seen && !dateRow) topLines.push(model.seen); // sem linha de data: não perde a informação

    for (const a of arts) {
      if (a !== target || !topLines.length) remove(a, 'label');
      if (a !== target || !dateRow) remove(a, 'seen');
      if (a !== first || a === target || !model.bannerText) remove(a, 'banner');
    }
    if (target && topLines.length) ensure(doc, target, 'label', topLines, null, model.names);
    if (target && dateRow) ensure(doc, target, 'seen', [model.seen], dateRow, model.names);
    if (first && first !== target && model.bannerText) ensure(doc, first, 'banner', [model.bannerText], null, model.names);
    return {
      label: !!(target && topLines.length),
      seen: !!(target && dateRow),
      banner: !!(first && first !== target && model.bannerText),
    };
  }

  function clear(root) {
    for (const n of Array.from(root.querySelectorAll('[data-nx]'))) n.remove();
  }

  return { sync, clear };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Labels;

// ---- following.js ----
// following: lista de contas que você segue. (1) leitura completa da página de Seguindo; (2) reconhecimento dos
// botões de seguir/deixar de seguir para manter a lista atualizada ao vivo. Só lê a página: nunca clica em nada.
//
// Estrutura do X usada (conferida na página real): botões `data-testid="<idNumérico>-follow|unfollow"`, dentro de
// `[data-testid="UserCell"]` com o link do perfil; meu perfil em `a[data-testid="AppTabBar_Profile_Link"]`.
const Following = (function () {
  const C = () => (typeof Core !== 'undefined' ? Core : require('./core.js'));
  const ORIGIN = 'https://x.com';
  const BTN_RE = /^(\d+)-(follow|unfollow)$/;

  // Meu @, lido do link do perfil na navegação do X.
  function ownHandle(root) {
    const a = root.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    return a ? C().parseProfileHref(a.getAttribute('href'), ORIGIN) : null;
  }

  // Botão de seguir/deixar de seguir a partir do elemento clicado (o clique costuma cair num span interno).
  function buttonOf(target) {
    let n = target;
    for (let i = 0; n && i < 8; i++, n = n.parentElement) {
      const t = n.getAttribute && n.getAttribute('data-testid');
      if (t && BTN_RE.test(t)) return n;
    }
    return null;
  }

  function profileLinkIn(container) {
    for (const a of container.querySelectorAll('a[href^="/"]')) {
      const h = C().parseProfileHref(a.getAttribute('href'), ORIGIN);
      if (h) return h;
    }
    return null;
  }

  // Nome de exibição: primeiro texto dentro de um elemento com `dir` (o @ vem depois e começa com "@").
  function nameIn(container) {
    for (const el of container.querySelectorAll('[dir="ltr"] span')) {
      const t = el.textContent.trim();
      if (t && !t.startsWith('@')) return t;
    }
    return null;
  }

  // { id, kind: 'follow'|'unfollow', handle|null, name|null }
  function infoFor(btn, pathname) {
    const m = BTN_RE.exec(btn.getAttribute('data-testid'));
    const container = btn.closest('[data-testid="UserCell"]') || btn.closest('[data-testid="HoverCard"]');
    let handle = container ? profileLinkIn(container) : null;
    if (!handle) handle = C().parseProfileHref(pathname || '', ORIGIN); // cabeçalho da página de perfil
    return { id: m[1], kind: m[2], handle, name: container ? nameIn(container) : null };
  }

  // Seletor do botão que aparece DEPOIS de a ação dar certo (seguir -> "seguindo" e vice-versa).
  function oppositeSelector(id, kind) {
    return '[data-testid="' + id + '-' + (kind === 'follow' ? 'unfollow' : 'follow') + '"]';
  }

  // Contas listadas na página de Seguindo, em ordem de DOM.
  function readCells(root) {
    const out = [];
    for (const c of root.querySelectorAll('[data-testid="UserCell"]')) {
      const handle = profileLinkIn(c);
      if (handle) out.push({ handle, name: nameIn(c) });
    }
    return out;
  }

  // env: { readCells(), scrollToTop(), scrollBy(px), viewportHeight(), atBottom(), sleep(ms), rand(a,b),
  //        onProgress(n, steps), isCancelled() }
  // Devolve { accounts, complete, reason }. Só é "completa" ao chegar ao fim da lista (estável por 3 passos).
  async function collect(env, options) {
    const o = Object.assign(
      { maxSteps: 150, stepFraction: 0.8, stepDelayMs: [700, 1300], settleMs: 1000, stagnantLimit: 3, settlePolls: 4, pollMs: 500 },
      options || {}
    );
    const seen = new Map();
    let stagnant = 0;
    let steps = 0;
    env.scrollToTop();
    await env.sleep(o.settleMs);
    for (;;) {
      const before = seen.size;
      for (const c of env.readCells()) if (!seen.has(c.handle.toLowerCase())) seen.set(c.handle.toLowerCase(), c);
      env.onProgress(seen.size, steps);
      const accounts = () => Array.from(seen.values());
      if (env.isCancelled()) return { accounts: accounts(), complete: false, reason: 'cancelled' };
      if (steps >= o.maxSteps) return { accounts: accounts(), complete: false, reason: 'max_steps' };

      env.scrollBy(Math.round(env.viewportHeight() * o.stepFraction));
      await env.sleep(env.rand(o.stepDelayMs[0], o.stepDelayMs[1]));
      // Espera o X desenhar/carregar mais, inclusive no fim da página (rolagem infinita: é quando ele carrega).
      for (let p = 0; p < o.settlePolls; p++) {
        if (env.readCells().some((c) => !seen.has(c.handle.toLowerCase()))) break;
        await env.sleep(o.pollMs);
      }
      steps++;
      if (seen.size === before && env.atBottom()) {
        // lê mais uma vez antes de contar como parado (o X pode ter desenhado agora)
        for (const c of env.readCells()) if (!seen.has(c.handle.toLowerCase())) seen.set(c.handle.toLowerCase(), c);
        if (seen.size === before && ++stagnant >= o.stagnantLimit) return { accounts: accounts(), complete: true, reason: 'end' };
      } else if (seen.size !== before) {
        stagnant = 0;
      }
    }
  }

  return { ownHandle, buttonOf, infoFor, oppositeSelector, readCells, collect };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Following;

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
    knownRun: 5, // itens CONHECIDOS seguidos necessários para encerrar...
    minKnown: 25, // ...e total mínimo de conhecidos vistos (cobre conversas que sobem no feed abaixo de uma sequência longa de conhecidos)
    settlePolls: 4, // esperas extras (pollMs) por itens novos quando o X ainda não desenhou nada
    pollMs: 500,
    maxExpand: 40, // cliques máximos em "Mostrar mais" (lacunas) por busca
    // Busca profunda: em vez da âncora, vai até a fronteira de TEMPO (a última verificação profunda).
    olderThanMs: 0, // horário (ms) da fronteira; 0 = desligado
    olderRun: 3, // posts comuns (sem repost, sem fixado) seguidos mais antigos que a fronteira para parar
    ignoreAnchor: false, // true: itens conhecidos não encerram a busca (só a fronteira, o fim do feed ou os limites)
    maxMs: 0, // limite de tempo total da busca (0 = sem limite)
  };

  function snowflakeMs(id) {
    try { return Number(BigInt(id) >> 22n) + 1288834974657; } catch (e) { return null; }
  }

  // env: { readItems(), scrollToTop(), scrollBy(px), scrollHeight(), viewportHeight(), atBottom(),
  //        sleep(ms), rand(a,b), onProgress(n, steps), isCancelled(),
  //        expand(click)?  -> { found, clicked }  (opcional: com click=true abre UMA lacuna "Mostrar mais" visível;
  //                           com click=false só conta quantas há),
  //        expandTop()? (opcional: clica em "Ver novos posts" antes de começar) }
  //
  // Por que NÃO parar no primeiro item conhecido: o X reagrupa conversas (um post antigo com respostas novas
  // sobe no feed junto delas), então um item conhecido pode aparecer ACIMA de itens novos. A busca só termina
  // depois de `knownRun` itens conhecidos consecutivos E de ter visto `minKnown` conhecidos no total (ou todas as âncoras).
  //
  // Devolve { seq, anchorFound, reason, steps, expanded, gapUnresolved }. `seq` traz todos os itens lidos, do mais novo ao mais antigo,
  // cada um com `known` (já está na fila); os conhecidos servem de contexto para reconhecer conversas.
  async function run(env, options, anchorKeys) {
    const o = Object.assign({}, DEFAULTS, options || {});
    const t0 = Date.now();
    let olderStreak = 0;
    let boundaryReached = false;
    const known = new Set(anchorKeys || []);
    const need = Math.max(1, Math.min(o.knownRun, known.size || 1));
    const needTotal = Math.min(o.minKnown, known.size);
    const seen = new Set();
    const byKey = new Map();
    const seq = [];
    let fresh = 0; // itens novos (desconhecidos)
    let consecutive = 0;
    let knownTotal = 0;
    let anchorFound = false;
    let stagnant = 0;
    let steps = 0;
    let reason = '';
    let expanded = 0;
    let gapUnresolved = 0;

    if (env.expandTop && env.expandTop()) await env.sleep(o.settleMs * 2);
    env.scrollToTop();
    await env.sleep(o.settleMs);

    for (;;) {
      // Cada item novo entra logo abaixo do vizinho que o X mostra acima dele (assim, posts de uma lacuna que
      // acabou de ser aberta ficam NO MEIO, na ordem do feed, e não depois dos que já tinham sido vistos).
      let prev = null;
      for (const it of env.readItems()) {
        if (seen.has(it.key)) {
          prev = byKey.get(it.key);
          continue;
        }
        seen.add(it.key);
        const isKnown = known.has(it.key);
        const obj = Object.assign({}, it, { known: isKnown });
        byKey.set(it.key, obj);
        seq.splice(prev ? seq.indexOf(prev) + 1 : seq.length, 0, obj);
        prev = obj;
        if (isKnown) {
          consecutive++;
          knownTotal++;
        } else {
          consecutive = 0;
          fresh++;
        }
        if (o.olderThanMs && !it.reposter && !it.pinned) {
          const created = snowflakeMs(it.id);
          if (created !== null) olderStreak = created < o.olderThanMs ? olderStreak + 1 : 0;
          if (olderStreak >= o.olderRun) {
            boundaryReached = true;
            anchorFound = true;
            break;
          }
        }
        if (!o.ignoreAnchor && known.size && consecutive >= need && knownTotal >= needTotal) {
          anchorFound = true;
          break;
        }
      }
      env.onProgress(fresh, steps);

      // Lacuna "Mostrar mais" na tela: abre e relê o mesmo trecho antes de rolar (nada é pulado). Passando do limite
      // de cliques, só conta: fica registrado que pode haver posts escondidos.
      if (!anchorFound && env.expand) {
        const ex = env.expand(expanded < o.maxExpand); // { found, clicked }
        if (ex.clicked) {
          expanded++;
          await env.sleep(o.pollMs * 3);
          continue;
        }
        gapUnresolved += ex.found;
      }

      if (anchorFound) { reason = boundaryReached ? 'time_boundary' : 'anchor'; break; }
      if (env.isCancelled()) { reason = 'cancelled'; break; }
      if (!o.olderThanMs && known.size === 0 && fresh >= o.initialBackfill) { reason = 'backfill'; break; }
      if (seq.length >= o.maxCollect) { reason = 'max_collect'; break; }
      if (steps >= o.maxSteps) { reason = 'max_steps'; break; }
      if (o.maxMs && Date.now() - t0 > o.maxMs) { reason = 'max_time'; break; }

      const before = env.scrollHeight();
      env.scrollBy(Math.round(env.viewportHeight() * o.stepFraction));
      await env.sleep(env.rand(o.stepDelayMs[0], o.stepDelayMs[1]));
      // O X às vezes demora a desenhar: espera um pouco antes de seguir (não pula posts sem ler).
      // (inclusive no fim da página: é quando a rolagem infinita carrega mais)
      for (let p = 0; p < o.settlePolls; p++) {
        if (env.readItems().some((it) => !seen.has(it.key))) break;
        await env.sleep(o.pollMs);
      }
      steps++;
      if (env.atBottom() && env.scrollHeight() === before) {
        if (++stagnant >= 3) { reason = 'end'; break; }
      } else {
        stagnant = 0;
      }
    }
    return { seq, anchorFound, reason, steps, expanded, gapUnresolved };
  }

  return { run, DEFAULTS };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Scanner;

// ---- profiles.js ----
// profiles: verificação de UM perfil (aba Posts ou Respostas) na busca profunda. Lê só o que a própria conta publicou,
// do mais novo para o mais antigo, e para ao achar `olderStop` posts feitos ANTES da última verificação profunda.
// Nunca clica em nada: só rola e lê. Todo efeito colateral passa por `env` (testável com um perfil simulado).
const Profiles = (function () {
  const C = () => (typeof Core !== 'undefined' ? Core : require('./core.js'));
  const DEFAULTS = {
    olderStop: 5, // posts mais antigos que a fronteira para encerrar
    maxSteps: 150,
    stepFraction: 0.7,
    stepDelayMs: [800, 1500],
    settleMs: 800,
    settlePolls: 4,
    pollMs: 500,
  };

  // env: { readItems(), scrollToTop(), scrollBy(px), scrollHeight(), viewportHeight(), atBottom(), sleep(ms),
  //        rand(a,b), isCancelled(), onStep(steps)? }
  // Devolve { items, reason, steps, older }:
  //   items  = posts da conta com horário >= fronteira (sem reposts, sem fixado), do mais novo ao mais antigo;
  //   reason = 'older' (achou os posts antigos) | 'end' (fim da página) | 'max_steps' | 'cancelled'.
  // Posts de OUTRAS contas (a resposta mostra o post respondido acima, por exemplo) e reposts não contam nem entram:
  // o horário de um repost não está no ID, e quem reposta já aparece no Seguindo.
  async function scan(env, handle, boundaryMs, options) {
    const o = Object.assign({}, DEFAULTS, options || {});
    const me = String(handle).toLowerCase();
    const seen = new Set();
    const items = [];
    let older = 0;
    let steps = 0;
    let stagnant = 0;
    env.scrollToTop();
    await env.sleep(o.settleMs);
    for (;;) {
      for (const it of env.readItems()) {
        if (seen.has(it.key)) continue;
        seen.add(it.key);
        if (it.author.toLowerCase() !== me || it.reposter || it.pinned) continue;
        const created = C().snowflakeMs(it.id);
        if (created !== null && created < boundaryMs) {
          older++;
          if (older >= o.olderStop) return { items, reason: 'older', steps, older };
        } else {
          items.push(it);
        }
      }
      if (env.isCancelled()) return { items, reason: 'cancelled', steps, older };
      if (steps >= o.maxSteps) return { items, reason: 'max_steps', steps, older };
      const before = env.scrollHeight();
      env.scrollBy(Math.round(env.viewportHeight() * o.stepFraction));
      await env.sleep(env.rand(o.stepDelayMs[0], o.stepDelayMs[1]));
      // o X desenha aos poucos (e carrega mais no fim da página): espera antes de contar como parado
      for (let p = 0; p < o.settlePolls; p++) {
        if (env.readItems().some((x) => !seen.has(x.key))) break;
        await env.sleep(o.pollMs);
      }
      steps++;
      if (env.onStep) env.onStep(steps);
      if (env.atBottom() && env.scrollHeight() === before) {
        if (++stagnant >= 3) return { items, reason: 'end', steps, older };
      } else {
        stagnant = 0;
      }
    }
  }

  return { scan };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Profiles;

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
      runs: (limit) => call('GET', '/runs', { params: { limit } }),
      runFailed: (body) => call('POST', '/runs', { body }),
      runReport: (body) => call('POST', '/runs/report', { body }),
      deepLast: (mode) => call('GET', '/runs/deep-last', { params: { mode } }),
      queue: (params) => call('GET', '/queue', { params }),
      entry: (seq) => call('GET', '/entries/' + seq),
      patchEntry: (seq, body) => call('PATCH', '/entries/' + seq, { body }),
      cover: (body) => call('POST', '/entries/cover', { body }),
      uncover: (body) => call('POST', '/entries/uncover', { body }),
      settle: (body) => call('POST', '/entries/settle', { body }),
      views: (body) => call('POST', '/views', { body }),
      following: (include) => call('GET', '/accounts/following', { params: { include: include ? 'true' : undefined } }),
      putFollowing: (body) => call('PUT', '/accounts/following', { body }),
      followAdd: (body) => call('POST', '/accounts/following/add', { body }),
      followRemove: (body) => call('POST', '/accounts/following/remove', { body }),
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
    .ov.list { justify-content: flex-start; align-items: stretch; text-align: left; padding: 16px 14px calc(16px + env(safe-area-inset-bottom)); }
    .ov.list h1 { text-align: center; }
    .ov.list .btns { flex: none; }
    .rows { flex: 1 1 auto; overflow-y: auto; min-height: 0; width: 100%; max-width: 42em; margin: 0 auto; -webkit-overflow-scrolling: touch;
      border-top: 1px solid #2f3336; }
    .rw { padding: 12px 6px; border-bottom: 1px solid #2f3336; }
    .rw .m { font-size: 15px; font-weight: 600; }
    .rw .s { font-size: 14px; color: #9aa0a6; margin-top: 4px; line-height: 1.4; overflow-wrap: anywhere; }
    .rw.warn .s { color: #f0b429; }
    .rw.next { background: #0f1c27; border-radius: 10px; border-bottom: 1px solid #1d9bf0; margin: 8px 0; }
    .rw.next .m { color: #1d9bf0; }
    .rw.event { background: #14110a; }
    .rw.event .m { color: #f0b429; }
    .rw.event .s { color: #c9b27a; }
    .rw.error .s { color: #f4212e; }
    .rw.empty { color: #9aa0a6; text-align: center; border: 0; }
    button { appearance: none; border: 1px solid #536471; background: #16181c; color: #e7e9ea;
      border-radius: 999px; padding: 12px 20px; font-size: 16px; min-height: 44px; cursor: pointer; }
  `;
  const SPEED_CSS = `
    :host { all: initial; }
    button { display: block; min-width: 46px; height: 28px; padding: 0 10px; border-radius: 14px;
      border: 1px solid rgba(255,255,255,.25); background: rgba(15,20,25,.42); color: rgba(255,255,255,.9); cursor: pointer;
      font: 600 13px -apple-system, system-ui, "Segoe UI", sans-serif; -webkit-tap-highlight-color: transparent; }
  `;
  const SPEED_MENU_CSS = `
    .menu { position: absolute; top: 34px; right: 0; display: grid; grid-template-columns: repeat(2, minmax(62px, 1fr)); gap: 4px;
      padding: 5px; background: rgba(15,20,25,.88); border: 1px solid rgba(255,255,255,.3); border-radius: 12px; overflow-y: auto; }
    .menu button { height: 32px; min-width: 62px; padding: 0 8px; font-size: 14px; border-radius: 9px; font-weight: 500;
      background: rgba(255,255,255,.06); color: #fff; }
    .menu button.sel { background: #1d9bf0; border-color: #1d9bf0; font-weight: 700; }
  `;
  // Tela de carregamento ao abrir um post da fila: cobre a página enquanto o script a arruma (rola ao topo, abre os
  // "Mostrar mais", confere a conversa) e some num fade suave, deixando o post já na posição certa.
  const LOADING_CSS = `
    :host { all: initial; }
    .ld { position: fixed; inset: 0; z-index: 2147483647; background: #000; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 16px; opacity: 1; transition: opacity .45s ease; }
    .ld.out { opacity: 0; pointer-events: none; }
    .sp { width: 44px; height: 44px; border-radius: 50%; border: 4px solid rgba(255,255,255,.14); border-top-color: #1d9bf0;
      animation: nxspin .9s linear infinite; }
    .tx { color: #71767b; font: 500 14px -apple-system, system-ui, "Segoe UI", sans-serif; letter-spacing: .02em; }
    @keyframes nxspin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .sp { animation-duration: 2.6s; } .ld { transition-duration: .2s; } }
  `;
  const LOADING_FAILSAFE_MS = 25000; // se algo der errado, a tela nunca fica presa
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
    const spd = makeHost(doc, 'notixias-speed', SPEED_CSS + SPEED_MENU_CSS);
    const ld = makeHost(doc, 'notixias-loading', LOADING_CSS);
    let ldNode = null;
    let ldRemoveTimer = null;
    let ldFailTimer = null;
    let spdNode = null;
    let spdOpen = false;
    let spdModel = null;
    let spdMenu = null;
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

    // o: { title, detail, error, rows[{main, sub, tone}] (lista rolável), buttons[{label,onClick}] }
    function showOverlay(o) {
      attach(ov);
      if (ovNode) ovNode.remove();
      ovNode = el(doc, 'div', { class: 'ov' + (o.error ? ' error' : '') + (o.rows ? ' list' : '') },
        el(doc, 'h1', {}, o.title || ''),
        o.detail ? el(doc, 'p', {}, o.detail) : null,
        o.rows
          ? el(doc, 'div', { class: 'rows' }, o.rows.length
              ? o.rows.map((r) => el(doc, 'div', { class: 'rw ' + (r.tone || '') }, el(doc, 'div', { class: 'm' }, r.main), r.sub ? el(doc, 'div', { class: 's' }, r.sub) : null))
              : el(doc, 'div', { class: 'rw empty' }, 'Nenhuma execução registrada ainda.'))
          : null,
        el(doc, 'div', { class: 'btns' }, (o.buttons || []).map((b) => el(doc, 'button', { onclick: b.onClick }, b.label))));
      ov.root.append(ovNode);
    }

    function hideOverlay() {
      if (ovNode) ovNode.remove();
      ovNode = null;
    }

    // Botão de velocidade do vídeo; ao tocar abre um menu com as opções.
    // o: { label, options[{value,label,selected}], onPick(value), container?, visible?, maxHeight?, top?, right? }
    //  - com `container` (o player do X): o botão vai DENTRO dele, em posição absoluta, e rola junto com o vídeo sem
    //    atraso; `visible=false` esconde (os controles do X sumiram) e fecha o menu;
    //  - sem `container`: fixo na tela em top/right (quem chama o esconde enquanto a página rola).
    function renderSpeedMenu() {
      if (spdMenu) spdMenu.remove();
      spdMenu = null;
      if (!spdOpen || !spdModel || spdModel.visible === false) return;
      spdMenu = el(doc, 'div', { class: 'menu', style: 'max-height:' + Math.max(120, Math.round(spdModel.maxHeight || 260)) + 'px' },
        (spdModel.options || []).map((op) => el(doc, 'button', {
          class: op.selected ? 'sel' : '',
          onclick: (e) => { e.preventDefault(); e.stopPropagation(); spdOpen = false; renderSpeedMenu(); if (spdModel.onPick) spdModel.onPick(op.value); },
        }, op.label)));
      spd.root.append(spdMenu);
    }

    function showSpeed(o) {
      spdModel = o;
      const host = spd.host;
      if (!spdNode) {
        spdNode = el(doc, 'button', {});
        const stop = (e) => { e.stopPropagation(); };
        for (const ev of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend']) host.addEventListener(ev, stop);
        spdNode.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); spdOpen = !spdOpen; renderSpeedMenu(); });
        spd.root.append(spdNode);
        // toque fora do botão/menu fecha o menu
        doc.addEventListener('click', (e) => {
          if (spdOpen && !(e.composedPath && e.composedPath().includes(host))) { spdOpen = false; renderSpeedMenu(); }
        }, true);
      }
      if (spdNode.textContent !== o.label) spdNode.textContent = o.label;
      const hidden = o.visible === false ? 'display:none;' : '';
      if (o.container) {
        if (host.parentElement !== o.container) o.container.append(host);
        host.style.cssText = 'position:absolute;top:10px;right:10px;z-index:5;' + hidden;
      } else {
        const root = doc.documentElement;
        if (host.parentElement !== root) root.append(host);
        host.style.cssText = 'position:fixed;top:' + Math.round(o.top) + 'px;right:' + Math.round(o.right) + 'px;z-index:2147483645;' + hidden;
      }
      if (o.visible === false && spdOpen) { spdOpen = false; renderSpeedMenu(); }
      else if (spdOpen && spdMenu) {
        // mantém o menu em dia (opção marcada, altura máxima) sem fechá-lo
        const sel = (o.options || []).map((x) => x.selected).join();
        if (spdMenu.getAttribute('data-sel') !== sel) { renderSpeedMenu(); }
      }
      if (spdMenu) spdMenu.setAttribute('data-sel', (o.options || []).map((x) => x.selected).join());
    }

    function hideSpeed() {
      spdOpen = false;
      if (spdMenu) spdMenu.remove();
      spdMenu = null;
      spd.host.remove();
    }

    function showLoading(label) {
      attach(ld);
      clearTimeout(ldRemoveTimer);
      if (!ldNode) {
        ldNode = el(doc, 'div', { class: 'ld' }, el(doc, 'div', { class: 'sp' }), el(doc, 'div', { class: 'tx' }, label || 'Abrindo…'));
        ld.root.append(ldNode);
      }
      ldNode.classList.remove('out');
      const tx = ldNode.querySelector('.tx');
      if (tx && label && tx.textContent !== label) tx.textContent = label; // ao abrir outro post, o texto acompanha
      clearTimeout(ldFailTimer);
      ldFailTimer = setTimeout(hideLoading, LOADING_FAILSAFE_MS);
    }

    // Fade out suave; depois remove da página.
    function hideLoading() {
      if (!ldNode) return;
      clearTimeout(ldFailTimer);
      const node = ldNode;
      node.classList.add('out');
      clearTimeout(ldRemoveTimer);
      ldRemoveTimer = setTimeout(() => {
        if (ldNode !== node) return;
        node.remove();
        ldNode = null;
        ld.host.remove();
      }, 520);
    }

    return { renderBar, hideBar, showOverlay, hideOverlay, showSpeed, hideSpeed, showLoading, hideLoading };
  }

  return { create, readWidths };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Ui;

// ---- main.js ----
// main: orquestração no navegador (GM_*, navegação, fases). Não é coberto por testes unitários;
// ver o checklist manual em docs/STATUS.md.
async function startApp() {
  const NX_VERSION = '0.10.2'; // trocado na montagem (build.js)
  const DEFAULTS = {
    apiBaseUrl: 'http://localhost:8010',
    apiKey: '',
    autoResume: true,
    internalNav: true,
    layout: 'full', // 'full' | 'left' | 'right'  (modo uma mão: botões em ~65% da largura, no lado escolhido)
    buttons: 'both', // 'both' | 'next' | 'prev'
    hideXBar: true, // esconde a barra de navegação inferior do X (mobile)
    videoSpeed: 1, // velocidade dos vídeos (botão sobre o vídeo; o X no celular não tem controle)
    bot: false, // robô do servidor (navegador sem tela): só busca novas, nunca abre/lê entradas nem mexe na posição
  };
  const SCAN = { initialBackfill: 40, maxSteps: 150, maxCollect: 400, stepDelayMs: [900, 1700], stepFraction: 0.7, anchorDepth: 100, knownRun: 5, minKnown: 25 };
  // O robô roda sem pessoa olhando e com intervalos longos entre as buscas: aceita rolar mais antes de desistir.
  const BOT_SCAN = { maxSteps: 400, maxCollect: 800 };
  // Busca profunda: sem limite de passos. Para na fronteira de TEMPO (3 posts comuns seguidos mais antigos que a última
  // verificação profunda), no fim do feed, em 900 posts (teto da API: 1000 por envio) ou em 45 min. Âncoras: 50.
  const DEEP_SCAN = { maxSteps: 1e9, maxCollect: 900, ignoreAnchor: true, olderRun: 3, maxMs: 45 * 60 * 1000 };
  const DEEP_ANCHOR_DEPTH = 50;
  const PROFILE_PAUSE_MS = [1500, 4000]; // pausa entre um perfil e o seguinte
  const PROFILE_MAX_FAILS = 5; // perfis seguidos sem conseguir ler antes de desistir da verificação
  const FETCH_STALE_MS = 60 * 60 * 1000; // uma busca profunda no feed pode durar até 45 min
  const PROFILES_STALE_MS = 3 * 60 * 60 * 1000; // a verificação de perfis atravessa dezenas de páginas
  const ERROR_STALE_MS = 5 * 60 * 1000;
  const NOTICE_MS = 6000;

  // ---------- armazenamento do gerenciador de scripts (nunca o armazenamento do próprio x.com) ----------
  // No Tampermonkey GM_getValue é síncrono; no app Userscripts (iOS) devolve Promise. Por isso tudo é lido uma vez,
  // antes de iniciar, para um cache em memória, e o resto do código continua lendo de forma síncrona.
  const GM_KEYS = ['nx_beat', 'nx_cfg', 'nx_why', 'nx_follow_dirty', 'nx_follow_fail_at', 'nx_follow_ops', 'nx_launch', 'nx_mode', 'nx_notice', 'nx_phase', 'nx_skeleton', 'nx_view'];
  const gmCache = new Map();
  // Tampermonkey: GM_getValue/GM_setValue. Userscripts (iOS): GM.getValue/GM.setValue (assíncronos).
  const gmGet = (k) => (typeof GM_getValue === 'function' ? GM_getValue(k) : GM.getValue(k));
  const gmSet = (k, v) => (typeof GM_setValue === 'function' ? GM_setValue(k, v) : GM.setValue(k, v));
  const gm = {
    async load() {
      // Limite de tempo: se o gerenciador não responder, o app inicia com os padrões em vez de ficar parado.
      const one = async (k) => {
        try {
          const raw = await Promise.race([gmGet(k), new Promise((r) => setTimeout(() => r(undefined), 1500))]);
          if (raw !== undefined && raw !== null && raw !== '') gmCache.set(k, JSON.parse(raw));
        } catch (e) { /* valor ausente ou ilegível: usa o padrão */ }
      };
      await Promise.all(GM_KEYS.map(one));
    },
    get(k, d) {
      return gmCache.has(k) ? gmCache.get(k) : d;
    },
    set(k, v) {
      gmCache.set(k, v);
      try {
        const r = gmSet(k, JSON.stringify(v));
        if (r && typeof r.catch === 'function') r.catch(() => {});
      } catch (e) { /* sem armazenamento */ }
    },
  };
  await gm.load();
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
  // Sinal para o robô do servidor (lido pelo navegador sem tela): a busca terminou, com sucesso ou erro.
  // Identificação da execução (histórico): quem disparou e se foi normal ou profunda.
  // `x`: "normal" | "deep" (busca profunda do feed) | "profiles" (verificação dos perfis); aceita booleano (deep) por compatibilidade.
  // `trigger`: por que o robô rodou fora de hora (ex.: "restam 29 não lidas"), vindo do robô.
  const runMeta = (x) => {
    const mode = typeof x === 'string' ? x : x ? 'deep' : 'normal';
    const meta = { source: cfg.bot ? 'robot' : 'manual', mode };
    const why = cfg.bot ? gm.get('nx_why', null) : null;
    if (why) meta.trigger = String(why).slice(0, 200);
    return meta;
  };
  // Batimento de progresso (só no robô): o robô do servidor lê isto para saber se a busca está andando ou travou.
  const beat = () => { if (cfg.bot) gm.set('nx_beat', Date.now()); };
  const botDone = (result) => { if (cfg.bot) window.__nxBotResult = Object.assign({ at: Date.now() }, result); };
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
    if (p.name === 'following' && age > FETCH_STALE_MS) return { name: 'idle' };
    if (p.name === 'profiles' && age > PROFILES_STALE_MS) return { name: 'idle' };
    return p;
  };
  const setPhase = (name, extra) => gm.set('nx_phase', Object.assign({ name, at: Date.now() }, extra || {}));

  // ---------- barra do X escondida ----------
  function applyXBar() {
    try { Xdom.setBottomBarsHidden(document, window, cfg.hideXBar); } catch (e) { /* melhor esforço */ }
  }
  setInterval(applyXBar, 1500);

  // "· 35 h" ao lado do nome, nas páginas de post (o horário próprio do X nessa linha é escondido).
  function applyAges() {
    if (cfg.bot || !Core.parseStatusPath(location.pathname)) return;
    try { Xdom.setAges(document, window); } catch (e) { /* melhor esforço */ }
  }
  setInterval(applyAges, 1500);

  // Velocidade do vídeo: botão dentro do player (rola junto com o vídeo) que só aparece com os controles do X visíveis;
  // o toque abre um menu de 0,1x a 3x. Só mexe no vídeo quando a escolhida não é 1x.
  // Sem o player conhecido (página diferente), usa um botão fixo que some enquanto a página rola.
  let scrollingUntil = 0;
  const speedTouched = new WeakSet(); // vídeos cuja velocidade o script já alterou
  window.addEventListener('scroll', () => { scrollingUntil = Date.now() + 300; }, true);
  function applySpeed() {
    if (cfg.bot) return;
    let v = null;
    try { v = Xdom.visibleVideo(document, window); } catch (e) { /* melhor esforço */ }
    if (!v || (!v.component && Date.now() < scrollingUntil)) { ui.hideSpeed(); return; }
    const rate = cfg.videoSpeed || 1;
    Xdom.applyPlaybackRate(v.video, rate, speedTouched);
    ui.showSpeed({
      label: Core.formatSpeed(rate),
      options: Core.SPEEDS.map((s) => ({ value: s, label: Core.formatSpeed(s), selected: s === rate })),
      onPick: (s) => { cfg.videoSpeed = s; saveCfg(); applySpeed(); },
      container: v.component,
      visible: Xdom.controlsVisible(v.component, window),
      maxHeight: v.rect.bottom - v.rect.top - 60,   // o menu cabe dentro do vídeo (rola se for pequeno)
      top: v.rect.top + 10, right: window.innerWidth - v.rect.right + 10,
    });
  }
  setInterval(applySpeed, 300);
  // O X recria o vídeo e devolve a velocidade a 1x ao (re)começar: reaplica na hora, sem esperar o intervalo.
  for (const ev of ['play', 'loadedmetadata']) document.addEventListener(ev, () => { applySpeed(); }, true);

  // ---------- etiquetas dentro da página ----------
  let labelModel = null;
  let labelTimer = null;
  function syncLabels() {
    if (labelModel) Labels.sync(document, labelModel);
  }
  function setLabels(entry) {
    if (!entry) { labelModel = null; Labels.clear(document); return; }
    const parts = Core.buildLabelParts(entry);
    labelModel = {
      tweetId: entry.open_id || entry.tweet_id,
      lines: parts.top,
      seen: parts.seen,
      bannerText: Core.buildBannerText(entry),
      names: entry.all_reposter_names || entry.reposter_names || {},
    };
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

  // Espera a página "assentar": o número de posts desenhados fica igual por `stableMs`, ou passa `maxMs`.
  async function waitSettled(maxMs, stableMs) {
    const t0 = Date.now();
    let last = -1;
    let since = Date.now();
    while (Date.now() - t0 < maxMs) {
      const n = document.querySelectorAll('article').length;
      if (n !== last) { last = n; since = Date.now(); } else if (Date.now() - since >= stableMs) return;
      await sleep(100);
    }
  }

  // Rola ao topo repetidamente por alguns segundos (o X rola sozinho até o post aberto), parando se o dono interagir.
  // Fica escondido atrás da tela de carregamento, então a página não "pula" diante dos olhos. Devolve { stop }.
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
    return { stop: () => { stop = true; } };
  }

  // O post da fila que está sendo aberto? (o `nx_view` guardado ao abrir bate com o endereço)
  function isEntryPath() {
    const s = Core.parseStatusPath(location.pathname);
    const v = gm.get('nx_view', null);
    return !!(s && v && (s.id === v.tweetId || s.id === v.targetId));
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

  // Histórico das execuções (manuais e do robô), da mais recente para a mais antiga, em tela cheia com rolagem.
  async function showRuns() {
    ui.showOverlay({ title: 'Execuções', detail: 'Carregando…', buttons: [{ label: 'Fechar', onClick: ui.hideOverlay }] });
    try {
      const r = await api.runs(100);
      const nextRow = Core.formatNext(r.next);
      ui.showOverlay({ title: 'Execuções', rows: (nextRow ? [nextRow] : []).concat(r.items.map(Core.formatRun)), buttons: [{ label: 'Fechar', onClick: ui.hideOverlay }] });
    } catch (e) {
      ui.showOverlay({ title: 'Execuções', detail: '⚠ ' + (e && e.message ? e.message : 'Não consegui carregar.'), error: true, buttons: [{ label: 'Fechar', onClick: ui.hideOverlay }] });
    }
  }

  function menuItems(st) {
    return [
      { label: 'Execuções…', onClick: showRuns },
      { label: 'Buscar novas agora', onClick: () => startFetch() },
      { label: 'Buscar novas (varredura profunda do feed)', onClick: () => startFetch(true) },
      { label: 'Verificar perfis de quem sigo (profunda)', onClick: () => startProfilesRun() },
      { label: followingLabel(st), onClick: () => startFollowingRefresh() },
      { label: 'Mão: ' + CYCLE.layout.label[cfg.layout], onClick: () => cycle('layout') },
      { label: 'Botões: ' + CYCLE.buttons.label[cfg.buttons], onClick: () => cycle('buttons') },
      { label: 'Barra do X: ' + (cfg.hideXBar ? 'escondida' : 'visível'), onClick: () => { cfg.hideXBar = !cfg.hideXBar; saveCfg(); applyXBar(); drawBar(); } },
      { label: 'Ir para Explorar', onClick: () => go('https://x.com/explore') },
      { label: 'Trocar feed…', onClick: changeFeed },
      { label: 'Copiar esqueleto da última falha', onClick: copySkeleton },
      { label: 'Configurar API…', onClick: () => promptConfig() },
      { label: 'Retomar automaticamente: ' + (cfg.autoResume ? 'sim' : 'não'), onClick: () => { cfg.autoResume = !cfg.autoResume; saveCfg(); drawBar(); } },
      { label: 'Navegação interna: ' + (cfg.internalNav ? 'sim' : 'não'), onClick: () => { cfg.internalNav = !cfg.internalNav; saveCfg(); drawBar(); } },
      { label: 'notiXias versão ' + NX_VERSION, onClick: () => {} },
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

  // Lembrete discreto quando a lista de contas seguidas nunca foi lida ou está velha.
  function followingHint(st) {
    const f = st && st.following;
    if (!f || !f.last_full_at) return 'Contas seguidas ainda não lidas — menu ⋯';
    const days = Math.floor((Date.now() - new Date(f.last_full_at).getTime()) / 86400000);
    return days >= 30 ? 'Lista de contas seguidas com mais de 30 dias — menu ⋯' : null;
  }

  function renderEntryBar(st, notice) {
    showBar({ st, notice: notice || followingHint(st) });
    setLabels(st.current);
  }

  function renderSideBar(message, st) {
    setLabels(null);
    showBar({ st: st || null, message });
  }

  // ---------- leitura ----------
  async function openEntry(entry) {
    const label = Core.openingLabel(entry);
    if (!cfg.bot) ui.showLoading(label); // cobre a página já na saída; some em fade quando o post estiver pronto
    await api.putState({ cursor_seq: entry.seq });
    gm.set('nx_view', { seq: entry.seq, tweetId: entry.open_id || entry.tweet_id, targetId: null, label });
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

  // O post desta entrada não existe mais: marca como visto e abre o próximo, sem deixar a tela de carregamento esperando.
  // Se o que sumiu foi só o fim de uma thread (destino do salto), volta à entrada original, sem tentar o salto de novo.
  async function skipUnavailable(status, cur, view) {
    if (view.targetId && status.id === view.targetId) {
      gm.set('nx_view', Object.assign({}, view, { targetId: null, noJump: true }));
      go(cur.url);
      return 'jump';
    }
    await api.views({ seqs: [cur.seq] });
    gm.set('nx_notice', 'Post indisponível (apagado?): pulado');
    const q = await api.queue({ after: cur.seq, limit: 1 });
    if (q.items.length) { await openEntry(q.items[0]); return 'jump'; }
    ui.hideLoading();
    await startFetch();
    return 'jump';
  }

  async function onStatusPage(token, status, st) {
    const cur = st.current;
    const view = gm.get('nx_view', null);
    const openId = cur && (cur.open_id || cur.tweet_id);
    const inQueue = cur && view && view.seq === cur.seq && (status.id === cur.tweet_id || status.id === openId || status.id === view.targetId);
    if (!inQueue) { renderSideBar('Fora da fila', st); return 'out'; }

    const notice = gm.get('nx_notice', null);
    if (notice) gm.set('nx_notice', null);
    renderEntryBar(st, notice);
    const pin = pinTop(8000); // enquanto a tela de carregamento cobre a página
    const stale = () => { pin.stop(); return 'stale'; }; // outra navegação assumiu: para de rolar

    // Espera o post aparecer OU o X avisar que ele não existe mais (apagado, conta suspensa...): nesse caso não adianta esperar.
    await waitFor(() => Xdom.hasStatus(document, status.id) || Xdom.pageMissing(document), 10000, 100);
    if (token !== routeToken) return stale();
    if (!Xdom.hasStatus(document, status.id)) {
      pin.stop();
      if (Xdom.pageMissing(document)) return skipUnavailable(status, cur, view);
      return 'done';
    }
    syncLabels();
    // Em vez de uma pausa fixa, espera a conversa parar de mudar (o X desenha os posts de cima aos poucos).
    await waitSettled(2500, 450);
    if (token !== routeToken) return stale();

    // Abre todo "Mostrar mais" do texto dos posts da página (originais acima, o aberto e as respostas). O X desenha
    // os posts aos poucos, então olha de novo algumas vezes. Cada botão é clicado uma vez só; se um clique levar a
    // outra página, volta e para.
    const clickedMore = new WeakSet();
    for (let round = 0, idle = 0, clicks = 0; round < 12 && idle < 2 && clicks < 40; round++) {
      const btn = Xdom.findTextMoreButtons(document).find((b) => !clickedMore.has(b));
      if (!btn) { idle++; await sleep(250); if (token !== routeToken) return stale(); continue; }
      idle = 0;
      clickedMore.add(btn);
      clicks++;
      const href = location.href;
      btn.click();
      await sleep(300);
      if (token !== routeToken) return stale();
      if (location.href !== href) { history.back(); await sleep(800); break; }
    }

    // Thread: pedaços do mesmo autor encadeados abaixo do post focal -> salta para o último.
    if (!view.targetId && !view.noJump) {
      const pageItems = Xdom.pageItems(document);
      const focal = pageItems.find((i) => i.id === status.id);
      const pick = Core.pickThreadTarget(pageItems, status.id, focal ? focal.author : cur.author);
      if (pick && pick.target.id !== status.id) {
        view.targetId = pick.target.id;
        gm.set('nx_view', view);
        pin.stop();
        go('https://x.com/' + pick.target.author + '/status/' + pick.target.id);
        return 'jump'; // a tela de carregamento continua até a página de destino ficar pronta
      }
    }

    // Tudo o que mexe no que se vê terminou: fixa no topo e revela o post pronto (a conferência da conversa, abaixo,
    // só fala com a API e não muda a tela).
    pin.stop();
    window.scrollTo(0, 0);
    ui.hideLoading();

    // Cobertura: só o que está de fato desenhado na conversa da página.
    //  - pedaços do mesmo autor (thread) e
    //  - TODOS os posts acima do post aberto (resposta -> original), de qualquer autor: um único registro.
    const items = Xdom.pageItems(document);
    const split = Core.splitConversation(items, status.id);
    const own = new Set([cur.tweet_id, openId]);
    const ancestorIds = split.before.map((i) => i.id).filter((id) => !own.has(id));
    const sameAuthorIds = items.map((i) => i.id).filter((id) => !own.has(id));
    if (ancestorIds.length || sameAuthorIds.length) {
      const res = await api.cover({ covered_by: cur.seq, tweet_ids: sameAuthorIds, ancestor_ids: ancestorIds });
      if (token !== routeToken) return stale();
      // Confirma a cobertura provisória do que esta página mostra; o que não aparece volta à fila.
      const st2 = await api.settle({ covered_by: cur.seq, present_ids: items.map((i) => i.id) });
      if (token !== routeToken) return stale();
      if (res.covered > 0 || st2.confirmed > 0 || st2.released > 0) renderEntryBar(await api.state(), notice);
    } else {
      await api.settle({ covered_by: cur.seq, present_ids: [] });
    }
    return 'done';
  }

  // ---------- busca de novas ----------
  async function startFetch(deep) {
    // Sem a lista de contas seguidas (nunca lida), lê primeiro; se falhou há pouco, segue sem ela.
    try {
      const f = await api.following();
      const failedRecently = Date.now() - gm.get('nx_follow_fail_at', 0) < 24 * 3600 * 1000;
      if (!f.last_full_at && !failedRecently && !cfg.bot) return startFollowingRefresh({ then: 'fetch', deep: !!deep });
    } catch (e) { /* sem a lista, a busca ainda funciona (usa o aprendido do feed) */ }
    if (deep) {
      // Fronteira da verificação profunda: o começo da última concluída, no máximo 24 h atrás.
      let boundary = Date.now() - 24 * 3600 * 1000;
      try {
        const last = await api.deepLast('deep');
        if (last.started_at) boundary = Math.max(boundary, new Date(last.started_at).getTime());
      } catch (e) { /* sem a data da última: usa as 24 h */ }
      setPhase('fetching', { deep: true, boundary, startedAt: new Date().toISOString() });
    } else {
      setPhase('fetching', { deep: false });
    }
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
    const ph0 = getPhase();
    const wasMode = ph0.mode || (ph0.deep ? 'deep' : 'normal');
    botDone({ ok: false, error: message });
    setPhase('error');
    try { await api.runFailed(Object.assign(runMeta(wasMode), { error: message.slice(0, 300) })); } catch (e) { /* o histórico é só informativo */ }
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
    const progress = (n, steps) => { beat(); ui.showOverlay({
      title: 'Buscando novas…',
      detail: n + ' posts lidos · passo ' + steps,
      buttons: [{ label: 'Cancelar', onClick: () => { cancelled = true; } }],
    }); };
    progress(0, 0);

    await ensureFeedTab();
    const first = await waitFor(() => Xdom.hasArticles(document) && document.querySelector('article'), 15000);
    if (token !== routeToken) return;
    if (!first) return failFetch('Nenhum post carregou no feed.');
    if (!Xdom.readItems(document).length) return failFetch('Há posts na tela, mas nenhum link de post foi reconhecido.', first);

    const ph = getPhase();
    const deep = !!ph.deep;
    const anchor = await api.anchor(deep ? DEEP_ANCHOR_DEPTH : SCAN.anchorDepth);
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
      // Abre lacunas "Mostrar mais" no meio do feed (e o botão "Ver novos posts"): nada escondido é pulado.
      expand: (click) => {
        const btns = Xdom.findGapButtons(document, window);
        if (click && btns.length) { btns[0].click(); return { found: btns.length, clicked: true }; }
        return { found: btns.length, clicked: false };
      },
      expandTop: () => {
        const pill = Xdom.findNewPostsPill(document);
        if (pill) { pill.click(); return true; }
        return false;
      },
    };
    const base = cfg.bot ? Object.assign({}, SCAN, BOT_SCAN) : SCAN;
    const scan = await Scanner.run(env, deep ? Object.assign({}, base, DEEP_SCAN, { olderThanMs: ph.boundary }) : base, anchor.keys);
    if (token !== routeToken) return;

    if (scan.reason === 'cancelled') {
      setPhase('idle');
      ui.hideOverlay();
      const st = await api.state();
      if (st.current) { await openEntry(st.current); return; }
      return;
    }
    if (!scan.seq.filter((i) => !i.known).length && !anchor.keys.length) return failFetch('A busca terminou sem capturar nenhum post.');

    const res = await api.append({
      items: Core.clusterize(scan.seq).map(Core.toApiItem),
      anchor_found: scan.anchorFound && !scan.gapUnresolved,  // lacuna não aberta = pode haver posts escondidos
      batch_id: Core.newBatchId(),
      // diagnóstico: por que a busca parou (fica na lacuna e no lote, para a causa não precisar ser adivinhada)
      run: deep ? undefined : runMeta('normal'), // a profunda do feed registra a execução com o relatório, logo abaixo
      scan: { reason: scan.reason || 'unknown', steps: scan.steps || 0, collected: scan.seq.length, gap_unresolved: scan.gapUnresolved || 0 },
    });
    if (deep) {
      // Fecha a busca profunda do feed: a fronteira da próxima só avança se este relatório chegar.
      try {
        await api.runReport(Object.assign(runMeta('deep'), {
          started_at: ph.startedAt, created: res.created, updated: res.updated, gap: !!res.gap, reason: scan.reason || null,
          steps: scan.steps || 0, collected: scan.seq.length,
        }));
      } catch (e) { /* o histórico é só informativo */ }
    }
    setPhase('idle');
    if (cfg.bot) {
      // Robô: não abre nada (abrir uma entrada registraria leitura e mexeria na posição). Só informa o resultado.
      botDone({ ok: true, created: res.created, updated: res.updated, gap: !!res.gap, reason: scan.reason, steps: scan.steps, anchor_found: scan.anchorFound });
      return;
    }

    const st = await api.state();
    if (res.created > 0 || res.updated > 0) {
      const parts = [];
      if (res.created > 0) parts.push(res.created + ' novos');
      if (res.updated > 0) parts.push(res.updated + ' com resposta nova');
      gm.set('nx_notice', parts.join(' · ') + (res.gap ? ' · ⚠ pode haver lacuna' : ''));
      ui.hideOverlay();
      // Não avança sozinho: volta para onde você estava e você segue com ▶. Só abre o primeiro novo se ainda não
      // havia nenhuma posição de leitura.
      if (st.current) return openEntry(st.current);
      const q = await api.queue({ after: st.cursor_seq || 0, limit: 1 });
      if (q.items.length) return openEntry(q.items[0]);
    }
    gm.set('nx_notice', 'Você está em dia');
    ui.hideOverlay();
    if (st.current) return openEntry(st.current);
    ui.showOverlay({ title: 'Nada para ler', detail: 'O feed não trouxe posts.', buttons: [{ label: 'Fechar', onClick: ui.hideOverlay }] });
  }

  // ---------- verificação profunda: perfis de quem você segue ----------
  // Depois do feed, a busca profunda abre o perfil de cada conta seguida (aba Posts e aba Respostas) e confere se há
  // posts da conta, feitos DEPOIS da última verificação profunda, que ainda não estão na fila. Para cada aba, para ao achar
  // 5 posts anteriores a essa verificação. Um perfil por página (navegação completa); o andamento fica na fase 'profiles'.
  const profileUrl = (p) => 'https://x.com/' + p.handles[p.i] + (p.tab === 'replies' ? '/with_replies' : '');

  // Verificação dos perfis (a "profunda dos perfis"): não lê o feed, só os perfis de quem você segue.
  async function startProfilesRun() {
    ui.hideOverlay();
    // Fronteira: o começo da última verificação de perfis concluída, no máximo 24 h atrás.
    let boundary = Date.now() - 24 * 3600 * 1000;
    try {
      const last = await api.deepLast('profiles');
      if (last.started_at) boundary = Math.max(boundary, new Date(last.started_at).getTime());
    } catch (e) { /* sem a data da última: usa as 24 h */ }
    let handles = [];
    try {
      const f = await api.following(true);
      handles = (f.accounts || []).map((a) => a.handle).filter(Boolean);
    } catch (e) { /* sem a lista não há o que verificar */ }
    const feedPart = { created: 0, updated: 0, gap: false, reason: null, steps: 0, collected: 0 };
    setPhase('profiles', { deep: true, mode: 'profiles', boundary, startedAt: new Date().toISOString(), handles, i: 0, tab: 'posts', feed: feedPart, done: 0, skipped: 0, pcreated: 0, pupdated: 0, failRun: 0, nav: 0 });
    return advanceProfile(getPhase());
  }

  // Abre o perfil/aba atual (ou encerra se acabaram os perfis).
  function advanceProfile(p) {
    if (p.i >= p.handles.length) return finishDeep(p);
    location.assign(profileUrl(p));
  }

  async function runProfiles(token, p) {
    beat();
    if (p.i >= p.handles.length) return finishDeep(p);
    const handle = p.handles[p.i];
    const here = location.pathname.replace(/\/+$/, '').toLowerCase();
    const want = new URL(profileUrl(p)).pathname.toLowerCase();
    if (here !== want) {
      // Não está na página esperada (o X redirecionou ou a navegação falhou): tenta de novo uma vez, depois pula o perfil.
      if ((p.nav || 0) >= 2) return nextProfile(p, { skipped: true });
      setPhase('profiles', Object.assign({}, p, { nav: (p.nav || 0) + 1 }));
      return advanceProfile(getPhase());
    }
    cancelled = false;
    ui.hideBar();
    ui.showOverlay({
      title: 'Verificação profunda',
      detail: 'Perfil ' + (p.i + 1) + ' de ' + p.handles.length + ': @' + handle + (p.tab === 'replies' ? ' (respostas)' : ' (posts)'),
      buttons: [{ label: 'Cancelar', onClick: () => { cancelled = true; } }],
    });
    try {
      await waitFor(() => { beat(); return document.querySelector('article'); }, 12000); // perfil vazio/privado/suspenso: segue sem posts
      if (token !== routeToken) return;
      const env = {
        readItems: () => Xdom.readItems(document),
        scrollToTop: () => window.scrollTo(0, 0),
        scrollBy: (px) => window.scrollBy(0, px),
        scrollHeight: () => document.documentElement.scrollHeight,
        viewportHeight: () => window.innerHeight,
        atBottom: () => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4,
        sleep, rand,
        isCancelled: () => cancelled || token !== routeToken,
        onStep: beat,
      };
      const r = await Profiles.scan(env, handle, p.boundary);
      if (token !== routeToken) return;
      if (r.reason === 'cancelled') {
        setPhase('idle');
        ui.hideOverlay();
        const st = await api.state();
        if (st.current) await openEntry(st.current);
        return;
      }
      let created = 0;
      let updated = 0;
      if (r.items.length) {
        const res = await api.append({ items: r.items.map(Core.toApiItem), anchor_found: true, batch_id: Core.newBatchId() });
        created = res.created;
        updated = res.updated;
      }
      return nextProfile(p, { created, updated });
    } catch (e) {
      if (token !== routeToken) return;
      if (e && e.status === 401) return handleError(e);
      return nextProfile(p, { skipped: true });
    }
  }

  // Registra o resultado do perfil/aba e abre o seguinte (ou fecha a verificação).
  async function nextProfile(p, r) {
    const q = Object.assign({}, p, { nav: 0, pcreated: p.pcreated + (r.created || 0), pupdated: p.pupdated + (r.updated || 0) });
    q.failRun = r.skipped ? (p.failRun || 0) + 1 : 0;
    if (q.failRun >= PROFILE_MAX_FAILS) {
      setPhase('profiles', q);
      return failFetch('A verificação de perfis falhou: ' + PROFILE_MAX_FAILS + ' perfis seguidos sem leitura.');
    }
    if (r.skipped) { q.skipped = p.skipped + 1; q.tab = 'posts'; q.i = p.i + 1; }       // pula a conta inteira
    else if (p.tab === 'posts') { q.tab = 'replies'; }
    else { q.done = p.done + 1; q.tab = 'posts'; q.i = p.i + 1; }
    setPhase('profiles', q);
    beat();
    await sleep(rand(PROFILE_PAUSE_MS[0], PROFILE_PAUSE_MS[1]));
    beat();
    return advanceProfile(getPhase());
  }

  async function finishDeep(p) {
    const created = p.feed.created + p.pcreated;
    const updated = p.feed.updated + p.pupdated;
    try {
      await api.runReport({
        ...runMeta('profiles'), started_at: p.startedAt,
        created, updated, gap: p.feed.gap, reason: p.feed.reason, steps: p.feed.steps, collected: p.feed.collected,
        profiles_done: p.done, profiles_skipped: p.skipped, profile_created: p.pcreated,
      });
    } catch (e) { /* o histórico é só informativo; a fronteira só avança se o relatório chegar */ }
    setPhase('idle');
    if (cfg.bot) {
      botDone({ ok: true, created, updated, gap: p.feed.gap, reason: p.feed.reason, steps: p.feed.steps, profiles_done: p.done, profiles_skipped: p.skipped, profile_created: p.pcreated });
      return;
    }
    const parts = [];
    if (created > 0) parts.push(created + ' novos' + (p.pcreated ? ' (' + p.pcreated + ' nos perfis)' : ''));
    if (updated > 0) parts.push(updated + ' com resposta nova');
    parts.push(p.done + ' perfis verificados' + (p.skipped ? ' (' + p.skipped + ' sem leitura)' : ''));
    gm.set('nx_notice', 'Perfis: ' + parts.join(' · ') + (p.feed.gap ? ' · ⚠ pode haver lacuna' : ''));
    ui.hideOverlay();
    const st = await api.state();
    if (st.current) return openEntry(st.current);
    return go('https://x.com/home');
  }

  // ---------- contas seguidas ----------
  function followingLabel(st) {
    const f = st && st.following;
    const dirty = gm.get('nx_follow_dirty', false);
    if (!f || !f.last_full_at) return 'Ler contas seguidas (ainda não lidas)';
    const days = Math.floor((Date.now() - new Date(f.last_full_at).getTime()) / 86400000);
    return 'Atualizar contas seguidas (' + f.count + (dirty ? ' · ⚠ pode estar desatualizada' : days >= 30 ? ' · há ' + days + ' dias' : '') + ')';
  }

  function myHandle() {
    // Lê do próprio X (muda se você trocar de conta); o guardado só vale se a página não mostrar o perfil.
    let h = Following.ownHandle(document) || cfg.myHandle;
    if (!h) {
      const v = prompt('Seu usuário no X (sem @), para abrir a lista de quem você segue');
      h = v ? v.trim().replace(/^@/, '') : null;
    }
    if (h && h !== cfg.myHandle) { cfg.myHandle = h; saveCfg(); }
    return h || null;
  }

  function startFollowingRefresh(opts) {
    const h = myHandle();
    if (!h) return;
    setPhase('following', { handle: h, then: opts && opts.then ? opts.then : null, deep: !!(opts && opts.deep), returnTo: location.href });
    if (location.pathname.toLowerCase() === '/' + h.toLowerCase() + '/following') onRoute();
    else go('https://x.com/' + h + '/following');
  }

  function leaveFollowing(phase) {
    if (phase.then === 'fetch') return startFetch(!!phase.deep);
    return go(phase.returnTo && phase.returnTo.indexOf('/following') < 0 ? phase.returnTo : 'https://x.com/home');
  }

  async function failFollowing(message, art) {
    setPhase('error');
    gm.set('nx_follow_fail_at', Date.now());
    const sk = Xdom.skeleton(art || document.querySelector('main') || document.body);
    gm.set('nx_skeleton', sk);
    try {
      await api.skeleton({ page: location.pathname.slice(0, 100), user_agent: navigator.userAgent.slice(0, 300), skeleton: sk, note: ('following: ' + message).slice(0, 500) });
    } catch (e) { /* o esqueleto local já foi guardado */ }
    ui.showOverlay({
      title: '⚠ Não consegui ler as contas seguidas',
      detail: message + ' Copie o esqueleto (sem texto) para eu ajustar. A busca continua funcionando sem a lista.',
      error: true,
      buttons: [
        { label: 'Copiar esqueleto', onClick: copySkeleton },
        { label: 'Voltar', onClick: () => { setPhase('idle'); ui.hideOverlay(); go('https://x.com/home'); } },
      ],
    });
  }

  async function runFollowingScan(token, phase) {
    cancelled = false;
    ui.hideBar();
    const progress = (n) => ui.showOverlay({
      title: 'Atualizando contas seguidas…',
      detail: n + ' contas lidas',
      buttons: [{ label: 'Cancelar', onClick: () => { cancelled = true; } }],
    });
    progress(0);
    const first = await waitFor(() => document.querySelector('[data-testid="UserCell"]'), 15000);
    if (token !== routeToken) return;
    if (!first) return failFollowing('Nenhuma conta apareceu na página de Seguindo.');
    const env = {
      readCells: () => Following.readCells(document),
      scrollToTop: () => window.scrollTo(0, 0),
      scrollBy: (px) => window.scrollBy(0, px),
      viewportHeight: () => window.innerHeight,
      atBottom: () => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4,
      sleep, rand,
      onProgress: progress,
      isCancelled: () => cancelled || token !== routeToken,
    };
    const res = await Following.collect(env);
    if (token !== routeToken) return;
    if (!res.complete) {
      gm.set('nx_follow_fail_at', Date.now());
      setPhase('idle');
      ui.hideOverlay();
      gm.set('nx_notice', res.reason === 'cancelled' ? 'Leitura das contas seguidas cancelada' : 'A leitura das contas seguidas não terminou');
      return leaveFollowing(Object.assign({}, phase, { then: null }));
    }
    const sum = await api.putFollowing({ accounts: res.accounts.map((a) => ({ handle: a.handle, name: a.name || null })) });
    setPhase('idle');
    gm.set('nx_follow_dirty', false);
    gm.set('nx_follow_fail_at', 0);
    gm.set('nx_notice', sum.count + ' contas seguidas atualizadas');
    ui.hideOverlay();
    return leaveFollowing(phase);
  }

  // --- atualização ao vivo: observa o RESULTADO do clique (o botão muda de "seguir" para "seguindo" e vice-versa) ---
  let pendingUnfollow = null;

  function flashNotice(text) {
    if (barState) { barState.notice = text; drawBar(); setTimeout(() => { if (barState && barState.notice === text) { barState.notice = null; drawBar(); } }, NOTICE_MS); }
  }

  async function flushFollowOps() {
    const q = gm.get('nx_follow_ops', []);
    while (q.length) {
      const op = q[0];
      try {
        if (op.op === 'add') await api.followAdd({ handle: op.handle, name: op.name || null });
        else await api.followRemove({ handle: op.handle });
      } catch (e) {
        gm.set('nx_follow_ops', q);
        return;
      }
      q.shift();
    }
    gm.set('nx_follow_ops', q);
  }

  async function queueFollowOp(op) {
    const q = gm.get('nx_follow_ops', []);
    q.push(op);
    gm.set('nx_follow_ops', q.slice(-300));
    await flushFollowOps();
    flashNotice((op.op === 'add' ? 'Seguindo @' : 'Deixou de seguir @') + op.handle + ' (lista atualizada)');
  }

  async function watchFollowChange(info) {
    const changed = await waitFor(() => document.querySelector(Following.oppositeSelector(info.id, info.kind)), 8000, 400);
    if (!changed) return; // confirmação cancelada, erro do X...
    if (!info.handle) {
      gm.set('nx_follow_dirty', true);
      flashNotice('Não identifiquei quem foi (de)seguido — atualize as contas seguidas no menu ⋯');
      return;
    }
    queueFollowOp({ op: info.kind === 'follow' ? 'add' : 'remove', handle: info.handle, name: info.name });
  }

  document.addEventListener('click', (e) => {
    try {
      const btn = Following.buttonOf(e.target);
      if (btn) {
        const info = Following.infoFor(btn, location.pathname);
        if (info.kind === 'unfollow') pendingUnfollow = { info, t: Date.now() };
        watchFollowChange(info);
        return;
      }
      if (e.target.closest && e.target.closest('[data-testid="confirmationSheetConfirm"]') && pendingUnfollow && Date.now() - pendingUnfollow.t < 60000) {
        watchFollowChange(pendingUnfollow.info);
        pendingUnfollow = null;
      }
    } catch (err) { /* nunca atrapalha o clique do X */ }
  }, true);

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

  async function copySkeleton() {
    const sk = gm.get('nx_skeleton', '');
    try { await navigator.clipboard.writeText(sk); alert('Esqueleto copiado (' + sk.length + ' caracteres).'); }
    catch (e) { prompt('Copie o esqueleto:', sk.slice(0, 5000)); }
  }

  // Comando vindo da URL, válido por 2 minutos (uma busca nunca dispara por uma abertura antiga).
  function takeLaunch() {
    const l = gm.get('nx_launch', null);
    if (!l) return null;
    gm.set('nx_launch', null);
    return Date.now() - (l.at || 0) < 2 * 60 * 1000 ? l.cmd : null;
  }

  // ---------- roteamento ----------
  function handleError(e) {
    ui.hideLoading();
    botDone({ ok: false, error: (e && e.message) || 'erro', status: e && e.status });
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
    // Abrindo um post da fila: cobre a página já (antes de falar com a API); em qualquer outra página, descobre.
    if (!cfg.bot && isEntryPath()) ui.showLoading((gm.get('nx_view', null) || {}).label); else ui.hideLoading();
    try {
      if (Xdom.isLoginPath(location.pathname)) { botDone({ ok: false, error: 'sessão do X expirada (tela de login)', login: true }); return; }
      if (!cfg.apiKey && !promptConfig()) return handleError(new Error('Configure a API para começar'));

      const st = await api.state();
      if (token !== routeToken) return;
      feed = st.feed;
      flushFollowOps();
      const cmd = takeLaunch();
      if (cmd) {
        ui.hideOverlay();
        if (cmd === 'update') return await startFetch(false);
        if (cmd === 'deep') return await startFetch(true);
        if (cmd === 'profiles') return await startProfilesRun();
        if (cmd === 'following') return startFollowingRefresh();
        if (cmd === 'read') return await resumeReading();
      }
      const phase = getPhase();
      const feedHere = Core.isFeedPath(feed.url, location.pathname);

      if (phase.name === 'fetching') {
        if (feedHere) return await runFetch(token);
        return renderSideBar('Busca em andamento', st);
      }
      if (phase.name === 'profiles') return await runProfiles(token, phase);
      if (phase.name === 'following') {
        if (location.pathname.toLowerCase() === '/' + String(phase.handle).toLowerCase() + '/following') return await runFollowingScan(token, phase);
        return renderSideBar('Atualização das contas seguidas em andamento', st);
      }
      if (phase.name === 'error') return renderSideBar('Última busca falhou — veja o menu ⋯', st);

      if (cfg.bot) return; // robô: sem comando de busca, não faz nada
      if (feedHere && cfg.autoResume) return await resumeReading();

      const status = Core.parseStatusPath(location.pathname);
      if (status) {
        const r = await onStatusPage(token, status, st);
        if (r !== 'jump' && r !== 'stale') ui.hideLoading();
        return;
      }
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

  // Comando pela URL (atalho do iPhone: https://x.com/home?nx=update): guarda e limpa o parâmetro.
  const launch = Core.parseLaunch(location.search);
  if (launch.cmd || /[?&]nx=/.test(location.search)) {
    history.replaceState(history.state, '', location.pathname + launch.search + location.hash);
    if (launch.cmd) gm.set('nx_launch', { cmd: launch.cmd, at: Date.now() });
  }

  lastHref = location.href;
  applyXBar();
  onRoute();
}

if (typeof window !== 'undefined' && typeof GM_xmlhttpRequest !== 'undefined') {
  startApp().catch((e) => {
    // Sem isto, uma falha ao iniciar deixa a página sem nada e sem pista do motivo.
    try {
      const d = document.createElement('div');
      d.textContent = 'notiXias: erro ao iniciar: ' + (e && e.message ? e.message : e);
      d.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#b00020;color:#fff;padding:8px;font:13px sans-serif;text-align:center';
      document.documentElement.appendChild(d);
    } catch (e2) { /* nada a fazer */ }
  });
}

})();

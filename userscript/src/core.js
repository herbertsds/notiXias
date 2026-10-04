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
      out.push('↻ repostado por ' + reps.map((r) => '@' + r).join(', '));
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
      parts.top.push('↻ repostado por ' + reps.map((r) => '@' + r).join(', '));
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
    return '↻ uma mensagem dessa thread foi repostada por ' + reps.map((r) => '@' + r).join(', ');
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
    pickThreadTarget, splitConversation, buildBadges, buildLabelParts, buildBannerText, isFeedPath, toApiItem, newBatchId,
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Core;

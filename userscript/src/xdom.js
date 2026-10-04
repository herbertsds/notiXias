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
    articles, parseArticle, readItems, pageItems, findDateRow, hasStatus, hasArticles,
    selectTab, skeleton, isLoginPath, findBottomBars, setBottomBarsHidden,
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Xdom;

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
    return {
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
        best = { video: v, share, rect: { top: Math.max(r.top, 0), left: Math.max(r.left, 0), bottom: Math.min(r.bottom, win.innerHeight), right: Math.min(r.right, win.innerWidth) } };
      }
    }
    return best ? { video: best.video, rect: best.rect } : null;
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
    selectTab, skeleton, isLoginPath, findBottomBars, findAppBanners, setBottomBarsHidden, setAges, findTextMoreButtons, visibleVideo, findGapButtons, findNewPostsPill,
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Xdom;

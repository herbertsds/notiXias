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

  // Uma conversa do feed é ligada por uma LINHA VERTICAL entre as fotos de perfil: a célula de cima tem a linha chegando
  // ao fim dela e a de baixo tem um pedaço de linha logo no começo. Posts avulsos (mesmo em sequência, com IDs crescentes,
  // porque o feed não é cronológico) NÃO têm linha. Sem medidas de layout (página oculta, testes) devolve {} = desconhecido.
  // Devolve { linkPrev, linkNext } booleanos.
  function threadLinks(art) {
    const cell = art.closest('[data-testid="cellInnerDiv"]');
    if (!cell || !cell.getBoundingClientRect) return {};
    const win = (cell.ownerDocument && cell.ownerDocument.defaultView) || null;
    const cr = cell.getBoundingClientRect();
    if (!win || !cr.height) return {};
    let linkPrev = false;
    let linkNext = false;
    for (const d of cell.querySelectorAll('div')) {
      const r = d.getBoundingClientRect();
      if (!r.width || r.width > 3 || r.height < 6) continue;
      const bg = win.getComputedStyle(d).backgroundColor;
      if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') continue;
      if (r.top - cr.top <= 2) linkPrev = true;
      if (cr.bottom - r.bottom <= 2) linkNext = true;
    }
    return { linkPrev, linkNext };
  }

  // Posts visíveis, em ordem de DOM.
  function readItems(root) {
    const out = [];
    for (const art of articles(root)) {
      const it = parseArticle(art);
      if (it) out.push(Object.assign(it, threadLinks(art)));
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
  const STATIC_ATTR = 'data-nx-static';
  const HIDE_CSS = '[' + HIDE_ATTR + ']{display:none!important}[' + STATIC_ATTR + ']{position:static!important}';

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

  // ---- barra do topo ("← Post") ----
  // A barra original do X é fixa (`position: fixed/sticky`) e fica POR CIMA do primeiro post. No computador ela mora dentro da
  // coluna principal; no CELULAR ela está numa camada separada, `position: fixed`, FORA da coluna (`TopNavBar`), e o conteúdo
  // começa em y=0, por baixo dela. Por isso: (1) a barra é procurada na página inteira; (2) o maior ancestral fixo/sticky dela é
  // ESCONDIDO inteiro (sem nunca conter posts, a coluna principal ou a barra de baixo); (3) uma barra NOSSA, comum, entra
  // no fluxo, como primeiro filho do conteúdo da coluna, empurrando a conversa para baixo e rolando junto com ela.
  // Garantida uma só (o X recria a original ao redesenhar). Devolve 1 quando criou a nossa.
  const HEADER_ATTR = 'data-nx-header';
  // Sem serifa, como o X: usada se a fonte do título original não puder ser lida.
  const SANS = 'TwitterChirp, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

  function topBarOf(root, win) {
    const marker = root.querySelector('[data-testid="TopNavBar"]') || root.querySelector('[data-testid="app-bar-back"]');
    if (!marker) return null;
    let outer = null; // o maior ancestral fixo/sticky
    let small = null; // sem fixo: o maior ancestral que ainda é uma faixa
    for (let el = marker; el && el.tagName !== 'BODY' && el !== root.documentElement; el = el.parentElement) {
      if (el.hasAttribute(HEADER_ATTR)) return null; // é a nossa
      if (el.querySelector('article, [data-testid="primaryColumn"], nav[role="navigation"], [data-testid="BottomBar"]')) break;
      const pos = win.getComputedStyle(el).position;
      if (pos === 'fixed' || pos === 'sticky') outer = el;
      const h = el.getBoundingClientRect ? el.getBoundingClientRect().height : 0;
      if (h && h <= 90) small = el;
    }
    return { bar: outer || small || marker, marker };
  }

  function setHeaderStatic(root, win) {
    const doc = root.ownerDocument || root;
    const col = root.querySelector('[data-testid="primaryColumn"]');
    if (!col) return 0;
    ensureStyle(doc);
    const found = topBarOf(root, win);
    let own = root.querySelector('[' + HEADER_ATTR + ']');
    let created = 0;
    if (found) {
      found.bar.setAttribute(HIDE_ATTR, '1');
      if (!own) {
        const heading = found.marker.querySelector('h2[role="heading"], [role="heading"]') || found.bar.querySelector('h2[role="heading"], [role="heading"]');
        const title = ((heading && heading.textContent) || '').trim() || 'Post';
        own = doc.createElement('div');
        own.setAttribute(HEADER_ATTR, '1');
        own.innerHTML =
          '<button type="button" aria-label="Voltar" style="all:unset;box-sizing:border-box;display:flex;align-items:center;' +
          'justify-content:center;width:30px;height:30px;border-radius:50%;cursor:pointer;margin-right:14px;flex:none">' +
          '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M7.414 13l5.043 5.04-1.414 1.42L3.586 12l7.457-7.46 1.414 1.42L7.414 11H21v2H7.414z"/></svg></button>' +
          '<span data-nx-title style="font-size:16px;font-weight:700;line-height:20px"></span>';
        own.querySelector('[data-nx-title]').textContent = title;
        own.querySelector('button').addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          win.history.back();
        });
        // Fonte e cor: as do título que o X usava (o <body> não traz a fonte do X: cairia na padrão do navegador, com serifa).
        // Guardadas na própria barra, porque a original fica escondida/some quando o X redesenha.
        const src = heading || found.marker.querySelector('span, div') || col.querySelector('article span');
        if (src) {
          const f = win.getComputedStyle(src);
          if (f.fontFamily) own.setAttribute('data-nx-font', f.fontFamily);
          if (f.color) own.setAttribute('data-nx-color', f.color);
        }
        created = 1;
      }
    }
    if (found) {
      // No celular o X reserva, no fluxo, um bloco VAZIO (<header role="banner"> com um <div style="height: 50px">) do tamanho
      // da barra fixa. Escondida a barra, ele sobraria como uma faixa em branco acima da nossa. Só some se for baixo e não
      // tiver link, botão, navegação nem texto (a barra lateral do computador tem tudo isso e fica como está).
      for (const h of root.querySelectorAll('header[role="banner"]')) {
        const r = h.getBoundingClientRect();
        if (r.height > 70 || h.querySelector('a, button, nav, input, [role="button"], [role="link"]') || h.textContent.trim()) continue;
        h.setAttribute(HIDE_ATTR, '1');
      }
    }
    if (own) {
      // Cores do tema do X (claro/escuro): fundo e texto do próprio <body>. Comum: nada de fixed/sticky.
      const cs = win.getComputedStyle(doc.body);
      const bg = cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' ? cs.backgroundColor : '#000';
      const off = parseFloat(own.getAttribute('data-nx-offset') || '0') || 0; // compensação do topo (medida uma vez, abaixo)
      own.style.cssText =
        (off ? 'margin-top:' + off + 'px;' : '') +
        'display:flex;align-items:center;box-sizing:border-box;position:static;width:100%;min-height:40px;padding:0 12px;' +
        'background:' + bg + ';color:' + (own.getAttribute('data-nx-color') || cs.color || '#e7e9ea') +
        ';border-bottom:1px solid rgba(113,118,123,.35);' +
        'font-family:' + (own.getAttribute('data-nx-font') || SANS);
      // No fluxo, ANTES do conteúdo da coluna: empurra a conversa para baixo (os posts ficam em células absolutas dentro do
      // contêiner da lista, que começa depois da nossa barra).
      const target = col.firstElementChild || col;
      if (own.parentElement !== target || target.firstChild !== own) target.insertBefore(own, target.firstChild);
      // O layout do X às vezes deixa o começo do conteúdo um pouco ACIMA da tela (margem negativa: ~10 px no computador, 1 px
      // no celular), o que cortaria o topo da nossa barra. Com a página no topo, empurra a barra para dentro, uma vez só.
      if (!own.hasAttribute('data-nx-offset') && (win.scrollY || 0) === 0) {
        const top = own.getBoundingClientRect().top;
        const need = top < -0.5 && top > -60 ? Math.ceil(-top) : 0;
        own.setAttribute('data-nx-offset', String(need));
        if (need) own.style.marginTop = need + 'px';
      }
    }
    return created;
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

  // ---- fim do vídeo: não avançar sozinho ----
  // O player do X (visualizador de vídeos no celular) pula para o próximo vídeo quando o evento `ended` dispara. Eventos
  // de mídia não "sobem" (bubble), mas passam por TODOS os ancestrais na fase de captura, e `window` é o primeiro: um ouvinte
  // de captura ali, com stopImmediatePropagation, impede que qualquer ouvinte do X (no próprio <video> ou em ancestrais) o veja.
  // O vídeo só fica parado no último quadro. `isOn()` liga/desliga sem remover. Devolve a função que remove o ouvinte.
  // Sai da tela cheia do vídeo que acabou. Cobre os dois "tela cheia" do iPhone/Safari:
  //  - o player nativo (`video.webkitExitFullscreen()` / `webkitSetPresentationMode('inline')`) e o Fullscreen API normal;
  //  - o visualizador de vídeo do X, uma rota própria (`/usuario/status/ID/video/N`), que se fecha voltando uma página.
  // Devolve true se fez alguma coisa.
  // Rotas do visualizador de vídeo do X (a tela própria, não a página do post): /usuario/status/ID/video/N, e as de modo
  // imersivo. Uma página de post comum (/usuario/status/ID) NUNCA entra aqui.
  const VIEWER_RE = /\/status\/\d+\/video\/\d+|\/immersive|\/i\/videos?(\/|$)/i;

  function leaveFullscreen(video, win) {
    const doc = win.document;
    let did = false;
    try {
      if (video.webkitDisplayingFullscreen && typeof video.webkitExitFullscreen === 'function') {
        video.webkitExitFullscreen();
        did = true;
      }
    } catch (e) { /* segue */ }
    try {
      if (video.webkitPresentationMode === 'fullscreen' && typeof video.webkitSetPresentationMode === 'function') {
        video.webkitSetPresentationMode('inline');
        did = true;
      }
    } catch (e) { /* segue */ }
    try {
      if (doc.fullscreenElement || doc.webkitFullscreenElement) {
        const exit = doc.exitFullscreen || doc.webkitExitFullscreen;
        if (typeof exit === 'function') {
          const p = exit.call(doc);
          if (p && typeof p.catch === 'function') p.catch(() => {});
          did = true;
        }
      }
    } catch (e) { /* segue */ }
    if (!did && win.location && VIEWER_RE.test(win.location.pathname) && win.history) {
      win.history.back();
      did = true;
    }
    return did;
  }

  // Fim de um vídeo (evento `ended`, interceptado em `window` antes de qualquer ouvinte do X):
  //  - `blockOn()`: o X não vê o fim, então não pula para o próximo vídeo; o vídeo só pausa no último quadro;
  //  - `leaveOn()`: sai da tela cheia (ver `leaveFullscreen`).
  // Ambos ligam/desligam sem remover o ouvinte. Devolve a função que o remove.
  function blockEndedAdvance(win, blockOn, leaveOn, onEnded) {
    const handler = (e) => {
      const v = e.target;
      if (!v || v.tagName !== 'VIDEO') return;
      const block = !!(blockOn && blockOn());
      const leave = !!(leaveOn && leaveOn());
      if (block) {
        e.stopImmediatePropagation();
        try { v.pause(); } catch (err) { /* já parado */ }
      }
      let left = false;
      if (leave) left = leaveFullscreen(v, win);
      if (onEnded) {
        try { onEnded(v, { block, leave, left }); } catch (err) { /* o aviso é só informativo */ }
      }
    };
    win.addEventListener('ended', handler, true);
    return () => win.removeEventListener('ended', handler, true);
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

  // Esconde o horário PRÓPRIO do X no cabeçalho (o "· 16 h" depois do @) e o "·" que o precede. Estrutura e nível de
  // aninhamento variam (computador/celular, resposta/post em foco), então: para cada <time> do cabeçalho, sobe até o maior
  // ancestral que ainda NÃO contém o link do @ (o "irmão" do @ na linha) e esconde esse ancestral e o "·" logo antes dele.
  // É refeito a cada passada: o X recria esses elementos ao redesenhar a resposta e o horário voltava, duplicado.
  function hideOwnTime(un) {
    const handleLink = (un.children[1] && un.children[1].querySelector('a[href^="/"]')) || un.querySelector('a[href^="/"]');
    for (const t of un.querySelectorAll('time')) {
      let el = t;
      while (el.parentElement && el.parentElement !== un && !(handleLink && el.parentElement.contains(handleLink))) el = el.parentElement;
      if (el.hasAttribute('data-nx-age') || el === handleLink || (handleLink && el.contains(handleLink))) continue;
      el.setAttribute(HIDE_ATTR, '1');
      const prev = el.previousElementSibling;
      if (prev && prev.textContent.trim() === '·') prev.setAttribute(HIDE_ATTR, '1');
    }
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
      }
      hideOwnTime(un);
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
    articles, parseArticle, readItems, threadLinks, pageItems, findDateRow, hasStatus, hasArticles,
    selectTab, skeleton, isLoginPath, findBottomBars, findAppBanners, setBottomBarsHidden, setAges, findTextMoreButtons, visibleVideo, controlsVisible, applyPlaybackRate, pageMissing, setHeaderStatic, blockEndedAdvance, leaveFullscreen, findGapButtons, findNewPostsPill,
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Xdom;

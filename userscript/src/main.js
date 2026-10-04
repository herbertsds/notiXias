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

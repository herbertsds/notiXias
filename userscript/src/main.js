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
  const SCAN = { initialBackfill: 40, maxSteps: 150, maxCollect: 400, stepDelayMs: [900, 1700], stepFraction: 0.7, anchorDepth: 100, knownRun: 5, minKnown: 25 };
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
    if (p.name === 'following' && age > FETCH_STALE_MS) return { name: 'idle' };
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
      { label: 'Buscar novas (varredura profunda)', onClick: () => startFetch(true) },
      { label: followingLabel(st), onClick: () => startFollowingRefresh() },
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
    await api.putState({ cursor_seq: entry.seq });
    gm.set('nx_view', { seq: entry.seq, tweetId: entry.open_id || entry.tweet_id, targetId: null });
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
    const openId = cur && (cur.open_id || cur.tweet_id);
    const inQueue = cur && view && view.seq === cur.seq && (status.id === cur.tweet_id || status.id === openId || status.id === view.targetId);
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
      const pageItems = Xdom.pageItems(document);
      const focal = pageItems.find((i) => i.id === status.id);
      const pick = Core.pickThreadTarget(pageItems, status.id, focal ? focal.author : cur.author);
      if (pick && pick.target.id !== status.id) {
        view.targetId = pick.target.id;
        gm.set('nx_view', view);
        go('https://x.com/' + pick.target.author + '/status/' + pick.target.id);
        return;
      }
    }

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
      if (token !== routeToken) return;
      // Confirma a cobertura provisória do que esta página mostra; o que não aparece volta à fila.
      const st2 = await api.settle({ covered_by: cur.seq, present_ids: items.map((i) => i.id) });
      if (token !== routeToken) return;
      if (res.covered > 0 || st2.confirmed > 0 || st2.released > 0) renderEntryBar(await api.state(), notice);
    } else {
      await api.settle({ covered_by: cur.seq, present_ids: [] });
    }
  }

  // ---------- busca de novas ----------
  async function startFetch(deep) {
    // Sem a lista de contas seguidas (nunca lida), lê primeiro; se falhou há pouco, segue sem ela.
    try {
      const f = await api.following();
      const failedRecently = Date.now() - gm.get('nx_follow_fail_at', 0) < 24 * 3600 * 1000;
      if (!f.last_full_at && !failedRecently) return startFollowingRefresh({ then: 'fetch', deep: !!deep });
    } catch (e) { /* sem a lista, a busca ainda funciona (usa o aprendido do feed) */ }
    setPhase('fetching', { deep: !!deep });
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
    const deep = !!getPhase().deep;
    const scan = await Scanner.run(env, deep ? Object.assign({}, SCAN, { minKnown: 100, maxSteps: 400, maxCollect: 600 }) : SCAN, anchor.keys);
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
    });
    setPhase('idle');

    const st = await api.state();
    if (res.created > 0 || res.updated > 0) {
      const q = await api.queue({ after: st.cursor_seq || 0, limit: 1 });
      if (q.items.length) {
        const parts = [];
        if (res.created > 0) parts.push(res.created + ' novos');
        if (res.updated > 0) parts.push(res.updated + ' com resposta nova');
        gm.set('nx_notice', parts.join(' · ') + (res.gap ? ' · ⚠ pode haver lacuna' : ''));
        ui.hideOverlay();
        return openEntry(q.items[0]);
      }
    }
    gm.set('nx_notice', 'Você está em dia');
    ui.hideOverlay();
    if (st.current) return openEntry(st.current);
    ui.showOverlay({ title: 'Nada para ler', detail: 'O feed não trouxe posts.', buttons: [{ label: 'Fechar', onClick: ui.hideOverlay }] });
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
      flushFollowOps();
      const phase = getPhase();
      const feedHere = Core.isFeedPath(feed.url, location.pathname);

      if (phase.name === 'fetching') {
        if (feedHere) return await runFetch(token);
        return renderSideBar('Busca em andamento', st);
      }
      if (phase.name === 'following') {
        if (location.pathname.toLowerCase() === '/' + String(phase.handle).toLowerCase() + '/following') return await runFollowingScan(token, phase);
        return renderSideBar('Atualização das contas seguidas em andamento', st);
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

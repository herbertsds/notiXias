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
    .rw.error .s { color: #f4212e; }
    .rw.empty { color: #9aa0a6; text-align: center; border: 0; }
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

    return { renderBar, hideBar, showOverlay, hideOverlay };
  }

  return { create, readWidths };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Ui;

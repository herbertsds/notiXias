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

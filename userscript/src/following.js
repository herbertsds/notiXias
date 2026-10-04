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

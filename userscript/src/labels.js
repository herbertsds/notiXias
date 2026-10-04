// labels: etiquetas injetadas NA página do X.
//  - "label": primeiro filho do post da fila (antes do perfil e da mídia);
//  - "banner": primeiro filho do primeiro post da tela, quando ele NÃO é o post da fila e este foi repostado.
// `sync` é idempotente (só escreve no DOM se algo mudou), para poder rodar a cada mutação sem laços.
const Labels = (function () {
  const X = () => (typeof Xdom !== 'undefined' ? Xdom : require('./xdom.js'));
  const STYLES = {
    label: 'margin:0;padding:8px 14px;font:600 13px/1.4 system-ui,sans-serif;color:#fff;background:#16324a;border-bottom:1px solid #2f3336;',
    banner: 'margin:0;padding:8px 14px;font:600 13px/1.4 system-ui,sans-serif;color:#fff;background:#4a3a16;border-bottom:1px solid #2f3336;',
  };

  function find(art, kind) {
    return Array.from(art.children).find((c) => c.getAttribute && c.getAttribute('data-nx') === kind) || null;
  }

  function ensure(doc, art, kind, lines) {
    const text = lines.join('\n');
    let node = find(art, kind);
    if (node && node.getAttribute('data-nx-text') === text && art.firstChild === node) return false;
    if (node) node.remove();
    node = doc.createElement('div');
    node.setAttribute('data-nx', kind);
    node.setAttribute('data-nx-text', text);
    node.style.cssText = STYLES[kind];
    for (const l of lines) {
      const row = doc.createElement('div');
      row.textContent = l;
      node.append(row);
    }
    art.insertBefore(node, art.firstChild);
    return true;
  }

  function remove(art, kind) {
    const node = find(art, kind);
    if (node) node.remove();
  }

  // model: { tweetId, lines: string[], bannerText: string|null }
  function sync(root, model) {
    const doc = root.ownerDocument || root;
    const arts = X().articles(root);
    const first = arts[0] || null;
    const target = arts.find((a) => {
      const p = X().parseArticle(a);
      return p && p.id === model.tweetId;
    }) || null;

    for (const a of arts) {
      if (a !== target || !model.lines.length) remove(a, 'label');
      if (a !== first || a === target || !model.bannerText) remove(a, 'banner');
    }
    if (target && model.lines.length) ensure(doc, target, 'label', model.lines);
    if (first && first !== target && model.bannerText) ensure(doc, first, 'banner', [model.bannerText]);
    return { label: !!(target && model.lines.length), banner: !!(first && first !== target && model.bannerText) };
  }

  function clear(root) {
    for (const n of Array.from(root.querySelectorAll('[data-nx]'))) n.remove();
  }

  return { sync, clear };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Labels;

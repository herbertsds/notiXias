// labels: linhas de contexto injetadas NA página do X, no estilo do "fulano repostou" nativo
// (texto cinza, discreto, largura inteira, acima do avatar e do nome).
//  - "label": acima do post da fila;
//  - "banner": acima do primeiro post da tela, quando ele NÃO é o post da fila e este foi repostado.
// A faixa é IRMÃ imediatamente anterior ao <article> (os filhos do article do X ficam lado a lado, então
// um filho novo viraria uma coluna). `sync` é idempotente: só escreve no DOM se algo mudou.
const Labels = (function () {
  const X = () => (typeof Xdom !== 'undefined' ? Xdom : require('./xdom.js'));
  const HANDLE_SPLIT = /(@[A-Za-z0-9_]{1,15})/;
  const BOX = 'box-sizing:border-box;width:100%;flex:0 0 100%;padding:6px 16px 0;margin:0;' +
    'font:700 13px/1.4 -apple-system,system-ui,"Segoe UI",sans-serif;color:#71767b;';
  const LINK = 'color:inherit;text-decoration:none;';
  const WARN = 'color:#f0b429;';

  // A faixa fica logo antes do article.
  function find(art, kind) {
    const p = art.previousElementSibling;
    return p && p.getAttribute('data-nx') === kind ? p : null;
  }

  // "@fulano" vira link para o perfil; o resto é texto puro (nunca HTML).
  function fillLine(doc, row, text) {
    for (const part of text.split(HANDLE_SPLIT)) {
      if (!part) continue;
      if (HANDLE_SPLIT.test(part) && part.startsWith('@')) {
        const a = doc.createElement('a');
        a.href = 'https://x.com/' + part.slice(1);
        a.textContent = part;
        a.setAttribute('style', LINK);
        a.addEventListener('mouseenter', () => { a.style.textDecoration = 'underline'; });
        a.addEventListener('mouseleave', () => { a.style.textDecoration = 'none'; });
        row.append(a);
      } else {
        row.append(doc.createTextNode(part));
      }
    }
  }

  function ensure(doc, art, kind, lines) {
    const text = lines.join('\n');
    let node = find(art, kind);
    if (node && node.getAttribute('data-nx-text') === text) return false;
    if (node) node.remove();
    node = doc.createElement('div');
    node.setAttribute('data-nx', kind);
    node.setAttribute('data-nx-text', text);
    node.setAttribute('style', BOX);
    for (const l of lines) {
      const row = doc.createElement('div');
      if (l.startsWith('⚠')) row.setAttribute('style', WARN);
      fillLine(doc, row, l);
      node.append(row);
    }
    art.parentNode.insertBefore(node, art);
    return true;
  }

  function remove(art, kind) {
    const node = find(art, kind);
    if (node) node.remove();
  }

  // model: { tweetId, lines: string[], bannerText: string|null }
  function sync(root, model) {
    const doc = root.ownerDocument || root;
    const arts = X().articles(root).filter((a) => a.parentNode);
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

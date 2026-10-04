// labels: linhas de contexto injetadas NA página do X, no estilo do "fulano repostou" nativo
// (texto cinza, largura inteira), em três posições:
//  - "label":  acima do post da fila (repostado por, thread, lacuna);
//  - "banner": acima do primeiro post da tela, quando ele NÃO é o post da fila e este foi repostado;
//  - "seen":   ("já visto") logo ABAIXO da linha da data do post da fila. Se a página não mostra essa linha
//              (layout compacto), a informação cai para o fim do "label", para nunca se perder.
// "label" e "banner" são IRMÃS imediatamente anteriores ao <article> (os filhos do article do X ficam lado a
// lado, então um filho novo viraria uma coluna). `sync` é idempotente: só escreve no DOM se algo mudou.
const Labels = (function () {
  const X = () => (typeof Xdom !== 'undefined' ? Xdom : require('./xdom.js'));
  const HANDLE_SPLIT = /(@[A-Za-z0-9_]{1,15})/;
  const ICON_SPLIT = /^([^\p{L}\p{N}\s]+)\s+([\s\S]*)$/u;
  const FONT = 'font:600 16px/1.45 -apple-system,system-ui,"Segoe UI",sans-serif;color:#71767b;';
  const BOX = {
    top: 'box-sizing:border-box;width:100%;flex:0 0 100%;padding:12px 16px 14px;margin:0;' + FONT,
    seen: 'box-sizing:border-box;width:100%;padding:8px 0 4px;margin:0;' + FONT,
  };
  const ICON = 'display:inline-block;width:34px;';
  const ICON_SEEN = 'display:inline-block;margin-right:8px;'; // linha abaixo da data: ícone colado ao texto
  const LINK = 'color:inherit;text-decoration:none;';
  const WARN = 'color:#f0b429;';

  function find(art, kind) {
    if (kind === 'seen') return art.querySelector('[data-nx="seen"]');
    const p = art.previousElementSibling;
    return p && p.getAttribute('data-nx') === kind ? p : null;
  }

  // "@fulano" vira link para o perfil; o resto é texto puro (nunca HTML).
  function fillText(doc, parent, text, names) {
    for (const part of text.split(HANDLE_SPLIT)) {
      if (!part) continue;
      if (part.startsWith('@') && HANDLE_SPLIT.test(part)) {
        const a = doc.createElement('a');
        a.href = 'https://x.com/' + part.slice(1);
        a.textContent = (names && names[part.slice(1).toLowerCase()]) || part; // nome de exibição, se conhecido
        a.setAttribute('style', LINK);
        a.addEventListener('mouseenter', () => { a.style.textDecoration = 'underline'; });
        a.addEventListener('mouseleave', () => { a.style.textDecoration = 'none'; });
        parent.append(a);
      } else {
        parent.append(doc.createTextNode(part));
      }
    }
  }

  // Ícone numa coluna própria, com o texto um pouco mais à direita.
  function fillLine(doc, row, text, kind, names) {
    const m = ICON_SPLIT.exec(text);
    if (m) {
      const icon = doc.createElement('span');
      icon.setAttribute('style', kind === 'seen' ? ICON_SEEN : ICON);
      icon.textContent = m[1];
      row.append(icon);
      fillText(doc, row, m[2], names);
    } else {
      fillText(doc, row, text, names);
    }
  }

  function build(doc, kind, lines, names) {
    const node = doc.createElement('div');
    node.setAttribute('data-nx', kind);
    node.setAttribute('data-nx-text', stamp(lines, names));
    node.setAttribute('style', kind === 'seen' ? BOX.seen : BOX.top);
    for (const l of lines) {
      const row = doc.createElement('div');
      if (l.startsWith('⚠')) row.setAttribute('style', WARN);
      fillLine(doc, row, l, kind, names);
      node.append(row);
    }
    return node;
  }

  // Posição correta de cada tipo em relação ao article.
  function placed(art, kind, node, dateRow) {
    if (kind === 'seen') return !!dateRow && dateRow.nextElementSibling === node;
    return art.previousElementSibling === node;
  }

  // Assinatura do conteúdo (texto + nomes): só reescreve o DOM quando algo mudou.
  function stamp(lines, names) {
    return lines.join('\n') + '\u0001' + JSON.stringify(names || {});
  }

  function ensure(doc, art, kind, lines, dateRow, names) {
    const text = stamp(lines, names);
    let node = find(art, kind);
    if (node && node.getAttribute('data-nx-text') === text && placed(art, kind, node, dateRow)) return false;
    if (node) node.remove();
    node = build(doc, kind, lines, names);
    if (kind === 'seen') dateRow.after(node);
    else art.parentNode.insertBefore(node, art);
    return true;
  }

  function remove(art, kind) {
    const node = find(art, kind);
    if (node) node.remove();
  }

  // model: { tweetId, lines: string[] (topo), seen: string|null, bannerText: string|null }
  function sync(root, model) {
    const doc = root.ownerDocument || root;
    const arts = X().articles(root).filter((a) => a.parentNode);
    const first = arts[0] || null;
    const target = arts.find((a) => {
      const p = X().parseArticle(a);
      return p && p.id === model.tweetId;
    }) || null;
    const dateRow = target && model.seen ? X().findDateRow(target) : null;
    const topLines = model.lines.slice();
    if (model.seen && !dateRow) topLines.push(model.seen); // sem linha de data: não perde a informação

    for (const a of arts) {
      if (a !== target || !topLines.length) remove(a, 'label');
      if (a !== target || !dateRow) remove(a, 'seen');
      if (a !== first || a === target || !model.bannerText) remove(a, 'banner');
    }
    if (target && topLines.length) ensure(doc, target, 'label', topLines, null, model.names);
    if (target && dateRow) ensure(doc, target, 'seen', [model.seen], dateRow, model.names);
    if (first && first !== target && model.bannerText) ensure(doc, first, 'banner', [model.bannerText], null, model.names);
    return {
      label: !!(target && topLines.length),
      seen: !!(target && dateRow),
      banner: !!(first && first !== target && model.bannerText),
    };
  }

  function clear(root) {
    for (const n of Array.from(root.querySelectorAll('[data-nx]'))) n.remove();
  }

  return { sync, clear };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Labels;

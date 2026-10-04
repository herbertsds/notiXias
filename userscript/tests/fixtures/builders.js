// HTML SINTÉTICO que imita a estrutura conhecida do X (não é captura real).
// Deve ser substituído/complementado por fixtures reais anonimizadas quando houver acesso ao X.
const SECRET = 'TEXTO-SECRETO-DO-POST';

function article({ id, author, reposter, repostStyle = 'anchor-wraps', quoted, ad = false, pinned = false, text = SECRET }) {
  let ctx = '';
  if (reposter) {
    ctx =
      repostStyle === 'anchor-wraps'
        ? `<a href="/${reposter}" role="link"><span data-testid="socialContext">${reposter} reposted</span></a>`
        : `<div data-testid="socialContext"><a href="/${reposter}"><span>${reposter} reposted</span></a></div>`;
  } else if (pinned) {
    ctx = `<div data-testid="socialContext"><span>Pinned</span></div>`;
  }
  const time = ad
    ? `<span>Ad</span>`
    : `<a href="/${author}/status/${id}" role="link"><time datetime="2026-10-03T21:00:00.000Z">21:00</time></a>`;
  const q = quoted
    ? `<div role="link"><a href="/${quoted.author}/status/${quoted.id}"><time datetime="2026-10-01T10:00:00.000Z">1 out</time></a></div>`
    : '';
  return `<div data-testid="cellInnerDiv"><article data-testid="tweet" role="article">
    ${ctx}
    <div data-testid="User-Name"><a href="/${author}"><span>${author}</span></a></div>
    ${time}
    <div data-testid="tweetText"><span>${text}</span></div>
    <a href="/${author}/status/${id}/photo/1"><img src="x.png"></a>
    ${q}
  </article></div>`;
}

function page(...articles) {
  return `<!doctype html><html><body><main><div role="tablist"><div role="tab" aria-selected="true">Para você</div><div role="tab" aria-selected="false">Seguindo</div></div>${articles.join('\n')}</main></body></html>`;
}

module.exports = { article, page, SECRET };

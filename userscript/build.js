// Concatena src/*.js em um único userscript. Uso: `node build.js` (grava) ou require('./build').bundle() (string).
const fs = require('fs');
const path = require('path');

const ORDER = ['core.js', 'xdom.js', 'labels.js', 'following.js', 'scanner.js', 'api.js', 'ui.js', 'main.js'];
const VERSION = '0.7.4';

const HEADER = `// ==UserScript==
// @name         notiXias
// @namespace    notixias
// @version      ${VERSION}
// @description  Leitor sequencial da timeline do X com posição salva (uso pessoal). v${VERSION}
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM.getValue
// @grant        GM.setValue
// @connect      localhost
// @connect      127.0.0.1
// @connect      notixias.163.176.176.10.nip.io
// ==/UserScript==
`;

function bundle() {
  const parts = ORDER.map((f) => {
    const src = fs.readFileSync(path.join(__dirname, 'src', f), 'utf8');
    return `// ---- ${f} ----\n${src.trimEnd()}\n`;
  });
  return `${HEADER}\n(function () {\n'use strict';\n\n${parts.join('\n')}\n})();\n`.replace(/__NX_VERSION__/g, VERSION);
}

module.exports = { bundle, HEADER, ORDER };

if (require.main === module) {
  const out = path.join(__dirname, 'notixias.user.js');
  fs.writeFileSync(out, bundle());
  console.log('gerado', out);
}

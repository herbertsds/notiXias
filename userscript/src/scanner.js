// scanner: rola o feed e coleta aparições até reencontrar uma âncora. Todo efeito colateral passa por `env`
// (rolagem, leitura do DOM, tempo), o que permite simular um feed nos testes.
const Scanner = (function () {
  const DEFAULTS = {
    initialBackfill: 40,
    maxSteps: 150,
    maxCollect: 400,
    stepDelayMs: [900, 1700],
    stepFraction: 0.7,
    settleMs: 800,
    knownRun: 5, // itens CONHECIDOS seguidos necessários para encerrar...
    minKnown: 25, // ...e total mínimo de conhecidos vistos (cobre conversas que sobem no feed abaixo de uma sequência longa de conhecidos)
    settlePolls: 4, // esperas extras (pollMs) por itens novos quando o X ainda não desenhou nada
    pollMs: 500,
    maxExpand: 40, // cliques máximos em "Mostrar mais" (lacunas) por busca
  };

  // env: { readItems(), scrollToTop(), scrollBy(px), scrollHeight(), viewportHeight(), atBottom(),
  //        sleep(ms), rand(a,b), onProgress(n, steps), isCancelled(),
  //        expand(click)?  -> { found, clicked }  (opcional: com click=true abre UMA lacuna "Mostrar mais" visível;
  //                           com click=false só conta quantas há),
  //        expandTop()? (opcional: clica em "Ver novos posts" antes de começar) }
  //
  // Por que NÃO parar no primeiro item conhecido: o X reagrupa conversas (um post antigo com respostas novas
  // sobe no feed junto delas), então um item conhecido pode aparecer ACIMA de itens novos. A busca só termina
  // depois de `knownRun` itens conhecidos consecutivos E de ter visto `minKnown` conhecidos no total (ou todas as âncoras).
  //
  // Devolve { seq, anchorFound, reason, steps, expanded, gapUnresolved }. `seq` traz todos os itens lidos, do mais novo ao mais antigo,
  // cada um com `known` (já está na fila); os conhecidos servem de contexto para reconhecer conversas.
  async function run(env, options, anchorKeys) {
    const o = Object.assign({}, DEFAULTS, options || {});
    const known = new Set(anchorKeys || []);
    const need = Math.max(1, Math.min(o.knownRun, known.size || 1));
    const needTotal = Math.min(o.minKnown, known.size);
    const seen = new Set();
    const byKey = new Map();
    const seq = [];
    let fresh = 0; // itens novos (desconhecidos)
    let consecutive = 0;
    let knownTotal = 0;
    let anchorFound = false;
    let stagnant = 0;
    let steps = 0;
    let reason = '';
    let expanded = 0;
    let gapUnresolved = 0;

    if (env.expandTop && env.expandTop()) await env.sleep(o.settleMs * 2);
    env.scrollToTop();
    await env.sleep(o.settleMs);

    for (;;) {
      // Cada item novo entra logo abaixo do vizinho que o X mostra acima dele (assim, posts de uma lacuna que
      // acabou de ser aberta ficam NO MEIO, na ordem do feed, e não depois dos que já tinham sido vistos).
      let prev = null;
      for (const it of env.readItems()) {
        if (seen.has(it.key)) {
          prev = byKey.get(it.key);
          continue;
        }
        seen.add(it.key);
        const isKnown = known.has(it.key);
        const obj = Object.assign({}, it, { known: isKnown });
        byKey.set(it.key, obj);
        seq.splice(prev ? seq.indexOf(prev) + 1 : seq.length, 0, obj);
        prev = obj;
        if (isKnown) {
          consecutive++;
          knownTotal++;
        } else {
          consecutive = 0;
          fresh++;
        }
        if (known.size && consecutive >= need && knownTotal >= needTotal) {
          anchorFound = true;
          break;
        }
      }
      env.onProgress(fresh, steps);

      // Lacuna "Mostrar mais" na tela: abre e relê o mesmo trecho antes de rolar (nada é pulado). Passando do limite
      // de cliques, só conta: fica registrado que pode haver posts escondidos.
      if (!anchorFound && env.expand) {
        const ex = env.expand(expanded < o.maxExpand); // { found, clicked }
        if (ex.clicked) {
          expanded++;
          await env.sleep(o.pollMs * 3);
          continue;
        }
        gapUnresolved += ex.found;
      }

      if (anchorFound) { reason = 'anchor'; break; }
      if (env.isCancelled()) { reason = 'cancelled'; break; }
      if (known.size === 0 && fresh >= o.initialBackfill) { reason = 'backfill'; break; }
      if (seq.length >= o.maxCollect) { reason = 'max_collect'; break; }
      if (steps >= o.maxSteps) { reason = 'max_steps'; break; }

      const before = env.scrollHeight();
      env.scrollBy(Math.round(env.viewportHeight() * o.stepFraction));
      await env.sleep(env.rand(o.stepDelayMs[0], o.stepDelayMs[1]));
      // O X às vezes demora a desenhar: espera um pouco antes de seguir (não pula posts sem ler).
      // (inclusive no fim da página: é quando a rolagem infinita carrega mais)
      for (let p = 0; p < o.settlePolls; p++) {
        if (env.readItems().some((it) => !seen.has(it.key))) break;
        await env.sleep(o.pollMs);
      }
      steps++;
      if (env.atBottom() && env.scrollHeight() === before) {
        if (++stagnant >= 3) { reason = 'end'; break; }
      } else {
        stagnant = 0;
      }
    }
    return { seq, anchorFound, reason, steps, expanded, gapUnresolved };
  }

  return { run, DEFAULTS };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Scanner;

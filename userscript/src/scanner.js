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
  };

  // env: { readItems(), scrollToTop(), scrollBy(px), scrollHeight(), viewportHeight(), atBottom(),
  //        sleep(ms), rand(a,b), onProgress(n, steps), isCancelled() }
  // Devolve { seq (do mais novo ao mais antigo), anchorFound, reason, steps }
  async function run(env, options, anchorKeys) {
    const o = Object.assign({}, DEFAULTS, options || {});
    const anchors = new Set(anchorKeys || []);
    const seen = new Set();
    const seq = [];
    let anchorFound = false;
    let stagnant = 0;
    let steps = 0;
    let reason = '';

    env.scrollToTop();
    await env.sleep(o.settleMs);

    for (;;) {
      for (const it of env.readItems()) {
        if (seen.has(it.key)) continue;
        if (anchors.has(it.key)) {
          anchorFound = true;
          break;
        }
        seen.add(it.key);
        seq.push(it);
      }
      env.onProgress(seq.length, steps);

      if (anchorFound) { reason = 'anchor'; break; }
      if (env.isCancelled()) { reason = 'cancelled'; break; }
      if (anchors.size === 0 && seq.length >= o.initialBackfill) { reason = 'backfill'; break; }
      if (seq.length >= o.maxCollect) { reason = 'max_collect'; break; }
      if (steps >= o.maxSteps) { reason = 'max_steps'; break; }

      const before = env.scrollHeight();
      env.scrollBy(Math.round(env.viewportHeight() * o.stepFraction));
      await env.sleep(env.rand(o.stepDelayMs[0], o.stepDelayMs[1]));
      steps++;
      if (env.atBottom() && env.scrollHeight() === before) {
        if (++stagnant >= 3) { reason = 'end'; break; }
      } else {
        stagnant = 0;
      }
    }
    return { seq, anchorFound, reason, steps };
  }

  return { run, DEFAULTS };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Scanner;

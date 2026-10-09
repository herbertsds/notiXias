// api: cliente da API do notiXias. `request` é injetado (GM_xmlhttpRequest no navegador, fake nos testes).
const Api = (function () {
  class ApiError extends Error {
    constructor(status, body, message) {
      super(message || 'API respondeu ' + status);
      this.name = 'ApiError';
      this.status = status;
      this.body = body;
    }
  }

  function qs(params) {
    const parts = [];
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null) continue;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    }
    return parts.length ? '?' + parts.join('&') : '';
  }

  // request({method, url, headers, body}) -> Promise<{status, json}>
  function create({ request, getConfig }) {
    async function call(method, path, { params, body } = {}) {
      const cfg = getConfig();
      const url = cfg.apiBaseUrl.replace(/\/+$/, '') + '/api/v1' + path + qs(params);
      const headers = { Authorization: 'Bearer ' + cfg.apiKey, Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await request({
        method,
        url,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status >= 200 && res.status < 300) return res.json;
      throw new ApiError(res.status, res.json);
    }

    return {
      state: () => call('GET', '/state'),
      putState: (body) => call('PUT', '/state', { body }),
      anchor: (depth) => call('GET', '/queue/anchor', { params: { depth } }),
      append: (body) => call('POST', '/queue/append', { body }),
      runs: (limit) => call('GET', '/runs', { params: { limit } }),
      runFailed: (body) => call('POST', '/runs', { body }),
      runReport: (body) => call('POST', '/runs/report', { body }),
      deepLast: (mode) => call('GET', '/runs/deep-last', { params: { mode } }),
      queue: (params) => call('GET', '/queue', { params }),
      entry: (seq) => call('GET', '/entries/' + seq),
      patchEntry: (seq, body) => call('PATCH', '/entries/' + seq, { body }),
      cover: (body) => call('POST', '/entries/cover', { body }),
      uncover: (body) => call('POST', '/entries/uncover', { body }),
      settle: (body) => call('POST', '/entries/settle', { body }),
      views: (body) => call('POST', '/views', { body }),
      following: (include) => call('GET', '/accounts/following', { params: { include: include ? 'true' : undefined } }),
      putFollowing: (body) => call('PUT', '/accounts/following', { body }),
      followAdd: (body) => call('POST', '/accounts/following/add', { body }),
      followRemove: (body) => call('POST', '/accounts/following/remove', { body }),
      skeleton: (body) => call('POST', '/health/skeleton', { body }),
      exportAll: () => call('GET', '/export'),
    };
  }

  return { create, ApiError };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Api;

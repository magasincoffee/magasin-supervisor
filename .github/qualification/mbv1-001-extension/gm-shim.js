(() => {
  function gmXmlHttpRequest(options = {}) {
    const timeoutMs = Math.max(1, Number(options.timeout || 10000));
    let settled = false;

    const fail = (kind, error) => {
      if (settled) return;
      settled = true;
      if (kind === "timeout" && typeof options.ontimeout === "function") {
        options.ontimeout();
        return;
      }
      if (typeof options.onerror === "function") {
        options.onerror(error || new Error(kind));
      }
    };

    const timer = setTimeout(() => fail("timeout"), timeoutMs + 500);

    chrome.runtime.sendMessage({
      type: "MBV1_GM_REQUEST",
      method: options.method || "GET",
      url: options.url,
      headers: options.headers || {},
      body: options.data == null ? null : options.data,
      timeout: timeoutMs
    }, (response) => {
      clearTimeout(timer);
      if (settled) return;
      if (chrome.runtime.lastError) {
        fail("network", new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response || response.ok !== true) {
        fail("network", new Error(response && response.error ? response.error : "request failed"));
        return;
      }
      settled = true;
      if (typeof options.onload === "function") {
        options.onload({
          status: response.status,
          responseText: response.responseText || ""
        });
      }
    });
  }

  globalThis.GM_xmlhttpRequest = gmXmlHttpRequest;
  globalThis.GM = Object.assign({}, globalThis.GM || {}, {
    xmlHttpRequest: gmXmlHttpRequest
  });
})();

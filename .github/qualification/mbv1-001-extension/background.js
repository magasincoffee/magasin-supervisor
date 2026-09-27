chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "MBV1_GM_REQUEST") return false;

  const controller = new AbortController();
  const timeoutMs = Math.max(1, Number(message.timeout || 10000));
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  fetch(String(message.url || ""), {
    method: String(message.method || "GET"),
    headers: message.headers || {},
    body: message.body == null ? undefined : String(message.body),
    signal: controller.signal
  })
    .then(async (response) => {
      const responseText = await response.text();
      clearTimeout(timer);
      sendResponse({
        ok: true,
        status: response.status,
        responseText
      });
    })
    .catch((error) => {
      clearTimeout(timer);
      sendResponse({
        ok: false,
        error: String(error && error.message ? error.message : error)
      });
    });

  return true;
});

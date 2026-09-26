import test from "node:test";
import assert from "node:assert/strict";

import { ChatGptUiAdapter } from "../src/ui/playwright-adapter.mjs";

function fakePage(url) {
  let closed = false;
  const listeners = new Map();
  return {
    url() { return url; },
    isClosed() { return closed; },
    once(event, handler) { listeners.set(event, handler); },
    closeForTest() {
      closed = true;
      listeners.get("close")?.();
    }
  };
}

test("target recovery creates at most one live recovery tab per logical target", async () => {
  const adapter = new ChatGptUiAdapter({ chromeExecutable: "fake-chrome" });
  adapter.context = { pages: () => [] };

  let creates = 0;
  const recoveryPage = fakePage("https://chatgpt.com/");
  adapter.newChatPage = async () => {
    creates += 1;
    return recoveryPage;
  };

  const first = await adapter.reopenTargetPage("https://chatgpt.com/c/worker-1");
  const second = await adapter.reopenTargetPage("https://chatgpt.com/c/worker-1");

  assert.equal(first, recoveryPage);
  assert.equal(second, recoveryPage);
  assert.equal(creates, 1);
});

test("target recovery reuses an already-open exact target without creating a tab", async () => {
  const adapter = new ChatGptUiAdapter({ chromeExecutable: "fake-chrome" });
  const existing = fakePage("https://chatgpt.com/c/brain");
  adapter.context = { pages: () => [existing] };

  let creates = 0;
  adapter.newChatPage = async () => {
    creates += 1;
    return fakePage("https://chatgpt.com/");
  };

  const page = await adapter.reopenTargetPage("https://chatgpt.com/c/brain");
  assert.equal(page, existing);
  assert.equal(creates, 0);
});

test("closed recovery tab may be recreated once on the next bounded recovery", async () => {
  const adapter = new ChatGptUiAdapter({ chromeExecutable: "fake-chrome" });
  adapter.context = { pages: () => [] };

  let creates = 0;
  const pages = [
    fakePage("https://chatgpt.com/"),
    fakePage("https://chatgpt.com/")
  ];
  adapter.newChatPage = async () => pages[creates++];

  const first = await adapter.reopenTargetPage("https://chatgpt.com/c/worker-2");
  first.closeForTest();
  const second = await adapter.reopenTargetPage("https://chatgpt.com/c/worker-2");

  assert.notEqual(first, second);
  assert.equal(creates, 2);
});


test("CDP adapter contains bounded reconnect logic for a replaced browser context", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/ui/playwright-adapter.mjs", import.meta.url), "utf8")
  );

  assert.match(source, /async reconnectOverCdp\(\)/);
  assert.match(source, /isTransientNavigationError\(error\)/);
  assert.match(source, /await this\.reconnectOverCdp\(\)/);
  assert.match(source, /page = await this\.context\.newPage\(\)/);
});

test("target recovery reuses an open Project route for the same direct conversation id", async () => {
  const adapter = new ChatGptUiAdapter({ chromeExecutable: "fake-chrome" });
  const uuid = "6ab6b646-4804-43ec-99dd-415b1f123456";
  const existing = fakePage(
    `https://chatgpt.com/g/g-p-6ab5e241a9108191b8c17331941aecf5-magasin-webapp/c/${uuid}`
  );
  adapter.context = { pages: () => [existing] };

  let creates = 0;
  adapter.newChatPage = async () => {
    creates += 1;
    return fakePage("https://chatgpt.com/");
  };

  const page = await adapter.reopenTargetPage(`https://chatgpt.com/c/${uuid}`);
  assert.equal(page, existing);
  assert.equal(creates, 0);
});

test("findPageForTarget treats direct and Project routes as the same exact conversation", () => {
  const adapter = new ChatGptUiAdapter({ chromeExecutable: "fake-chrome" });
  const uuid = "6ab6b646-4804-43ec-99dd-415b1f123456";
  const existing = fakePage(`https://chatgpt.com/c/${uuid}`);
  adapter.context = { pages: () => [existing] };

  const target = {
    origin: "https://chatgpt.com",
    pathname: `/g/g-p-project/c/${uuid}`
  };
  assert.equal(adapter.findPageForTarget(target), existing);
});

test("CDP adapter keeps navigation generous but UI actions fail fast", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/ui/playwright-adapter.mjs", import.meta.url), "utf8")
  );

  assert.match(source, /timeoutMs = 60_000/);
  assert.match(source, /actionTimeoutMs = 10_000/);
  assert.match(source, /setDefaultTimeout\(this\.actionTimeoutMs\)/);
  assert.match(source, /setDefaultNavigationTimeout\(this\.timeoutMs\)/);
});


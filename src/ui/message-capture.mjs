import crypto from "node:crypto";

export function digestCapturedResponse(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

export async function captureCompletedAssistantTurn(page) {
  if (!page) throw new TypeError("page is required");

  const captured = await page.evaluate(() => {
    const messages = Array.from(
      document.querySelectorAll("[data-message-author-role]")
    );
    const last = messages.at(-1) || null;
    if (!last || last.getAttribute("data-message-author-role") !== "assistant") {
      return null;
    }

    const text = String(last.innerText || last.textContent || "").trim();
    let turn = 0;
    const turnNode = last.closest("[data-testid^='conversation-turn-']") ||
      last.querySelector("[data-testid^='conversation-turn-']");
    if (turnNode) {
      const match = /^conversation-turn-(\d+)$/.exec(
        String(turnNode.getAttribute("data-testid") || "")
      );
      if (match) turn = Number(match[1]);
    }

    return { text, turn, chars: text.length };
  });

  if (!captured?.text) return null;
  return {
    ...captured,
    digest: digestCapturedResponse(captured.text)
  };
}


export async function captureAssistantTurnDigests(page) {
  if (!page) throw new TypeError("page is required");

  const texts = await page.evaluate(() => Array.from(
    document.querySelectorAll("[data-message-author-role='assistant']")
  ).map((node) => String(node.innerText || node.textContent || "").trim())
    .filter(Boolean));

  return texts.map((text) => digestCapturedResponse(text));
}


export async function captureUserTurnTexts(page) {
  if (!page) throw new TypeError("page is required");

  return page.evaluate(() => Array.from(
    document.querySelectorAll("[data-message-author-role='user']")
  ).map((node) => String(node.innerText || node.textContent || "").trim())
    .filter(Boolean));
}

export async function captureUserTurnDigests(page) {
  const texts = await captureUserTurnTexts(page);
  return texts.map((text) => digestCapturedResponse(text));
}


export async function captureRecentAssistantTurns(page, { limit = 12 } = {}) {
  if (!page) throw new TypeError("page is required");

  const turns = await page.evaluate((maxItems) => {
    const nodes = Array.from(
      document.querySelectorAll("[data-message-author-role='assistant']")
    ).slice(-Math.max(1, Math.min(50, Number(maxItems) || 12)));

    return nodes.map((node) => {
      const text = String(node.innerText || node.textContent || "").trim();
      let turn = 0;
      const turnNode = node.closest("[data-testid^='conversation-turn-']") ||
        node.querySelector("[data-testid^='conversation-turn-']");
      if (turnNode) {
        const match = /^conversation-turn-(\d+)$/.exec(
          String(turnNode.getAttribute("data-testid") || "")
        );
        if (match) turn = Number(match[1]);
      }
      return { text, turn, chars: text.length };
    }).filter((item) => item.text);
  }, limit);

  return turns.map((item) => ({
    ...item,
    digest: digestCapturedResponse(item.text)
  }));
}


export async function captureRecentConversationTurns(page, { limit = 30 } = {}) {
  if (!page) throw new TypeError("page is required");

  const turns = await page.evaluate((maxItems) => {
    const nodes = Array.from(
      document.querySelectorAll("[data-message-author-role]")
    ).slice(-Math.max(1, Math.min(80, Number(maxItems) || 30)));

    return nodes.map((node) => {
      const role = String(node.getAttribute("data-message-author-role") || "").trim();
      const text = String(node.innerText || node.textContent || "").trim();
      let turn = 0;
      const turnNode = node.closest("[data-testid^='conversation-turn-']") ||
        node.querySelector("[data-testid^='conversation-turn-']");
      if (turnNode) {
        const match = /^conversation-turn-(\d+)$/.exec(
          String(turnNode.getAttribute("data-testid") || "")
        );
        if (match) turn = Number(match[1]);
      }
      return { role, text, turn, chars: text.length };
    }).filter((item) => item.role && item.text);
  }, limit);

  return turns.map((item) => ({
    ...item,
    digest: digestCapturedResponse(item.text)
  }));
}


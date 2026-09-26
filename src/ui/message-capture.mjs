import crypto from "node:crypto";

const CHAT_DOM_SELECTORS = Object.freeze({
  legacyRole: "[data-message-author-role]",
  legacyTurn: "[data-testid^='conversation-turn-']",
  modernUser: "main .text-size-chat.whitespace-pre-wrap",
  modernAssistant: "main [class*='MarkdownRoot-']"
});

export function digestCapturedResponse(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

async function captureConversationTurns(page, { limit = 80 } = {}) {
  if (!page) throw new TypeError("page is required");

  const turns = await page.evaluate(({ maxItems, selectors }) => {
    const records = [];
    const seen = new Set();

    const usable = (node) => {
      if (!node) return false;
      const style = getComputedStyle(node);
      return style.display !== "none" && style.visibility !== "hidden";
    };

    const push = (node, role, source) => {
      if (!node || seen.has(node) || !usable(node)) return;
      const normalizedRole = String(role || "").trim();
      if (normalizedRole !== "user" && normalizedRole !== "assistant") return;

      if (source !== "legacy" && node.closest(selectors.legacyRole)) return;
      if (source === "modern-assistant") {
        const ancestor = node.parentElement?.closest(selectors.modernAssistant);
        if (ancestor && ancestor !== node) return;
      }

      const text = String(node.innerText || node.textContent || "").trim();
      if (!text) return;
      seen.add(node);
      records.push({ node, role: normalizedRole, text });
    };

    for (const node of document.querySelectorAll(selectors.legacyRole)) {
      push(
        node,
        String(node.getAttribute("data-message-author-role") || ""),
        "legacy"
      );
    }

    for (const node of document.querySelectorAll(selectors.modernUser)) {
      push(node, "user", "modern-user");
    }

    for (const node of document.querySelectorAll(selectors.modernAssistant)) {
      push(node, "assistant", "modern-assistant");
    }

    records.sort((a, b) => {
      if (a.node === b.node) return 0;
      const relation = a.node.compareDocumentPosition(b.node);
      if (relation & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (relation & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    return records.slice(-Math.max(1, Math.min(120, Number(maxItems) || 80)))
      .map((item, index) => {
        let turn = 0;
        const turnNode =
          item.node.closest(selectors.legacyTurn) ||
          item.node.querySelector?.(selectors.legacyTurn);
        if (turnNode) {
          const match = /^conversation-turn-(\d+)$/.exec(
            String(turnNode.getAttribute("data-testid") || "")
          );
          if (match) turn = Number(match[1]);
        }
        if (!turn) turn = index + 1;
        return {
          role: item.role,
          text: item.text,
          turn,
          chars: item.text.length
        };
      });
  }, {
    maxItems: limit,
    selectors: CHAT_DOM_SELECTORS
  });

  if (!Array.isArray(turns)) return [];
  return turns.map((item) => ({
    ...item,
    digest: digestCapturedResponse(item.text)
  }));
}

export async function captureCompletedAssistantTurn(page) {
  const turns = await captureConversationTurns(page, { limit: 80 });
  const last = turns.at(-1) || null;
  if (!last || last.role !== "assistant" || !last.text) return null;
  return {
    text: last.text,
    turn: Number(last.turn || 0),
    chars: Number(last.chars || last.text.length),
    digest: last.digest
  };
}

export async function captureAssistantTurnDigests(page) {
  const turns = await captureConversationTurns(page, { limit: 120 });
  return turns
    .filter((item) => item.role === "assistant")
    .map((item) => item.digest);
}

export async function captureUserTurnTexts(page) {
  const turns = await captureConversationTurns(page, { limit: 120 });
  return turns
    .filter((item) => item.role === "user")
    .map((item) => item.text);
}

export async function captureUserTurnDigests(page) {
  const turns = await captureConversationTurns(page, { limit: 120 });
  return turns
    .filter((item) => item.role === "user")
    .map((item) => item.digest);
}

export async function captureRecentAssistantTurns(page, { limit = 12 } = {}) {
  const turns = await captureConversationTurns(page, { limit: 120 });
  return turns
    .filter((item) => item.role === "assistant")
    .slice(-Math.max(1, Math.min(50, Number(limit) || 12)));
}

export async function captureRecentConversationTurns(page, { limit = 30 } = {}) {
  const turns = await captureConversationTurns(page, {
    limit: Math.max(1, Math.min(80, Number(limit) || 30))
  });
  return turns.slice(-Math.max(1, Math.min(80, Number(limit) || 30)));
}

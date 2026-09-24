import crypto from "node:crypto";

export function digestCapturedResponse(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

async function captureConversationModel(page, { limit = 80 } = {}) {
  if (!page) throw new TypeError("page is required");

  return page.evaluate((maxItems) => {
    const bounded = Math.max(1, Math.min(120, Number(maxItems) || 80));
    const textOf = (node) =>
      String(node?.innerText || node?.textContent || "").trim();

    const legacyNodes = Array.from(
      document.querySelectorAll("[data-message-author-role]")
    );
    if (legacyNodes.length) {
      return legacyNodes
        .slice(-bounded)
        .map((node) => {
          const role = String(
            node.getAttribute("data-message-author-role") || ""
          ).trim();
          const text = textOf(node);
          let turn = 0;
          const turnNode =
            node.closest("[data-testid^='conversation-turn-']") ||
            node.querySelector("[data-testid^='conversation-turn-']");
          if (turnNode) {
            const match = /^conversation-turn-(\d+)$/.exec(
              String(turnNode.getAttribute("data-testid") || "")
            );
            if (match) turn = Number(match[1]);
          }
          return { role, text, turn, chars: text.length };
        })
        .filter((item) => item.role && item.text);
    }

    // ChatGPT's current browser UI no longer exposes data-message-author-role
    // or conversation-turn-* attributes. The stable thread surface is now
    // organized by data-turn-key. User messages expose data-user-message-bubble;
    // assistant units expose a conversation-role heading plus a selection
    // message container. Keep the legacy path above for compatibility.
    const turns = Array.from(document.querySelectorAll("[data-turn-key]"));
    const records = [];

    turns.forEach((turnNode, turnIndex) => {
      const baseTurn = turnIndex * 2 + 1;
      const userNode = turnNode.querySelector("[data-user-message-bubble]");
      const userText = textOf(userNode);
      if (userText) {
        records.push({
          role: "user",
          text: userText,
          turn: baseTurn,
          chars: userText.length
        });
      }

      const assistantUnits = Array.from(
        turnNode.querySelectorAll("[data-content-search-unit-key]")
      ).filter((unit) =>
        Boolean(unit.querySelector("h4[data-conversation-role]")) &&
        !unit.querySelector("[data-user-message-bubble]")
      );

      assistantUnits.forEach((unit, assistantIndex) => {
        const body =
          unit.querySelector("[data-chatgpt-selection-message-id]") ||
          unit.querySelector("[data-markdown-text-style]") ||
          unit;
        const assistantText = textOf(body);
        if (!assistantText) return;
        records.push({
          role: "assistant",
          text: assistantText,
          turn: baseTurn + 1 + assistantIndex,
          chars: assistantText.length
        });
      });
    });

    return records.slice(-bounded);
  }, limit);
}

export async function captureCompletedAssistantTurn(page) {
  const turns = await captureConversationModel(page, { limit: 80 });
  const last = turns.at(-1) || null;
  if (!last || last.role !== "assistant" || !last.text) return null;
  return {
    text: last.text,
    turn: Number(last.turn || 0),
    chars: Number(last.chars || last.text.length),
    digest: digestCapturedResponse(last.text)
  };
}

export async function captureAssistantTurnDigests(page) {
  const turns = await captureConversationModel(page, { limit: 120 });
  return turns
    .filter((item) => item.role === "assistant" && item.text)
    .map((item) => digestCapturedResponse(item.text));
}

export async function captureUserTurnTexts(page) {
  const turns = await captureConversationModel(page, { limit: 120 });
  return turns
    .filter((item) => item.role === "user" && item.text)
    .map((item) => item.text);
}

export async function captureUserTurnDigests(page) {
  const texts = await captureUserTurnTexts(page);
  return texts.map((text) => digestCapturedResponse(text));
}

export async function captureRecentAssistantTurns(page, { limit = 12 } = {}) {
  const turns = await captureConversationModel(page, { limit: 120 });
  return turns
    .filter((item) => item.role === "assistant" && item.text)
    .slice(-Math.max(1, Math.min(50, Number(limit) || 12)))
    .map((item) => ({
      ...item,
      digest: digestCapturedResponse(item.text)
    }));
}

export async function captureRecentConversationTurns(page, { limit = 30 } = {}) {
  const turns = await captureConversationModel(page, { limit: 120 });
  return turns
    .slice(-Math.max(1, Math.min(80, Number(limit) || 30)))
    .map((item) => ({
      ...item,
      digest: digestCapturedResponse(item.text)
    }));
}

export async function captureCompletedAssistantTurnScreenshot(page, outputPath) {
  if (!page) throw new TypeError("page is required");
  if (typeof outputPath !== "string" || !outputPath.trim()) {
    throw new Error("outputPath is required");
  }

  let locator = page.locator("[data-message-author-role='assistant']").last();
  if (!(await locator.count().catch(() => 0))) {
    locator = page.locator("[data-chatgpt-selection-message-id]").last();
  }
  if (!(await locator.count().catch(() => 0))) {
    throw new Error("completed assistant turn screenshot target is missing");
  }

  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.screenshot({
    path: outputPath,
    type: "png"
  });
  return outputPath;
}

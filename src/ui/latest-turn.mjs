import crypto from "node:crypto";

const SELECTORS = Object.freeze({
  legacyRole: "[data-message-author-role]",
  legacyTurn: "[data-testid^='conversation-turn-']",
  modernUser: "main .text-size-chat.whitespace-pre-wrap",
  modernAssistant: "main [class*='MarkdownRoot-']"
});

function digest(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

export async function captureLatestRoleTurn(page, role) {
  if (!page) throw new TypeError("page is required");
  if (role !== "user" && role !== "assistant") {
    throw new Error("role must be user or assistant");
  }

  const captured = await page.evaluate(({ wantedRole, selectors }) => {
    const visible = (node) => {
      if (!node) return false;
      const style = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return style.display !== "none" &&
        style.visibility !== "hidden" &&
        box.width > 0 &&
        box.height > 0;
    };

    const lastVisible = (selector, predicate = null) => {
      const nodes = document.querySelectorAll(selector);
      for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const node = nodes[index];
        if (!visible(node)) continue;
        if (predicate && !predicate(node)) continue;
        return node;
      }
      return null;
    };

    let node = lastVisible(
      selectors.legacyRole,
      (candidate) =>
        String(candidate.getAttribute("data-message-author-role") || "") ===
        wantedRole
    );

    if (!node) {
      node = lastVisible(
        wantedRole === "user"
          ? selectors.modernUser
          : selectors.modernAssistant
      );
    }
    if (!node) return null;

    const turnContainer = node.closest(selectors.legacyTurn);
    let text = "";
    if (wantedRole === "assistant" && turnContainer) {
      const roots = Array.from(
        turnContainer.querySelectorAll(selectors.modernAssistant)
      ).filter(visible);
      if (roots.length) {
        const fragments = [];
        for (const root of roots) {
          const part = String(root.innerText || root.textContent || "").trim();
          if (!part) continue;
          if (fragments.at(-1) === part) continue;
          fragments.push(part);
        }
        text = fragments.join("\n").trim();
      }
    }

    if (!text) {
      text = String(node.innerText || node.textContent || "").trim();
    }
    if (!text) return null;

    const testId = String(
      turnContainer?.getAttribute("data-testid") || ""
    ).trim();

    return {
      role: wantedRole,
      text,
      turn_id: testId || null
    };
  }, {
    wantedRole: role,
    selectors: SELECTORS
  });

  if (!captured?.text) return null;
  const text = String(captured.text).trim();
  const textDigest = digest(text);
  return {
    role,
    text,
    digest: textDigest,
    turn_id: captured.turn_id || `${role}:${textDigest}`
  };
}

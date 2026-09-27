import crypto from "node:crypto";

const SELECTORS = Object.freeze({
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
      if (!node || !(node instanceof Element)) return false;
      const style = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return style.display !== "none" &&
        style.visibility !== "hidden" &&
        box.width > 0 &&
        box.height > 0;
    };

    const matchesWantedRole = (node) => {
      if (!visible(node)) return false;
      const legacyRole = String(
        node.getAttribute?.("data-message-author-role") || ""
      );
      if (legacyRole) return legacyRole === wantedRole;

      if (wantedRole === "user") {
        return node.matches?.(selectors.modernUser) || false;
      }
      return node.matches?.(selectors.modernAssistant) || false;
    };

    // Reverse-walk from the end of <main> and stop on the first relevant node.
    // This does not materialize or read historical turns on the normal path.
    const root = document.querySelector("main") || document.body;
    let node = root?.lastElementChild || null;
    let found = null;
    while (node && root) {
      if (matchesWantedRole(node)) {
        found = node;
        break;
      }
      if (node.lastElementChild) {
        node = node.lastElementChild;
        continue;
      }
      while (node && node !== root && !node.previousElementSibling) {
        node = node.parentElement;
      }
      if (!node || node === root) break;
      node = node.previousElementSibling;
    }

    if (!found) return null;

    const turnContainer = found.closest(selectors.legacyTurn);
    let text = "";

    // A single current assistant turn may contain multiple Markdown roots.
    // Coalesce only roots inside that one latest turn container.
    if (wantedRole === "assistant" && turnContainer) {
      const roots = Array.from(
        turnContainer.querySelectorAll("[class*='MarkdownRoot-']")
      ).filter(visible);
      if (roots.length) {
        const fragments = [];
        for (const rootNode of roots) {
          const part = String(
            rootNode.innerText || rootNode.textContent || ""
          ).trim();
          if (!part || fragments.at(-1) === part) continue;
          fragments.push(part);
        }
        text = fragments.join("\n").trim();
      }
    }

    if (!text) {
      text = String(found.innerText || found.textContent || "").trim();
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

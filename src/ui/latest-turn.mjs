import crypto from "node:crypto";

const SELECTORS = Object.freeze({
  legacyTurn: "[data-testid^='conversation-turn-']",
  modernUser: "main [data-markdown-text-tone='user-message'], main .rich-text-user-turn",
  modernUserFallback: "main .text-size-chat.whitespace-pre-wrap",
  modernAssistant: "main [data-markdown-text-style='assistant-message']",
  modernAssistantInner: "[data-markdown-text-style='assistant-message']",
  modernAssistantFallback: "main [class*='MarkdownRoot-']"
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

    const excludeComposer = (node) => !(
      node?.matches?.("#prompt-textarea,textarea,[contenteditable='true'],[contenteditable='plaintext-only']") ||
      node?.closest?.("#prompt-textarea")
    );

    const semanticSelector = wantedRole === "user"
      ? selectors.modernUser
      : selectors.modernAssistant;
    const semantic = Array.from(document.querySelectorAll(semanticSelector))
      .filter((node) => visible(node) && excludeComposer(node));

    const legacy = Array.from(
      document.querySelectorAll(`[data-message-author-role="${wantedRole}"]`)
    ).filter((node) => visible(node) && excludeComposer(node));

    let fallback = [];
    if (!semantic.length && !legacy.length) {
      const selector = wantedRole === "user"
        ? selectors.modernUserFallback
        : selectors.modernAssistantFallback;
      fallback = Array.from(document.querySelectorAll(selector))
        .filter((node) => {
          if (!visible(node) || !excludeComposer(node)) return false;
          if (wantedRole === "user") {
            return !node.closest?.("[data-markdown-text-style='assistant-message']");
          }
          return !node.matches?.("[data-markdown-text-tone='user-message'],.rich-text-user-turn") &&
            !node.closest?.("[data-markdown-text-tone='user-message'],.rich-text-user-turn");
        });
    }

    const found = semantic.at(-1) || legacy.at(-1) || fallback.at(-1) || null;
    if (!found) return null;

    const legacyTurn = found.closest(selectors.legacyTurn);
    const selectionContainer = found.closest("[data-chatgpt-selection-message-id]");
    const roleUnit = found.closest(
      `[data-chatgpt-search-unit-key$=":${wantedRole}"],[data-content-search-unit-key$=":${wantedRole}"]`
    );
    const turnKeyContainer = found.closest("[data-turn-key]");
    const turnContainer =
      legacyTurn ||
      selectionContainer ||
      roleUnit ||
      turnKeyContainer ||
      found;

    let text = "";
    if (wantedRole === "assistant") {
      let roots = [];
      if (semantic.length) {
        roots = Array.from(
          turnContainer.querySelectorAll(selectors.modernAssistantInner)
        ).filter(visible);
        if (found.matches?.(selectors.modernAssistantInner) && !roots.includes(found)) {
          roots.push(found);
        }
      } else if (legacyTurn) {
        roots = Array.from(
          legacyTurn.querySelectorAll("[class*='MarkdownRoot-']")
        ).filter((node) =>
          visible(node) &&
          !node.matches?.("[data-markdown-text-tone='user-message'],.rich-text-user-turn")
        );
      }
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
      legacyTurn?.getAttribute("data-testid") || ""
    ).trim();
    const selectionId = String(
      selectionContainer?.getAttribute("data-chatgpt-selection-message-id") || ""
    ).trim();
    const searchIds = String(
      found.closest("[data-chatgpt-search-message-ids]")
        ?.getAttribute("data-chatgpt-search-message-ids") || ""
    ).trim();
    const searchId = searchIds.split(/\s+/u).filter(Boolean)[0] || "";
    const turnKey = String(
      turnKeyContainer?.getAttribute("data-turn-key") || ""
    ).trim();
    const unitKey = String(
      roleUnit?.getAttribute("data-chatgpt-search-unit-key") ||
      roleUnit?.getAttribute("data-content-search-unit-key") ||
      ""
    ).trim();

    return {
      role: wantedRole,
      text,
      turn_id: testId || selectionId || searchId || turnKey || unitKey || null
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


export async function captureAssistantCycleCorrelationEvidence(page, messageId) {
  if (!page) throw new TypeError("page is required");
  const id = String(messageId || "").trim();
  if (!id) {
    return {
      confirmed: false,
      turn_id: null,
      evidence: "missing-message-id",
      match_count: 0
    };
  }
  const marker = `MAGASIN_CYCLE_CORRELATION_V1 ${id}`;
  const result = await page.evaluate(({ wantedMarker, selectors }) => {
    const visible = (node) => {
      if (!node || !(node instanceof Element)) return false;
      const style = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return style.display !== "none" &&
        style.visibility !== "hidden" &&
        box.width > 0 &&
        box.height > 0;
    };
    const nodes = [
      ...document.querySelectorAll(selectors.modernAssistant),
      ...document.querySelectorAll('[data-message-author-role="assistant"]')
    ];
    const matches = new Map();
    for (const node of nodes) {
      if (!visible(node)) continue;
      const text = String(node.innerText || node.textContent || "");
      if (!text.includes(wantedMarker)) continue;

      const legacyTurn = node.closest(selectors.legacyTurn);
      const selection = node.closest("[data-chatgpt-selection-message-id]");
      const searchContainer = node.closest("[data-chatgpt-search-message-ids]");
      const turnKeyContainer = node.closest("[data-turn-key]");
      const roleUnit = node.closest(
        "[data-chatgpt-search-unit-key$=':assistant'],[data-content-search-unit-key$=':assistant']"
      );
      const searchIds = String(
        searchContainer?.getAttribute("data-chatgpt-search-message-ids") || ""
      ).trim();
      const turnId =
        String(legacyTurn?.getAttribute("data-testid") || "").trim() ||
        String(selection?.getAttribute("data-chatgpt-selection-message-id") || "").trim() ||
        searchIds.split(/\s+/u).filter(Boolean)[0] ||
        String(turnKeyContainer?.getAttribute("data-turn-key") || "").trim() ||
        String(roleUnit?.getAttribute("data-chatgpt-search-unit-key") || "").trim() ||
        String(roleUnit?.getAttribute("data-content-search-unit-key") || "").trim() ||
        `assistant-marker-${matches.size}`;

      if (!matches.has(turnId)) {
        matches.set(turnId, {
          turn_id: turnId,
          text
        });
      }
    }
    return {
      matches: Array.from(matches.values())
    };
  }, {
    wantedMarker: marker,
    selectors: SELECTORS
  });

  const matches = Array.isArray(result?.matches) ? result.matches : [];
  if (matches.length !== 1) {
    return {
      confirmed: false,
      turn_id: null,
      evidence: matches.length > 1
        ? "multiple-assistant-cycle-correlations"
        : "assistant-cycle-correlation-not-observed",
      match_count: matches.length
    };
  }
  const turn = matches[0];
  const text = String(turn.text || "").trim();
  return {
    confirmed: true,
    turn_id: turn.turn_id || null,
    evidence: "assistant-cycle-correlation-observed",
    match_count: 1,
    text,
    digest: digest(text)
  };
}
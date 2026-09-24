const NORMALIZE = String.raw`
(text) => (text || "").replace(/\s+/g, " ").trim()
`;

const CONVERSATION_FULL_RE =
  /maximum (?:length|duration)|reached.{0,50}maximum|conversation.{0,60}(?:too long|full|limit|maximum)|chat.{0,50}(?:too long|full|limit|maximum)|start (?:a )?new (?:chat|conversation)|continue.{0,40}(?:new chat|new conversation)|thời lượng tối đa|độ dài tối đa|cuộc trò chuyện.{0,60}(?:quá dài|đầy|giới hạn|tối đa)|đoạn chat.{0,50}(?:quá dài|đầy|giới hạn|tối đa)|đạt.{0,50}(?:giới hạn|tối đa)|bắt đầu.{0,30}(?:đoạn chat|cuộc trò chuyện) mới/i;

const CONVERSATION_MISSING_RE =
  /conversation not found|unable to load conversation|couldn.t load conversation|conversation.{0,20}unavailable|chat not found|chat.{0,20}unavailable|không tìm thấy cuộc trò chuyện|không thể tải cuộc trò chuyện|cuộc trò chuyện.{0,20}không khả dụng|không tìm thấy đoạn chat|không thể tải đoạn chat|đoạn chat.{0,20}không khả dụng/i;
const CONVERSATION_ACCESS_DENIED_RE =
  /(?:you (?:do not|don't) have|no) access.{0,80}(?:conversation|chat)|not authorized.{0,80}(?:conversation|chat)|permission.{0,50}denied.{0,50}(?:conversation|chat)|không có quyền truy cập.{0,80}(?:cuộc trò chuyện|đoạn chat)|không được phép truy cập.{0,80}(?:cuộc trò chuyện|đoạn chat)|đăng nhập đúng tài khoản.{0,120}(?:liên kết chia sẻ|share link)/i;


const MODEL_SWITCHING_RE =
  /switching.{0,30}model|switched.{0,30}model|using.{0,30}(?:different|another) model|continue.{0,30}another model|đang chuyển.{0,30}mô hình|chuyển sang.{0,30}mô hình|đang dùng.{0,30}mô hình khác/i;

const EXPLICIT_RETRY_CONTROL_RE =
  /^(?:try again|retry|thử lại)$/i;

const TRANSIENT_ERROR_ALERT_RE =
  /something went wrong|đã xảy ra lỗi/i;

export function matchesConversationFullText(value) {
  return CONVERSATION_FULL_RE.test(String(value || ""));
}

export function matchesConversationMissingText(value) {
  return CONVERSATION_MISSING_RE.test(String(value || ""));
}

export function matchesConversationAccessDeniedText(value) {
  return CONVERSATION_ACCESS_DENIED_RE.test(String(value || ""));
}

export function matchesModelSwitchingText(value) {
  return MODEL_SWITCHING_RE.test(String(value || ""));
}

export function matchesExplicitRetryControl(value) {
  return EXPLICIT_RETRY_CONTROL_RE.test(String(value || "").trim());
}

export function matchesTransientErrorAlert(value) {
  return TRANSIENT_ERROR_ALERT_RE.test(String(value || ""));
}

export function matchesStopControlMetadata(control = {}) {
  const testId = String(control.testId || "").trim().toLowerCase();
  const text = String(control.text || "").trim().toLowerCase();
  const ariaLabel = String(control.ariaLabel || "").trim().toLowerCase();

  return testId === "stop-button" ||
    /^(?:stop generating|stop response|dừng tạo|dừng phản hồi)$/.test(text) ||
    /^(?:stop generating|stop response|dừng tạo|dừng phản hồi)$/.test(ariaLabel);
}

export async function collectSafeUiSnapshot(page) {
  return page.evaluate(
    ({
      normalizeSource,
      conversationFullPattern,
      conversationMissingPattern,
      conversationAccessDeniedPattern,
      modelSwitchingPattern,
      explicitRetryControlPattern,
      transientErrorAlertPattern
    }) => {
      const normalize = eval(normalizeSource);
      const visible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        return style.display !== "none" &&
          style.visibility !== "hidden" &&
          box.width > 0 &&
          box.height > 0;
      };

      const controls = Array.from(
        document.querySelectorAll("button,a,[role='button'],[role='alert'],[role='status']")
      )
        .filter(visible)
        .slice(0, 160)
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role"),
          text: normalize(el.innerText || el.textContent).slice(0, 120),
          ariaLabel: normalize(el.getAttribute("aria-label")).slice(0, 120),
          title: normalize(el.getAttribute("title")).slice(0, 120),
          testId: el.getAttribute("data-testid") || null,
          disabled:
            Boolean(el.disabled) ||
            el.getAttribute("aria-disabled") === "true"
        }));

      const haystack = controls
        .flatMap((item) => [item.text, item.ariaLabel, item.testId || ""])
        .join(" | ")
        .toLowerCase();

      const nonMessageSurface = Array.from(
        document.querySelectorAll("main [role='alert'],main [role='status'],main p,main div")
      )
        .filter(visible)
        .filter((el) => !el.closest(
          "[data-message-author-role],[data-turn-key],[data-user-message-bubble],[data-content-search-unit-key]"
        ))
        .filter((el) => el.children.length === 0)
        .slice(0, 120)
        .map((el) => normalize(el.innerText || el.textContent).slice(0, 160))
        .filter(Boolean)
        .join(" | ")
        .toLowerCase();

      const recoveryHaystack = `${haystack} | ${nonMessageSurface}`;

      const composer = [
        document.querySelector("#prompt-textarea"),
        ...document.querySelectorAll("textarea,[contenteditable='true']")
      ].find(visible);

      const composerDisabled = Boolean(
        composer && (
          Boolean(composer.disabled) ||
          composer.getAttribute("aria-disabled") === "true" ||
          composer.getAttribute("contenteditable") === "false"
        )
      );
      const composerEnabled = Boolean(composer && !composerDisabled);

      const frames = Array.from(document.querySelectorAll("iframe"))
        .map((el) => String(el.src || "").toLowerCase());

      const path = location.pathname || "";
      const conversationPath =
        /^\/c\//.test(path) ||
        /^\/g\//.test(path) ||
        /^\/project\//.test(path);

      const loginRequired =
        /(^|\W)(log in|login|đăng nhập)(\W|$)/i.test(haystack) &&
        !composer;

      const hasCaptcha =
        frames.some((src) =>
          /turnstile|recaptcha|hcaptcha|challenge/.test(src)
        ) ||
        /verify you are human|xác minh bạn là người|captcha/.test(haystack);

      const legacyAssistantMessages = Array.from(
        document.querySelectorAll("[data-message-author-role='assistant']")
      );
      const legacyUserMessages = Array.from(
        document.querySelectorAll("[data-message-author-role='user']")
      );
      const legacyConversationMessages = Array.from(
        document.querySelectorAll("[data-message-author-role]")
      );

      const modernTurns = Array.from(
        document.querySelectorAll("[data-turn-key]")
      );
      const modernUserMessages = Array.from(
        document.querySelectorAll("[data-user-message-bubble]")
      );
      const modernAssistantMessages = Array.from(
        document.querySelectorAll("[data-chatgpt-selection-message-id]")
      ).filter((node) => {
        const unit = node.closest("[data-content-search-unit-key]");
        return Boolean(unit?.querySelector("h4[data-conversation-role]"));
      });

      const assistantMessages = legacyAssistantMessages.length
        ? legacyAssistantMessages
        : modernAssistantMessages;
      const userMessages = legacyUserMessages.length
        ? legacyUserMessages
        : modernUserMessages;

      let lastMessage = null;
      let lastMessageRole = null;
      if (legacyConversationMessages.length) {
        lastMessage = legacyConversationMessages.at(-1) || null;
        lastMessageRole = lastMessage
          ? String(lastMessage.getAttribute("data-message-author-role") || "")
          : null;
      } else if (modernTurns.length) {
        const lastTurn = modernTurns.at(-1);
        const modernUser = lastTurn.querySelector("[data-user-message-bubble]");
        const assistantCandidates = Array.from(
          lastTurn.querySelectorAll("[data-chatgpt-selection-message-id]")
        ).filter((node) => {
          const unit = node.closest("[data-content-search-unit-key]");
          return Boolean(unit?.querySelector("h4[data-conversation-role]"));
        });
        const modernAssistant = assistantCandidates.at(-1) || null;
        const assistantText = String(
          modernAssistant?.innerText || modernAssistant?.textContent || ""
        ).trim();
        const userText = String(
          modernUser?.innerText || modernUser?.textContent || ""
        ).trim();
        if (modernAssistant && assistantText) {
          lastMessage = modernAssistant;
          lastMessageRole = "assistant";
        } else if (modernUser && userText) {
          lastMessage = modernUser;
          lastMessageRole = "user";
        }
      }

      const lastAssistant = assistantMessages.at(-1) || null;
      const main = document.querySelector("main");
      const mainBusy = Boolean(
        main && (
          main.getAttribute("aria-busy") === "true" ||
          Array.from(main.querySelectorAll(
            "[aria-busy='true'],[data-testid*='loading'],[data-testid*='spinner'],[data-testid*='progress']"
          )).some(visible)
        )
      );
      const assistantBusy = Boolean(
        lastAssistant && (
          lastAssistant.getAttribute("aria-busy") === "true" ||
          Array.from(lastAssistant.querySelectorAll(
            "[aria-busy='true'],[data-testid*='loading'],[data-testid*='spinner']"
          )).some(visible)
        )
      );
      const lastAssistantCharCount = Number(
        (lastAssistant && lastAssistant.textContent && lastAssistant.textContent.length) || 0
      );

      const modelSwitching =
        new RegExp(modelSwitchingPattern, "i").test(recoveryHaystack);

      const hasStopControl = controls.some((control) => {
        const testId = String(control.testId || "").trim().toLowerCase();
        const text = String(control.text || "").trim().toLowerCase();
        const ariaLabel = String(control.ariaLabel || "").trim().toLowerCase();
        return testId === "stop-button" ||
          /^(?:stop generating|stop response|dừng tạo|dừng phản hồi)$/.test(text) ||
          /^(?:stop generating|stop response|dừng tạo|dừng phản hồi)$/.test(ariaLabel);
      });

      const turnOrdinals = Array.from(
        document.querySelectorAll("[data-testid^='conversation-turn-']")
      )
        .map((el) => {
          const value = String(el.getAttribute("data-testid") || "");
          const match = /^conversation-turn-(\d+)$/.exec(value);
          return match ? Number(match[1]) : null;
        })
        .filter((value) => Number.isFinite(value));

      const maxConversationTurnOrdinal = turnOrdinals.length
        ? Math.max(...turnOrdinals)
        : modernTurns.length * 2;

      const responseRunning =
        hasStopControl ||
        mainBusy ||
        assistantBusy ||
        modelSwitching;

      const hasNetworkError =
        /network error|lỗi mạng|connection lost|mất kết nối/.test(haystack);

      const explicitRetryRe = new RegExp(explicitRetryControlPattern, "i");
      const transientAlertRe = new RegExp(transientErrorAlertPattern, "i");

      const hasRetryControl = controls.some((control) => {
        if (control.tag !== "button" && control.role !== "button") return false;
        return [control.text, control.ariaLabel]
          .filter(Boolean)
          .some((value) => explicitRetryRe.test(String(value).trim()));
      });

      const hasTransientError =
        hasRetryControl ||
        controls.some((control) =>
          control.role === "alert" &&
          transientAlertRe.test(`${control.text} ${control.ariaLabel}`)
        );

      const fullRe = new RegExp(conversationFullPattern, "i");
      const conversationFull = fullRe.test(recoveryHaystack);

      const explicitFullLimitUi = controls.some((control) => {
        const semanticSurface = [
          control.text,
          control.ariaLabel,
          control.title,
          control.testId || ""
        ].filter(Boolean).join(" ");
        const structuredRole =
          control.role === "alert" ||
          control.role === "status";
        const capacityTestId =
          /(?:conversation|chat).{0,24}(?:full|limit|capacity|maximum)|(?:full|limit|capacity).{0,24}(?:conversation|chat)/i
            .test(String(control.testId || ""));
        return (structuredRole && fullRe.test(semanticSurface)) || capacityTestId;
      });

      const sendControl = controls.find((control) => {
        const testId = String(control.testId || "").toLowerCase();
        const candidates = [control.text, control.ariaLabel]
          .map((value) => String(value || "").trim())
          .filter(Boolean);
        return testId === "send-button" ||
          candidates.some((value) =>
            /^(?:send|send prompt|gửi|gửi tin nhắn)$/i.test(value)
          );
      }) || null;
      const sendCapacityReason = sendControl
        ? [sendControl.ariaLabel, sendControl.title, sendControl.testId || ""]
            .filter(Boolean)
            .join(" ")
        : "";
      const composerCapacityBlocked = Boolean(
        sendControl?.disabled &&
        fullRe.test(sendCapacityReason)
      );
      const composerGenericBlocked = Boolean(
        composer &&
        (!composerEnabled || Boolean(sendControl?.disabled))
      );

      const conversationMissing =
        new RegExp(conversationMissingPattern, "i").test(recoveryHaystack);

      const conversationAccessDenied =
        new RegExp(conversationAccessDeniedPattern, "i").test(recoveryHaystack);

      return {
        schemaVersion: "1.0",
        urlOrigin: location.origin,
        pathKind: conversationPath ? "conversation" : (path === "/" ? "home" : "other"),
        conversationPath,
        composerReady: Boolean(composer),
        composerPresent: Boolean(composer),
        composerEnabled,
        composerCapacityBlocked,
        composerGenericBlocked,
        capacityExplicitFullUi: explicitFullLimitUi,
        assistantMessageCount: assistantMessages.length,
        lastAssistantCharCount,
        userMessageCount: userMessages.length,
        lastMessageRole,
        lastMessageCharCount: Number(
          (lastMessage && lastMessage.textContent && lastMessage.textContent.length) || 0
        ),
        mainBusy,
        mainTextCharCount: Number(
          (main && main.textContent && main.textContent.length) || 0
        ),
        mainElementCount: Number(
          (main && main.querySelectorAll("*").length) || 0
        ),
        loginRequired,
        hasCaptcha,
        responseRunning,
        hasStopControl,
        maxConversationTurnOrdinal,
        assistantBusy,
        modelSwitching,
        hasNetworkError,
        hasTransientError,
        hasContinueControl:
          /continue generating|tiếp tục tạo|continue response/.test(haystack),
        hasRetryControl,
        conversationFull,
        conversationMissing,
        conversationAccessDenied
      };
    },
    {
      normalizeSource: NORMALIZE,
      conversationFullPattern: CONVERSATION_FULL_RE.source,
      conversationMissingPattern: CONVERSATION_MISSING_RE.source,
      conversationAccessDeniedPattern: CONVERSATION_ACCESS_DENIED_RE.source,
      modelSwitchingPattern: MODEL_SWITCHING_RE.source,
      explicitRetryControlPattern: EXPLICIT_RETRY_CONTROL_RE.source,
      transientErrorAlertPattern: TRANSIENT_ERROR_ALERT_RE.source
    }
  );
}

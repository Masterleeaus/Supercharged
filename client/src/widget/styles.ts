/**
 * Widget styles. Written for this widget. Layout and colour roles follow the core widget (launcher bottom corner,
 * window above it, rounded corners, soft shadow), but no rule is copied. Every colour comes from one CSS variable.
 * The primary colour is checked before it is set, so a bad value falls back to the default.
 */
export const DEFAULT_PRIMARY = "#763ed1";
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export function safePrimary(value: string | undefined | null): string {
  return typeof value === "string" && COLOR_PATTERN.test(value) ? value : DEFAULT_PRIMARY;
}

export const WIDGET_STYLE_ID = "titan-chat-widget-style";

export const WIDGET_CSS = `
#titan-chat-widget, #titan-chat-widget * { box-sizing: border-box; }
#titan-chat-widget {
  position: fixed; bottom: 24px; z-index: 2147483000;
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1c1c1e;
}
#titan-chat-widget.tcw-right { right: 24px; }
#titan-chat-widget.tcw-left { left: 24px; }
.tcw-launcher {
  display: inline-flex; align-items: center; gap: 8px; height: 56px; min-width: 56px; padding: 0 18px;
  border: 0; border-radius: 28px; cursor: pointer; color: #fff; background: var(--tcw-primary);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18); font: inherit; font-weight: 600;
}
.tcw-launcher:focus-visible, .tcw-close:focus-visible, .tcw-send:focus-visible, .tcw-input:focus-visible {
  outline: 3px solid var(--tcw-primary); outline-offset: 2px;
}
.tcw-panel {
  position: absolute; bottom: 72px; width: min(380px, calc(100vw - 32px)); height: min(560px, calc(100vh - 120px));
  display: none; flex-direction: column; overflow: hidden; background: #fff; border-radius: 14px;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.22);
}
#titan-chat-widget.tcw-right .tcw-panel { right: 0; }
#titan-chat-widget.tcw-left .tcw-panel { left: 0; }
#titan-chat-widget[data-open="true"] .tcw-panel { display: flex; }
#titan-chat-widget[data-open="true"] .tcw-launcher { display: none; }
.tcw-header {
  display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px;
  background: var(--tcw-primary); color: #fff;
}
.tcw-title { margin: 0; font-size: 16px; font-weight: 700; }
.tcw-close {
  display: inline-grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 0;
  border-radius: 16px; background: rgba(255, 255, 255, 0.18); color: #fff; cursor: pointer;
}
.tcw-banner { margin: 0; padding: 14px 16px; background: #f5f5f7; color: #3a3a3c; border-bottom: 1px solid #e5e5ea; white-space: pre-wrap; }
.tcw-log {
  flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding: 14px 16px;
}
.tcw-msg { max-width: 82%; padding: 9px 12px; border-radius: 12px; white-space: pre-wrap; word-wrap: break-word; }
.tcw-msg-user { align-self: flex-end; background: var(--tcw-primary); color: #fff; border-bottom-right-radius: 4px; }
.tcw-msg-assistant { align-self: flex-start; background: #f2f2f7; color: #1c1c1e; border-bottom-left-radius: 4px; }
.tcw-msg-error { align-self: center; background: #fdecea; color: #8a1c12; font-size: 13px; }
.tcw-form { display: flex; align-items: flex-end; gap: 8px; padding: 10px 12px; border-top: 1px solid #e5e5ea; }
.tcw-input {
  flex: 1; min-height: 40px; max-height: 120px; padding: 9px 12px; resize: none; border: 1px solid #d1d1d6;
  border-radius: 10px; font: inherit; color: inherit; background: #fff;
}
.tcw-send {
  display: inline-grid; place-items: center; width: 40px; height: 40px; padding: 0; border: 0; border-radius: 10px;
  background: var(--tcw-primary); color: #fff; cursor: pointer;
}
.tcw-send:disabled, .tcw-input:disabled { opacity: 0.55; cursor: default; }
.tcw-hidden { display: none !important; }
@media (max-width: 480px) {
  #titan-chat-widget .tcw-panel { position: fixed; inset: 0; width: 100vw; height: 100vh; border-radius: 0; bottom: 0; }
}
`;

/** Adds the widget's stylesheet once. Creates the element from code, so no server markup runs. */
export function injectWidgetStyles(doc: Document): void {
  if (doc.getElementById(WIDGET_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = WIDGET_STYLE_ID;
  style.textContent = WIDGET_CSS;
  doc.head.append(style);
}

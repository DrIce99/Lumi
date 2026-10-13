// Speech bubble: streamed text typed out progressively, light markdown,
// optional answer buttons (questions such as "can I send a screenshot?").
import type { BubbleChunk, BubbleEnd, BubbleStart } from "../shared/types";

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Just enough markdown for a speech bubble: code blocks, `code`, **bold**, bullet lists. */
export function markdown(src: string): string {
  return src
    .split("```")
    .map((part, i) => {
      if (i % 2 === 1) return `<pre><code>${escapeHtml(part.replace(/^[\w+#-]*\n/, ""))}</code></pre>`;
      return escapeHtml(part)
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .split("\n")
        .map((line) => (/^\s*[-*•]\s+/.test(line) ? `<span class="li">• ${line.replace(/^\s*[-*•]\s+/, "")}</span>` : line))
        .join("\n")
        .replace(/^\n+|\n+$/g, "")
        .replace(/\n/g, "<br>");
    })
    .join("");
}

export interface BubbleHandlers {
  /** The bubble changed size or visibility. */
  relayout(): void;
  clicked(): void;
  choice(bubbleId: number, choice: string): void;
}

export class Bubble {
  private id = 0;
  private target = "";
  private shownChars = 0;
  private ended = false;
  private holdMs = 8000;
  private typing = false;
  private hovering = false;
  private typeTimer: number | undefined;
  private hideTimer: number | undefined;
  private readonly text: HTMLElement;
  private readonly choices: HTMLElement;

  constructor(
    readonly el: HTMLElement,
    private readonly handlers: BubbleHandlers,
  ) {
    this.text = el.querySelector(".bubble-text") as HTMLElement;
    this.choices = el.querySelector(".bubble-choices") as HTMLElement;
    (el.querySelector(".bubble-close") as HTMLButtonElement).addEventListener("click", () => this.hide());
    el.addEventListener("mouseenter", () => {
      this.hovering = true;
      window.clearTimeout(this.hideTimer);
    });
    el.addEventListener("mouseleave", () => {
      this.hovering = false;
      if (this.ended && !this.typing && !this.el.hidden && this.choices.hidden) this.scheduleHide(4000);
    });
    this.text.addEventListener("click", () => {
      if (!window.getSelection()?.toString()) handlers.clicked();
    });
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  start({ id, kind }: BubbleStart): void {
    this.id = id;
    this.target = "";
    this.shownChars = 0;
    this.ended = false;
    window.clearTimeout(this.hideTimer);
    this.el.className = `bubble ${kind}`;
    this.text.innerHTML = "";
    this.choices.hidden = true;
    this.choices.replaceChildren();
    this.el.hidden = false;
    this.handlers.relayout();
  }

  chunk({ id, text }: BubbleChunk): void {
    if (id !== this.id) return;
    this.target += text;
    this.startTyping();
  }

  end({ id, finalText, holdMs, choices }: BubbleEnd): void {
    if (id !== this.id) return;
    if (!finalText.startsWith(this.target.slice(0, this.shownChars))) this.shownChars = 0;
    this.target = finalText;
    this.ended = true;
    this.holdMs = holdMs;
    if (choices?.length) {
      this.choices.replaceChildren(
        ...choices.map((c, i) => {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = c.label;
          if (i > 0) button.className = "secondary";
          button.addEventListener("click", () => {
            this.handlers.choice(id, c.id);
            this.hide();
          });
          return button;
        }),
      );
      this.choices.hidden = false;
    }
    this.startTyping();
  }

  hide(): void {
    window.clearTimeout(this.hideTimer);
    window.clearInterval(this.typeTimer);
    this.typeTimer = undefined;
    this.typing = false;
    this.el.hidden = true;
    this.handlers.relayout();
  }

  private render(text: string): void {
    this.text.innerHTML = markdown(text);
    this.text.scrollTop = this.text.scrollHeight;
    this.handlers.relayout();
  }

  private startTyping(): void {
    if (this.typeTimer !== undefined) return;
    this.typeTimer = window.setInterval(() => {
      if (this.shownChars < this.target.length) {
        this.shownChars = Math.min(this.target.length, this.shownChars + Math.max(1, Math.ceil((this.target.length - this.shownChars) / 30)));
        this.typing = true;
        this.render(this.target.slice(0, this.shownChars));
        return;
      }
      this.typing = false;
      window.clearInterval(this.typeTimer);
      this.typeTimer = undefined;
      // Questions wait for an answer; other bubbles fade after a while
      if (this.ended && this.choices.hidden) this.scheduleHide(this.holdMs);
      else if (this.ended) this.scheduleHide(Math.max(this.holdMs, 60_000));
    }, 28);
  }

  private scheduleHide(ms: number): void {
    window.clearTimeout(this.hideTimer);
    if (!this.hovering) this.hideTimer = window.setTimeout(() => this.hide(), ms);
  }
}

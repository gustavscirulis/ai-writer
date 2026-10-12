import { beforeEach, expect, test, vi } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://localhost${path}`,
}));
vi.mock("@/hooks/feedback-api", () => ({
  clearAttachmentHighlight: vi.fn(),
  highlightAttachment: vi.fn(),
  revealAttachment: vi.fn(),
}));

import { openUrl } from "@tauri-apps/plugin-opener";
import { MarkdownReply } from "../../src/components/claude-panel/markdown-reply";
import { openReplyLink, replyUrl } from "../../src/components/claude-panel/markdown-links";
import { AssistantTurn, UserMessage } from "../../src/components/claude-panel/chat-message";
import type { ChatMessage } from "../../src/lib/claude-stream";

const render = (text: string, id = "reply") =>
  renderToStaticMarkup(createElement(MarkdownReply, { id, text }));
beforeEach(() => vi.resetAllMocks());

test("replies render headings, emphasis, quotes, nested lists, links and code", () => {
  const html = render(
    "# Summary\n\n**Bold**, *italic* and `inline`.\n\n> Quoted\n\n1. First\n   - Nested\n2. Second\n\n[Read more](https://example.com/docs)\n\n```ts\nconst value = 1;\n```\n",
  );
  for (const element of [
    "<h1>Summary</h1>",
    "<strong>Bold</strong>",
    "<em>italic</em>",
    "<code>inline</code>",
    "<blockquote>",
    "<ol>",
    "<ul>",
    "Nested",
    "const value = 1;",
  ])
    expect(html).toContain(element);
  expect(html).toContain('href="https://example.com/docs"');
  expect(html).toContain('target="_blank"');
  expect(html).toContain('role="region" aria-label="Code block"');
  expect(html).toContain('tabindex="0"');
});

test("GFM tables, tasks, strikethrough and bare URLs render", () => {
  const html = render(
    "~~Old~~\n\n- [x] Done\n- [ ] Next\n\nhttps://example.com\n\n| Item | Count |\n| --- | ---: |\n| Word | 2 |\n",
  );
  expect(html).toContain("<del>Old</del>");
  expect(html).toContain('type="checkbox"');
  expect(html).toContain('checked=""');
  expect(html).toContain('disabled=""');
  expect(html).toContain('href="https://example.com/"');
  expect(html).toContain('role="region" aria-label="Table"');
  expect(html).toContain("<table>");
  expect(html).toContain('style="text-align:right"');
});

test("every streamed prefix stays renderable; incomplete code fences preserve their content", () => {
  const text = "# Summary\n\n**Clear** text.\n\n```ts\nconst value = 1;\n```\n\nDone.";
  for (let end = 0; end <= text.length; end++)
    expect(() => render(text.slice(0, end))).not.toThrow();
  const partial = render(text.slice(0, text.lastIndexOf("```")));
  expect(partial).toContain("<strong>Clear</strong>");
  expect(partial).toContain("const value = 1;");
  const complete = render(text);
  expect(complete).toContain("<p>Done.</p>");
});

test("raw HTML and dangerous destinations never become executable markup", () => {
  const html = render(
    '[Unsafe](javascript:alert%281%29)\n\n[Data](data:text/html,test)\n\n[Relative](note.md)\n\n<img src="x" onerror="alert(1)">\n\n<script>alert(1)</script>\n\nSafe',
  );
  expect(html).toContain("<span>Unsafe</span>");
  expect(html).toContain("<span>Relative</span>");
  expect(html).toContain("<p>Safe</p>");
  expect(html).not.toMatch(/<script|<img|onerror|javascript:|data:text/);
  expect(render("```html\n<script>alert(1)</script>\n```")).toContain("&lt;script&gt;");
});

test("images use only web destinations and preserve alt text for unsupported sources", () => {
  expect(render("![Preview](https://example.com/image.png)")).toContain(
    'src="https://example.com/image.png" alt="Preview"',
  );
  const invalid = render("![Local](file:///private/image.png) ![Email](mailto:hello@example.com)");
  expect(invalid).toContain("<span>Local</span>");
  expect(invalid).toContain("<span>Email</span>");
  expect(invalid).not.toContain("<img");
});

test("footnote targets, backlinks and descriptions are isolated per message", () => {
  const text = "A note[^1].\n\n[^1]: Footnote text.";
  const html = render(text, "first") + render(text, "second");
  for (const id of ["first", "second"]) {
    expect(html).toContain(`href="#chat-${id}-fn-1"`);
    expect(html).toContain(`id="chat-${id}-fn-1"`);
    expect(html).toContain(`href="#chat-${id}-fnref-1"`);
    expect(html).toContain(`id="chat-${id}-footnote-label"`);
    expect(html).toContain(`aria-describedby="chat-${id}-footnote-label"`);
  }
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  expect(new Set(ids).size).toBe(ids.length);
});

test("assistant integration renders every text step as Markdown while user text stays literal", () => {
  const first: ChatMessage = { id: "one", role: "assistant", text: "**First**", tools: [] };
  const second: ChatMessage = { id: "two", role: "assistant", text: "## Second", tools: [] };
  const html = renderToStaticMarkup(
    createElement(AssistantTurn, { messages: [first, second], live: true }),
  );
  expect(html).toContain("<strong>First</strong>");
  expect(html).toContain("<h2>Second</h2>");
  const user = renderToStaticMarkup(
    createElement(UserMessage, { message: { ...first, role: "user" }, path: null }),
  );
  expect(user).toContain("**First**");
  expect(user).not.toContain("<strong>");
});

test("assistant turn keeps tool summaries in chronological order between text steps", () => {
  const tool = (id: string) => ({ id, name: "Write", done: true });
  const messages: ChatMessage[] = [
    { id: "a", role: "assistant", text: "Alpha", tools: [tool("t1")] },
    { id: "b", role: "assistant", text: "", tools: [tool("t2")] },
    { id: "c", role: "assistant", text: "Bravo", tools: [] },
    { id: "d", role: "assistant", text: "", tools: [tool("t3")] },
  ];
  const html = renderToStaticMarkup(createElement(AssistantTurn, { messages, live: false }));
  const order = [...html.matchAll(/Alpha|Bravo|tabular-nums">(\d+)</g)].map(
    (match) => match[1] ?? match[0],
  );
  expect(order).toEqual(["Alpha", "2", "Bravo", "1"]);
});

test.each([
  "javascript:alert(1)",
  "java\nscript:alert(1)",
  "data:text/html,test",
  "file:///tmp/note",
  "note.md",
  "//example.com",
])("URL transform rejects %s", (value) => {
  expect(replyUrl(value)).toBe("");
});

test("web links open through the system opener and prevent webview navigation", async () => {
  const event = { preventDefault: vi.fn() };
  expect(await openReplyLink(event, "https://example.com/docs")).toBeNull();
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(openUrl).toHaveBeenCalledWith("https://example.com/docs");
  expect(replyUrl("mailto:hello@example.com")).toBe("mailto:hello@example.com");
});

test("opener failures become visible error text; fragments stay native and unsafe URLs never open", async () => {
  vi.mocked(openUrl).mockRejectedValueOnce(new Error("Unavailable"));
  const event = { preventDefault: vi.fn() };
  expect(await openReplyLink(event, "https://example.com")).toBe(
    "Could not open link: Unavailable",
  );
  vi.clearAllMocks();
  expect(await openReplyLink(event, "#chat-reply-fn-1")).toBeNull();
  expect(event.preventDefault).not.toHaveBeenCalled();
  expect(openUrl).not.toHaveBeenCalled();
  expect(await openReplyLink(event, "javascript:alert(1)")).toBeNull();
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(openUrl).not.toHaveBeenCalled();
});

test("user messages show their attached files, with thumbnails for images", () => {
  const html = renderToStaticMarkup(
    createElement(UserMessage, {
      message: {
        id: "files",
        role: "user",
        text: "Compare these",
        tools: [],
        files: ["/Users/me/Downloads/diagram.png", "/Users/me/report.pdf"],
      },
      path: null,
    }),
  );
  expect(html).toContain('aria-label="Attached files"');
  expect(html).toContain('src="asset://localhost/Users/me/Downloads/diagram.png"');
  expect(html).toContain("diagram.png");
  expect(html).toContain("report.pdf");
  expect(html).toContain('title="/Users/me/report.pdf"');
});

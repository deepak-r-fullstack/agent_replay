import { applyPromptEdit, applyReplacements, chatRequestFrom, editablePromptOf } from "../src/services/forks/forkText";
import { completeChat, isLlmConfigured, llmDescription } from "../src/services/llm/llmClient";
import { demoReply } from "../src/services/llm/demoProvider";
import { isAllowedLinkUrl } from "../src/utils/externalRef";

// The small pieces forks are built from, tested without a database.

const chat = (messages: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ model: "gpt-4o-mini", ...extra, messages });

describe("reading and changing what an AI step was asked", () => {
  it("shows the last thing the user said, or the whole text for a step recorded by hand", () => {
    expect(editablePromptOf(chat([{ role: "user", content: "first" }, { role: "assistant", content: "ok" }, { role: "user", content: "second" }]))).toBe("second");
    expect(editablePromptOf("Just a plain question")).toBe("Just a plain question");
    expect(editablePromptOf('{"not":"a chat"}')).toBe('{"not":"a chat"}');
    expect(editablePromptOf('{"messages":[{"role":"user","content":"cut off in the mid')).toContain("cut off");
    expect(editablePromptOf(chat([]))).toBe("");
  });

  it("falls back to the last message when nobody is marked as the user, and writes non-text content as text", () => {
    expect(editablePromptOf(chat([{ role: "assistant", content: "only me" }]))).toBe("only me");
    expect(editablePromptOf(chat([{ role: "user", content: [{ type: "text", text: "blocks" }] }]))).toContain("blocks");
  });

  it("puts a new prompt in the last user message and keeps everything else as it was", () => {
    const input = chat([{ role: "user", content: "first" }, { role: "assistant", content: "ok" }, { role: "user", content: "second" }], { system: "Be kind" });
    const edited = JSON.parse(applyPromptEdit(input, "changed"));
    expect(edited.system).toBe("Be kind");
    expect(edited.model).toBe("gpt-4o-mini");
    expect(edited.messages).toEqual([{ role: "user", content: "first" }, { role: "assistant", content: "ok" }, { role: "user", content: "changed" }]);
  });

  it("replaces the whole input for steps that are plain text", () => {
    expect(applyPromptEdit("old question", "new question")).toBe("new question");
    expect(applyPromptEdit(chat([]), "new question")).toBe("new question");
  });
});

describe("carrying a changed answer into later steps", () => {
  const replacement = { from: "Your refund is 1800 rupees.", to: "Your refund is 2400 rupees." };

  it("swaps text that was quoted word for word, in plain text and inside chat messages", () => {
    expect(applyReplacements(`Email: ${replacement.from} Bye`, [replacement])).toBe(`Email: ${replacement.to} Bye`);
    const input = chat([{ role: "user", content: `Rewrite this: ${replacement.from}` }], { system: `Context: ${replacement.from}` });
    const result = JSON.parse(applyReplacements(input, [replacement]));
    expect(result.messages[0].content).toBe(`Rewrite this: ${replacement.to}`);
    expect(result.system).toBe(`Context: ${replacement.to}`);
  });

  it("finds text with line breaks and quotes in it, which look different once saved as JSON", () => {
    const old = 'Line one.\nShe said "hello" there.';
    const input = chat([{ role: "user", content: `Quote: ${old}` }]);
    expect(JSON.parse(applyReplacements(input, [{ from: old, to: "NEW TEXT HERE" }])).messages[0].content).toBe("Quote: NEW TEXT HERE");
  });

  it("leaves everything alone when there is nothing to swap, or the old text is too short to match safely", () => {
    expect(applyReplacements("nothing here", [replacement])).toBe("nothing here");
    expect(applyReplacements("ok then", [{ from: "ok", to: "fine" }])).toBe("ok then");
    expect(applyReplacements("same", [{ from: "same same same", to: "same same same" }])).toBe("same");
    expect(applyReplacements("anything", [])).toBe("anything");
  });

  it("applies several swaps in order", () => {
    const result = applyReplacements("alpha-alpha then beta-beta", [{ from: "alpha-alpha", to: "gamma-gamma" }, { from: "beta-beta", to: "delta-delta" }]);
    expect(result).toBe("gamma-gamma then delta-delta");
  });
});

describe("what is sent to the AI model", () => {
  it("sends the system text and the conversation, folding any system message into the system text", () => {
    const request = chatRequestFrom(chat([{ role: "system", content: "Extra rule" }, { role: "user", content: "Hi" }, { role: "assistant", content: "Hello" }], { system: "Be kind" }));
    expect(request.system).toBe("Be kind\n\nExtra rule");
    expect(request.messages).toEqual([{ role: "user", content: "Hi" }, { role: "assistant", content: "Hello" }]);
  });

  it("sends plain text as one user message, and never sends nothing", () => {
    expect(chatRequestFrom("Plain question")).toEqual({ messages: [{ role: "user", content: "Plain question" }] });
    expect(chatRequestFrom(chat([], { system: "Only a system text" })).messages).toEqual([{ role: "user", content: "Only a system text" }]);
  });
});

describe("the scripted demo model", () => {
  it("knows the refund story and always answers the same way", () => {
    const right = demoReply("Refund for order 1042. Order data: order 1042, total ₹2,400.");
    expect(right).toContain("order 1042 is ₹2,400");
    expect(demoReply("Refund for order 1042. Order data: order 1042, total ₹2,400.")).toBe(right);
    expect(demoReply("Refund for order 1042. Order data: order 1041, total ₹1800.")).toContain("order 1041 is ₹1,800");
    expect(demoReply("Please summarise this chat")).toMatch(/^Summary:/);
    expect(demoReply("What is the weather?")).toMatch(/scripted demo answer/);
  });

  it("answers through the same client the real providers use, with token counts and no cost", async () => {
    expect(isLlmConfigured()).toBe(true);
    expect(llmDescription()).toMatchObject({ provider: "demo", configured: true });
    const result = await completeChat({ model: "gpt-4o-mini", messages: [{ role: "user", content: "Refund for order 1042, total ₹2,400" }] });
    expect(result.text).toContain("₹2,400");
    expect(result.model).toBe("gpt-4o-mini");
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.outputTokens).toBeGreaterThan(0);
  });
});

describe("links to other systems", () => {
  it.each([
    ["https://agentguard.example.com/activity/act_1", true],
    ["https://agentguard.example.com/a?action=abc123&view=1#top", true],
    ["http://localhost:5173/activity/act_1", true],
    ["http://localhost/x", true],
    ["http://example.com/x", false],
    ["http://127.0.0.1:5173/x", false],
    ["http://localhost.evil.example/x", false],
    ["javascript:alert(1)", false],
    ["data:text/html,<script>alert(1)</script>", false],
    ["ftp://example.com/file", false],
    ["//example.com/x", false],
    ["/relative/path", false],
    ["https://user:pass@example.com/x", false],
    ["https://:pass@example.com/x", false],
    ["https://example.com/?token=sk-abcdefghijklmnopqrstu", false],
    ["https://example.com/?mail=ann@example.com", false],
    ["not a link", false],
    ["", false],
  ])("%s is allowed: %s", (url, allowed) => {
    expect(isAllowedLinkUrl(url, false)).toBe(allowed);
  });

  it("accepts 500 characters and refuses 501", () => {
    const base = "https://example.com/";
    expect(isAllowedLinkUrl(base + "a".repeat(500 - base.length), false)).toBe(true);
    expect(isAllowedLinkUrl(base + "a".repeat(501 - base.length), false)).toBe(false);
  });

  it("refuses http://localhost in production but still allows https", () => {
    expect(isAllowedLinkUrl("http://localhost:5173/x", true)).toBe(false);
    expect(isAllowedLinkUrl("https://agentguard.example.com/x", true)).toBe(true);
  });
});

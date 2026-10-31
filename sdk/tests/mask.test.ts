import { maskSecrets } from "../src/mask";
import { capText, prepareText, toText } from "../src/text";

// Secrets must never leave the app. The server has the same rules and the same test cases (server/tests/mask.test.ts).

describe("maskSecrets", () => {
  it.each([
    ["an OpenAI key", "key is sk-proj-abcdefghijklmnop1234567890", "key is [secret hidden]"],
    ["an Anthropic key", "sk-ant-api03-abcdefghijklmnopqrstuvwx", "[secret hidden]"],
    ["a bearer header", "Authorization: Bearer abcdefghijklmnop1234567890", "Authorization: [secret hidden]"],
    ["an AgentReplay key", `use ar_${"0123456789abcdef".repeat(3)} here`, "use [secret hidden] here"],
    ["an AgentGuard key", `agk_${"0123456789abcdef".repeat(3)}`, "[secret hidden]"],
    ["an AWS key", "AKIAABCDEFGHIJKLMNOP", "[secret hidden]"],
    ["a GitHub token", `ghp_${"a1B2c3D4e5".repeat(4)}`, "[secret hidden]"],
    ["a Slack token", "xoxb-123456789012-abcdefghij", "[secret hidden]"],
    ["a web token", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop", "[secret hidden]"],
    ["a password in text", "password: hunter22", "password: [secret hidden]"],
    ["a password in JSON", '{"api_key":"abc12345","name":"x"}', '{"api_key":"[secret hidden]","name":"x"}'],
    ["a token in a setting", "token=xyz789abc", "token=[secret hidden]"],
    ["an email", "write to jane.doe+refunds@example.co.in now", "write to [email hidden] now"],
    ["a card number with spaces", "card 4111 1111 1111 1111 expires", "card [card hidden] expires"],
    ["a card number with dashes", "4111-1111-1111-1111", "[card hidden]"],
    ["a card number in one run", "4111111111111111", "[card hidden]"],
  ])("hides %s", (_label, input, expected) => {
    expect(maskSecrets(input)).toBe(expected);
  });

  it.each([
    "The refund for order 1042 is 2400 rupees.",
    "tokens used: 1234567",
    "max_tokens: 4096",
    "Call us on 98765 43210 after 10 am",
    "Order number 1234 5678 9012 3456", // 16 digits but not a valid card number
    "Invoice 20240115123045",
    "at-sign alone @ and a.b@c are not emails",
    "",
  ])("leaves normal text alone: %s", (input) => {
    expect(maskSecrets(input)).toBe(input);
  });

  it("hides several different secrets in one text", () => {
    const out = maskSecrets("mail a@b.com, card 4111 1111 1111 1111, key sk-abcdefghijklmnopqrstu");
    expect(out).toBe("mail [email hidden], card [card hidden], key [secret hidden]");
  });

  it("gives the same result when run twice, so the SDK and the server can both mask", () => {
    const once = maskSecrets('password: hunter22 and a@b.com and 4111 1111 1111 1111 and api_key="sk-abcdefghijklmnopqrstu"');
    expect(maskSecrets(once)).toBe(once);
  });

  it("stays fast on long hostile text, so it cannot freeze the host app", () => {
    const hostile = ["a.".repeat(16000), "a".repeat(32768), "1 ".repeat(16000), "-".repeat(32768), "a@".repeat(16000), "sk-".repeat(10000)];
    for (const text of hostile) {
      const started = Date.now();
      maskSecrets(text);
      expect(Date.now() - started).toBeLessThan(500);
    }
  });
});

describe("text preparation", () => {
  it("cuts text at 32 KB, with a note, and counts bytes not letters", () => {
    const out = capText("é".repeat(40000));
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(32 * 1024);
    expect(out.endsWith("[cut at 32 KB]")).toBe(true);
    expect(out).not.toContain("�");
  });

  it("leaves short text alone", () => {
    expect(capText("hello")).toBe("hello");
  });

  it("turns objects into text and never throws on odd values", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    expect(toText({ a: 1 })).toBe('{"a":1}');
    expect(toText(circular)).toContain("[circular]");
    expect(toText({ big: BigInt(5) })).toBe('{"big":"5"}');
    expect(toText(new Error("boom"))).toContain("boom");
    expect(toText(undefined)).toBe("");
    expect(toText(null)).toBe("");
    expect(toText(() => 1)).toBe("() => 1");
    expect(toText({ toJSON: () => { throw new Error("bad"); } })).toBe("[could not be recorded]");
  });

  it("masks before it cuts, and cuts again afterwards", () => {
    const text = prepareText(`${"x".repeat(40000)} sk-abcdefghijklmnopqrstu`);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(32 * 1024);
    const withSecret = prepareText({ note: "email a@b.com and key sk-abcdefghijklmnopqrstu" });
    expect(withSecret).toBe('{"note":"email [email hidden] and key [secret hidden]"}');
  });
});

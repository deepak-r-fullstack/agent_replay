// The free, scripted "model" behind LLM_PROVIDER=demo. It needs no key and gives the same answer to the same
// question every time, so the demo works anywhere and can be repeated. It only knows the refund story:
// a support agent looked up the wrong order (1041, ₹1,800) when the customer asked about order 1042 (₹2,400).
// Fork that step with the right order data in the question, and the answer comes out right.

const RULES: Array<{ matches: (text: string) => boolean; reply: string }> = [
  {
    matches: (text) => /\b1042\b/.test(text) && /₹?\s?2,?400\b/.test(text),
    reply: "Your refund for order 1042 is ₹2,400. It will reach your original payment method in 3 to 5 working days. Is there anything else I can help with?",
  },
  {
    matches: (text) => /\b1041\b/.test(text) && /₹?\s?1,?800\b/.test(text),
    reply: "Your refund for order 1041 is ₹1,800. It will reach your original payment method in 3 to 5 working days. Is there anything else I can help with?",
  },
  {
    matches: (text) => /summar/i.test(text),
    reply: "Summary: the customer asked for a refund and the support agent told them how much it would be and when it would arrive.",
  },
];

// The two free scripted models. "demo-fast" stands for a cheaper model that is less careful: it misreads the refund
// amount. Running all tests with it shows what a change for the worse looks like.
export const DEMO_MODELS = ["demo-model", "demo-fast"] as const;

const FALLBACK_REPLY = "This is a scripted demo answer. The built-in demo model only knows the refund story, so it cannot answer other questions.";

const FAST_MODEL_MISTAKE =
  "Your refund for order 1042 is ₹1,800. It will reach your original payment method in 3 to 5 working days. Is there anything else I can help with?";

export function demoReply(promptText: string, model = "demo-model"): string {
  // The careless model reads order 1042's data and still says ₹1,800.
  if (model === "demo-fast" && RULES[0].matches(promptText)) return FAST_MODEL_MISTAKE;
  return RULES.find((rule) => rule.matches(promptText))?.reply ?? FALLBACK_REPLY;
}

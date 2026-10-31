import { AGENTGUARD_DEMO_ACTION_ID } from "../../constants";
import { IngestBatch } from "../ingest/ingestSchemas";

// The story the shared demo tells. A support bot got a refund wrong: a customer asked about order 1042 (₹2,400), but the
// bot looked up order 1041 (₹1,800) and refunded that. Replay shows where it went wrong, a fork fixes the question,
// and AgentGuard (the sister product) is where the wrong refund is undone. The free scripted demo model knows exactly
// this story (see llm/demoProvider.ts), so forking it works with no AI key.

export const WRONG_RUN_ID = "demo-refund-1042";
export const WRONG_STEP_INDEX = 1; // the AI step where the wrong order data went into the question
export const WRONG_PROMPT = "Customer asks for a refund for order 1042. Order data: order 1041, total ₹1800.";
export const RIGHT_PROMPT = "Customer asks for a refund for order 1042. Order data: order 1042, total ₹2,400.";
const WRONG_ANSWER = "Your refund for order 1041 is ₹1,800. It will reach your original payment method in 3 to 5 working days. Is there anything else I can help with?";
const RIGHT_ANSWER_1041 = "Your refund for order 1041 is ₹1,800. It will reach your original payment method in 3 to 5 working days. Is there anything else I can help with?";

export const DEMO_TESTS = [
  {
    name: "Refund amount is right",
    checks: [
      { type: "contains" as const, value: "₹2,400" },
      { type: "not_contains" as const, value: "₹1,800" },
    ],
  },
  { name: "Says when the money arrives", checks: [{ type: "contains" as const, value: "working days" }] },
];

const minutesAgo = (now: Date, minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

const chat = (prompt: string, model = "gpt-4o-mini") =>
  JSON.stringify({ model, system: "You are a polite support agent for Acme.", messages: [{ role: "user", content: prompt }] });

// Where the wrong refund can be undone: the matching action in AgentGuard's demo.
export const agentGuardLink = (baseUrl: string) => `${baseUrl.replace(/\/+$/, "")}/activity?action=${AGENTGUARD_DEMO_ACTION_ID}`;

export function buildDemoStory(agentGuardUrl: string, now = new Date()): IngestBatch {
  return {
    runs: [
      { id: WRONG_RUN_ID, name: "Refund request, order 1042", userRef: "customer-2231", tags: ["refund", "support"], status: "ok", startedAt: new Date(minutesAgo(now, 50)), durationMs: 2480 },
      { id: "demo-refund-1041", name: "Refund request, order 1041", userRef: "customer-1187", tags: ["refund", "support"], status: "ok", startedAt: new Date(minutesAgo(now, 38)), durationMs: 2210 },
      { id: "demo-order-status", name: "Where is my order?", userRef: "customer-3340", tags: ["orders"], status: "ok", startedAt: new Date(minutesAgo(now, 27)), durationMs: 1320 },
      { id: "demo-cancel-booking", name: "Cancel a booking", userRef: "customer-4410", tags: ["bookings"], status: "failed", startedAt: new Date(minutesAgo(now, 14)), durationMs: 10_900 },
      { id: "demo-ticket-summary", name: "Summarise a long ticket", userRef: "agent-7", tags: ["internal"], status: "ok", startedAt: new Date(minutesAgo(now, 6)), durationMs: 980 },
    ],
    steps: [
      // 1. The wrong refund: the lookup found order 1041, so everything after it is wrong, and it still "succeeded".
      { runId: WRONG_RUN_ID, index: 0, type: "retrieval", name: "find_order", input: '{"customer":"customer-2231","question":"refund for order 1042"}', output: '{"orderId":"1041","total":1800,"note":"closest match for this customer"}', model: "", tokens: 0, costUsd: 0, durationMs: 40, error: "" },
      { runId: WRONG_RUN_ID, index: WRONG_STEP_INDEX, type: "llm", name: "draft_answer", input: chat(WRONG_PROMPT), output: WRONG_ANSWER, model: "gpt-4o-mini", tokens: 182, costUsd: 0.0004, durationMs: 650, error: "" },
      {
        runId: WRONG_RUN_ID,
        index: 2,
        type: "tool",
        name: "issue_refund",
        input: '{"orderId":"1041","amount":1800}',
        output: '{"status":"refunded","amount":1800}',
        model: "",
        tokens: 0,
        costUsd: 0,
        durationMs: 1300,
        error: "",
        externalRef: { system: "agentguard", id: AGENTGUARD_DEMO_ACTION_ID, url: agentGuardLink(agentGuardUrl) },
      },
      { runId: WRONG_RUN_ID, index: 3, type: "tool", name: "send_email", input: `Email body: ${WRONG_ANSWER}`, output: "sent", model: "", tokens: 0, costUsd: 0, durationMs: 450, error: "" },

      // 2. The same kind of request, answered correctly.
      { runId: "demo-refund-1041", index: 0, type: "retrieval", name: "find_order", input: '{"customer":"customer-1187","question":"refund for order 1041"}', output: '{"orderId":"1041","total":1800}', model: "", tokens: 0, costUsd: 0, durationMs: 38, error: "" },
      { runId: "demo-refund-1041", index: 1, type: "llm", name: "draft_answer", input: chat("Customer asks for a refund for order 1041. Order data: order 1041, total ₹1800."), output: RIGHT_ANSWER_1041, model: "gpt-4o-mini", tokens: 176, costUsd: 0.0004, durationMs: 610, error: "" },
      { runId: "demo-refund-1041", index: 2, type: "tool", name: "issue_refund", input: '{"orderId":"1041","amount":1800}', output: '{"status":"refunded","amount":1800}', model: "", tokens: 0, costUsd: 0, durationMs: 1200, error: "" },

      // 3. A quick lookup.
      { runId: "demo-order-status", index: 0, type: "retrieval", name: "track_order", input: '{"orderId":"1038"}', output: '{"status":"out for delivery","arrivesBy":"6 pm today"}', model: "", tokens: 0, costUsd: 0, durationMs: 35, error: "" },
      { runId: "demo-order-status", index: 1, type: "llm", name: "write_reply", input: chat("Summarise the delivery status for the customer: out for delivery, arrives by 6 pm today."), output: "Summary: your order 1038 is out for delivery and should arrive by 6 pm today.", model: "gpt-4o-mini", tokens: 96, costUsd: 0.0002, durationMs: 520, error: "" },

      // 4. A run that failed: the booking service did not answer in time.
      { runId: "demo-cancel-booking", index: 0, type: "llm", name: "understand_request", input: chat("Customer wants to cancel booking BK-5521."), output: '{"intent":"cancel_booking","bookingId":"BK-5521"}', model: "gpt-4o-mini", tokens: 88, costUsd: 0.0002, durationMs: 480, error: "" },
      { runId: "demo-cancel-booking", index: 1, type: "tool", name: "cancel_booking", input: '{"bookingId":"BK-5521"}', output: "", model: "", tokens: 0, costUsd: 0, durationMs: 10_000, error: "The booking service did not answer within 10 seconds." },

      // 5. An internal helper.
      { runId: "demo-ticket-summary", index: 0, type: "llm", name: "summarise_ticket", input: chat("Summarise this support ticket in one line: the customer waited 3 days for a refund and was asked for the same details twice."), output: "Summary: the customer waited 3 days for a refund and had to repeat their details.", model: "gpt-4o-mini", tokens: 120, costUsd: 0.0003, durationMs: 980, error: "" },
    ],
  };
}

import { describe, expect, it } from "vitest";
import { apiErrorDetail } from "../../demos/streaming/openai";

describe("OpenAI error detail", () => {
  it("reads the message and code at the top level or under error", () => {
    expect(
      apiErrorDetail(
        {
          type: "error",
          code: "insufficient_quota",
          message: "You exceeded your current quota",
        },
        "stream error",
      ),
    ).toBe("You exceeded your current quota (insufficient_quota)");
    expect(
      apiErrorDetail(
        { error: { message: "Bad key", code: "invalid_api_key" } },
        "x",
      ),
    ).toBe("Bad key (invalid_api_key)");
    expect(apiErrorDetail({ error: { message: "Server error" } }, "x")).toBe(
      "Server error",
    );
  });

  it("falls back when the event carries no message", () => {
    expect(apiErrorDetail({ type: "error" }, "stream error")).toBe(
      "stream error",
    );
    expect(apiErrorDetail(null, "response failed")).toBe("response failed");
    expect(apiErrorDetail({ error: { code: "e" } }, "f")).toBe("f (e)");
  });
});

import { describe, expect, test } from "bun:test";
import { decodeCompiledGameEntities } from "../src";

describe("compiled game entity decoder", () => {
  test("accepts a complete closed-union member", () => {
    expect(
      decodeCompiledGameEntities([
        {
          kind: "relay",
          authoredId: "relay.main",
          targetName: "main",
          target: "door",
          delaySeconds: 0.25,
          once: false,
          body: null,
          presentation: { kind: "none" },
          interaction: "none",
        },
      ]),
    ).toHaveLength(1);
  });

  test("rejects unknown gameplay kinds after generic capability validation", () => {
    expect(() =>
      decodeCompiledGameEntities([
        {
          kind: "logic-counter",
          authoredId: "counter.main",
          body: null,
          presentation: { kind: "none" },
          interaction: "none",
        },
      ]),
    ).toThrow("logic-counter");
  });
});

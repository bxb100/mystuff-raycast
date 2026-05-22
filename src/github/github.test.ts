import { describe, expect, test } from "vite-plus/test";
import { formatContent } from "./github";

describe("formatContent", () => {
  test("joins topics, description, and README content in a stable order", () => {
    expect(formatContent("owner/repo\nA useful tool", ["rust", "cli"], "README body")).toBe(
      ["rust,cli", "owner/repo\nA useful tool", "README body"].join("\n"),
    );
  });

  test("omits empty fields", () => {
    expect(formatContent("owner/repo", [], "  ")).toBe("owner/repo");
  });
});

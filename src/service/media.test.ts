import { describe, expect, test } from "vitest";
import { collectMediaPathsFromString, collectMediaPathsFromUnknown } from "./media.js";

describe("media path extraction", () => {
  test("collects direct local path values", () => {
    const target = new Set<string>();
    collectMediaPathsFromString("/tmp/image.png", target);
    expect([...target]).toEqual(["/tmp/image.png"]);
  });

  test("collects media: local path references", () => {
    const target = new Set<string>();
    collectMediaPathsFromString("preview media:/tmp/image.png", target);
    expect([...target]).toEqual(["/tmp/image.png"]);
  });

  test("collects file:// local path references", () => {
    const target = new Set<string>();
    collectMediaPathsFromString("open file:///tmp/image.png", target);
    expect([...target]).toEqual(["/tmp/image.png"]);
  });

  test("collects markdown local media links", () => {
    const target = new Set<string>();
    collectMediaPathsFromString("![preview](/tmp/image.png)", target);
    expect([...target]).toEqual(["/tmp/image.png"]);
  });

  test("does not collect incidental local paths in plain text", () => {
    const target = new Set<string>();
    collectMediaPathsFromString("debug: attempted /tmp/image.png from prior run", target);
    expect(target.size).toBe(0);
  });

  test("collects local media paths from nested objects", () => {
    const target = new Set<string>();
    collectMediaPathsFromUnknown(
      {
        images: [
          { src: "file:///tmp/image.png" },
          { ref: "media:/tmp/other.jpg" },
        ],
      },
      target,
    );
    expect([...target].sort()).toEqual(["/tmp/image.png", "/tmp/other.jpg"]);
  });
});

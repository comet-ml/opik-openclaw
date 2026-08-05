import { describe, expect, test } from "vitest";
import { collectMediaPathsFromString, collectMediaPathsFromUnknown } from "./media.js";

describe("media path extraction", () => {
  test("does not collect direct local path values without an explicit marker", () => {
    const target = new Set<string>();
    collectMediaPathsFromString("/tmp/image.png", target);
    expect(target.size).toBe(0);
  });

  test("collects media: local path references", () => {
    const target = new Set<string>();
    collectMediaPathsFromString("preview media:/tmp/image.png", target);
    expect([...target]).toEqual(["/tmp/image.png"]);
  });

  test("ignores media:// authority URIs instead of normalizing them to local paths", () => {
    const target = new Set<string>();
    collectMediaPathsFromString("media://inbound/example.jpg", target);
    expect(target.size).toBe(0);
  });

  test("ignores media:// authority URIs with a host segment", () => {
    const target = new Set<string>();
    collectMediaPathsFromString("see media://host/path/to/example.jpg now", target);
    expect(target.size).toBe(0);
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

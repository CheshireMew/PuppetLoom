import { describe, expect, it } from "vitest";
import { parseByteRange } from "../apps/desktop/electron/media-range.js";

describe("parseByteRange", () => {
  it("leaves a full media request unbounded", () => {
    expect(parseByteRange(null, 1000)).toBeUndefined();
  });

  it("parses bounded, open-ended and suffix byte ranges", () => {
    expect(parseByteRange("bytes=20-39", 1000)).toEqual({ start: 20, end: 39 });
    expect(parseByteRange("bytes=900-", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseByteRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
  });

  it("clamps requested ends to the file boundary", () => {
    expect(parseByteRange("bytes=900-2000", 1000)).toEqual({ start: 900, end: 999 });
  });

  it("rejects malformed, multipart and unsatisfiable ranges", () => {
    expect(parseByteRange("items=0-1", 1000)).toBeNull();
    expect(parseByteRange("bytes=0-1,4-5", 1000)).toBeNull();
    expect(parseByteRange("bytes=1000-", 1000)).toBeNull();
    expect(parseByteRange("bytes=50-20", 1000)).toBeNull();
  });
});

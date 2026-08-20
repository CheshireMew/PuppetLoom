export interface ByteRange {
  start: number;
  end: number;
}

/** Parses the single byte range used by Chromium's media loader. */
export function parseByteRange(value: string | null, size: number): ByteRange | undefined | null {
  if (!value) return undefined;
  if (!Number.isSafeInteger(size) || size <= 0 || !value.startsWith("bytes=") || value.includes(",")) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match) return null;
  const [, rawStart = "", rawEnd = ""] = match;
  if (!rawStart && !rawEnd) return null;
  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(rawStart);
  const requestedEnd = rawEnd ? Number(rawEnd) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= size || requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, size - 1) };
}

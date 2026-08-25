export interface OscMessage { address: string; arguments: Array<string | number | boolean> }

function aligned(length: number): number { return Math.ceil(length / 4) * 4; }
function text(buffer: Buffer, offset: number): { value: string; next: number } {
  const end = buffer.indexOf(0, offset);
  if (end < 0) throw new Error("OSC 字符串没有终止符。");
  return { value: buffer.toString("utf8", offset, end), next: aligned(end + 1) };
}

function message(buffer: Buffer): OscMessage {
  const address = text(buffer, 0); const tags = text(buffer, address.next);
  if (!tags.value.startsWith(",")) throw new Error("OSC 类型标签无效。");
  let offset = tags.next; const arguments_: OscMessage["arguments"] = [];
  for (const tag of tags.value.slice(1)) {
    if (tag === "f") { arguments_.push(buffer.readFloatBE(offset)); offset += 4; }
    else if (tag === "i") { arguments_.push(buffer.readInt32BE(offset)); offset += 4; }
    else if (tag === "s") { const value = text(buffer, offset); arguments_.push(value.value); offset = value.next; }
    else if (tag === "T" || tag === "F") arguments_.push(tag === "T");
    else throw new Error(`尚未支持 OSC 类型：${tag}`);
  }
  return { address: address.value, arguments: arguments_ };
}

export function parseOscPacket(buffer: Buffer): OscMessage[] {
  if (buffer.subarray(0, 8).toString("ascii") !== "#bundle\0") return [message(buffer)];
  const result: OscMessage[] = []; let offset = 16;
  while (offset + 4 <= buffer.length) {
    const size = buffer.readInt32BE(offset); offset += 4;
    if (size <= 0 || offset + size > buffer.length) throw new Error("OSC bundle 元素尺寸无效。");
    result.push(...parseOscPacket(buffer.subarray(offset, offset + size))); offset += size;
  }
  return result;
}

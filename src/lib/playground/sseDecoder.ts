export interface SseFrame { event: string; data: string }

/** Incremental UTF-8/SSE decoder. Only complete, blank-line-delimited frames are emitted. */
export class SseDecoder {
  private decoder = new TextDecoder();
  private buffer = "";
  private event = "message";
  private data: string[] = [];
  private dataChars = 0;
  constructor(private readonly limit = 1_048_576) {}

  push(bytes: Uint8Array): SseFrame[] {
    this.buffer += this.decoder.decode(bytes, { stream: true });
    return this.drain(false);
  }

  finish(): SseFrame[] {
    this.buffer += this.decoder.decode();
    const frames = this.drain(true);
    if (this.buffer.length > 0 || this.data.length > 0) {
      throw new Error("stream_truncated: incomplete SSE frame");
    }
    return frames;
  }

  private drain(final: boolean): SseFrame[] {
    const out: SseFrame[] = [];
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (!match) break;
      if (!final && match[0] === "\r" && match.index + 1 === this.buffer.length) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      if (line.length + this.dataChars > this.limit) throw new Error("SSE frame limit exceeded");
      if (line === "") {
        if (this.data.length > 0) out.push({ event: this.event, data: this.data.join("\n") });
        this.event = "message";
        this.data = [];
        this.dataChars = 0;
      } else if (!line.startsWith(":")) {
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "data") { this.data.push(value); this.dataChars += value.length + 1; }
        else if (field === "event") this.event = value;
      }
    }
    if (this.buffer.length + this.dataChars > this.limit) throw new Error("SSE frame limit exceeded");
    return out;
  }
}

// Chrome native messaging: each message is a 32-bit length in native byte order
// (little-endian on every platform Quack supports) followed by UTF-8 JSON.

const MAX_INCOMING = 64 * 1024 * 1024;

export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class MessageDecoder {
  private buffer = Buffer.alloc(0);

  /** Feeds a chunk and returns every complete message it finished. */
  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > MAX_INCOMING) throw new Error(`Incoming message too large: ${length} bytes`);
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length).toString('utf8');
      this.buffer = this.buffer.subarray(4 + length);
      messages.push(JSON.parse(body));
    }
    return messages;
  }
}

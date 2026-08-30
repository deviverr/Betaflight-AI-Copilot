/**
 * MSP v1 and v2 frame encoding / decoding.
 *
 * v1: $ M <dir> <len:u8> <code:u8> <payload> <crc:u8 = xor(len, code, payload)>
 * v2: $ X <dir> <flag:u8> <code:u16le> <len:u16le> <payload> <crc:u8 = dvb-s2>
 *
 * Codes above 254, and payloads above 254 bytes, force v2.
 */

export type MspDirection = "<" | ">" | "!";

export interface MspFrame {
  code: number;
  payload: Uint8Array;
  /** ">" is a normal reply, "!" means the FC rejected the command. */
  direction: MspDirection;
  version: 1 | 2;
}

const DOLLAR = 0x24;
const M = 0x4d;
const X = 0x58;

export function crc8DvbS2(crc: number, byte: number): number {
  crc ^= byte;
  for (let i = 0; i < 8; i++) {
    crc = crc & 0x80 ? ((crc << 1) ^ 0xd5) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

export function crc8DvbS2Buffer(data: Uint8Array, seed = 0): number {
  let crc = seed;
  for (const byte of data) crc = crc8DvbS2(crc, byte);
  return crc;
}

export function encodeV1(code: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (code > 254) throw new RangeError(`MSPv1 cannot carry code ${code}`);
  if (payload.length > 254) throw new RangeError(`MSPv1 cannot carry ${payload.length} bytes`);
  const out = new Uint8Array(6 + payload.length);
  out[0] = DOLLAR;
  out[1] = M;
  out[2] = 0x3c; // '<'
  out[3] = payload.length;
  out[4] = code;
  out.set(payload, 5);
  let crc = payload.length ^ code;
  for (const byte of payload) crc ^= byte;
  out[out.length - 1] = crc;
  return out;
}

export function encodeV2(code: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(9 + payload.length);
  out[0] = DOLLAR;
  out[1] = X;
  out[2] = 0x3c; // '<'
  out[3] = 0; // flag, reserved
  out[4] = code & 0xff;
  out[5] = (code >> 8) & 0xff;
  out[6] = payload.length & 0xff;
  out[7] = (payload.length >> 8) & 0xff;
  out.set(payload, 8);
  out[out.length - 1] = crc8DvbS2Buffer(out.subarray(3, out.length - 1));
  return out;
}

/** Picks the narrowest frame version that can carry this request. */
export function encode(code: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  return code > 254 || payload.length > 254 ? encodeV2(code, payload) : encodeV1(code, payload);
}

type ParserState =
  | "idle"
  | "version"
  | "v1-dir"
  | "v1-len"
  | "v1-code"
  | "v1-payload"
  | "v1-crc"
  | "v2-dir"
  | "v2-flag"
  | "v2-code"
  | "v2-len"
  | "v2-payload"
  | "v2-crc";

/**
 * Incremental parser: serial arrives in arbitrary chunks, so frames are
 * reassembled across `push()` calls rather than assuming one chunk per frame.
 */
export class MspParser {
  private state: ParserState = "idle";
  private direction: MspDirection = ">";
  private version: 1 | 2 = 1;
  private code = 0;
  private length = 0;
  private offset = 0;
  private payload = new Uint8Array(0);
  private crc = 0;

  /** Bytes seen outside of any MSP frame — this is how CLI text reaches us. */
  private text: number[] = [];

  /** Frames that failed CRC. Surfaced so the UI can warn about a bad cable. */
  public crcErrors = 0;

  push(chunk: Uint8Array): { frames: MspFrame[]; text: Uint8Array } {
    const frames: MspFrame[] = [];
    this.text = [];

    for (const byte of chunk) {
      switch (this.state) {
        case "idle":
          if (byte === DOLLAR) this.state = "version";
          else this.text.push(byte);
          break;

        case "version":
          if (byte === M) this.state = "v1-dir";
          else if (byte === X) this.state = "v2-dir";
          else {
            // Not a frame after all; the '$' was ordinary text.
            this.text.push(DOLLAR, byte);
            this.state = "idle";
          }
          break;

        case "v1-dir":
          this.direction = String.fromCharCode(byte) as MspDirection;
          this.version = 1;
          this.state = "v1-len";
          break;

        case "v1-len":
          this.length = byte;
          this.crc = byte;
          this.state = "v1-code";
          break;

        case "v1-code":
          this.code = byte;
          this.crc ^= byte;
          this.payload = new Uint8Array(this.length);
          this.offset = 0;
          this.state = this.length ? "v1-payload" : "v1-crc";
          break;

        case "v1-payload":
          this.payload[this.offset++] = byte;
          this.crc ^= byte;
          if (this.offset >= this.length) this.state = "v1-crc";
          break;

        case "v1-crc":
          if (byte === this.crc) frames.push(this.finish());
          else this.crcErrors++;
          this.state = "idle";
          break;

        case "v2-dir":
          this.direction = String.fromCharCode(byte) as MspDirection;
          this.version = 2;
          this.state = "v2-flag";
          break;

        case "v2-flag":
          this.crc = crc8DvbS2(0, byte);
          this.code = 0;
          this.offset = 0;
          this.state = "v2-code";
          break;

        case "v2-code":
          this.crc = crc8DvbS2(this.crc, byte);
          this.code |= byte << (8 * this.offset);
          if (++this.offset === 2) {
            this.offset = 0;
            this.length = 0;
            this.state = "v2-len";
          }
          break;

        case "v2-len":
          this.crc = crc8DvbS2(this.crc, byte);
          this.length |= byte << (8 * this.offset);
          if (++this.offset === 2) {
            this.payload = new Uint8Array(this.length);
            this.offset = 0;
            this.state = this.length ? "v2-payload" : "v2-crc";
          }
          break;

        case "v2-payload":
          this.crc = crc8DvbS2(this.crc, byte);
          this.payload[this.offset++] = byte;
          if (this.offset >= this.length) this.state = "v2-crc";
          break;

        case "v2-crc":
          if (byte === this.crc) frames.push(this.finish());
          else this.crcErrors++;
          this.state = "idle";
          break;
      }
    }

    return { frames, text: new Uint8Array(this.text) };
  }

  private finish(): MspFrame {
    return {
      code: this.code,
      payload: this.payload,
      direction: this.direction,
      version: this.version,
    };
  }

  reset(): void {
    this.state = "idle";
    this.text = [];
  }
}

/** Little-endian reader for MSP reply payloads. */
export class PayloadReader {
  private view: DataView;
  private pos = 0;

  constructor(private data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get remaining(): number {
    return this.data.length - this.pos;
  }

  u8(): number {
    return this.view.getUint8(this.pos++);
  }

  u16(): number {
    const value = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return value;
  }

  u32(): number {
    const value = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return value;
  }

  i16(): number {
    const value = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return value;
  }

  bytes(count: number): Uint8Array {
    const slice = this.data.subarray(this.pos, this.pos + count);
    this.pos += count;
    return slice;
  }

  ascii(count = this.remaining): string {
    return new TextDecoder().decode(this.bytes(count)).replace(/\0+$/, "");
  }
}

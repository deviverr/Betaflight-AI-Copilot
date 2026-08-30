import { describe, it, expect } from "vitest";
import { encodeV1, encodeV2, encode, MspParser, crc8DvbS2Buffer, PayloadReader } from "../src/msp/codec";

function feed(parser: MspParser, bytes: Uint8Array) {
  return parser.push(bytes);
}

describe("MSP v1 encoding", () => {
  it("frames an empty request with the documented header and checksum", () => {
    const frame = encodeV1(101);
    expect([...frame]).toEqual([0x24, 0x4d, 0x3c, 0x00, 101, 101]);
  });

  it("xors length, code and payload into the checksum", () => {
    const frame = encodeV1(200, new Uint8Array([1, 2, 3]));
    const expected = 3 ^ 200 ^ 1 ^ 2 ^ 3;
    expect(frame[frame.length - 1]).toBe(expected);
  });

  it("refuses codes and payloads that do not fit", () => {
    expect(() => encodeV1(300)).toThrow(RangeError);
    expect(() => encodeV1(1, new Uint8Array(255))).toThrow(RangeError);
  });
});

describe("MSP v2 encoding", () => {
  it("uses a dvb-s2 checksum over flag, code, length and payload", () => {
    const frame = encodeV2(0x1f9c, new Uint8Array([9, 9]));
    expect(frame[0]).toBe(0x24);
    expect(frame[1]).toBe(0x58);
    expect(frame[4]).toBe(0x9c);
    expect(frame[5]).toBe(0x1f);
    expect(frame[frame.length - 1]).toBe(crc8DvbS2Buffer(frame.subarray(3, frame.length - 1)));
  });

  it("is selected automatically for wide codes", () => {
    expect(encode(0x2000)[1]).toBe(0x58);
    expect(encode(100)[1]).toBe(0x4d);
  });
});

describe("MspParser", () => {
  it("round-trips a v1 frame", () => {
    const parser = new MspParser();
    const payload = new Uint8Array([10, 20, 30]);
    const wire = encodeV1(112, payload);
    wire[2] = 0x3e; // reply direction '>'
    // Recompute nothing: direction is outside the checksum.
    const { frames } = feed(parser, wire);
    expect(frames).toHaveLength(1);
    expect(frames[0].code).toBe(112);
    expect([...frames[0].payload]).toEqual([10, 20, 30]);
    expect(frames[0].direction).toBe(">");
  });

  it("round-trips a v2 frame", () => {
    const parser = new MspParser();
    const wire = encodeV2(0x3000, new Uint8Array([7, 7, 7]));
    wire[2] = 0x3e;
    const { frames } = feed(parser, wire);
    expect(frames).toHaveLength(1);
    expect(frames[0].code).toBe(0x3000);
    expect(frames[0].version).toBe(2);
  });

  it("reassembles a frame split across chunks", () => {
    const parser = new MspParser();
    const wire = encodeV1(101, new Uint8Array([1, 2, 3, 4]));
    wire[2] = 0x3e;
    for (const byte of wire.subarray(0, wire.length - 1)) {
      expect(feed(parser, new Uint8Array([byte])).frames).toHaveLength(0);
    }
    const { frames } = feed(parser, wire.subarray(wire.length - 1));
    expect(frames).toHaveLength(1);
  });

  it("counts a bad checksum instead of emitting a frame", () => {
    const parser = new MspParser();
    const wire = encodeV1(101, new Uint8Array([1]));
    wire[2] = 0x3e;
    wire[wire.length - 1] ^= 0xff;
    const { frames } = feed(parser, wire);
    expect(frames).toHaveLength(0);
    expect(parser.crcErrors).toBe(1);
  });

  it("surfaces the error direction so a rejected command is visible", () => {
    const parser = new MspParser();
    const wire = encodeV1(202);
    wire[2] = 0x21; // '!'
    expect(feed(parser, wire).frames[0].direction).toBe("!");
  });

  it("passes non-frame bytes through as text", () => {
    const parser = new MspParser();
    const { text } = feed(parser, new TextEncoder().encode("# hello"));
    expect(new TextDecoder().decode(text)).toBe("# hello");
  });
});

describe("PayloadReader", () => {
  it("reads little-endian integers and trims trailing nulls from strings", () => {
    const bytes = new Uint8Array([0x34, 0x12, 0xff, 0xff, 0x41, 0x42, 0x00]);
    const reader = new PayloadReader(bytes);
    expect(reader.u16()).toBe(0x1234);
    expect(reader.i16()).toBe(-1);
    expect(reader.ascii()).toBe("AB");
  });
});

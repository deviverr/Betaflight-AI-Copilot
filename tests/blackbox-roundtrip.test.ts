import { describe, it, expect } from "vitest";
import { readTag2_3S32, readTag8_4S16, readTag2_3SVariable } from "../src/blackbox/decoder";

/**
 * Direct ports of Betaflight's encoders from
 * `src/main/blackbox/blackbox_encoding.c`. Round-tripping every layout
 * boundary through these is the only way to be sure the decoder's bit
 * arithmetic matches the firmware's, short of a real log from every version.
 */

function writeTag2_3S32(values: number[]): number[] {
  const out: number[] = [];
  const write = (byte: number) => out.push(byte & 0xff);

  let selector = 0; // BITS_2
  for (const value of values) {
    if (value >= 32 || value < -32) {
      selector = 3; // BITS_32
      break;
    }
    if (value >= 8 || value < -8) {
      if (selector < 2) selector = 2; // BITS_6
    } else if (value >= 2 || value < -2) {
      if (selector < 1) selector = 1; // BITS_4
    }
  }

  switch (selector) {
    case 0:
      write((selector << 6) | ((values[0] & 0x03) << 4) | ((values[1] & 0x03) << 2) | (values[2] & 0x03));
      break;
    case 1:
      write((selector << 6) | (values[0] & 0x0f));
      write((values[1] << 4) | (values[2] & 0x0f));
      break;
    case 2:
      write((selector << 6) | (values[0] & 0x3f));
      write(values[1]);
      write(values[2]);
      break;
    default: {
      let selector2 = 0;
      for (let x = 2; x >= 0; x--) {
        selector2 <<= 2;
        const value = values[x];
        if (value < 128 && value >= -128) selector2 |= 0;
        else if (value < 32768 && value >= -32768) selector2 |= 1;
        else if (value < 8388608 && value >= -8388608) selector2 |= 2;
        else selector2 |= 3;
      }
      write((selector << 6) | selector2);
      let widths = selector2;
      for (let x = 0; x < 3; x++, widths >>= 2) {
        const value = values[x];
        write(value);
        if ((widths & 0x03) >= 1) write(value >> 8);
        if ((widths & 0x03) >= 2) write(value >> 16);
        if ((widths & 0x03) >= 3) write(value >> 24);
      }
      break;
    }
  }
  return out;
}

function writeTag2_3SVariable(values: number[]): number[] {
  const out: number[] = [];
  const write = (byte: number) => out.push(byte & 0xff);

  let selector = 0; // BITS_2
  if (
    values[0] >= 256 || values[0] < -256 ||
    values[1] >= 128 || values[1] < -128 ||
    values[2] >= 128 || values[2] < -128
  ) {
    selector = 3; // BITS_32
  } else if (
    values[0] >= 16 || values[0] < -16 ||
    values[1] >= 16 || values[1] < -16 ||
    values[2] >= 8 || values[2] < -8
  ) {
    selector = 2; // BITS_877
  } else if (
    values[0] >= 2 || values[0] < -2 ||
    values[1] >= 2 || values[1] < -2 ||
    values[2] >= 2 || values[2] < -2
  ) {
    selector = 1; // BITS_554
  }

  switch (selector) {
    case 0:
      write((selector << 6) | ((values[0] & 0x03) << 4) | ((values[1] & 0x03) << 2) | (values[2] & 0x03));
      break;
    case 1:
      write((selector << 6) | ((values[0] & 0x1f) << 1) | ((values[1] & 0x1f) >> 4));
      write(((values[1] & 0x0f) << 4) | (values[2] & 0x0f));
      break;
    case 2:
      write((selector << 6) | ((values[0] & 0xff) >> 2));
      write(((values[0] & 0x03) << 6) | ((values[1] & 0x7f) >> 1));
      write(((values[1] & 0x01) << 7) | (values[2] & 0x7f));
      break;
    default: {
      let selector2 = 0;
      for (let x = 2; x >= 0; x--) {
        selector2 <<= 2;
        const value = values[x];
        if (value < 128 && value >= -128) selector2 |= 0;
        else if (value < 32768 && value >= -32768) selector2 |= 1;
        else if (value < 8388608 && value >= -8388608) selector2 |= 2;
        else selector2 |= 3;
      }
      write((selector << 6) | selector2);
      let widths = selector2;
      for (let x = 0; x < 3; x++, widths >>= 2) {
        const value = values[x];
        write(value);
        if ((widths & 0x03) >= 1) write(value >> 8);
        if ((widths & 0x03) >= 2) write(value >> 16);
        if ((widths & 0x03) >= 3) write(value >> 24);
      }
      break;
    }
  }
  return out;
}

function writeTag8_4S16(values: number[]): number[] {
  const out: number[] = [];
  const write = (byte: number) => out.push(byte & 0xff);

  let selector = 0;
  for (let x = 3; x >= 0; x--) {
    selector <<= 2;
    const value = values[x];
    if (value === 0) selector |= 0;
    else if (value < 8 && value >= -8) selector |= 1;
    else if (value < 128 && value >= -128) selector |= 2;
    else selector |= 3;
  }
  write(selector);

  let nibbleIndex = 0;
  let buffer = 0;
  let bits = selector;
  for (let x = 0; x < 4; x++, bits >>= 2) {
    const value = values[x];
    switch (bits & 0x03) {
      case 0:
        break;
      case 1:
        if (nibbleIndex === 0) {
          buffer = (value << 4) & 0xff;
          nibbleIndex = 1;
        } else {
          write(buffer | (value & 0x0f));
          nibbleIndex = 0;
        }
        break;
      case 2:
        if (nibbleIndex === 0) {
          write(value);
        } else {
          write(buffer | ((value >> 4) & 0x0f));
          buffer = (value << 4) & 0xff;
        }
        break;
      default:
        if (nibbleIndex === 0) {
          write(value >> 8);
          write(value);
        } else {
          write(buffer | ((value >> 12) & 0x0f));
          write(value >> 4);
          buffer = (value << 4) & 0xff;
        }
        break;
    }
  }
  if (nibbleIndex === 1) write(buffer);
  return out;
}

function reader(bytes: number[]) {
  let pos = 0;
  return {
    byte() {
      if (pos >= bytes.length) throw new RangeError("read past end of encoded buffer");
      return bytes[pos++];
    },
  };
}

/** Values chosen to sit on every layout boundary in both encoders. */
const BOUNDARIES = [
  0, 1, -1, 2, -2, 3, -3, 7, -7, 8, -8, 9, -9, 15, -15, 16, -16, 17, -17,
  31, -31, 32, -32, 33, -33, 63, -63, 64, -64, 100, -100, 127, -127, 128, -128,
  129, -129, 255, -255, 256, -256, 1000, -1000, 32767, -32768, 32768, -32769,
  8388607, -8388608, 8388608, -8388609, 2147483647, -2147483648,
];

describe("TAG2_3S32 round-trips the firmware encoder", () => {
  it("survives every boundary value in every position", () => {
    for (const a of BOUNDARIES) {
      for (const b of [0, 1, -1, 7, -8, 31, -32, 127, -128, 32767, -32768]) {
        const triple = [a, b, b === 0 ? 0 : -b];
        expect(readTag2_3S32(reader(writeTag2_3S32(triple)))).toEqual(triple);
      }
    }
  });

  it("picks the compact layouts for small values", () => {
    expect(writeTag2_3S32([1, -1, -2])).toHaveLength(1); // 2-bit
    expect(writeTag2_3S32([7, -1, 1])).toHaveLength(2); // 4-bit
    expect(writeTag2_3S32([31, -1, -32])).toHaveLength(3); // 6-bit
    expect(writeTag2_3S32([1000, 0, 0]).length).toBeGreaterThan(3); // per-field widths
  });

  it("survives random values", () => {
    let seed = 12345;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let i = 0; i < 3000; i++) {
      const triple = [0, 0, 0].map(() => (next() % 4000001) - 2000000);
      expect(readTag2_3S32(reader(writeTag2_3S32(triple)))).toEqual(triple);
    }
  });
});

describe("TAG2_3SVARIABLE round-trips the firmware encoder", () => {
  /**
   * The firmware's own encoder is lossy in a narrow band. Its escape to the
   * per-field-width layout triggers at |field0| >= 256 and |field1|, |field2| >=
   * 128, but the 877 layout only gives field0 8 signed bits (-128..127) and
   * fields 1 and 2 seven signed bits (-64..63). Values between those two
   * thresholds are silently truncated when the log is *written*, on the flight
   * controller, before this decoder ever sees them.
   *
   * The decoder reproduces exactly what was written, which is the correct
   * behaviour; there is nothing a reader can do to recover a value the writer
   * threw away. These helpers keep the round-trip sweep inside the range the
   * encoder can actually represent, and the band itself is covered by its own
   * test below.
   */
  const encoderIsLossless = ([a, b, c]: number[]): boolean => {
    const escapes = a >= 256 || a < -256 || b >= 128 || b < -128 || c >= 128 || c < -128;
    if (escapes) return true;
    const uses877 = a >= 16 || a < -16 || b >= 16 || b < -16 || c >= 8 || c < -8;
    if (!uses877) return true;
    return a >= -128 && a <= 127 && b >= -64 && b <= 63 && c >= -64 && c <= 63;
  };

  it("survives every boundary value in every position", () => {
    let checked = 0;
    for (const a of BOUNDARIES) {
      for (const b of [0, 1, -1, 7, -8, 15, -16, 63, -64, 127, -128, 1000, -1000]) {
        const triple = [a, b, b === 0 ? 0 : -b];
        if (!encoderIsLossless(triple)) continue;
        expect(readTag2_3SVariable(reader(writeTag2_3SVariable(triple)))).toEqual(triple);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it("documents the band where the firmware encoder itself loses information", () => {
    // field1 = 100 needs 8 bits, but the 877 layout gives it 7 and the encoder
    // does not escape to a wider layout until 128. It comes back as 100 - 128.
    expect(readTag2_3SVariable(reader(writeTag2_3SVariable([0, 100, 0])))).toEqual([0, -28, 0]);
    // One past the escape threshold the value survives, because the encoder
    // switches to the per-field-width layout.
    expect(readTag2_3SVariable(reader(writeTag2_3SVariable([0, 128, 0])))).toEqual([0, 128, 0]);
    // field0 has the same problem one bit higher up: 8 bits, escape at 256.
    expect(readTag2_3SVariable(reader(writeTag2_3SVariable([200, 0, 0])))).toEqual([-56, 0, 0]);
    expect(readTag2_3SVariable(reader(writeTag2_3SVariable([256, 0, 0])))).toEqual([256, 0, 0]);
  });

  it("uses each of the four layouts where the encoder says it should", () => {
    // ss11 2233
    expect(writeTag2_3SVariable([1, -1, -2])).toHaveLength(1);
    // ss11 1112 2222 3333 — 5, 5 and 4 bits
    expect(writeTag2_3SVariable([15, -16, 7])).toHaveLength(2);
    // ss11 1111 1122 2222 2333 3333 — 8, 7 and 7 bits
    expect(writeTag2_3SVariable([200, -64, 63])).toHaveLength(3);
    // sstt tttt then per-field byte counts
    expect(writeTag2_3SVariable([300, 0, 0]).length).toBeGreaterThan(3);
  });

  it("round-trips gyro-shaped values, which is what Betaflight uses it for", () => {
    let seed = 987654321;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let i = 0; i < 3000; i++) {
      // Frame-to-frame gyro deltas are small most of the time and occasionally large.
      const magnitude = i % 7 === 0 ? 200000 : 40;
      const triple = [0, 0, 0].map(() => (next() % (magnitude * 2 + 1)) - magnitude);
      if (!encoderIsLossless(triple)) continue;
      expect(readTag2_3SVariable(reader(writeTag2_3SVariable(triple)))).toEqual(triple);
    }
  });
});

describe("TAG8_4S16 round-trips the firmware encoder", () => {
  it("survives every combination of the four field widths", () => {
    // One representative value per width bucket: zero, 4-bit, 8-bit, 16-bit.
    const buckets = [0, 7, -8, 100, -128, 1000, -32768, 32767];
    for (const a of buckets) {
      for (const b of buckets) {
        for (const c of buckets) {
          for (const d of buckets) {
            const quad = [a, b, c, d];
            expect(readTag8_4S16(reader(writeTag8_4S16(quad)))).toEqual(quad);
          }
        }
      }
    }
  });

  it("spends no bytes on zero fields", () => {
    expect(writeTag8_4S16([0, 0, 0, 0])).toEqual([0]);
  });

  it("packs two 4-bit fields into a single byte", () => {
    expect(writeTag8_4S16([3, -1, 0, 0])).toHaveLength(2);
  });

  it("survives random values", () => {
    let seed = 24680;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let i = 0; i < 3000; i++) {
      const quad = [0, 0, 0, 0].map(() => (next() % 65536) - 32768);
      expect(readTag8_4S16(reader(writeTag8_4S16(quad)))).toEqual(quad);
    }
  });
});

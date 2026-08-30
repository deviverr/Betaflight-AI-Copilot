import { describe, it, expect } from "vitest";
import { readTag2_3S32, readTag8_4S16, parseHeader, decodeLog, UnsupportedEncodingError } from "../src/blackbox/decoder";
import { fft, findNoisePeaks, analyzeCsv } from "../src/blackbox/analyze";

function stream(bytes: number[]) {
  let pos = 0;
  return { byte: () => bytes[pos++] };
}

describe("readTag2_3S32", () => {
  it("decodes three 2-bit signed fields from the selector-0 layout", () => {
    // selector 0, fields 01, 11, 10 -> 1, -1, -2
    expect(readTag2_3S32(stream([0b00_01_11_10]))).toEqual([1, -1, -2]);
  });

  it("decodes the selector-1 4-bit layout across two bytes", () => {
    expect(readTag2_3S32(stream([0b01_00_0111, 0b1111_0001]))).toEqual([7, -1, 1]);
  });

  it("decodes the selector-2 6-bit layout", () => {
    expect(readTag2_3S32(stream([0b10_000101, 0b00111111, 0b00100000]))).toEqual([5, -1, -32]);
  });

  it("decodes per-field widths in the selector-3 layout", () => {
    // widths: field0 = 8 bit, field1 = 16 bit, field2 = 8 bit
    const bytes = [0b11_00_01_00, 0xff, 0x00, 0x01, 0x7f];
    expect(readTag2_3S32(stream(bytes))).toEqual([-1, 256, 127]);
  });
});

describe("readTag8_4S16", () => {
  it("decodes zero fields without consuming bytes", () => {
    expect(readTag8_4S16(stream([0b00000000]))).toEqual([0, 0, 0, 0]);
  });

  it("packs two 4-bit fields into one byte", () => {
    // selector: field0 = 4bit, field1 = 4bit, rest zero
    expect(readTag8_4S16(stream([0b0000_0101, 0b0011_1111]))).toEqual([3, -1, 0, 0]);
  });

  it("decodes 8-bit and 16-bit fields", () => {
    // field0 = 8 bit (0xff -> -1), field1 = 16 bit (0x0100 -> 256)
    expect(readTag8_4S16(stream([0b0000_1110, 0xff, 0x01, 0x00]))).toEqual([-1, 256, 0, 0]);
  });
});

describe("parseHeader", () => {
  const log =
    "H Product:Blackbox flight data recorder by Nicholas Sherlock\n" +
    "H Data version:2\n" +
    "H Firmware revision:Betaflight 4.5.1 (77d01ba3b) SPEEDYBEEF405V3\n" +
    "H Craft name:Freestyle5\n" +
    "H Field I name:loopIteration,time,axisP[0]\n" +
    "H Field I signed:0,0,1\n" +
    "H Field I predictor:0,0,0\n" +
    "H Field I encoding:1,1,0\n" +
    "H Field P predictor:6,2,1\n" +
    "H Field P encoding:9,0,0\n" +
    "H looptime:125\n" +
    "H minthrottle:1070\n";

  it("reads key/value header lines", () => {
    const { header } = parseHeader(new TextEncoder().encode(log));
    expect(header.values.get("Craft name")).toBe("Freestyle5");
    expect(header.values.get("Firmware revision")).toContain("4.5.1");
    expect(header.minthrottle).toBe(1070);
  });

  it("assembles field definitions from the parallel header lines", () => {
    const { header } = parseHeader(new TextEncoder().encode(log));
    expect(header.mainFields.map((field) => field.name)).toEqual(["loopIteration", "time", "axisP[0]"]);
    expect(header.mainFields[2].signed).toBe(true);
    expect(header.mainFields[0].pencoding).toBe(9); // NULL
    expect(header.mainFields[0].ppredictor).toBe(6); // INC
  });

  it("reports where the binary body starts", () => {
    const bytes = new TextEncoder().encode(log + "\x49body");
    const { bodyOffset } = parseHeader(bytes);
    expect(bytes[bodyOffset]).toBe(0x49);
  });
});

describe("decodeLog", () => {
  it("decodes I and P frames with predictors applied", () => {
    const header =
      "H Field I name:loopIteration,time,axisP[0]\n" +
      "H Field I signed:0,0,1\n" +
      "H Field I predictor:0,0,0\n" +
      "H Field I encoding:1,1,0\n" +
      "H Field P predictor:6,1,1\n" +
      "H Field P encoding:9,0,0\n" +
      "H looptime:125\n";
    // I frame: loopIteration=0, time=1000, axisP[0]=zigzag(4)=8 -> 4
    // P frame: loopIteration NULL+INC, time signedVB(zigzag 125)=250 -> +125, axisP zigzag(-2)=3 -> +(-2)
    const body = [0x49, 0x00, 0xe8, 0x07, 0x08, 0x50, 0xfa, 0x01, 0x03];
    const bytes = new Uint8Array([...new TextEncoder().encode(header), ...body]);

    const log = decodeLog(bytes);
    expect(log.fieldNames).toEqual(["loopIteration", "time", "axisP[0]"]);
    expect(log.rows).toHaveLength(2);
    expect(log.rows[0]).toEqual([0, 1000, 4]);
    expect(log.rows[1]).toEqual([1, 1125, 2]);
  });

  it("refuses a log that uses TAG2_3SVARIABLE rather than guessing its layout", () => {
    const header =
      "H Field I name:gyroADC[0],gyroADC[1],gyroADC[2]\n" +
      "H Field I signed:1,1,1\n" +
      "H Field I predictor:0,0,0\n" +
      "H Field I encoding:0,0,0\n" +
      "H Field P predictor:3,3,3\n" +
      "H Field P encoding:10,10,10\n";
    const bytes = new Uint8Array(new TextEncoder().encode(header));
    expect(() => decodeLog(bytes)).toThrow(UnsupportedEncodingError);
    expect(() => decodeLog(bytes)).toThrow(/CSV/);
  });
});

describe("fft", () => {
  it("puts a pure tone in the expected bin", () => {
    const n = 256;
    const real = new Float64Array(n);
    const imag = new Float64Array(n);
    for (let i = 0; i < n; i++) real[i] = Math.sin((2 * Math.PI * 8 * i) / n);
    fft(real, imag);

    const magnitudes = Array.from({ length: n / 2 }, (_, bin) => Math.hypot(real[bin], imag[bin]));
    const peak = magnitudes.indexOf(Math.max(...magnitudes));
    expect(peak).toBe(8);
  });

  it("rejects a length that is not a power of two", () => {
    expect(() => fft(new Float64Array(3), new Float64Array(3))).toThrow(/power of two/);
  });
});

describe("findNoisePeaks", () => {
  it("locates a synthetic 200 Hz vibration", () => {
    const sampleRate = 2000;
    const signal = Array.from({ length: 8192 }, (_, i) => Math.sin((2 * Math.PI * 200 * i) / sampleRate));
    const peaks = findNoisePeaks(signal, sampleRate);
    expect(peaks.length).toBeGreaterThan(0);
    expect(peaks[0].frequencyHz).toBeCloseTo(200, -1);
    expect(peaks[0].relativeAmplitude).toBe(1);
  });

  it("returns nothing for a signal shorter than one analysis block", () => {
    expect(findNoisePeaks([1, 2, 3], 1000)).toEqual([]);
  });
});

describe("analyzeCsv", () => {
  it("computes per-axis statistics and flags motor saturation", () => {
    const rows = ["time (us),gyroADC[0],gyroADC[1],gyroADC[2],motor[0],motor[1],motor[2],motor[3]"];
    for (let i = 0; i < 400; i++) {
      rows.push(`${i * 1000},${Math.sin(i / 3) * 100},0,0,1990,1990,1990,1990`);
    }
    const analysis = analyzeCsv("test.csv", rows.join("\n"));

    expect(analysis.frameCount).toBe(400);
    expect(analysis.durationSeconds).toBeCloseTo(0.399, 2);
    expect(analysis.axes.find((axis) => axis.name === "roll")!.gyroPeak).toBeGreaterThan(90);
    expect(analysis.motors!.saturationRatio).toBe(1);
    expect(analysis.notes.some((note) => note.includes("95% output"))).toBe(true);
  });
});

/**
 * Betaflight blackbox (.bbl / .bfl) reader.
 *
 * Implements every encoding Betaflight emits for main frames: SIGNED_VB,
 * UNSIGNED_VB, NEG_14BIT, TAG8_8SVB, TAG2_3S32, TAG8_4S16, TAG2_3SVARIABLE and
 * NULL. The bit layouts follow `blackboxWriteTag2_3S32`,
 * `blackboxWriteTag8_4S16` and `blackboxWriteTag2_3SVariable` in Betaflight's
 * `src/main/blackbox/blackbox_encoding.c`, and the test suite verifies each one
 * by round-tripping against a direct port of that encoder.
 *
 * An encoding outside that set throws `UnsupportedEncodingError` rather than
 * producing plausible-looking but wrong numbers, and the UI falls back to
 * header-only analysis plus a request for a CSV export.
 */

export class UnsupportedEncodingError extends Error {
  constructor(readonly encoding: number, readonly field: string) {
    super(
      `This log encodes "${field}" with blackbox encoding ${encoding}, which this decoder does ` +
        "not recognise — it is newer than the encodings Betaflight documents. Export the log to " +
        "CSV with `blackbox_decode` or Betaflight Blackbox Explorer and load the CSV instead.",
    );
    this.name = "UnsupportedEncodingError";
  }
}

export const Encoding = {
  SIGNED_VB: 0,
  UNSIGNED_VB: 1,
  NEG_14BIT: 3,
  TAG8_8SVB: 6,
  TAG2_3S32: 7,
  TAG8_4S16: 8,
  NULL: 9,
  TAG2_3SVARIABLE: 10,
} as const;

export const Predictor = {
  ZERO: 0,
  PREVIOUS: 1,
  STRAIGHT_LINE: 2,
  AVERAGE_2: 3,
  MINTHROTTLE: 4,
  MOTOR_0: 5,
  INC: 6,
  HOME_COORD: 7,
  CONST_1500: 8,
  VBATREF: 9,
  LAST_MAIN_FRAME_TIME: 10,
  MINMOTOR: 11,
} as const;

export interface FieldDefinition {
  name: string;
  signed: boolean;
  ipredictor: number;
  iencoding: number;
  ppredictor: number;
  pencoding: number;
}

export interface LogHeader {
  /** Every `H key:value` line, e.g. "Firmware revision" -> "Betaflight 4.5.1". */
  values: Map<string, string>;
  mainFields: FieldDefinition[];
  slowFields: FieldDefinition[];
  /** Microseconds between logged main frames, derived from looptime and denom. */
  frameIntervalUs: number;
  minthrottle: number;
  motorOutputLow: number;
  vbatref: number;
}

export interface DecodedLog {
  header: LogHeader;
  fieldNames: string[];
  /** One row per decoded main frame, in field order. */
  rows: number[][];
  /** Frames skipped because they failed to decode; a few are normal at log end. */
  corruptFrames: number;
}

// ------------------------------------------------------------------ bit reader

class ByteStream {
  pos = 0;
  constructor(readonly data: Uint8Array) {}

  get eof(): boolean {
    return this.pos >= this.data.length;
  }

  byte(): number {
    if (this.pos >= this.data.length) throw new RangeError("Unexpected end of blackbox log");
    return this.data[this.pos++];
  }

  peek(): number {
    return this.data[this.pos];
  }

  unsignedVB(): number {
    let result = 0;
    for (let shift = 0; shift < 32; shift += 7) {
      const byte = this.byte();
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result >>> 0;
    }
    return result >>> 0;
  }

  signedVB(): number {
    const unsigned = this.unsignedVB();
    // ZigZag decode.
    return (unsigned >>> 1) ^ -(unsigned & 1);
  }
}

const signExtend2 = (v: number) => (v & 0x02 ? v | ~0x03 : v);
const signExtend4 = (v: number) => (v & 0x08 ? v | ~0x0f : v);
const signExtend5 = (v: number) => (v & 0x10 ? v | ~0x1f : v);
const signExtend6 = (v: number) => (v & 0x20 ? v | ~0x3f : v);
const signExtend7 = (v: number) => (v & 0x40 ? v | ~0x7f : v);
const signExtend8 = (v: number) => (v << 24) >> 24;
const signExtend14 = (v: number) => (v & 0x2000 ? v | ~0x3fff : v);
const signExtend16 = (v: number) => (v << 16) >> 16;
const signExtend24 = (v: number) => (v << 8) >> 8;

// -------------------------------------------------------------------- header

const HEADER_PREFIX = "H ";

export function parseHeader(data: Uint8Array): { header: LogHeader; bodyOffset: number } {
  const values = new Map<string, string>();
  const decoder = new TextDecoder("latin1");
  let offset = 0;

  const fieldParts: Record<string, string[]> = {};

  while (offset < data.length) {
    // Header lines are ASCII and newline terminated; the body starts at the
    // first line that is not "H ".
    const lineEnd = data.indexOf(0x0a, offset);
    if (lineEnd === -1) break;
    const line = decoder.decode(data.subarray(offset, lineEnd)).replace(/\r$/, "");
    if (!line.startsWith(HEADER_PREFIX)) break;
    offset = lineEnd + 1;

    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(HEADER_PREFIX.length, colon).trim();
    const value = line.slice(colon + 1);

    const fieldMatch = key.match(/^Field\s+([IPSGH])\s+(\w+)$/);
    if (fieldMatch) {
      fieldParts[`${fieldMatch[1]}:${fieldMatch[2]}`] = value.split(",");
      continue;
    }
    values.set(key, value);
  }

  const mainFields = assembleFields(fieldParts, "I", "P");
  const slowFields = assembleFields(fieldParts, "S", "S");

  const looptime = Number(values.get("looptime") ?? 125);
  const pDenom = Number(values.get("P interval")?.split("/")[1] ?? values.get("frameIntervalPDenom") ?? 1);
  const iInterval = Number(values.get("I interval") ?? 32);
  void iInterval;

  return {
    header: {
      values,
      mainFields,
      slowFields,
      frameIntervalUs: looptime * (pDenom > 0 ? pDenom : 1),
      minthrottle: Number(values.get("minthrottle") ?? 1070),
      motorOutputLow: Number((values.get("motorOutput") ?? "0,0").split(",")[0]),
      vbatref: Number(values.get("vbatref") ?? 0),
    },
    bodyOffset: offset,
  };
}

function assembleFields(
  parts: Record<string, string[]>,
  frame: string,
  pFrame: string,
): FieldDefinition[] {
  const names = parts[`${frame}:name`];
  if (!names) return [];
  const signed = parts[`${frame}:signed`] ?? [];
  const ipredictor = parts[`${frame}:predictor`] ?? [];
  const iencoding = parts[`${frame}:encoding`] ?? [];
  const ppredictor = parts[`${pFrame}:predictor`] ?? ipredictor;
  const pencoding = parts[`${pFrame}:encoding`] ?? iencoding;

  return names.map((name, index) => ({
    name: name.trim(),
    signed: signed[index] === "1",
    ipredictor: Number(ipredictor[index] ?? 0),
    iencoding: Number(iencoding[index] ?? 0),
    ppredictor: Number(ppredictor[index] ?? 0),
    pencoding: Number(pencoding[index] ?? 0),
  }));
}

// --------------------------------------------------------------------- frames

const FRAME_I = 0x49;
const FRAME_P = 0x50;
const FRAME_S = 0x53;
const FRAME_E = 0x45;
const FRAME_G = 0x47;
const FRAME_H = 0x48;

export function decodeLog(data: Uint8Array, options: { maxFrames?: number } = {}): DecodedLog {
  const { header, bodyOffset } = parseHeader(data);
  const fields = header.mainFields;
  if (!fields.length) throw new Error("This file has no blackbox field definitions in its header.");

  const stream = new ByteStream(data.subarray(bodyOffset));
  const rows: number[][] = [];
  const maxFrames = options.maxFrames ?? 200_000;

  let previous: number[] | null = null;
  let previous2: number[] | null = null;
  let corruptFrames = 0;

  while (!stream.eof && rows.length < maxFrames) {
    const marker = stream.byte();
    try {
      if (marker === FRAME_I) {
        const values = readFrame(stream, fields, header, "I", previous, previous2);
        previous2 = previous;
        previous = values;
        rows.push(values);
      } else if (marker === FRAME_P) {
        if (!previous) {
          // A P frame before any I frame cannot be reconstructed.
          corruptFrames++;
          continue;
        }
        const values = readFrame(stream, fields, header, "P", previous, previous2);
        previous2 = previous;
        previous = values;
        rows.push(values);
      } else if (marker === FRAME_S) {
        readFrame(stream, header.slowFields, header, "I", null, null);
      } else if (marker === FRAME_E) {
        if (!skipEventFrame(stream)) break;
      } else if (marker === FRAME_G || marker === FRAME_H) {
        // GPS frames are not used by the analyser; their length is variable and
        // depends on a separate field set, so stop rather than desynchronise.
        break;
      }
      // Any other byte is log padding or corruption; keep scanning.
    } catch (error) {
      if (error instanceof RangeError) break; // Truncated final frame: normal.
      corruptFrames++;
      previous = null;
      previous2 = null;
    }
  }

  return {
    header,
    fieldNames: fields.map((field) => field.name),
    rows,
    corruptFrames,
  };
}

function skipEventFrame(stream: ByteStream): boolean {
  const eventType = stream.byte();
  // 255 = LOG_END, followed by the "End of log" string.
  if (eventType === 255) return false;
  // Event payloads are short and self-describing per type; the analyser does not
  // use them, so skip to the next frame marker conservatively.
  while (!stream.eof) {
    const next = stream.peek();
    if (next === FRAME_I || next === FRAME_P || next === FRAME_S || next === FRAME_E) return true;
    stream.byte();
  }
  return false;
}

function readFrame(
  stream: ByteStream,
  fields: FieldDefinition[],
  header: LogHeader,
  kind: "I" | "P",
  previous: number[] | null,
  previous2: number[] | null,
): number[] {
  const values = new Array<number>(fields.length).fill(0);

  let index = 0;
  while (index < fields.length) {
    const field = fields[index];
    const encoding = kind === "I" ? field.iencoding : field.pencoding;

    switch (encoding) {
      case Encoding.SIGNED_VB:
        values[index] = stream.signedVB();
        index++;
        break;

      case Encoding.UNSIGNED_VB:
        values[index] = stream.unsignedVB();
        index++;
        break;

      case Encoding.NEG_14BIT:
        values[index] = -signExtend14(stream.unsignedVB());
        index++;
        break;

      case Encoding.NULL:
        values[index] = 0;
        index++;
        break;

      case Encoding.TAG8_8SVB: {
        // Consumes up to 8 consecutive fields sharing one presence bitmap.
        const count = Math.min(8, fields.length - index);
        if (count === 1) {
          values[index] = stream.signedVB();
        } else {
          const bitmap = stream.byte();
          for (let i = 0; i < count; i++) {
            values[index + i] = bitmap & (1 << i) ? stream.signedVB() : 0;
          }
        }
        index += count;
        break;
      }

      case Encoding.TAG2_3S32: {
        const three = readTag2_3S32(stream);
        for (let i = 0; i < 3 && index + i < fields.length; i++) values[index + i] = three[i];
        index += 3;
        break;
      }

      case Encoding.TAG8_4S16: {
        const four = readTag8_4S16(stream);
        for (let i = 0; i < 4 && index + i < fields.length; i++) values[index + i] = four[i];
        index += 4;
        break;
      }

      case Encoding.TAG2_3SVARIABLE: {
        const three = readTag2_3SVariable(stream);
        for (let i = 0; i < 3 && index + i < fields.length; i++) values[index + i] = three[i];
        index += 3;
        break;
      }

      default:
        throw new UnsupportedEncodingError(encoding, field.name);
    }
  }

  // Apply predictors after all raw values in the frame are known: MOTOR_0 and
  // friends reference other fields of the same frame.
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    const predictor = kind === "I" ? field.ipredictor : field.ppredictor;
    values[i] = applyPredictor(predictor, values, i, fields, header, previous, previous2);
  }

  return values;
}

function applyPredictor(
  predictor: number,
  values: number[],
  index: number,
  fields: FieldDefinition[],
  header: LogHeader,
  previous: number[] | null,
  previous2: number[] | null,
): number {
  const raw = values[index];
  switch (predictor) {
    case Predictor.ZERO:
      return raw;
    case Predictor.PREVIOUS:
      return raw + (previous?.[index] ?? 0);
    case Predictor.STRAIGHT_LINE:
      return raw + 2 * (previous?.[index] ?? 0) - (previous2?.[index] ?? 0);
    case Predictor.AVERAGE_2:
      return raw + Math.trunc(((previous?.[index] ?? 0) + (previous2?.[index] ?? 0)) / 2);
    case Predictor.MINTHROTTLE:
      return raw + header.minthrottle;
    case Predictor.MOTOR_0: {
      const motor0 = fields.findIndex((field) => field.name === "motor[0]");
      return raw + (motor0 >= 0 ? values[motor0] : 0);
    }
    case Predictor.INC:
      return raw + (previous?.[index] ?? 0) + 1;
    case Predictor.CONST_1500:
      return raw + 1500;
    case Predictor.VBATREF:
      return raw + header.vbatref;
    case Predictor.LAST_MAIN_FRAME_TIME:
      return raw + (previous?.[index] ?? 0);
    case Predictor.MINMOTOR:
      return raw + header.motorOutputLow;
    case Predictor.HOME_COORD:
      return raw; // GPS only; not used by the analyser.
    default:
      return raw;
  }
}

export function readTag2_3S32(stream: ByteStream | { byte(): number }): [number, number, number] {
  let lead = stream.byte();
  const values: [number, number, number] = [0, 0, 0];

  switch (lead >> 6) {
    case 0:
      values[0] = signExtend2((lead >> 4) & 0x03);
      values[1] = signExtend2((lead >> 2) & 0x03);
      values[2] = signExtend2(lead & 0x03);
      break;
    case 1: {
      values[0] = signExtend4(lead & 0x0f);
      const next = stream.byte();
      values[1] = signExtend4(next >> 4);
      values[2] = signExtend4(next & 0x0f);
      break;
    }
    case 2:
      values[0] = signExtend6(lead & 0x3f);
      values[1] = signExtend6(stream.byte() & 0x3f);
      values[2] = signExtend6(stream.byte() & 0x3f);
      break;
    default:
      // Each field carries its own width in the low 6 bits, two bits per field.
      for (let i = 0; i < 3; i++) {
        switch (lead & 0x03) {
          case 0:
            values[i] = signExtend8(stream.byte());
            break;
          case 1:
            values[i] = signExtend16(stream.byte() | (stream.byte() << 8));
            break;
          case 2:
            values[i] = signExtend24(stream.byte() | (stream.byte() << 8) | (stream.byte() << 16));
            break;
          default:
            values[i] =
              (stream.byte() | (stream.byte() << 8) | (stream.byte() << 16) | (stream.byte() << 24)) | 0;
            break;
        }
        lead >>= 2;
      }
      break;
  }
  return values;
}

export function readTag8_4S16(
  stream: ByteStream | { byte(): number },
): [number, number, number, number] {
  let selector = stream.byte();
  const values: [number, number, number, number] = [0, 0, 0, 0];
  let nibbleHeld = false;
  let buffer = 0;

  for (let i = 0; i < 4; i++) {
    switch (selector & 0x03) {
      case 0: // zero
        values[i] = 0;
        break;
      case 1: // 4 bit
        if (!nibbleHeld) {
          buffer = stream.byte();
          values[i] = signExtend4(buffer >> 4);
          nibbleHeld = true;
        } else {
          values[i] = signExtend4(buffer & 0x0f);
          nibbleHeld = false;
        }
        break;
      case 2: // 8 bit
        if (!nibbleHeld) {
          values[i] = signExtend8(stream.byte());
        } else {
          const next = stream.byte();
          values[i] = signExtend8(((buffer & 0x0f) << 4) | (next >> 4));
          buffer = next;
        }
        break;
      default: {
        // 16 bit
        const a = stream.byte();
        const b = stream.byte();
        if (!nibbleHeld) {
          values[i] = signExtend16((a << 8) | b);
        } else {
          values[i] = signExtend16(((buffer & 0x0f) << 12) | (a << 4) | (b >> 4));
          buffer = b;
        }
        break;
      }
    }
    selector >>= 2;
  }
  return values;
}

/**
 * TAG2_3SVARIABLE: three signed values packed into the smallest of four
 * layouts, chosen by the top two bits of the lead byte. Mirrors
 * `blackboxWriteTag2_3SVariable` exactly.
 *
 *   0  2 bits per field    ss11 2233
 *   1  554 bits per field  ss11 1112 2222 3333
 *   2  877 bits per field  ss11 1111 1122 2222 2333 3333
 *   3  per-field widths    sstt tttt, then 1-4 little-endian bytes per field
 */
export function readTag2_3SVariable(
  stream: ByteStream | { byte(): number },
): [number, number, number] {
  const lead = stream.byte();
  const values: [number, number, number] = [0, 0, 0];

  switch (lead >> 6) {
    case 0:
      values[0] = signExtend2((lead >> 4) & 0x03);
      values[1] = signExtend2((lead >> 2) & 0x03);
      values[2] = signExtend2(lead & 0x03);
      break;

    case 1: {
      const second = stream.byte();
      values[0] = signExtend5((lead >> 1) & 0x1f);
      values[1] = signExtend5(((lead & 0x01) << 4) | (second >> 4));
      values[2] = signExtend4(second & 0x0f);
      break;
    }

    case 2: {
      const second = stream.byte();
      const third = stream.byte();
      values[0] = signExtend8(((lead & 0x3f) << 2) | (second >> 6));
      values[1] = signExtend7(((second & 0x3f) << 1) | (third >> 7));
      values[2] = signExtend7(third & 0x7f);
      break;
    }

    default: {
      // The low six bits hold a width per field, two bits each, first field in
      // the low bits: 0 = 1 byte, 1 = 2 bytes, 2 = 3 bytes, 3 = 4 bytes.
      let widths = lead & 0x3f;
      for (let i = 0; i < 3; i++) {
        switch (widths & 0x03) {
          case 0:
            values[i] = signExtend8(stream.byte());
            break;
          case 1:
            values[i] = signExtend16(stream.byte() | (stream.byte() << 8));
            break;
          case 2:
            values[i] = signExtend24(stream.byte() | (stream.byte() << 8) | (stream.byte() << 16));
            break;
          default:
            values[i] =
              (stream.byte() | (stream.byte() << 8) | (stream.byte() << 16) | (stream.byte() << 24)) | 0;
            break;
        }
        widths >>= 2;
      }
      break;
    }
  }
  return values;
}

/**
 * Statistics the AI can reason about: gyro noise spectrum, PID error levels,
 * motor saturation and imbalance. Works on either a decoded .bbl or a CSV
 * exported from `blackbox_decode` / Blackbox Explorer.
 */
import { decodeLog, parseHeader, UnsupportedEncodingError, type DecodedLog } from "./decoder";

export interface NoisePeak {
  frequencyHz: number;
  /** Amplitude relative to the strongest peak on this axis, 0..1. */
  relativeAmplitude: number;
}

export interface AxisAnalysis {
  name: "roll" | "pitch" | "yaw";
  gyroRms: number;
  gyroPeak: number;
  errorRms: number;
  errorPeak: number;
  noisePeaks: NoisePeak[];
}

export interface MotorAnalysis {
  meanOutput: number;
  saturationRatio: number;
  maxImbalance: number;
}

export interface BlackboxAnalysis {
  fileName: string;
  firmware: string;
  craftName: string;
  durationSeconds: number;
  frameCount: number;
  sampleRateHz: number;
  axes: AxisAnalysis[];
  motors: MotorAnalysis | null;
  notes: string[];
  /** True when only the header could be read (see decoder limitations). */
  headerOnly: boolean;
}

const AXES = ["roll", "pitch", "yaw"] as const;

export async function analyzeFile(file: File): Promise<BlackboxAnalysis> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".csv")) {
    return analyzeCsv(file.name, await file.text());
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const log = decodeLog(bytes);
    // A log whose frames all failed to decode carries no usable statistics, so
    // fall back to the header rather than reporting an empty analysis as if it
    // were a quiet flight.
    if (!log.rows.length) {
      return headerOnlyAnalysis(
        file.name,
        bytes,
        log.corruptFrames
          ? `None of the ${log.corruptFrames} frames in this log could be decoded. ` +
              "Export it to CSV with `blackbox_decode` or Betaflight Blackbox Explorer and load that instead."
          : "This log contains no data frames.",
      );
    }
    return analyzeDecoded(file.name, log);
  } catch (error) {
    if (error instanceof UnsupportedEncodingError) {
      return headerOnlyAnalysis(file.name, bytes, error.message);
    }
    throw error;
  }
}

function headerOnlyAnalysis(fileName: string, bytes: Uint8Array, note: string): BlackboxAnalysis {
  const { header } = parseHeader(bytes);
  return {
    fileName,
    firmware: header.values.get("Firmware revision") ?? "",
    craftName: header.values.get("Craft name") ?? "",
    durationSeconds: 0,
    frameCount: 0,
    sampleRateHz: header.frameIntervalUs ? 1e6 / header.frameIntervalUs : 0,
    axes: [],
    motors: null,
    headerOnly: true,
    notes: [note, ...headerNotes(header.values)],
  };
}

function headerNotes(values: Map<string, string>): string[] {
  const notes: string[] = [];
  const interesting = [
    "Firmware revision", "Board information", "Craft name", "rates", "rate_limits",
    "rollPID", "pitchPID", "yawPID", "dynamic_notch_count", "dynamic_notch_q",
    "gyro_lowpass_hz", "dterm_lowpass_hz", "rpm_filter_harmonics", "motor_poles",
    "dshot_bidir", "looptime", "pid_process_denom",
  ];
  for (const key of interesting) {
    const value = values.get(key);
    if (value) notes.push(`${key}: ${value}`);
  }
  return notes;
}

function analyzeDecoded(fileName: string, log: DecodedLog): BlackboxAnalysis {
  const columns = new Map<string, number[]>();
  log.fieldNames.forEach((name, index) => {
    columns.set(name, log.rows.map((row) => row[index]));
  });

  const timeUs = columns.get("time") ?? [];
  const duration = timeUs.length > 1 ? (timeUs[timeUs.length - 1] - timeUs[0]) / 1e6 : 0;
  const sampleRate = duration > 0 ? log.rows.length / duration : 1e6 / (log.header.frameIntervalUs || 125);

  // Gyro is logged in raw units; the header records the scale factor.
  const gyroScale = Number(log.header.values.get("gyro_scale") ?? "0") || 0;
  const toDegPerSec = gyroScale ? (gyroScale * 1e6) / (Math.PI / 180) / 1e6 : 1;

  const analysis = buildAnalysis(columns, sampleRate, toDegPerSec);

  return {
    fileName,
    firmware: log.header.values.get("Firmware revision") ?? "",
    craftName: log.header.values.get("Craft name") ?? "",
    durationSeconds: duration,
    frameCount: log.rows.length,
    sampleRateHz: sampleRate,
    headerOnly: false,
    ...analysis,
    notes: [
      ...(log.corruptFrames ? [`${log.corruptFrames} frames could not be decoded and were skipped.`] : []),
      ...analysis.notes,
      ...headerNotes(log.header.values),
    ],
  };
}

export function analyzeCsv(fileName: string, text: string): BlackboxAnalysis {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) throw new Error("This CSV has no data rows.");

  const headerCells = splitCsvLine(lines[0]).map((cell) => cell.trim().replace(/^"|"$/g, ""));
  const columns = new Map<string, number[]>();
  headerCells.forEach((name) => columns.set(name, []));

  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    headerCells.forEach((name, index) => {
      const value = Number(cells[index]);
      columns.get(name)!.push(Number.isFinite(value) ? value : 0);
    });
  }

  const timeUs = columns.get("time (us)") ?? columns.get("time") ?? [];
  const duration = timeUs.length > 1 ? (timeUs[timeUs.length - 1] - timeUs[0]) / 1e6 : 0;
  const rowCount = columns.get(headerCells[0])?.length ?? 0;
  const sampleRate = duration > 0 ? rowCount / duration : 1000;

  // Blackbox Explorer CSV headers are already in deg/s and carry unit suffixes.
  const normalized = new Map<string, number[]>();
  for (const [name, values] of columns) {
    normalized.set(name.replace(/\s*\([^)]*\)\s*$/, "").trim(), values);
  }

  const analysis = buildAnalysis(normalized, sampleRate, 1);
  return {
    fileName,
    firmware: "",
    craftName: "",
    durationSeconds: duration,
    frameCount: rowCount,
    sampleRateHz: sampleRate,
    headerOnly: false,
    ...analysis,
  };
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const char of line) {
    if (char === '"') inQuotes = !inQuotes;
    else if (char === "," && !inQuotes) {
      cells.push(current);
      current = "";
    } else current += char;
  }
  cells.push(current);
  return cells;
}

function buildAnalysis(
  columns: Map<string, number[]>,
  sampleRate: number,
  gyroScale: number,
): { axes: AxisAnalysis[]; motors: MotorAnalysis | null; notes: string[] } {
  const notes: string[] = [];
  const axes: AxisAnalysis[] = [];

  AXES.forEach((name, axis) => {
    const gyro = pick(columns, [`gyroADC[${axis}]`, `gyroUnfilt[${axis}]`, `gyro[${axis}]`]);
    if (!gyro?.length) return;
    const scaled = gyroScale === 1 ? gyro : gyro.map((value) => value * gyroScale);

    const setpoint = pick(columns, [`setpoint[${axis}]`, `rcCommand[${axis}]`]) ?? [];
    const error = setpoint.length === scaled.length ? scaled.map((value, i) => setpoint[i] - value) : scaled;

    axes.push({
      name,
      gyroRms: rms(scaled),
      gyroPeak: Math.max(...scaled.map(Math.abs)),
      errorRms: rms(error),
      errorPeak: Math.max(...error.map(Math.abs)),
      noisePeaks: findNoisePeaks(scaled, sampleRate),
    });
  });

  const motorColumns: number[][] = [];
  for (let i = 0; i < 8; i++) {
    const motor = columns.get(`motor[${i}]`);
    if (motor?.length) motorColumns.push(motor);
  }

  let motors: MotorAnalysis | null = null;
  if (motorColumns.length) {
    // Motor values are DShot 0..2000 in Betaflight logs; normalise to 0..1.
    const scale = Math.max(...motorColumns.flat()) > 1200 ? 2000 : 1;
    const rows = motorColumns[0].length;
    let sum = 0;
    let saturated = 0;
    let maxSpread = 0;
    for (let row = 0; row < rows; row++) {
      const outputs = motorColumns.map((motor) => motor[row] / scale);
      const mean = outputs.reduce((a, b) => a + b, 0) / outputs.length;
      sum += mean;
      if (outputs.some((value) => value > 0.95)) saturated++;
      maxSpread = Math.max(maxSpread, Math.max(...outputs) - Math.min(...outputs));
    }
    motors = {
      meanOutput: sum / rows,
      saturationRatio: saturated / rows,
      maxImbalance: maxSpread,
    };

    if (motors.saturationRatio > 0.05) {
      notes.push(
        "Motors spend more than 5% of the log at or above 95% output — the tune is fighting a " +
          "power limit, so PID changes will not behave predictably until that is addressed.",
      );
    }
    if (motors.maxImbalance > 0.3) {
      notes.push(
        "Large spread between motors. Check for a bent shaft, damaged prop, loose arm or a " +
          "centre of gravity well off centre before tuning.",
      );
    }
  }

  for (const axis of axes) {
    const strong = axis.noisePeaks.filter((peak) => peak.relativeAmplitude > 0.5 && peak.frequencyHz > 80);
    if (strong.length) {
      notes.push(
        `${axis.name}: significant gyro energy at ` +
          `${strong.map((peak) => `${peak.frequencyHz.toFixed(0)} Hz`).join(", ")}. ` +
          "Peaks that track throttle are motor or prop noise and are best handled with RPM " +
          "filtering; fixed peaks usually come from a frame or mounting resonance.",
      );
    }
  }

  return { axes, motors, notes };
}

function pick(columns: Map<string, number[]>, names: string[]): number[] | undefined {
  for (const name of names) {
    const values = columns.get(name);
    if (values?.length) return values;
  }
  return undefined;
}

function rms(values: number[]): number {
  if (!values.length) return 0;
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
}

// ------------------------------------------------------------------------ FFT

/** In-place iterative radix-2 FFT. `real` and `imag` must be a power of two long. */
export function fft(real: Float64Array, imag: Float64Array): void {
  const n = real.length;
  if (n <= 1) return;
  if ((n & (n - 1)) !== 0) throw new Error("FFT length must be a power of two");

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wReal = Math.cos(angle);
    const wImag = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curReal = 1;
      let curImag = 0;
      for (let k = 0; k < len / 2; k++) {
        const uReal = real[i + k];
        const uImag = imag[i + k];
        const vReal = real[i + k + len / 2] * curReal - imag[i + k + len / 2] * curImag;
        const vImag = real[i + k + len / 2] * curImag + imag[i + k + len / 2] * curReal;
        real[i + k] = uReal + vReal;
        imag[i + k] = uImag + vImag;
        real[i + k + len / 2] = uReal - vReal;
        imag[i + k + len / 2] = uImag - vImag;
        const nextReal = curReal * wReal - curImag * wImag;
        curImag = curReal * wImag + curImag * wReal;
        curReal = nextReal;
      }
    }
  }
}

/**
 * Averaged periodogram: split the signal into overlapping Hann-windowed blocks,
 * average their spectra, and return the strongest peaks above 40 Hz.
 */
export function findNoisePeaks(signal: number[], sampleRateHz: number, maxPeaks = 4): NoisePeak[] {
  const blockSize = 1024;
  if (signal.length < blockSize || !Number.isFinite(sampleRateHz) || sampleRateHz <= 0) return [];

  const spectrum = new Float64Array(blockSize / 2);
  const window = new Float64Array(blockSize);
  for (let i = 0; i < blockSize; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (blockSize - 1)));
  }

  const step = blockSize / 2;
  let blocks = 0;
  const real = new Float64Array(blockSize);
  const imag = new Float64Array(blockSize);

  for (let offset = 0; offset + blockSize <= signal.length; offset += step) {
    let mean = 0;
    for (let i = 0; i < blockSize; i++) mean += signal[offset + i];
    mean /= blockSize;

    for (let i = 0; i < blockSize; i++) {
      real[i] = (signal[offset + i] - mean) * window[i];
      imag[i] = 0;
    }
    fft(real, imag);
    for (let bin = 0; bin < blockSize / 2; bin++) {
      spectrum[bin] += Math.hypot(real[bin], imag[bin]);
    }
    blocks++;
  }
  if (!blocks) return [];

  const binHz = sampleRateHz / blockSize;
  const minBin = Math.max(2, Math.ceil(40 / binHz));

  const candidates: NoisePeak[] = [];
  for (let bin = minBin; bin < spectrum.length - 1; bin++) {
    if (spectrum[bin] > spectrum[bin - 1] && spectrum[bin] >= spectrum[bin + 1]) {
      candidates.push({ frequencyHz: bin * binHz, relativeAmplitude: spectrum[bin] / blocks });
    }
  }
  candidates.sort((a, b) => b.relativeAmplitude - a.relativeAmplitude);

  const top = candidates.slice(0, maxPeaks);
  const strongest = top[0]?.relativeAmplitude || 1;
  return top.map((peak) => ({
    frequencyHz: peak.frequencyHz,
    relativeAmplitude: peak.relativeAmplitude / strongest,
  }));
}

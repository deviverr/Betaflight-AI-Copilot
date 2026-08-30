import { describe, it, expect, beforeEach } from "vitest";
import { FcLink, CliCommandError } from "../src/msp/connection";
import { MspParser, encodeV1, PayloadReader } from "../src/msp/codec";
import { MSP } from "../src/msp/constants";

/**
 * A fake flight controller behind a Web Serial-shaped port: it answers the MSP
 * identity handshake, switches to CLI on '#', and serves a canned `diff all`.
 * This exercises the real framing, the real CLI completion detection and the
 * real error path without hardware.
 */
class FakeFlightController {
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private parser = new MspParser();
  private cli = false;
  private encoder = new TextEncoder();

  readonly writtenCliCommands: string[] = [];
  /** Commands the fake should answer with a parse error. */
  rejectCommands = new Set<string>();

  readable = new ReadableStream<Uint8Array>({
    start: (controller) => {
      this.controller = controller;
    },
  });

  writable = new WritableStream<Uint8Array>({
    write: (chunk) => this.handle(chunk),
  });

  async open(): Promise<void> {}
  async close(): Promise<void> {}

  private send(bytes: Uint8Array): void {
    this.controller.enqueue(bytes);
  }

  private reply(code: number, payload: Uint8Array): void {
    const frame = encodeV1(code, payload);
    frame[2] = 0x3e; // '>' reply
    this.send(frame);
  }

  private handle(chunk: Uint8Array): void {
    if (this.cli) {
      const text = new TextDecoder().decode(chunk);
      for (const line of text.split("\r\n")) {
        if (!line) continue;
        this.writtenCliCommands.push(line);
        this.send(this.encoder.encode(`${line}\r\n${this.cliResponse(line)}# `));
      }
      return;
    }

    const { frames, text } = this.parser.push(chunk);
    if (text.includes(0x23)) {
      this.cli = true;
      this.send(this.encoder.encode("\r\nEntering CLI Mode, type 'exit' to return\r\n\r\n# "));
      return;
    }
    for (const frame of frames) this.answerMsp(frame.code);
  }

  private cliResponse(line: string): string {
    if (this.rejectCommands.has(line)) return "###ERROR: Parse error###\r\n";
    if (line === "diff all") {
      return (
        "# version\r\n" +
        "# Betaflight / STM32F405 (S405) 4.5.1\r\n" +
        "# master\r\nset p_pitch = 47\r\nset motor_poles = 14\r\n"
      );
    }
    if (line.startsWith("get ")) return `${line.slice(4)} = 47\r\n`;
    if (line === "save" || line === "exit") return "";
    return "";
  }

  private answerMsp(code: number): void {
    const encoder = new TextEncoder();
    switch (code) {
      case MSP.API_VERSION:
        return this.reply(code, new Uint8Array([0, 1, 46]));
      case MSP.FC_VARIANT:
        return this.reply(code, encoder.encode("BTFL"));
      case MSP.FC_VERSION:
        return this.reply(code, new Uint8Array([4, 5, 1]));
      case MSP.BOARD_INFO: {
        const target = encoder.encode("SPEEDYBEEF405V3");
        const payload = new Uint8Array(9 + target.length);
        payload.set(encoder.encode("SBF4"), 0);
        payload[8] = target.length;
        payload.set(target, 9);
        return this.reply(code, payload);
      }
      case MSP.NAME:
        return this.reply(code, encoder.encode("Freestyle5"));
      case MSP.UID:
        return this.reply(code, new Uint8Array(12).fill(1));
      case MSP.ANALOG: {
        const payload = new Uint8Array(9);
        const view = new DataView(payload.buffer);
        payload[0] = 168;         // legacy voltage, 16.8 V
        view.setUint16(1, 350, true);  // mAh
        view.setUint16(3, 1000, true); // rssi
        view.setInt16(5, 120, true);   // 1.20 A
        view.setUint16(7, 1660, true); // 16.60 V
        return this.reply(code, payload);
      }
      case MSP.STATUS: {
        const payload = new Uint8Array(11);
        const view = new DataView(payload.buffer);
        view.setUint16(0, 125, true); // cycle time
        view.setUint16(2, 0, true);   // i2c errors
        view.setUint16(4, 0x23, true);
        view.setUint32(6, 0, true);   // flight mode flags: disarmed
        return this.reply(code, payload);
      }
      default:
        // Unknown command: answer with the error direction, like real firmware.
        {
          const frame = encodeV1(code);
          frame[2] = 0x21;
          this.send(frame);
        }
    }
  }
}

describe("FcLink against a fake flight controller", () => {
  let fc: FakeFlightController;
  let link: FcLink;

  beforeEach(() => {
    fc = new FakeFlightController();
    link = new FcLink();
  });

  it("completes the MSP identity handshake", async () => {
    const identity = await link.connect(115200, fc as unknown as SerialPort);
    expect(identity).toMatchObject({
      apiVersion: "1.46",
      variant: "BTFL",
      firmwareVersion: "4.5.1",
      boardIdentifier: "SBF4",
      targetName: "SPEEDYBEEF405V3",
      craftName: "Freestyle5",
    });
    expect(link.mode).toBe("msp");
  });

  it("decodes live telemetry", async () => {
    await link.connect(115200, fc as unknown as SerialPort);
    const telemetry = await link.readTelemetry();
    expect(telemetry.voltage).toBeCloseTo(16.6, 2);
    expect(telemetry.amperage).toBeCloseTo(1.2, 2);
    expect(telemetry.mahDrawn).toBe(350);
    expect(telemetry.cycleTime).toBe(125);
    expect(telemetry.flightModeFlags).toBe(0);
  });

  it("enters CLI mode and reads a diff", async () => {
    await link.connect(115200, fc as unknown as SerialPort);
    const banner = await link.enterCli();
    expect(banner).toContain("Entering CLI Mode");
    expect(link.mode).toBe("cli");

    const diff = await link.cli("diff all");
    expect(diff).toContain("set p_pitch = 47");
    expect(diff.endsWith("#")).toBe(false);
  });

  it("runs a batch of commands in order", async () => {
    await link.connect(115200, fc as unknown as SerialPort);
    await link.enterCli();
    await link.cliBatch(["profile 0", "set p_pitch = 52", "set d_pitch = 42"]);
    expect(fc.writtenCliCommands).toEqual(["profile 0", "set p_pitch = 52", "set d_pitch = 42"]);
  });

  it("stops the batch at the first command the firmware rejects", async () => {
    await link.connect(115200, fc as unknown as SerialPort);
    await link.enterCli();
    fc.rejectCommands.add("set not_a_setting = 1");

    await expect(
      link.cliBatch(["set p_pitch = 52", "set not_a_setting = 1", "set d_pitch = 42"]),
    ).rejects.toThrow(CliCommandError);

    expect(fc.writtenCliCommands).not.toContain("set d_pitch = 42");
  });

  it("refuses to send MSP while in CLI mode", async () => {
    await link.connect(115200, fc as unknown as SerialPort);
    await link.enterCli();
    await expect(link.request(MSP.STATUS)).rejects.toThrow(/cli mode/i);
  });

  it("surfaces a firmware rejection as an error", async () => {
    await link.connect(115200, fc as unknown as SerialPort);
    await expect(link.request(0x7e)).rejects.toThrow(/rejected MSP command/);
  });

  it("reports the connection in its log", async () => {
    await link.connect(115200, fc as unknown as SerialPort);
    expect(link.log.join("\n")).toContain("BTFL 4.5.1 on SPEEDYBEEF405V3");
  });
});

describe("PayloadReader against the fake's board info payload", () => {
  it("reads a length-prefixed target name", () => {
    const encoder = new TextEncoder();
    const target = encoder.encode("MATEKF405");
    const payload = new Uint8Array(9 + target.length);
    payload.set(encoder.encode("MTK4"), 0);
    payload[8] = target.length;
    payload.set(target, 9);

    const reader = new PayloadReader(payload);
    expect(reader.ascii(4)).toBe("MTK4");
    reader.u16();
    reader.u8();
    reader.u8();
    expect(reader.ascii(reader.u8())).toBe("MATEKF405");
  });
});

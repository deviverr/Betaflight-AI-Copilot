/**
 * A simulated flight controller behind a Web Serial-shaped port.
 *
 * It lets someone try the copilot end to end — connect, read a config, get a
 * proposal, approve it, watch it apply — without owning a quad or plugging
 * anything in. It speaks the real MSP framing and the real CLI grammar, so it
 * exercises the same code path the hardware does; only the wire is fake.
 *
 * The simulated craft is an ordinary 5-inch 6S freestyle build with a few
 * deliberately imperfect settings, so the copilot has something to find.
 */
import { MspParser, encodeV1 } from "./codec";
import { MSP } from "./constants";

/** Non-default settings the simulated board reports from `diff all`. */
const MASTER: Record<string, string> = {
  gyro_lpf1_static_hz: "0",
  gyro_lpf1_dyn_min_hz: "250",
  gyro_lpf1_dyn_max_hz: "500",
  gyro_lpf2_static_hz: "500",
  dyn_notch_count: "3",
  dyn_notch_q: "300",
  dyn_notch_min_hz: "100",
  dyn_notch_max_hz: "600",
  // Bidirectional DShot is off, so RPM filtering cannot work — something for
  // the copilot to notice.
  dshot_bidir: "OFF",
  rpm_filter_harmonics: "3",
  motor_poles: "14",
  motor_pwm_protocol: "DSHOT600",
  motor_output_limit: "100",
  vbat_max_cell_voltage: "435",
  vbat_min_cell_voltage: "330",
  vbat_warning_cell_voltage: "350",
  battery_capacity: "1300",
  serialrx_provider: "CRSF",
  failsafe_procedure: "DROP",
  small_angle: "180",
  blackbox_sample_rate: "1/2",
  osd_warn_batt_not_full: "OFF",
};

const PROFILE_0: Record<string, string> = {
  p_pitch: "47",
  i_pitch: "84",
  d_pitch: "40",
  f_pitch: "125",
  p_roll: "45",
  i_roll: "80",
  d_roll: "38",
  f_roll: "120",
  p_yaw: "45",
  i_yaw: "80",
  d_yaw: "0",
  f_yaw: "120",
  d_max_pitch: "55",
  d_max_roll: "50",
  // A low D-term lowpass adds delay, which shows up as propwash — the classic
  // complaint the copilot is asked about in the demo.
  dterm_lpf1_dyn_min_hz: "75",
  dterm_lpf1_dyn_max_hz: "145",
  dterm_lpf2_static_hz: "150",
  anti_gravity_gain: "80",
  feedforward_transition: "0",
  iterm_relax_cutoff: "15",
  tpa_rate: "65",
  tpa_breakpoint: "1350",
};

const RATEPROFILE_0: Record<string, string> = {
  rates_type: "ACTUAL",
  roll_rc_rate: "12",
  pitch_rc_rate: "12",
  yaw_rc_rate: "12",
  roll_srate: "67",
  pitch_srate: "67",
  yaw_srate: "67",
  roll_expo: "0",
  pitch_expo: "0",
  yaw_expo: "0",
  thr_mid: "50",
  thr_expo: "0",
};

const DIRECTIVES = [
  "board_name SPEEDYBEEF405V4",
  "manufacturer_id SPBE",
  "mixer QUADX",
  "feature -RX_PARALLEL_PWM",
  "feature RX_SERIAL",
  "feature TELEMETRY",
  "feature AIRMODE",
  "feature OSD",
  "serial 0 64 115200 57600 0 115200",
  "serial 1 1024 115200 57600 0 115200",
  "aux 0 0 0 1700 2100 0 0",
  "aux 1 1 1 1700 2100 0 0",
  "aux 2 13 2 1700 2100 0 0",
  "vtxtable bands 5",
];

export class SimulatedFlightController {
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private parser = new MspParser();
  private encoder = new TextEncoder();
  private cli = false;
  private opened = false;

  private master = { ...MASTER };
  private profile = { ...PROFILE_0 };
  private rateProfile = { ...RATEPROFILE_0 };
  private activeProfile = 0;
  private activeRateProfile = 0;
  /** Which section subsequent `set` commands land in, as on a real board. */
  private scope: "master" | "profile" | "rateprofile" = "master";

  private startedAt = Date.now();
  private savedCount = 0;

  readable = new ReadableStream<Uint8Array>({
    start: (controller) => {
      this.controller = controller;
    },
  });

  writable = new WritableStream<Uint8Array>({
    write: (chunk) => this.handle(chunk),
  });

  async open(): Promise<void> {
    if (this.opened) throw new Error("Simulated port already open");
    this.opened = true;
  }

  async close(): Promise<void> {
    this.opened = false;
  }

  // ------------------------------------------------------------------ wire

  private send(bytes: Uint8Array): void {
    // A real board takes a moment to answer; a little latency keeps the UI
    // honest about what a connection feels like.
    setTimeout(() => {
      try {
        this.controller.enqueue(bytes);
      } catch {
        // The stream is closed; the app has disconnected.
      }
    }, 8);
  }

  private text(value: string): void {
    this.send(this.encoder.encode(value));
  }

  private reply(code: number, payload: Uint8Array): void {
    const frame = encodeV1(code, payload);
    frame[2] = 0x3e; // '>'
    this.send(frame);
  }

  private handle(chunk: Uint8Array): void {
    if (this.cli) {
      const incoming = new TextDecoder().decode(chunk);
      for (const line of incoming.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.text(`${line}\r\n${this.runCli(line.trim())}# `);
      }
      return;
    }

    const { frames, text } = this.parser.push(chunk);
    if (text.includes(0x23)) {
      this.cli = true;
      this.text(
        "\r\nEntering CLI Mode, type 'exit' to return, or 'help'\r\n\r\n# ",
      );
      return;
    }
    for (const frame of frames) this.answerMsp(frame.code);
  }

  // ------------------------------------------------------------------- CLI

  private runCli(line: string): string {
    const [head, ...rest] = line.split(/\s+/);
    const command = head.toLowerCase();

    switch (command) {
      case "exit":
      case "save":
        if (command === "save") this.savedCount++;
        this.cli = false;
        this.parser.reset();
        // A real board reboots here and the USB device re-enumerates.
        setTimeout(() => {
          try {
            this.controller.close();
          } catch {
            // Already closed.
          }
        }, 50);
        return command === "save" ? "Saving\r\n" : "Leaving CLI mode\r\n";

      case "profile":
        if (rest.length) {
          this.activeProfile = Number(rest[0]) || 0;
          this.scope = "profile";
          return `profile ${this.activeProfile}\r\n`;
        }
        return `profile ${this.activeProfile}\r\n`;

      case "rateprofile":
        if (rest.length) {
          this.activeRateProfile = Number(rest[0]) || 0;
          this.scope = "rateprofile";
          return `rateprofile ${this.activeRateProfile}\r\n`;
        }
        return `rateprofile ${this.activeRateProfile}\r\n`;

      case "get": {
        const key = rest[0]?.toLowerCase() ?? "";
        const value = this.lookup(key);
        return value === undefined
          ? `###ERROR: INVALID NAME: ${key}###\r\n`
          : `${key} = ${value}\r\n`;
      }

      case "set": {
        const assignment = rest.join(" ");
        const match = assignment.match(/^([a-z0-9_]+)\s*=\s*(.+)$/i);
        if (!match) return "###ERROR: PARSE ERROR###\r\n";
        const [, key, value] = match;
        const lower = key.toLowerCase();
        if (this.lookup(lower) === undefined && !this.isKnownDefault(lower)) {
          return `###ERROR: INVALID NAME: ${lower}###\r\n`;
        }
        this.assign(lower, value.trim());
        return `${lower} set to ${value.trim()}\r\n`;
      }

      case "feature": {
        const name = rest.join(" ");
        if (!name) return DIRECTIVES.filter((d) => d.startsWith("feature")).join("\r\n") + "\r\n";
        return `Enabled/disabled ${name}\r\n`;
      }

      case "diff":
      case "dump":
        return this.dump(command === "dump");

      case "status":
        return (
          `MCU F405 Clock=168MHz, Vref=3.30V, Core temp=38degC\r\n` +
          `Stack size: 2048, Stack address: 0x2001fff0\r\n` +
          `Config size: 3612, Max available config: 16384\r\n` +
          `Gyros detected: gyro 1\r\n` +
          `System Uptime: ${Math.floor((Date.now() - this.startedAt) / 1000)} seconds\r\n` +
          `Voltage: ${this.voltage().toFixed(2)} * 100V (6S battery - OK)\r\n` +
          `CPU:12%, cycle time: 125, GYRO rate: 8000, RX rate: 111, System rate: 9\r\n` +
          `Arming disable flags: none\r\n`
        );

      case "version":
        return (
          "# Betaflight / STM32F405 (S405) 4.5.1 Jun 20 2024 / 09:20:15 (77d01ba3b) MSP API: 1.46\r\n" +
          "# board: manufacturer_id: SPBE, board_name: SPEEDYBEEF405V4\r\n"
        );

      case "resource":
        return "Currently active IO resource assignments:\r\n(reboot to update)\r\n";

      case "help":
        return "Available commands: get, set, diff, dump, status, version, save, exit\r\n";

      default:
        return `###ERROR: UNKNOWN COMMAND: ${command}###\r\n`;
    }
  }

  private lookup(key: string): string | undefined {
    return this.master[key] ?? this.profile[key] ?? this.rateProfile[key];
  }

  /** Settings the board knows but that currently hold their default value. */
  private isKnownDefault(key: string): boolean {
    return [
      "d_min_roll", "d_min_pitch", "simplified_pids_mode", "simplified_master_multiplier",
      "iterm_relax", "iterm_relax_type", "throttle_boost", "thrust_linear",
      "dyn_idle_min_rpm", "gyro_rpm_notch_q", "yaw_lowpass_hz", "abs_control_gain",
    ].includes(key);
  }

  private assign(key: string, value: string): void {
    if (key in this.master) this.master[key] = value;
    else if (key in this.profile) this.profile[key] = value;
    else if (key in this.rateProfile) this.rateProfile[key] = value;
    else if (this.scope === "profile") this.profile[key] = value;
    else if (this.scope === "rateprofile") this.rateProfile[key] = value;
    else this.master[key] = value;
  }

  private dump(full: boolean): string {
    const lines: string[] = [
      "# version",
      "# Betaflight / STM32F405 (S405) 4.5.1 Jun 20 2024 / 09:20:15 (77d01ba3b) MSP API: 1.46",
      "",
      "# name: Demo Freestyle 5",
      "",
      "# " + (full ? "dump" : "diff") + " all",
      "",
    ];
    lines.push(...DIRECTIVES.filter((d) => !d.startsWith("feature")));
    lines.push("");
    lines.push("# feature");
    lines.push(...DIRECTIVES.filter((d) => d.startsWith("feature")));
    lines.push("");
    lines.push("# master");
    for (const [key, value] of Object.entries(this.master)) lines.push(`set ${key} = ${value}`);
    lines.push("");
    lines.push(`profile ${this.activeProfile}`);
    lines.push("");
    lines.push(`# profile ${this.activeProfile}`);
    for (const [key, value] of Object.entries(this.profile)) lines.push(`set ${key} = ${value}`);
    lines.push("");
    lines.push(`rateprofile ${this.activeRateProfile}`);
    lines.push("");
    lines.push(`# rateprofile ${this.activeRateProfile}`);
    for (const [key, value] of Object.entries(this.rateProfile)) lines.push(`set ${key} = ${value}`);
    lines.push("");
    lines.push("# restore original profile selection");
    lines.push(`profile ${this.activeProfile}`);
    lines.push(`rateprofile ${this.activeRateProfile}`);
    lines.push("");
    return lines.join("\r\n") + "\r\n";
  }

  // ------------------------------------------------------------------- MSP

  /** A 6S pack sagging slowly, so telemetry is not suspiciously static. */
  private voltage(): number {
    const minutes = (Date.now() - this.startedAt) / 60000;
    return Math.max(19.8, 25.2 - minutes * 0.4);
  }

  private answerMsp(code: number): void {
    const encoder = this.encoder;
    switch (code) {
      case MSP.API_VERSION:
        return this.reply(code, new Uint8Array([0, 1, 46]));
      case MSP.FC_VARIANT:
        return this.reply(code, encoder.encode("BTFL"));
      case MSP.FC_VERSION:
        return this.reply(code, new Uint8Array([4, 5, 1]));
      case MSP.BOARD_INFO: {
        const target = encoder.encode("SPEEDYBEEF405V4");
        const payload = new Uint8Array(9 + target.length);
        payload.set(encoder.encode("SBF4"), 0);
        payload[8] = target.length;
        payload.set(target, 9);
        return this.reply(code, payload);
      }
      case MSP.NAME:
        return this.reply(code, encoder.encode("Demo Freestyle 5"));
      case MSP.UID:
        // A fixed, obviously fake UID so demo sessions are distinguishable.
        return this.reply(code, new Uint8Array([
          0xde, 0xa0, 0x51, 0x4d, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
        ]));
      case MSP.ANALOG: {
        const payload = new Uint8Array(9);
        const view = new DataView(payload.buffer);
        const volts = this.voltage();
        payload[0] = Math.min(255, Math.round(volts * 10));
        view.setUint16(1, 420, true);
        view.setUint16(3, 1023, true);
        view.setInt16(5, 180, true);
        view.setUint16(7, Math.round(volts * 100), true);
        return this.reply(code, payload);
      }
      case MSP.STATUS: {
        const payload = new Uint8Array(11);
        const view = new DataView(payload.buffer);
        view.setUint16(0, 125, true);
        view.setUint16(2, 0, true);
        view.setUint16(4, 0x23, true);
        view.setUint32(6, 0, true); // disarmed
        return this.reply(code, payload);
      }
      case MSP.REBOOT:
        return; // A rebooting board never answers.
      default: {
        const frame = encodeV1(code);
        frame[2] = 0x21; // '!'
        this.send(frame);
      }
    }
  }

  /** How many times the demo board has been "saved to EEPROM". */
  get saves(): number {
    return this.savedCount;
  }
}

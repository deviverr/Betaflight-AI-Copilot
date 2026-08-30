/**
 * Flight controller link: MSP request/response on top of the serial transport,
 * plus the CLI channel that carries `diff all` and `set` commands.
 */
import { SerialTransport, DEFAULT_BAUD } from "./serial";
import { MspParser, encode, PayloadReader, type MspFrame } from "./codec";
import { MSP, CLI_ENTER_BYTE } from "./constants";

export type LinkMode = "closed" | "msp" | "cli";

export interface FcIdentity {
  apiVersion: string;
  variant: string;
  firmwareVersion: string;
  boardIdentifier: string;
  targetName: string;
  craftName: string;
  uid: string;
}

interface PendingRequest {
  code: number;
  resolve: (frame: MspFrame) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const MSP_TIMEOUT_MS = 2000;
const CLI_IDLE_MS = 150;
const CLI_TIMEOUT_MS = 20000;

export class FcLink {
  private transport = new SerialTransport();
  private parser = new MspParser();
  private pending: PendingRequest[] = [];
  private cliBuffer = "";
  private cliResolve: ((text: string) => void) | null = null;
  private cliIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private cliTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private decoder = new TextDecoder();

  mode: LinkMode = "closed";
  identity: FcIdentity | null = null;

  /** Raw traffic log, capped, for the debug panel and for AI error context. */
  readonly log: string[] = [];
  onLog: (line: string) => void = () => {};
  onModeChange: (mode: LinkMode) => void = () => {};
  onDisconnect: (reason?: string) => void = () => {};
  /** Fires for each chunk of CLI output while a command is still streaming. */
  onCliStream: (chunk: string) => void = () => {};

  constructor() {
    this.transport.onData = (chunk) => this.handleData(chunk);
    this.transport.onClose = (reason) => {
      this.setMode("closed");
      this.identity = null;
      this.failAllPending(new Error(reason ?? "Disconnected"));
      this.onDisconnect(reason);
    };
  }

  get isConnected(): boolean {
    return this.mode !== "closed";
  }

  private setMode(mode: LinkMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.onModeChange(mode);
  }

  private pushLog(line: string): void {
    this.log.push(line);
    if (this.log.length > 500) this.log.shift();
    this.onLog(line);
  }

  // ---------------------------------------------------------------- connect

  async connect(baudRate = DEFAULT_BAUD, port?: SerialPort): Promise<FcIdentity> {
    const chosen = port ?? (await this.transport.requestPort());
    await this.transport.open(chosen, { baudRate });
    this.setMode("msp");
    this.pushLog(`Serial port open at ${baudRate} baud`);
    this.identity = await this.readIdentity();
    this.pushLog(
      `Connected: ${this.identity.variant} ${this.identity.firmwareVersion} on ${this.identity.targetName}`,
    );
    return this.identity;
  }

  async disconnect(): Promise<void> {
    if (this.mode === "cli") await this.exitCli().catch(() => {});
    await this.transport.close();
    this.setMode("closed");
    this.identity = null;
  }

  // -------------------------------------------------------------- incoming

  private handleData(chunk: Uint8Array): void {
    if (this.mode === "cli") {
      this.appendCli(this.decoder.decode(chunk, { stream: true }));
      return;
    }
    const { frames, text } = this.parser.push(chunk);
    for (const frame of frames) this.resolveFrame(frame);
    if (text.length) {
      const decoded = this.decoder.decode(text, { stream: true }).trim();
      if (decoded) this.pushLog(decoded);
    }
  }

  private resolveFrame(frame: MspFrame): void {
    const index = this.pending.findIndex((p) => p.code === frame.code);
    if (index === -1) return;
    const [request] = this.pending.splice(index, 1);
    clearTimeout(request.timer);
    if (frame.direction === "!") {
      request.reject(new Error(`Flight controller rejected MSP command ${frame.code}`));
    } else {
      request.resolve(frame);
    }
  }

  private failAllPending(error: Error): void {
    for (const request of this.pending) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending = [];
    if (this.cliResolve) {
      const resolve = this.cliResolve;
      this.cliResolve = null;
      resolve(this.cliBuffer);
    }
  }

  // ------------------------------------------------------------------- MSP

  async request(code: number, payload = new Uint8Array(0)): Promise<PayloadReader> {
    if (this.mode !== "msp") {
      throw new Error(`Cannot send MSP while the link is in ${this.mode} mode`);
    }
    const frame = await new Promise<MspFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = this.pending.filter((p) => p.timer !== timer);
        reject(new Error(`MSP command ${code} timed out after ${MSP_TIMEOUT_MS}ms`));
      }, MSP_TIMEOUT_MS);
      this.pending.push({ code, resolve, reject, timer });
      this.transport.write(encode(code, payload)).catch(reject);
    });
    return new PayloadReader(frame.payload);
  }

  private async readIdentity(): Promise<FcIdentity> {
    const api = await this.request(MSP.API_VERSION);
    api.u8(); // protocol version, not surfaced
    const apiVersion = `${api.u8()}.${api.u8()}`;

    const variant = (await this.request(MSP.FC_VARIANT)).ascii(4);

    const version = await this.request(MSP.FC_VERSION);
    const firmwareVersion = `${version.u8()}.${version.u8()}.${version.u8()}`;

    const board = await this.request(MSP.BOARD_INFO);
    const boardIdentifier = board.ascii(4);
    board.u16(); // hardware revision
    board.u8(); // board type
    board.u8(); // target capabilities
    const targetName = board.ascii(board.u8());

    let craftName = "";
    try {
      craftName = (await this.request(MSP.NAME)).ascii();
    } catch {
      // MSP_NAME is absent on some older targets; a blank craft name is fine.
    }

    let uid = "";
    try {
      const uidReader = await this.request(MSP.UID);
      uid = [uidReader.u32(), uidReader.u32(), uidReader.u32()]
        .map((part) => part.toString(16).padStart(8, "0"))
        .join("");
    } catch {
      // Same: UID is optional.
    }

    return { apiVersion, variant, firmwareVersion, boardIdentifier, targetName, craftName, uid };
  }

  /** Live values the AI can use as evidence: voltage, current, RSSI, arming flags. */
  async readTelemetry(): Promise<Record<string, number>> {
    const analog = await this.request(MSP.ANALOG);
    const legacyVoltage = analog.u8();
    const mahDrawn = analog.u16();
    const rssi = analog.u16();
    const amperage = analog.i16() / 100;
    const voltage = analog.remaining >= 2 ? analog.u16() / 100 : legacyVoltage / 10;

    const status = await this.request(MSP.STATUS);
    const cycleTime = status.u16();
    const i2cErrors = status.u16();
    status.u16(); // sensor bitmask
    const flightModeFlags = status.u32();

    return { voltage, amperage, mahDrawn, rssi, cycleTime, i2cErrors, flightModeFlags };
  }

  async reboot(): Promise<void> {
    // The FC resets before it can reply, so a timeout here is the success case.
    await this.request(MSP.REBOOT).catch(() => undefined);
  }

  // ------------------------------------------------------------------- CLI

  /**
   * Switches the port into CLI mode. Betaflight enters CLI when it receives a
   * bare '#' on a port that is running MSP.
   */
  async enterCli(): Promise<string> {
    if (this.mode === "cli") return "";
    if (this.mode !== "msp") throw new Error("Connect before entering CLI mode");
    this.setMode("cli");
    this.cliBuffer = "";
    const banner = await this.sendCliRaw(new Uint8Array([CLI_ENTER_BYTE]));
    this.pushLog("Entered CLI mode");
    return banner;
  }

  /**
   * Leaves CLI mode. `exit` discards unsaved CLI changes and reboots the FC,
   * which drops the serial link — the caller reconnects.
   */
  async exitCli(): Promise<void> {
    if (this.mode !== "cli") return;
    await this.sendCliRaw(new TextEncoder().encode("exit\r\n")).catch(() => "");
    this.pushLog("Left CLI mode (flight controller is rebooting)");
    this.setMode("msp");
  }

  /** `save` writes the CLI changes to EEPROM and reboots the flight controller. */
  async saveAndReboot(): Promise<void> {
    if (this.mode !== "cli") throw new Error("save is only valid in CLI mode");
    await this.sendCliRaw(new TextEncoder().encode("save\r\n")).catch(() => "");
    this.pushLog("Saved to EEPROM (flight controller is rebooting)");
    this.setMode("msp");
  }

  /** Runs one CLI command and returns its output with the echo and prompt stripped. */
  async cli(command: string): Promise<string> {
    if (this.mode !== "cli") throw new Error("Enter CLI mode before sending CLI commands");
    const raw = await this.sendCliRaw(new TextEncoder().encode(`${command}\r\n`));
    return stripCliEcho(raw, command);
  }

  /** Runs commands in order, stopping at the first one the firmware rejects. */
  async cliBatch(commands: string[]): Promise<{ command: string; output: string }[]> {
    const results: { command: string; output: string }[] = [];
    for (const command of commands) {
      const output = await this.cli(command);
      results.push({ command, output });
      if (CLI_ERROR.test(output)) {
        throw new CliCommandError(command, output, results);
      }
    }
    return results;
  }

  private sendCliRaw(bytes: Uint8Array): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.cliBuffer = "";
      this.cliResolve = resolve;
      this.cliTimeoutTimer = setTimeout(() => {
        this.cliResolve = null;
        reject(new Error(`CLI command timed out after ${CLI_TIMEOUT_MS}ms`));
      }, CLI_TIMEOUT_MS);
      this.transport.write(bytes).catch(reject);
    });
  }

  private appendCli(text: string): void {
    this.cliBuffer += text;
    this.onCliStream(text);
    if (!this.cliResolve) return;

    // Betaflight ends every CLI response with the "# " prompt. Long outputs such
    // as `dump all` stream in many chunks, so also wait out a short idle gap
    // before declaring the response complete.
    if (this.cliIdleTimer) clearTimeout(this.cliIdleTimer);
    const looksComplete = /(^|\n)#\s?$/.test(this.cliBuffer);
    this.cliIdleTimer = setTimeout(
      () => {
        if (!this.cliResolve) return;
        const resolve = this.cliResolve;
        this.cliResolve = null;
        if (this.cliTimeoutTimer) clearTimeout(this.cliTimeoutTimer);
        resolve(this.cliBuffer);
      },
      looksComplete ? CLI_IDLE_MS : CLI_IDLE_MS * 4,
    );
  }
}

/**
 * Betaflight reports a bad command as `###ERROR: ...###`, and older builds as a
 * bare "Parse error" or "Invalid name". Match all of them, anywhere in the
 * response, since the echo line comes first.
 */
const CLI_ERROR = /(^|\n)\s*#*\s*(###\s*)?(ERROR|Parse error|Invalid|Unknown command|Unknown)\b/i;

export class CliCommandError extends Error {
  constructor(
    readonly command: string,
    readonly output: string,
    readonly completed: { command: string; output: string }[],
  ) {
    super(`Flight controller rejected "${command}": ${output.trim().split("\n")[0]}`);
    this.name = "CliCommandError";
  }
}

/** Removes the command echo and the trailing "# " prompt from a CLI response. */
export function stripCliEcho(raw: string, command: string): string {
  let text = raw.replace(/\r/g, "");
  const echo = text.indexOf(command);
  if (echo !== -1) text = text.slice(echo + command.length);
  return text.replace(/\n?#\s*$/, "").trim();
}

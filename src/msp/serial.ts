/**
 * Web Serial transport.
 *
 * The browser grants an *exclusive* lock on the port, which is why this app
 * cannot run as an extension inside Betaflight Configurator: only one page can
 * hold the flight controller at a time. Close the Configurator tab first.
 */

export interface SerialOptions {
  baudRate: number;
}

export const DEFAULT_BAUD = 115200;

/** USB vendor IDs that ship on common flight controllers, used to filter the picker. */
const FC_FILTERS: SerialPortFilter[] = [
  { usbVendorId: 0x0483 }, // STMicroelectronics — virtual COM port on most F4/F7/H7 targets
  { usbVendorId: 0x2e3c }, // AT32
  { usbVendorId: 0x1209 }, // pid.codes, used by some open hardware targets
  { usbVendorId: 0x10c4 }, // Silicon Labs CP210x UART bridge
  { usbVendorId: 0x1a86 }, // WCH CH340 UART bridge
];

export function isWebSerialSupported(): boolean {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

export class SerialTransport {
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readLoop: Promise<void> | null = null;
  private closing = false;

  onData: (chunk: Uint8Array) => void = () => {};
  onClose: (reason?: string) => void = () => {};

  get isOpen(): boolean {
    return this.port !== null;
  }

  /**
   * Prompts the user to pick a port. Must be called from a user gesture —
   * the browser rejects `requestPort` otherwise.
   */
  async requestPort(showAllDevices = false): Promise<SerialPort> {
    if (!isWebSerialSupported()) {
      throw new Error(
        "This browser has no Web Serial API. Use Chrome, Edge, Opera or another Chromium browser on desktop.",
      );
    }
    return navigator.serial.requestPort(showAllDevices ? {} : { filters: FC_FILTERS });
  }

  /** Ports the user has already granted us, so reconnect needs no new prompt. */
  async getGrantedPorts(): Promise<SerialPort[]> {
    if (!isWebSerialSupported()) return [];
    return navigator.serial.getPorts();
  }

  async open(port: SerialPort, options: SerialOptions = { baudRate: DEFAULT_BAUD }): Promise<void> {
    if (this.port) throw new Error("Serial port already open");
    await port.open({ baudRate: options.baudRate, bufferSize: 8192 });
    this.port = port;
    this.closing = false;
    this.writer = port.writable!.getWriter();
    this.readLoop = this.pump();
  }

  private async pump(): Promise<void> {
    while (this.port?.readable && !this.closing) {
      const reader = this.port.readable.getReader();
      this.reader = reader;
      // A stream that ends cleanly means the device went away — a reboot into
      // the bootloader, or an unplugged cable. Without this flag the outer loop
      // would immediately take a new reader on the already-closed stream and
      // spin forever.
      let streamEnded = false;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            streamEnded = true;
            break;
          }
          if (value?.length) this.onData(value);
        }
      } catch (error) {
        if (!this.closing) {
          this.onClose(error instanceof Error ? error.message : String(error));
          return;
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // The lock is already gone when the device was physically unplugged.
        }
        this.reader = null;
      }
      if (streamEnded) break;
    }
    if (!this.closing) this.onClose("Device disconnected");
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.writer) throw new Error("Serial port is not open");
    await this.writer.write(data);
  }

  async close(): Promise<void> {
    this.closing = true;
    try {
      await this.reader?.cancel();
    } catch {
      // Cancelling a reader on an unplugged device throws; the port still closes.
    }
    try {
      this.writer?.releaseLock();
    } catch {
      // Already released.
    }
    this.writer = null;
    await this.readLoop?.catch(() => {});
    this.readLoop = null;
    try {
      await this.port?.close();
    } catch {
      // Nothing useful to do if the port is already gone.
    }
    this.port = null;
  }
}

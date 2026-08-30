import { describe, it, expect, beforeEach } from "vitest";
import { FcLink } from "../src/msp/connection";
import { SimulatedFlightController } from "../src/msp/simulator";
import { parseConfig } from "../src/core/config";
import { newChangeSet, resolveChange, toCliCommands } from "../src/core/changeset";

/**
 * The demo has to behave like the hardware or it is worse than useless — it
 * would teach the copilot habits that fail on a real board. These drive the
 * real FcLink against the simulator through the same path the app uses.
 */
describe("SimulatedFlightController", () => {
  let simulator: SimulatedFlightController;
  let link: FcLink;

  beforeEach(async () => {
    simulator = new SimulatedFlightController();
    link = new FcLink();
    await link.connect(115200, simulator as unknown as SerialPort);
  });

  it("answers the MSP identity handshake like a Betaflight board", () => {
    expect(link.identity).toMatchObject({
      apiVersion: "1.46",
      variant: "BTFL",
      firmwareVersion: "4.5.1",
      targetName: "SPEEDYBEEF405V4",
      craftName: "Demo Freestyle 5",
    });
  });

  it("reports a plausible, disarmed 6S pack", async () => {
    const telemetry = await link.readTelemetry();
    expect(telemetry.voltage).toBeGreaterThan(19);
    expect(telemetry.voltage).toBeLessThanOrEqual(25.2);
    expect(telemetry.flightModeFlags & 0x01).toBe(0);
    expect(telemetry.cycleTime).toBe(125);
  });

  it("produces a diff the real parser understands", async () => {
    await link.enterCli();
    const config = parseConfig(await link.cli("diff all"));

    expect(config.boardName).toBe("SPEEDYBEEF405V4");
    expect(config.craftName).toBe("Demo Freestyle 5");
    expect(config.mixer).toBe("QUADX");
    expect(config.features.get("OSD")).toBe(true);
    expect(config.master.get("motor_poles")).toBe("14");
    expect(config.profiles.get(0)?.get("p_pitch")).toBe("47");
    expect(config.rateProfiles.get(0)?.get("roll_srate")).toBe("67");
    expect(config.activeProfile).toBe(0);
  });

  it("leaves the copilot something worth finding", async () => {
    await link.enterCli();
    const config = parseConfig(await link.cli("diff all"));
    // RPM filtering is configured but bidirectional DShot is off, so it cannot
    // actually work — a real and common misconfiguration.
    expect(config.master.get("dshot_bidir")).toBe("OFF");
    expect(Number(config.master.get("rpm_filter_harmonics"))).toBeGreaterThan(0);
  });

  it("applies a `set` and reads it back", async () => {
    await link.enterCli();
    expect(await link.cli("get p_pitch")).toContain("p_pitch = 47");
    await link.cli("profile 0");
    await link.cli("set p_pitch = 52");
    expect(await link.cli("get p_pitch")).toContain("p_pitch = 52");
  });

  it("rejects an unknown setting name the way the firmware does", async () => {
    await link.enterCli();
    const output = await link.cli("set not_a_real_setting = 1");
    expect(output).toMatch(/INVALID NAME/i);
  });

  it("stops a batch at the rejected command", async () => {
    await link.enterCli();
    await expect(
      link.cliBatch(["set p_pitch = 52", "set nonsense = 1", "set d_pitch = 44"]),
    ).rejects.toThrow(/nonsense/);
    expect(await link.cli("get d_pitch")).toContain("d_pitch = 40");
  });

  it("routes a generated change set into the right sections", async () => {
    await link.enterCli();
    const config = parseConfig(await link.cli("diff all"));

    const changeSet = newChangeSet("tune", "", [
      resolveChange(config, { kind: "set", key: "d_pitch", value: "46", reason: "" }),
      resolveChange(config, { kind: "set", key: "dterm_lpf1_dyn_max_hz", value: "170", reason: "" }),
      resolveChange(config, { kind: "set", key: "roll_srate", value: "72", reason: "" }),
    ]);

    await link.cliBatch(toCliCommands(changeSet).filter((command) => command !== "save"));

    expect(await link.cli("get d_pitch")).toContain("d_pitch = 46");
    expect(await link.cli("get dterm_lpf1_dyn_max_hz")).toContain("= 170");
    expect(await link.cli("get roll_srate")).toContain("roll_srate = 72");
  });

  it("reboots on save, the way a real board drops the link", async () => {
    await link.enterCli();
    await link.cli("set p_pitch = 52");
    await link.saveAndReboot();
    expect(simulator.saves).toBe(1);
  });

  it("answers status and version for the read-only CLI tool", async () => {
    await link.enterCli();
    expect(await link.cli("status")).toMatch(/System Uptime/);
    expect(await link.cli("version")).toMatch(/Betaflight \/ STM32F405/);
  });

  it("refuses to be opened twice", async () => {
    await expect(simulator.open()).rejects.toThrow(/already open/);
  });
});

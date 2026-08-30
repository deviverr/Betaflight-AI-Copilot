import { describe, it, expect } from "vitest";
import { parseConfig } from "../src/core/config";
import {
  classifyKey, classifyCommand, resolveChange, newChangeSet, toCliCommands, renderDiff, riskOf, isNoop,
} from "../src/core/changeset";

const config = parseConfig(`
# master
set gyro_lpf1_static_hz = 250
set motor_poles = 14
profile 0
# profile 0
set p_pitch = 47
rateprofile 0
# rateprofile 0
set roll_srate = 78
`);

describe("risk classification", () => {
  it("treats tuning settings as safe", () => {
    expect(classifyKey("p_pitch")).toBe("safe");
    expect(classifyKey("dterm_lpf1_dyn_min_hz")).toBe("safe");
    expect(classifyKey("roll_srate")).toBe("safe");
  });

  it("treats hardware, power and receiver settings as moderate", () => {
    expect(classifyKey("motor_poles")).toBe("moderate");
    expect(classifyKey("failsafe_procedure")).toBe("moderate");
    expect(classifyKey("vbat_min_cell_voltage")).toBe("moderate");
  });

  it("treats remapping and defaults as dangerous", () => {
    expect(classifyCommand("resource MOTOR 1 B00")).toBe("dangerous");
    expect(classifyCommand("defaults nosave")).toBe("dangerous");
    expect(classifyCommand("mixer QUADX")).toBe("dangerous");
  });

  it("blocks motor, bootloader and flash commands outright", () => {
    for (const command of ["motor 1 1200", "bl", "dfu", "flash_erase", "esc4way"]) {
      expect(classifyCommand(command)).toBe("blocked");
    }
  });

  it("defaults an unrecognised key to moderate rather than safe", () => {
    expect(classifyKey("some_future_setting")).toBe("moderate");
  });
});

describe("resolveChange", () => {
  it("finds the existing value and the scope it lives in", () => {
    const change = resolveChange(config, { kind: "set", key: "p_pitch", value: "52" });
    expect(change.oldValue).toBe("47");
    expect(change.scope).toEqual({ kind: "profile", index: 0 });
    expect(change.risk).toBe("safe");
  });

  it("places an unseen PID key in the active profile", () => {
    const change = resolveChange(config, { kind: "set", key: "d_yaw", value: "30" });
    expect(change.scope).toEqual({ kind: "profile", index: 0 });
  });

  it("places an unseen rate key in the active rate profile", () => {
    const change = resolveChange(config, { kind: "set", key: "yaw_expo", value: "10" });
    expect(change.scope).toEqual({ kind: "rateprofile", index: 0 });
  });

  it("explains why a blocked command is refused", () => {
    const change = resolveChange(config, { kind: "command", key: "motor", value: "1 1200" });
    expect(change.risk).toBe("blocked");
    expect(change.blockedReason).toMatch(/never issues it/);
  });
});

describe("toCliCommands", () => {
  it("switches profile once per scope and saves at the end", () => {
    const changeSet = newChangeSet("tune", "", [
      resolveChange(config, { kind: "set", key: "p_pitch", value: "52" }),
      resolveChange(config, { kind: "set", key: "d_pitch", value: "42" }),
      resolveChange(config, { kind: "set", key: "gyro_lpf1_static_hz", value: "200" }),
      resolveChange(config, { kind: "set", key: "roll_srate", value: "80" }),
    ]);
    const commands = toCliCommands(changeSet);

    expect(commands.filter((line) => line.startsWith("profile "))).toHaveLength(1);
    expect(commands.filter((line) => line.startsWith("rateprofile "))).toHaveLength(1);
    expect(commands[commands.length - 1]).toBe("save");

    const profileIndex = commands.indexOf("profile 0");
    expect(commands.indexOf("set p_pitch = 52")).toBeGreaterThan(profileIndex);
  });

  it("omits blocked changes and values that already match", () => {
    const changeSet = newChangeSet("mixed", "", [
      resolveChange(config, { kind: "command", key: "motor", value: "1 1200" }),
      resolveChange(config, { kind: "set", key: "motor_poles", value: "14" }),
      resolveChange(config, { kind: "set", key: "motor_poles", value: "12" }),
    ]);
    const commands = toCliCommands(changeSet);
    expect(commands.some((line) => line.startsWith("motor "))).toBe(false);
    expect(commands).toContain("set motor_poles = 12");
    expect(commands.filter((line) => line.startsWith("set motor_poles"))).toHaveLength(1);
  });

  it("emits nothing but keeps quiet when every change is a no-op", () => {
    const changeSet = newChangeSet("noop", "", [
      resolveChange(config, { kind: "set", key: "p_pitch", value: "47" }),
    ]);
    expect(isNoop(changeSet.changes[0])).toBe(true);
    expect(toCliCommands(changeSet)).toEqual([]);
  });

  it("renders feature toggles with the right sign", () => {
    const changeSet = newChangeSet("features", "", [
      resolveChange(config, { kind: "feature", key: "gps", value: "on" }),
      resolveChange(config, { kind: "feature", key: "telemetry", value: "off" }),
    ]);
    const commands = toCliCommands(changeSet);
    expect(commands).toContain("feature GPS");
    expect(commands).toContain("feature -TELEMETRY");
  });
});

describe("riskOf and renderDiff", () => {
  it("reports the worst risk in the set", () => {
    const changeSet = newChangeSet("mixed", "", [
      resolveChange(config, { kind: "set", key: "p_pitch", value: "52" }),
      resolveChange(config, { kind: "command", key: "resource", value: "MOTOR 1 B00" }),
    ]);
    expect(riskOf(changeSet.changes)).toBe("dangerous");
  });

  it("shows old and new values side by side", () => {
    const changeSet = newChangeSet("tune", "", [
      resolveChange(config, { kind: "set", key: "p_pitch", value: "52" }),
    ]);
    expect(renderDiff(changeSet)[0].text).toBe("p_pitch: 47 → 52");
  });
});

describe("renderDiff no-op handling", () => {
  it("marks a value the board already holds as unchanged", () => {
    const changeSet = newChangeSet("mixed", "", [
      resolveChange(config, { kind: "set", key: "p_pitch", value: "47" }),
      resolveChange(config, { kind: "set", key: "p_pitch", value: "52" }),
    ]);
    const [already, changing] = renderDiff(changeSet);

    expect(already.unchanged).toBe(true);
    expect(already.text).toBe("p_pitch: 47");
    expect(changing.unchanged).toBe(false);
    expect(changing.text).toBe("p_pitch: 47 → 52");
  });
});

import { describe, it, expect } from "vitest";
import { parseConfig } from "../src/core/config";
import { newChangeSet, resolveChange } from "../src/core/changeset";
import { decide, isArmed } from "../src/core/permissions";

const config = parseConfig("# master\nset p_pitch = 47\nset motor_poles = 14\n");

const tuning = newChangeSet("tune", "", [
  resolveChange(config, { kind: "set", key: "p_pitch", value: "52" }),
]);
const hardware = newChangeSet("hardware", "", [
  resolveChange(config, { kind: "set", key: "motor_poles", value: "12" }),
]);
const remap = newChangeSet("remap", "", [
  resolveChange(config, { kind: "command", key: "resource", value: "MOTOR 1 B00" }),
]);
const blocked = newChangeSet("blocked", "", [
  resolveChange(config, { kind: "command", key: "motor", value: "1 1200" }),
]);

describe("decide", () => {
  it("asks for everything in manual mode", () => {
    expect(decide("manual", tuning).action).toBe("ask");
    expect(decide("manual", hardware).action).toBe("ask");
  });

  it("auto-applies only tuning in autoTune mode", () => {
    expect(decide("autoTune", tuning).action).toBe("apply");
    expect(decide("autoTune", hardware).action).toBe("ask");
  });

  it("auto-applies tuning and setup in auto mode", () => {
    expect(decide("auto", tuning).action).toBe("apply");
    expect(decide("auto", hardware).action).toBe("apply");
  });

  it("always asks before a resource remap, even in full auto", () => {
    expect(decide("auto", remap).action).toBe("ask");
    expect(decide("autoTune", remap).action).toBe("ask");
    expect(decide("manual", remap).action).toBe("ask");
  });

  it("refuses blocked commands in every mode", () => {
    for (const mode of ["manual", "autoTune", "auto"] as const) {
      expect(decide(mode, blocked).action).toBe("refuse");
    }
  });
});

describe("isArmed", () => {
  it("reads the arming bit out of the flight mode flags", () => {
    expect(isArmed(0b0001)).toBe(true);
    expect(isArmed(0b0110)).toBe(false);
  });
});

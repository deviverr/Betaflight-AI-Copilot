import { describe, it, expect } from "vitest";
import { parseConfig, getSetting, findScope, summarizeForModel } from "../src/core/config";

const DIFF = `
# version
# Betaflight / STM32F405 (S405) 4.5.1 Jun 20 2024 / 09:20:15 (77d01ba3b) MSP API: 1.46

# name: Freestyle5

board_name SPEEDYBEEF405V3
manufacturer_id SPBE

# feature
feature -RX_PARALLEL_PWM
feature GPS

# serial
serial 0 64 115200 57600 0 115200

# aux
aux 0 0 0 1700 2100 0 0

# master
set gyro_lpf1_static_hz = 250
set dyn_notch_count = 3
set motor_poles = 14

profile 0

# profile 0
set p_pitch = 47
set d_pitch = 40

profile 1

# profile 1
set p_pitch = 55

rateprofile 0

# rateprofile 0
set roll_rc_rate = 100
set roll_srate = 78

# restore original profile selection
profile 0
rateprofile 0
`;

describe("parseConfig", () => {
  const config = parseConfig(DIFF);

  it("reads board identity and craft name", () => {
    expect(config.boardName).toBe("SPEEDYBEEF405V3");
    expect(config.manufacturerId).toBe("SPBE");
    expect(config.craftName).toBe("Freestyle5");
    expect(config.firmwareLine).toContain("4.5.1");
  });

  it("records features with their enabled state", () => {
    expect(config.features.get("RX_PARALLEL_PWM")).toBe(false);
    expect(config.features.get("GPS")).toBe(true);
  });

  it("puts master settings in the master bucket", () => {
    expect(config.master.get("gyro_lpf1_static_hz")).toBe("250");
    expect(config.master.get("motor_poles")).toBe("14");
  });

  it("keeps per-profile settings separate", () => {
    expect(config.profiles.get(0)?.get("p_pitch")).toBe("47");
    expect(config.profiles.get(1)?.get("p_pitch")).toBe("55");
  });

  it("captures rate profile settings", () => {
    expect(config.rateProfiles.get(0)?.get("roll_srate")).toBe("78");
  });

  it("ends on the profile the board was actually using", () => {
    expect(config.activeProfile).toBe(0);
    expect(config.activeRateProfile).toBe(0);
  });

  it("keeps directive lines such as aux and serial", () => {
    expect(config.directives.some((d) => d.command === "aux")).toBe(true);
    expect(config.directives.some((d) => d.command === "serial")).toBe(true);
  });
});

describe("lookups", () => {
  const config = parseConfig(DIFF);

  it("resolves a setting through the active profile", () => {
    expect(getSetting(config, "p_pitch")).toBe("47");
    expect(getSetting(config, "p_pitch", { kind: "profile", index: 1 })).toBe("55");
  });

  it("reports where a key lives", () => {
    expect(findScope(config, "motor_poles")).toEqual({ kind: "master" });
    expect(findScope(config, "roll_srate")).toEqual({ kind: "rateprofile", index: 0 });
    expect(findScope(config, "not_a_real_setting")).toBeNull();
  });
});

describe("summarizeForModel", () => {
  it("includes identity, features and scoped settings", () => {
    const summary = summarizeForModel(parseConfig(DIFF));
    expect(summary).toContain("SPBE/SPEEDYBEEF405V3");
    expect(summary).toContain("GPS");
    expect(summary).toContain("master: gyro_lpf1_static_hz = 250");
    expect(summary).toContain("profile 1: p_pitch = 55");
  });
});

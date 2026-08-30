import { describe, it, expect } from "vitest";
import { stripCliEcho } from "../src/msp/connection";
import { restoreCommands } from "../src/core/backup";

describe("stripCliEcho", () => {
  it("removes the echoed command and the trailing prompt", () => {
    const raw = "get p_pitch\r\np_pitch = 47\r\n# ";
    expect(stripCliEcho(raw, "get p_pitch")).toBe("p_pitch = 47");
  });

  it("leaves output intact when the firmware does not echo", () => {
    expect(stripCliEcho("p_pitch = 47\r\n# ", "get p_pitch")).toBe("p_pitch = 47");
  });

  it("handles multi-line output such as diff all", () => {
    const raw = "diff all\r\n# version\r\nset p_pitch = 47\r\nset d_pitch = 40\r\n# ";
    expect(stripCliEcho(raw, "diff all").split("\n")).toEqual([
      "# version",
      "set p_pitch = 47",
      "set d_pitch = 40",
    ]);
  });
});

describe("restoreCommands", () => {
  it("resets to defaults first so removed settings do not linger", () => {
    const commands = restoreCommands({
      id: "b", createdAt: 0, label: "", craftName: "", firmware: "",
      text: "# comment\nset p_pitch = 47\n\nfeature GPS\n",
    });
    expect(commands[0]).toBe("defaults nosave");
    expect(commands).toContain("set p_pitch = 47");
    expect(commands).toContain("feature GPS");
    expect(commands.at(-1)).toBe("save");
    expect(commands.some((line) => line.startsWith("#"))).toBe(false);
  });
});

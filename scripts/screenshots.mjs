/**
 * Captures the README screenshots against the dev server.
 *
 * It drives the real UI: connects to the built-in simulated flight controller,
 * then seeds a transcript that mirrors a genuine session. Nothing here is a
 * mockup — the change-set card renders from a real parsed config, and the diff
 * values come from the simulator's actual settings.
 *
 *   npm run dev            # in one terminal
 *   node scripts/screenshots.mjs
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.SCREENSHOT_URL ?? "http://localhost:5173/";
const OUT = "docs/screenshots";
const VIEWPORT = { width: 1440, height: 940 };

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: VIEWPORT,
  deviceScaleFactor: 2,
  colorScheme: "dark",
});

page.on("pageerror", (error) => console.error("page error:", error.message));

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForFunction(() => Boolean(window.copilot), null, { timeout: 15000 });

// --- 1. empty state ---------------------------------------------------------
await page.screenshot({ path: `${OUT}/01-empty.png` });

// --- 2. connected to the simulator -----------------------------------------
await page.evaluate(() => window.copilot.connectDemo());
await page.waitForFunction(() => window.copilot.state.config !== null, null, { timeout: 20000 });
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/02-connected.png` });

// --- 3. a session with a pending change set --------------------------------
await page.evaluate(async () => {
  const { state, submitChangeSet } = window.copilot;
  const { newChangeSet, resolveChange } = await import("/src/core/changeset.ts");
  const config = state.config;

  state.transcript.push({
    id: "s1",
    kind: "user",
    text: "It washes out on fast descents and the motors are warm after a pack. 5\" 6S freestyle.",
  });
  state.transcript.push({
    id: "s2",
    kind: "tool",
    label: "read_config",
    detail: "Read configuration (24 master settings)",
    state: "done",
  });
  state.transcript.push({
    id: "s3",
    kind: "tool",
    label: "run_cli",
    detail: "$ get dshot_bidir",
    state: "done",
  });
  state.transcript.push({
    id: "s4",
    kind: "assistant",
    streaming: false,
    text:
      "Two separate things, and the second one explains the first.\n\n" +
      "Your RPM filter is configured — rpm_filter_harmonics is 3 — but dshot_bidir is OFF, " +
      "so the flight controller never receives RPM telemetry and the filter does nothing. " +
      "You are flying on the dynamic notch alone, which is why the D term is seeing motor " +
      "noise and the motors are running warm.\n\n" +
      "The propwash is downstream of that: your D-term lowpass is set low (75-145 Hz) to " +
      "hide the noise, and that delay is what shows up as wash on descents.\n\n" +
      "Turn bidirectional DShot on first. That is a change to how the ESCs talk to the " +
      "board, so it needs your approval and a bench test with props off — confirm you get " +
      "RPM in the motors tab before flying.",
  });

  const changeSet = newChangeSet(
    "Enable bidirectional DShot so RPM filtering actually runs",
    "This is the root cause of both symptoms. Verify RPM appears in the Motors tab with props off before flying, then I will open up the D-term filtering in a second step.",
    [
      resolveChange(config, {
        kind: "set",
        key: "dshot_bidir",
        value: "ON",
        reason: "Without this the flight controller never receives RPM telemetry",
      }),
      resolveChange(config, {
        kind: "set",
        key: "motor_poles",
        value: "14",
        reason: "Correct for 22xx-27xx motors; wrong values make RPM filtering track the wrong frequency",
      }),
      resolveChange(config, {
        kind: "set",
        key: "rpm_filter_harmonics",
        value: "3",
        reason: "Already set; kept explicit so the whole filter chain is visible in one place",
      }),
    ],
  );

  // Route it through the real approval gate so the card renders in its true
  // pending state, with the real permission-mode reason attached.
  submitChangeSet(changeSet);
});

await page.waitForSelector(".changeset.pending", { timeout: 10000 });
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/03-proposal.png` });

// --- 4. the exact CLI behind the diff --------------------------------------
await page.click(".changeset.pending header button");
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/04-cli.png` });

// --- 5. light theme ---------------------------------------------------------
await page.emulateMedia({ colorScheme: "light" });
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/05-light.png` });

await browser.close();
console.log(`wrote 5 screenshots to ${OUT}/`);

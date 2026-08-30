/**
 * MSP command codes used by the copilot.
 *
 * The copilot deliberately uses a small slice of MSP: identification, live
 * telemetry and reboot. All *configuration* reading and writing goes through
 * the CLI (`diff all` / `set x = y`), which is the same path Betaflight
 * Configurator uses for backup and restore and is stable across firmware
 * versions in a way that packed MSP structs are not.
 */
export const MSP = {
  API_VERSION: 1,
  FC_VARIANT: 2,
  FC_VERSION: 3,
  BOARD_INFO: 4,
  BUILD_INFO: 5,
  NAME: 10,
  BATTERY_CONFIG: 32,
  FEATURE_CONFIG: 36,
  REBOOT: 68,
  STATUS: 101,
  RAW_IMU: 102,
  MOTOR: 104,
  RC: 105,
  ATTITUDE: 108,
  ANALOG: 110,
  RC_TUNING: 111,
  PID: 112,
  STATUS_EX: 150,
  UID: 160,
  BATTERY_STATE: 130,
  MOTOR_CONFIG: 131,
  FILTER_CONFIG: 92,
  PID_ADVANCED: 94,
  SET_PID: 202,
  EEPROM_WRITE: 250,
} as const;

/** Byte the firmware interprets as "switch this serial port into CLI mode". */
export const CLI_ENTER_BYTE = 0x23; // '#'

/** Betaflight sends this at the end of every CLI response. */
export const CLI_PROMPT = "# ";

/** Flight controller identifiers we know how to talk to. */
export const KNOWN_VARIANTS = ["BTFL", "INAV", "CLFL", "BAFL"] as const;
export type FcVariant = (typeof KNOWN_VARIANTS)[number] | string;

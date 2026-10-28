// v1.3.4 — a small on-till log of drawer and receipt-print steps.
//
// WHY. The owner's Windows test showed the drawer stop working after an offline
// period, and nothing on the till recorded what the main process did. This
// file is that record: one JSON line per step, so the next test shows whether
// a request arrived, which printer queues Windows reported, what matched, what
// the spooler answered and how long each step took.
//
// WHAT IT NEVER HOLDS. No sale, amount, employee, PIN, token or pairing data —
// the main process never receives any of those on these channels. Only step
// names, outcomes, printer queue names (Windows' own labels), durations and
// error messages from Electron/Win32.
//
// IT CANNOT HURT THE TILL. Every write is synchronous, small, wrapped and
// swallowed: a full disk or a locked file loses a log line, never a sale, a
// receipt or a drawer opening. The file is capped and rotated once.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

export const HARDWARE_LOG_FILE = "hardware.log";
export const HARDWARE_LOG_MAX_BYTES = 512 * 1024;

/**
 * @param {{ directory: string | null, now?: () => Date, maxBytes?: number }} options
 * @returns {(step: string, fields?: Record<string, unknown>) => void}
 */
export function createHardwareLog({ directory, now = () => new Date(), maxBytes = HARDWARE_LOG_MAX_BYTES }) {
  if (typeof directory !== "string" || directory === "") {
    return () => {};
  }

  const file = join(directory, HARDWARE_LOG_FILE);
  let ready = false;

  return function log(step, fields = {}) {
    try {
      if (!ready) {
        mkdirSync(directory, { recursive: true });
        ready = true;
      }

      try {
        if (statSync(file).size > maxBytes) {
          renameSync(file, `${file}.1`);
        }
      } catch {
        // No file yet.
      }

      appendFileSync(file, `${JSON.stringify({ at: now().toISOString(), step, ...fields })}\n`);
    } catch {
      // A log line is never worth a failure.
    }
  };
}

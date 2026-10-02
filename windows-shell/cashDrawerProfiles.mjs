// v1.3 Cash Drawer Checkpoint 1C — the built-in, physically validated printer
// profiles, and the rule that decides which installed queue (if any) a drawer
// command may be sent to.
//
// PURE. No Electron, no koffi, no I/O. main.mjs supplies the installed queue
// names (from webContents.getPrintersAsync()) and acts on the answer.
//
// THIS FILE IS THE ONLY PLACE A DRAWER COMMAND EXISTS. The renderer never sees
// it, never chooses it and cannot send a different one: the IPC channel carries
// no arguments, and the bytes below are copied, never referenced, when they are
// handed to the spooler.
//
// MATCHING IS EXACT. A profile names the Windows queue that was physically
// tested, and a queue matches only if its name equals that one after trimming
// surrounding whitespace and ignoring case (Windows queue names are
// case-insensitive). No prefix, substring, pattern or model-family rule exists:
// "EPSON TM-T20 Receipt" (the other queue the same driver installs), a
// "(Copy 1)" duplicate, a TM-T20II/III and a \\server\ network connection are
// all different names and none of them matches.
//
// AMBIGUITY REFUSES. Exactly one matching installed queue is eligible. Zero is
// not_configured; more than one is not_configured too, because choosing between
// two candidates would be a guess about which one has the drawer.

/**
 * Every profile here was proven on real hardware before being added.
 *
 * epson-tm-t20-receipte4 — Epson TM-T20 family, Windows queue
 * "EPSON TM-T20 ReceiptE4" over USB, drawer on the printer's DK port. A direct
 * RAW spooler job of exactly these five bytes opened the drawer and printed
 * nothing. They are reproduced exactly as validated and must not be
 * "corrected": ESC p, pin 0, t1 = 0x02, t2 = 0x14.
 */
export const VALIDATED_CASH_DRAWER_PROFILES = Object.freeze([
  Object.freeze({
    id: "epson-tm-t20-receipte4",
    queueName: "EPSON TM-T20 ReceiptE4",
    datatype: "RAW",
    command: Object.freeze([0x1b, 0x70, 0x00, 0x02, 0x14]),
  }),
]);

/**
 * Trimmed and lower-cased, or null for anything that is not a usable name.
 *
 * @param {unknown} name
 * @returns {string | null}
 */
export function normalizeQueueName(name) {
  if (typeof name !== "string") {
    return null;
  }

  const trimmed = name.trim();

  return trimmed === "" ? null : trimmed.toLowerCase();
}

/**
 * Decides which installed queue, if any, the drawer command may go to.
 *
 * Returns the OS's own spelling of the queue name (untrimmed, as enumerated),
 * because that is the string OpenPrinterW must be given.
 *
 * @param {readonly unknown[]} installedQueueNames
 * @param {readonly { queueName: string }[]} [profiles]
 * @returns {{ status: "matched", queueName: string, profile: (typeof VALIDATED_CASH_DRAWER_PROFILES)[number] }
 *         | { status: "not_configured", reason: "no_match" | "ambiguous" }}
 */
export function matchCashDrawerProfile(installedQueueNames, profiles = VALIDATED_CASH_DRAWER_PROFILES) {
  const matches = [];

  if (Array.isArray(installedQueueNames)) {
    for (const installed of installedQueueNames) {
      const normalized = normalizeQueueName(installed);

      if (normalized === null) {
        continue;
      }

      for (const profile of profiles) {
        if (normalizeQueueName(profile.queueName) === normalized) {
          matches.push({ queueName: installed, profile });
        }
      }
    }
  }

  if (matches.length === 0) {
    return { status: "not_configured", reason: "no_match" };
  }

  if (matches.length > 1) {
    return { status: "not_configured", reason: "ambiguous" };
  }

  return { status: "matched", queueName: matches[0].queueName, profile: matches[0].profile };
}

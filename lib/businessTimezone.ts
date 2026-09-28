// v1.3 Task 5A — the owner-facing business timezone, as a pure selection model.
//
// WHAT THIS IS, AND WHAT IT IS EMPHATICALLY NOT. This module builds the LIST OF
// OPTIONS an owner may choose from. It never chooses one. Nothing here reads the
// browser's timezone, the device clock, a locale, an IP address or a location,
// and nothing here falls back to UTC: `projects.business_timezone` is an
// authoritative business fact, and a guessed value silently written to it would
// date every register day and every report that follows from it.
//
// A project with no timezone yet is UNSET, and stays unset until an owner picks
// one on purpose. lib/dailyRegister.ts already refuses to open a register day
// without it (`business_timezone_required`), which is the honest behaviour: the
// database would rather stop than invent a business day.
//
// WHY THE RUNTIME, NOT A DEPENDENCY. `Intl.supportedValuesOf("timeZone")` is the
// platform's own IANA list — the same database the server validates against —
// so a timezone package would add weight and a second source of truth for a list
// the runtime already has. Enumerating zones is a capability question; choosing
// one is a business decision, and only the second is forbidden here.
//
// Dependency-free and side-effect-free apart from the single documented runtime
// read below, so the selection model is unit-testable under plain Node.

/** What the owner sees when `projects.business_timezone` is null. */
export const BUSINESS_TIMEZONE_UNSET_LABEL = "Not set";

/**
 * The list used only when the runtime cannot enumerate IANA zones.
 *
 * Deliberately short and deliberately NOT a default: it is a starting set of
 * valid identifiers so an owner on an older runtime can still configure a
 * timezone, and the value they pick is still theirs to pick. A configured value
 * outside this list is always kept (see listBusinessTimezoneOptions), so this
 * never narrows an existing project.
 */
export const FALLBACK_BUSINESS_TIMEZONES: readonly string[] = [
  "America/Anchorage",
  "America/Chicago",
  "America/Denver",
  "America/Halifax",
  "America/Los_Angeles",
  "America/New_York",
  "America/Phoenix",
  "America/Puerto_Rico",
  "America/Toronto",
  "America/Vancouver",
  "Pacific/Honolulu",
  "UTC",
] as const;

/**
 * The IANA zones this runtime can name, or null when it cannot name any.
 *
 * READS A CAPABILITY, RETURNS NO CHOICE. The result is a menu, never a
 * selection: no caller may treat any element of it as the project's timezone.
 * Wrapped because `supportedValuesOf` is absent on older runtimes and may throw
 * on a partial Intl implementation.
 */
export function runtimeSupportedTimezones(): string[] | null {
  try {
    const intl = Intl as unknown as {
      supportedValuesOf?: (key: string) => string[];
    };

    if (typeof intl.supportedValuesOf !== "function") {
      return null;
    }

    const zones = intl.supportedValuesOf("timeZone");

    return Array.isArray(zones) && zones.length > 0 ? zones : null;
  } catch {
    return null;
  }
}

/**
 * The options to offer, given what the runtime knows and what is configured.
 *
 * THE CURRENT VALUE IS ALWAYS PRESENT, even when the runtime does not list it —
 * an owner must be able to SEE what their project is set to, and a select that
 * silently dropped an unrecognised value would show the wrong timezone as
 * selected, which is worse than showing an unfamiliar one.
 *
 * Sorted and de-duplicated so the control renders the same way every time.
 */
export function listBusinessTimezoneOptions(
  supported: readonly string[] | null | undefined,
  current: string | null | undefined
): string[] {
  const source =
    supported && supported.length > 0 ? supported : FALLBACK_BUSINESS_TIMEZONES;

  const options = new Set<string>();

  for (const zone of source) {
    if (typeof zone === "string" && zone.trim() !== "") {
      options.add(zone);
    }
  }

  if (typeof current === "string" && current.trim() !== "") {
    options.add(current);
  }

  return [...options].sort((a, b) => a.localeCompare(b));
}

/**
 * What to show for the currently configured timezone.
 *
 * Null stays visibly unset rather than borrowing a plausible-looking zone.
 */
export function describeBusinessTimezone(current: string | null | undefined): string {
  return typeof current === "string" && current.trim() !== ""
    ? current
    : BUSINESS_TIMEZONE_UNSET_LABEL;
}

/**
 * Should this save carry `business_timezone` at all?
 *
 * OMITTED MEANS UNTOUCHED in lib/projects.ts, and that is what an ordinary save
 * must do: resending the same value on every price edit would put the column
 * through the validation trigger for no reason, and sending one the owner never
 * chose is exactly the silent inference this feature refuses to make.
 */
export function businessTimezoneUpdate(
  saved: string | null,
  selected: string | null
): { businessTimezone?: string | null } {
  return saved === selected ? {} : { businessTimezone: selected };
}

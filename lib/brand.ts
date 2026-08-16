// Feature 24.1 — the POS Canvas platform identity, in one place.
//
// WHAT THIS IS: the product's own name, as customers read it and as the two app
// shells declare it. Before this module the same strings were typed out in five
// unrelated files — capacitor.config.ts, android/.../strings.xml,
// windows-shell/package.json (twice), windows-shell/main.mjs, the landing
// footer — and nothing tied them together. They happened to agree; nothing made
// them agree.
//
// THE DISTINCTION THIS MODULE EXISTS TO PROTECT, stated once and guarded in
// lib/brand.guards.test.ts:
//
//   PLATFORM branding (here)         the POS Canvas product: the website, the
//                                    Android launcher, the Windows app, the
//                                    splash screens, the About panel. One
//                                    identity for every customer.
//
//   CUSTOMER branding (NOT here)     a business's own name, accent colour and
//                                    logo, living in ProjectConfig.branding and
//                                    frozen into a published GeneratedPosConfig.
//                                    Different for every project.
//
// Mixing them would be a real bug in both directions: a customer's logo must
// never become the app's launcher icon, and the POS Canvas mark must never be
// baked into a customer's published configuration.
//
// NOTHING HERE IS INVENTED. Every value below is a name this product already
// uses in shipped artifacts. Fields that have no truthful value are `null`
// rather than a plausible-looking placeholder — see the note on
// legalCompanyName, which is the one that would matter legally.
//
// Dependency-free (no React, no Supabase, no node builtins) so the same identity
// is available in a server component, in the browser, and under Vitest.

/**
 * The POS Canvas platform identity.
 *
 * `as const` so every value is a literal type: a typo in a consumer is a type
 * error rather than a string that merely looks wrong at runtime.
 */
export const BRAND = {
  /** The product name, everywhere a customer reads it. */
  productName: "POS Canvas",

  /**
   * The short form, for places with little room (window titles, shortcuts).
   *
   * Identical to productName today because "POS Canvas" is already short. It
   * exists as a separate field so a future abbreviation has somewhere to go
   * that is not a second edit to every consumer.
   */
  shortName: "POS Canvas",

  /**
   * The publisher name shown to customers — in the footer, in About, and
   * eventually beside the app in Windows.
   *
   * This is a DISPLAY name, not a legal entity. See legalCompanyName.
   */
  companyDisplayName: "POS Canvas",

  /**
   * The application identifier shared by both shells.
   *
   * PERMANENT. On Android it is the applicationId, which together with the
   * signing certificate defines app identity — change it and installed tills
   * see a different app with no upgrade path. On Windows it is electron-builder's
   * appId, which determines the uninstall registry entry and, with productName,
   * the %APPDATA% directory holding the paired device session.
   */
  appId: "com.poscanvas.app",

  /** The site's name, for page titles and metadata. */
  websiteName: "POS Canvas",

  /**
   * NOT YET DEFINED — deliberately null, not a guess.
   *
   * There is no approved legal entity for POS Canvas. Inventing one ("POS Canvas
   * Inc.", "POS Canvas LLC") would be a false claim about who is responsible for
   * the software, and it is exactly the field that a code-signing certificate
   * subject, a privacy policy and a terms-of-service page would all have to
   * agree with. Any surface that would need it must state the requirement and
   * stop, rather than fill it in.
   */
  legalCompanyName: null,

  /** No support address exists yet. A fake one is worse than none. */
  supportEmail: null,

  /**
   * No canonical marketing URL is committed to this repository.
   *
   * The deployment origin lives in lib/siteOrigin.ts, which is a security
   * allow-list for recovery redirects — a different concern with different
   * rules, and not a value to duplicate here.
   */
  websiteUrl: null,
} as const;

/**
 * The one-line description of what the product is.
 *
 * Deliberately factual: it describes the universal-app architecture this
 * product actually has, and makes no claim about scale, security or
 * capabilities that has not been built.
 */
export const BRAND_TAGLINE = "Build and run your point of sale.";

/**
 * How the app describes itself in About.
 *
 * Says the one thing an owner benefits from understanding: the app they install
 * is the same for everybody, and it becomes THEIR till by pairing.
 */
export const BRAND_APP_SUMMARY =
  "One universal application for every business. Install it on a device, then " +
  "pair that device with a published configuration to turn it into your till.";

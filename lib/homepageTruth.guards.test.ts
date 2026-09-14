// Lane 3 Task 2 — the public homepage says only what the product actually does.
//
// WHY THIS FILE EXISTS. A marketing surface is the easiest place in a codebase
// to tell a lie, because nothing breaks when you do. This homepage had already
// proved it: a Features card read "Instant Download — Export your finished POS
// app and start using it right away", describing the superseded architecture in
// which a project produced its own application. That copy survived the whole of
// Feature 22, which replaced that model with one universal app per platform
// plus pairing, because no test reads marketing copy.
//
// v1.3 makes the risk sharper. Employee management, time clock, register
// sessions, cash movements and barcode scanning are being built in other lanes
// RIGHT NOW. They are implemented-but-not-released, which is exactly the state
// in which someone reasonably adds them to a features grid. These guards fail
// if that happens before a release verifies it.
//
// WHAT THESE DO NOT DO. They cannot tell whether copy is well written or
// whether a claim is fair. They assert the narrow, checkable things: that a
// banned vocabulary is absent, that a fabricated number is absent, and that the
// customer journey has one source rather than two.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LANDING_JOURNEY, LANDING_JOURNEY_SHORT } from "@/lib/landingJourney";
import { templates } from "@/data/templates";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf-8");
}

/**
 * Strips comments, so a comment that EXPLAINS a ban does not trip it.
 *
 * Load-bearing here: components/landing/Features.tsx documents in prose exactly
 * which unreleased capabilities it leaves out, and names every one of them.
 * Matching raw source would fail on the documentation of the rule.
 */
function code(source: string): string {
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const LANDING_DIR = "components/landing";

/** Every component the public homepage renders, plus the page itself. */
const HOMEPAGE_SURFACES = [
  "app/page.tsx",
  `${LANDING_DIR}/Navbar.tsx`,
  `${LANDING_DIR}/Hero.tsx`,
  `${LANDING_DIR}/SectionHeading.tsx`,
  `${LANDING_DIR}/Templates.tsx`,
  `${LANDING_DIR}/TemplateCard.tsx`,
  `${LANDING_DIR}/BusinessTypes.tsx`,
  `${LANDING_DIR}/Features.tsx`,
  `${LANDING_DIR}/FeatureCard.tsx`,
  `${LANDING_DIR}/HowItWorks.tsx`,
  `${LANDING_DIR}/PlatformAvailability.tsx`,
  `${LANDING_DIR}/CTASection.tsx`,
  `${LANDING_DIR}/Footer.tsx`,
  "lib/landingJourney.ts",
];

// ---------------------------------------------------------------------------
// Unreleased v1.3 capability
// ---------------------------------------------------------------------------

describe("the homepage markets nothing that has not been released", () => {
  // Being built in other v1.3 lanes as this is written. None of it is in the
  // released v1.2.0 an owner can download, so none of it may be advertised —
  // not as available, and not as "coming soon" either, which is still a promise
  // about a date nobody has committed to.
  const UNRELEASED = [
    "employee",
    "Employee",
    "workforce",
    "Workforce",
    "staff member",
    "time clock",
    "Time Clock",
    "timeclock",
    "payroll",
    "Payroll",
    "barcode",
    "Barcode",
    "scanner",
    "Scanner",
    "scanning",
    "Scanning",
    "cash drawer",
    "Cash drawer",
    "cash count",
    "register session",
    "Register session",
    "age verification",
    "Age verification",
    "ID check",
  ];

  for (const surface of HOMEPAGE_SURFACES) {
    it(`${surface} advertises no unreleased capability`, () => {
      const source = code(read(surface));

      for (const claim of UNRELEASED) {
        expect(`${surface}: ${claim}`).toBe(`${surface}: ${claim}`);
        expect(source).not.toContain(claim);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Distribution: the superseded architecture must not come back
// ---------------------------------------------------------------------------

describe("the homepage describes the distribution model that shipped", () => {
  // ONE universal application per platform, which becomes a specific business's
  // till by pairing. NOT one build per business. lib/publishTerminology.guards
  // .test.ts bans the phrases that model used repository-wide; these are the
  // homepage-shaped ways of saying the same false thing.
  const SUPERSEDED = [
    "your own app",
    "your own APK",
    "custom APK",
    "one APK",
    "APK per",
    "app per business",
    "your business's app",
    "we build your",
    "we generate",
    "custom executable",
    "custom installer",
  ];

  for (const surface of HOMEPAGE_SURFACES) {
    it(`${surface} does not promise a per-business build`, () => {
      const source = code(read(surface));

      for (const claim of SUPERSEDED) {
        expect(`${surface}: ${claim}`).toBe(`${surface}: ${claim}`);
        expect(source).not.toContain(claim);
      }
    });
  }

  it("the platform section still states the universal model in words", () => {
    // The positive control for the bans above: absence of a lie is not the
    // presence of the truth, and this is the sentence that carries it.
    const landing = read(`${LANDING_DIR}/PlatformAvailability.tsx`);

    expect(landing).toContain("universal POS Canvas app");
    expect(landing).toContain("same for every business");
  });

  it("the pairing step survives in the walkthrough", () => {
    const howItWorks = read(`${LANDING_DIR}/HowItWorks.tsx`);

    expect(howItWorks).toContain("Install POS Canvas");
    expect(howItWorks).toContain("pair it with your published configuration");
  });
});

// ---------------------------------------------------------------------------
// Storefronts and commerce claims
// ---------------------------------------------------------------------------

describe("the homepage invents no distribution channel or commercial term", () => {
  const FABRICATED = [
    "Play Store",
    "Google Play",
    "App Store",
    "Microsoft Store",
    "Windows Store",
    "free trial",
    "no credit card",
    "money-back",
    "guarantee",
    "Guarantee",
    "per month",
    "/mo",
    "trusted by",
    "Trusted by",
    "testimonial",
    "rated #1",
    "#1 ",
  ];

  for (const surface of HOMEPAGE_SURFACES) {
    it(`${surface} makes no store or pricing claim`, () => {
      const source = code(read(surface));

      for (const claim of FABRICATED) {
        expect(`${surface}: ${claim}`).toBe(`${surface}: ${claim}`);
        expect(source).not.toContain(claim);
      }
    });
  }

  it("no fabricated metric appears anywhere on the page", () => {
    // A price, a percentage or a customer count. There is no pricing system, no
    // uptime measurement and no customer number in this repository, so any of
    // these would have been invented.
    for (const surface of HOMEPAGE_SURFACES) {
      const source = code(read(surface));

      expect(`${surface} price`).toBe(`${surface} price`);
      expect(source).not.toMatch(/\$\s?\d/);
      expect(source).not.toMatch(/\b\d+(\.\d+)?%/);
      expect(source).not.toMatch(
        /\b\d[\d,]{2,}\+?\s+(businesses|customers|merchants|stores|users)/i
      );
    }
  });

  it("no payment processing or hardware ecosystem is implied", () => {
    // Cash and card are RECORDED payment methods; nothing is processed, and no
    // terminal, reader or peripheral is integrated.
    for (const surface of HOMEPAGE_SURFACES) {
      const source = code(read(surface));

      for (const claim of [
        "payment processing",
        "process payments",
        "card reader",
        "payment terminal",
        "Stripe",
        "Square",
        "PayPal",
        "chip reader",
        "tap to pay",
      ]) {
        expect(`${surface}: ${claim}`).toBe(`${surface}: ${claim}`);
        expect(source).not.toContain(claim);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Scale, quantity and commercial terms
// ---------------------------------------------------------------------------

describe("the homepage promises no quantity it has not committed to", () => {
  // THE DEFECT THIS EXISTS FOR. The platform section closed with "Run as many
  // devices as you need on one published configuration". That reads like an
  // architecture statement and is not one: pairing many devices to a single
  // published configuration is how the system is SHAPED, while "as many as you
  // need" is an unbounded scalability and commercial-support promise. No such
  // promise has been established or approved, and it is exactly the kind of
  // sentence that gets written once on a marketing page and then has to be
  // honoured forever.
  //
  // The same reasoning covers counts, tiers and locations: none of them exists
  // as a product fact in this repository, so any of them would be invented.
  const UNBOUNDED = [
    "as many",
    "as you need",
    "unlimited",
    "Unlimited",
    "no limit",
    "No limit",
    "any number",
    "however many",
    "every device you",
    "multi-location",
    "Multi-location",
    "multiple locations",
    "locations",
    "per device",
    "per seat",
    "per terminal",
    "pricing tier",
  ];

  for (const surface of HOMEPAGE_SURFACES) {
    it(`${surface} states no unbounded or metered quantity`, () => {
      const source = code(read(surface));

      for (const claim of UNBOUNDED) {
        expect(`${surface}: ${claim}`).toBe(`${surface}: ${claim}`);
        expect(source).not.toContain(claim);
      }
    });
  }

  it("no device, terminal or store count appears anywhere", () => {
    for (const surface of HOMEPAGE_SURFACES) {
      const source = code(read(surface));

      expect(`${surface} count`).toBe(`${surface} count`);
      expect(source).not.toMatch(
        /\b\d+\s*\+?\s*(devices|terminals|tills|counters|registers|locations|stores)\b/i
      );
    }
  });

  it("the platform section still explains pairing, which is the true part", () => {
    // The positive control. Removing the promise must not remove the
    // architecture it was wrapped around: many devices CAN share one published
    // configuration, and that shape is what the line is allowed to say.
    const landing = read(`${LANDING_DIR}/PlatformAvailability.tsx`);

    expect(landing).toContain(
      "Pair your devices with the same published business configuration."
    );
  });
});

// ---------------------------------------------------------------------------
// The journey has ONE source
// ---------------------------------------------------------------------------

describe("the hero and the walkthrough cannot disagree again", () => {
  it("both render the shared journey", () => {
    expect(code(read(`${LANDING_DIR}/Hero.tsx`))).toContain(
      "@/lib/landingJourney"
    );
    expect(code(read(`${LANDING_DIR}/HowItWorks.tsx`))).toContain(
      "@/lib/landingJourney"
    );
  });

  it("neither declares a competing list of steps", () => {
    // THE ACTUAL DEFECT: the hero held four labels while the section held
    // three, and nothing connected them. A second array of step-shaped strings
    // in either file is that bug returning.
    for (const surface of [`${LANDING_DIR}/Hero.tsx`, `${LANDING_DIR}/HowItWorks.tsx`]) {
      const source = code(read(surface));

      expect(`${surface}: FLOW`).toBe(`${surface}: FLOW`);
      expect(source).not.toMatch(/const\s+(FLOW|STEPS|JOURNEY)\s*=\s*\[/);
    }
  });

  it("the walkthrough states no step count that a seventh step would falsify", () => {
    // "From template to launch in three steps" was half of how the old
    // mismatch survived: the count was typed into the heading, so adding a step
    // left the heading wrong with nothing to notice.
    const howItWorks = code(read(`${LANDING_DIR}/HowItWorks.tsx`));

    for (const count of ["three steps", "four steps", "five steps", "3 steps"]) {
      expect(`HowItWorks: ${count}`).toBe(`HowItWorks: ${count}`);
      expect(howItWorks).not.toContain(count);
    }
  });

  it("every step has a description, and every description a step", () => {
    const howItWorks = read(`${LANDING_DIR}/HowItWorks.tsx`);

    for (const step of LANDING_JOURNEY) {
      expect(`step ${step.number}`).toBe(`step ${step.number}`);
      expect(howItWorks).toContain(`"${step.number}":`);
    }

    // The renderer indexes DESCRIPTIONS by step number, so a step with no entry
    // renders an empty paragraph rather than failing.
    const described = howItWorks.match(/"0\d":/g) ?? [];
    expect(described.length).toBe(LANDING_JOURNEY.length);
  });

  it("the journey is the approved one, in order", () => {
    expect(LANDING_JOURNEY.map((step) => step.number)).toEqual([
      "01",
      "02",
      "03",
      "04",
      "05",
      "06",
    ]);
    expect(LANDING_JOURNEY_SHORT.length).toBe(LANDING_JOURNEY.length);
  });

  it("the journey module names no unreleased step", () => {
    const journey = code(read("lib/landingJourney.ts"));

    for (const banned of ["employee", "barcode", "time clock", "register"]) {
      expect(`journey: ${banned}`).toBe(`journey: ${banned}`);
      expect(journey).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// Templates come from the registry, and only from the registry
// ---------------------------------------------------------------------------

describe("the templates section reports the registry it has", () => {
  const section = code(read(`${LANDING_DIR}/Templates.tsx`));

  it("renders every template, with nothing sliced off", () => {
    // It used to show the first four of six, so the page under-reported what
    // exists — the same class of defect as the hardcoded list before it.
    expect(section).toContain('from "@/data/templates"');
    expect(section).toContain("templates.map(");
    expect(section).not.toContain("slice(");
    expect(templates.length).toBeGreaterThan(0);
  });

  it("takes each card's words from the registry rather than retyping them", () => {
    expect(section).toContain("title={template.name}");
    expect(section).toContain("category={template.category}");
    expect(section).toContain("description={template.description}");
  });

  it("the business-type chips are derived, so none can be invented", () => {
    // The old list named "Barbers" and "Convenience Stores", neither of which
    // has a template behind it.
    const businessTypes = code(read(`${LANDING_DIR}/BusinessTypes.tsx`));

    expect(businessTypes).toContain('from "@/data/templates"');
    expect(businessTypes).toContain("templates.map(");
    expect(businessTypes).not.toContain('"Barbers"');
    expect(businessTypes).not.toContain('"Convenience Stores"');
  });

  it("no template is marketed as a different product", () => {
    // All six run the identical engine (see the Feature 12.1 correction note in
    // data/templates.ts). Liquor Store is the one most likely to attract a
    // vertical claim while v1.3 liquor work is unreleased.
    for (const surface of [
      `${LANDING_DIR}/Templates.tsx`,
      `${LANDING_DIR}/TemplateCard.tsx`,
      `${LANDING_DIR}/BusinessTypes.tsx`,
    ]) {
      const source = code(read(surface));

      for (const claim of [
        "built specifically for",
        "purpose-built",
        "complete liquor",
        "industry-specific",
        "vertical-specific",
        "tailored engine",
      ]) {
        expect(`${surface}: ${claim}`).toBe(`${surface}: ${claim}`);
        expect(source).not.toContain(claim);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

describe("the footer invents no company", () => {
  const footer = code(read(`${LANDING_DIR}/Footer.tsx`));

  it("fabricates no contact detail or social presence", () => {
    // lib/brand.ts holds null for supportEmail and websiteUrl because neither
    // has a truthful value. A footer that fills them in to look finished is a
    // footer that lies.
    for (const claim of [
      "@gmail",
      "mailto:",
      "tel:",
      "twitter",
      "Twitter",
      "facebook",
      "Facebook",
      "instagram",
      "Instagram",
      "linkedin",
      "LinkedIn",
      "Follow us",
      "Suite",
      "Street",
    ]) {
      expect(`footer: ${claim}`).toBe(`footer: ${claim}`);
      expect(footer).not.toContain(claim);
    }
  });

  it("claims no legal entity", () => {
    for (const suffix of ["Inc.", "LLC", "Ltd", "GmbH", "Corporation", "Pty"]) {
      expect(`footer: ${suffix}`).toBe(`footer: ${suffix}`);
      expect(footer).not.toContain(suffix);
    }

    expect(footer).not.toContain("legalCompanyName");
    expect(footer).toContain("BRAND.companyDisplayName");
  });

  it("links to no page that does not exist", () => {
    // Terms, Privacy and EULA are the ones a footer grows first. None has a
    // route, so none is linked; creating them was not this task.
    for (const route of ["terms", "privacy", "eula", "cookies"]) {
      expect(`footer: ${route}`).toBe(`footer: ${route}`);
      expect(footer.toLowerCase()).not.toContain(`/${route}`);
      expect(existsSync(join(repoRoot, "app", route, "page.tsx"))).toBe(false);
    }
  });

  it("every route it does link to resolves to a real page", () => {
    for (const route of ["templates", "signup", "login"]) {
      expect(`app/${route}/page.tsx`).toBe(`app/${route}/page.tsx`);
      expect(existsSync(join(repoRoot, "app", route, "page.tsx"))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The shared download row stayed shared
// ---------------------------------------------------------------------------

describe("restyling the homepage did not restyle the application", () => {
  const ROW = "components/platform/PlatformDownloadRow.tsx";

  it("the row's default tone is the application look", () => {
    // The landing page asked for a new tone; the signed-in surfaces must keep
    // rendering exactly as they did, which is what a default of "app" buys.
    expect(code(read(ROW))).toContain('tone = "app"');
  });

  it("the signed-in surfaces pass no tone at all", () => {
    for (const surface of [
      "components/dashboard/AndroidAppCard.tsx",
      "components/devices/RunYourPosPanel.tsx",
    ]) {
      expect(`${surface}`).toBe(surface);
      expect(code(read(surface))).not.toContain("tone=");
    }
  });

  it("only the landing page opts into the site tone", () => {
    expect(code(read(`${LANDING_DIR}/PlatformAvailability.tsx`))).toContain(
      'tone="site"'
    );
  });

  it("the tone changes colour and nothing else", () => {
    // The three states and the narrowing that picks between them are shared by
    // both tones. A tone that could decide whether something is downloadable
    // would be a second answer to the question lib/platformDownloads.ts exists
    // to answer once.
    const row = code(read(ROW));

    expect(row).toContain("isDownloadable(download) ? (");
    expect(row).toContain("href={download.release.downloadUrl}");
    expect(row).not.toMatch(/tone[^\n]*isDownloadable/);
    expect(row).not.toMatch(/tone[^\n]*downloadUrl/);
  });
});

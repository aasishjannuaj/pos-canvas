// Lane 3 Task 4.1 — three product-truth reconciliations, guarded across every
// public surface.
//
// These are NOT a general marketing-copy linter. Each rule exists because a
// specific published sentence was wrong about the released product:
//
//   OFFLINE   "Selling keeps working if the connection drops" read as a
//             property of POS Canvas. It is a property of a PAIRED Android or
//             Windows till that has already been set up online, and it is
//             time-bounded. The browser POS has no offline mode at all.
//
//   PRINTING  "Print it or hand it over on screen" and "Receipt settings and
//             printing" were unqualified. The Android app shows a receipt on
//             screen and cannot print it; Windows and the browser can.
//
//   LAYOUT    "customize items, pricing, and layout" and "a layout you can
//             change" promised a control the Builder does not have. A template
//             decides the layout; what an owner changes is the content,
//             settings and branding inside it.
//
// WHAT THESE GUARDS CANNOT DO, stated plainly: they are sentence- and
// fragment-level string checks. They cannot read, and a denial anywhere in a
// sentence makes the layout and printing rules stand down. They are a floor
// under the reconciliation, not a substitute for human product-truth review.
//
// INVENTORY, AND WHY NOTHING HERE ASSERTS THE SIMPLE VERSION. An ONLINE sale
// with insufficient tracked stock is rejected at completion. An offline-queued
// paired-device sale that syncs later is KEPT: stock floors at zero and the
// shortfall is recorded for the owner to reconcile. Public copy therefore may
// not say that insufficient stock always rejects a sale — and this file does
// not encode the opposite claim either. It only bans the blanket one.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { learnArticles } from "@/data/learn";
import { templates } from "@/data/templates";
import { publishedArticles } from "@/lib/learn";
import type { LearnArticle } from "@/lib/learn";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf-8");
}

function code(source: string): string {
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const ENTITIES: Record<string, string> = {
  "&rsquo;": "’",
  "&lsquo;": "‘",
  "&ldquo;": "“",
  "&rdquo;": "”",
  "&amp;": "&",
  "&rarr;": "→",
  "&eacute;": "é",
  "&mdash;": "—",
  "&nbsp;": " ",
};

const NON_PROSE_ATTRIBUTE =
  /\b(className|href|id|src|sizes|role|tabIndex|key|aria-hidden|aria-labelledby|type|rel|target|width|height|alt|fill|stroke|d|viewBox|x|y|x1|x2|y1|y2)=("[^"]*"|\{(?:`[^`]*`|[^{}`]*)\})/g;

/** The prose of a component or page: JSX text plus the strings it renders. */
function componentProse(source: string): string[] {
  const stripped = code(source)
    .replace(/^import[\s\S]*?;$/gm, "")
    .replace(NON_PROSE_ATTRIBUTE, " ");

  const textNodes = [...stripped.matchAll(/>([^<]*)</g)].map((match) =>
    match[1]
      .replace(/\{[^{}]*\}/g, " ")
      .replace(/\{[^}]*$/, " ")
      .replace(/^[^{]*\}/, " ")
  );
  const strings = [...stripped.matchAll(/"([^"\\]*)"/g)].map((m) => m[1]);

  return [...textNodes, ...strings]
    .map((fragment) =>
      fragment
        .replace(/&[a-z]+;/g, (entity) => ENTITIES[entity] ?? entity)
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter((fragment) => /[a-z]{2}/i.test(fragment) && / /.test(fragment));
}

/**
 * A published article's PUBLIC prose only.
 *
 * Read from the typed article rather than from data/learn.ts as text, so the
 * editorial metadata beside it — release-truth notes, editorial notes, source
 * titles — is never mistaken for something a visitor reads.
 */
function articleProse(article: LearnArticle): string[] {
  const parts: string[] = [article.title, article.deck];

  for (const block of article.body) {
    if (block.kind === "paragraph") parts.push(block.text);
    if (block.kind === "heading") parts.push(block.text);
    if (block.kind === "list") parts.push(...block.items);
    if (block.kind === "callout") {
      if (block.title) parts.push(block.title);
      parts.push(block.text);
    }
    if (block.kind === "diagram") parts.push(block.caption);
    if (block.kind === "figure" && block.caption) parts.push(block.caption);
  }

  if (article.cta) parts.push(article.cta.label);

  return parts.filter(Boolean);
}

function sentences(fragment: string): string[] {
  return fragment
    .split(/(?<=[.!?;])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
}

/** Every public component and page whose strings a visitor reads. */
function publicComponentFiles(): string[] {
  const roots = [
    "components/landing",
    "components/templates",
    "components/template-detail",
    "components/learn",
    "components/seo-landing",
    "components/platform",
  ];
  const files: string[] = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(join(repoRoot, dir))) {
      const path = `${dir}/${entry}`;
      if (statSync(join(repoRoot, path)).isDirectory()) walk(path);
      else if (entry.endsWith(".tsx") && !entry.includes(".test.")) files.push(path);
    }
  };

  for (const root of roots) walk(root);

  return [
    ...files,
    "app/page.tsx",
    "app/templates/page.tsx",
    "app/templates/[id]/page.tsx",
    "app/learn/page.tsx",
    "app/learn/[slug]/page.tsx",
    "app/customizable-pos/page.tsx",
    "app/pos-for-small-business/page.tsx",
    "app/no-code-pos-builder/page.tsx",
  ];
}

/** Public prose, as {where, fragment} pairs, from components and published articles. */
function publicProse(): { where: string; fragment: string }[] {
  const out: { where: string; fragment: string }[] = [];

  for (const file of publicComponentFiles()) {
    for (const fragment of componentProse(read(file))) out.push({ where: file, fragment });
  }
  for (const article of publishedArticles(learnArticles)) {
    for (const fragment of articleProse(article)) {
      out.push({ where: `learn:${article.slug}`, fragment });
    }
  }
  // The template registry's public strings: what the gallery and the detail
  // pages print. Not the starter configurations, which no visitor reads.
  for (const template of templates) {
    out.push({ where: `template:${template.id}`, fragment: template.description });
    for (const feature of template.features) {
      out.push({ where: `template:${template.id}`, fragment: feature });
    }
  }

  return out;
}

const PROSE = publicProse();

/** A sentence that denies something is not a claim that it works. */
const DENIAL = /n't\b|\b(not|no|never|nor|cannot|without)\b/;

// ---------------------------------------------------------------------------
// A. Offline selling
// ---------------------------------------------------------------------------

describe("public copy describes offline selling as the bounded paired-device capability it is", () => {
  /** Talking about connectivity at all. */
  const OFFLINE_CONTEXT =
    /\boffline\b|\bconnection (drops|goes|is out|returns|comes back)\b|\bnetwork drops\b|\binternet (drops|goes)\b|\bwithout a connection\b/;

  /**
   * Claiming that selling carries on regardless.
   *
   * BOTH WORD ORDERS, because the sentence this task corrected put the verb
   * second: "Selling keeps working if the connection drops." A pattern that
   * only matched "keeps selling" would have let exactly that one back in.
   */
  const KEEPS_SELLING =
    /\b(keeps?|keep|carry on|carries on|continues?|still)\b[^.]*\b(selling|sell|sales|taking sales)\b|\b(selling|sales)\b[^.]*\b(keeps?|continues?|carries on|works?|working|still)\b|\btakes? sales\b/;

  const offlineClaims = PROSE.filter(
    ({ fragment }) =>
      OFFLINE_CONTEXT.test(normalise(fragment)) && KEEPS_SELLING.test(normalise(fragment))
  );

  it("finds the offline statements it is supposed to be guarding", () => {
    // If this ever reads 0, the rules below are guarding nothing and the
    // reconciliation has been deleted rather than kept true.
    expect(offlineClaims.length).toBeGreaterThanOrEqual(3);
  });

  for (const { where, fragment } of offlineClaims) {
    it(`${where} scopes its offline claim to a paired, already-set-up till, for a bounded time`, () => {
      const text = normalise(fragment);

      expect(`${where}: ${fragment}`).toBe(`${where}: ${fragment}`);
      // WHOSE capability it is.
      expect(text).toMatch(/\bpaired\b/);
      // That the till must have been set up online first.
      expect(text).toMatch(/\bset up online\b|\balready been set up\b|\bonce it has been set up\b/);
      // That it does not last forever.
      expect(text).toMatch(/\blimited time\b|\bup to seven days\b|\bseven days\b|\btemporar/);
    });

    it(`${where} claims no unlimited offline operation`, () => {
      const text = normalise(fragment);
      for (const forever of [
        /\balways\b/,
        /\bindefinitely\b/,
        /\bunlimited\b/,
        /\bnever stops\b/,
        /\bas long as you (like|want|need)\b/,
        /\bany time\b/,
      ]) {
        expect(`${where}: ${forever}`).toBe(`${where}: ${forever}`);
        expect(forever.test(text)).toBe(false);
      }
    });

    it(`${where} does not advertise the browser POS as offline-capable`, () => {
      const text = normalise(fragment);
      if (!/\bbrowser\b/.test(text)) return;
      // Naming the browser beside an offline claim is only allowed when it is
      // being excluded from it.
      expect(text).toMatch(/needs a connection|not part of this/);
    });

    it(`${where} implies no offline card processing`, () => {
      const text = normalise(fragment);
      for (const rule of [
        /\bprocess(es|ing)? (card )?payments?\b/,
        /\bcard reader\b/,
        /\bpayment processing\b/,
      ]) {
        expect(`${where}: ${rule}`).toBe(`${where}: ${rule}`);
        expect(rule.test(text)).toBe(false);
      }
    });
  }

  it("the Learn explanation keeps the bound and the browser exception", () => {
    // The detailed surface: this is where the seven days and the browser
    // exclusion belong, and the homepage stays short because this exists.
    const article = publishedArticles(learnArticles).find(
      (candidate) => candidate.slug === "one-app-not-one-per-business"
    );
    expect(article).toBeDefined();

    const prose = normalise(articleProse(article as LearnArticle).join(" "));
    expect(prose).toContain("up to seven days");
    expect(prose).toContain("needs a connection");
    expect(prose).toMatch(/\bpaired android or windows till\b/);
  });

  it("no public surface claims that insufficient stock always rejects a sale", () => {
    // TRUE ONLINE, NOT TRUE OF A SYNCED OFFLINE SALE, which is kept with the
    // shortfall recorded. The blanket version is banned; nothing here requires
    // the opposite claim either.
    const SHORT_STOCK = /\b(insufficient|not enough|short on|runs? out of|out of)\b[^.]*\b(stock|inventory)\b|\b(stock|inventory)\b[^.]*\b(insufficient|not enough)\b/;
    const REFUSED = /\breject|\brefus|\bdeclin|\bblock/;

    for (const { where, fragment } of PROSE) {
      const text = normalise(fragment);
      if (!SHORT_STOCK.test(text) || !REFUSED.test(text)) continue;
      expect(`${where}: ${fragment}`).toBe("no blanket insufficient-stock rejection claim");
    }
  });
});

// ---------------------------------------------------------------------------
// B. Receipt printing
// ---------------------------------------------------------------------------

describe("public copy qualifies receipt printing by platform", () => {
  const PRINT = /\bprint(s|ed|ing)?\b/;

  it("every printing claim names Windows or the browser, or denies printing", () => {
    for (const { where, fragment } of PROSE) {
      for (const sentence of sentences(fragment)) {
        const text = normalise(sentence);
        if (!PRINT.test(text)) continue;
        if (DENIAL.test(text)) continue;

        expect(`${where}: ${sentence}`).toBe(`${where}: ${sentence}`);
        expect(text).toMatch(/\bwindows\b|\bbrowser\b/);
      }
    }
  });

  it("no public sentence puts printing and Android together as something that works", () => {
    for (const { where, fragment } of PROSE) {
      for (const sentence of sentences(fragment)) {
        const text = normalise(sentence);
        if (!PRINT.test(text) || !/\bandroid\b/.test(text)) continue;
        if (DENIAL.test(text)) continue;
        expect(`${where}: ${sentence}`).toBe("no Android printing claim");
      }
    }
  });

  it("no public surface implies printer hardware or automatic printing", () => {
    for (const { where, fragment } of PROSE) {
      const text = normalise(fragment);
      for (const rule of [
        /\bprinters?\b/,
        /\bthermal print/,
        /\bprint(s|ing)? automatically\b/,
        /\bautomatic(ally)? print/,
      ]) {
        expect(`${where}: ${rule}`).toBe(`${where}: ${rule}`);
        expect(rule.test(text)).toBe(false);
      }
    }
  });

  it("the printing that DOES work is still advertised somewhere public", () => {
    // The other half of the correction: qualifying the claim must not quietly
    // delete a capability Windows and the browser really have.
    const kept = PROSE.some(({ fragment }) => {
      const text = normalise(fragment);
      return PRINT.test(text) && /\bwindows\b|\bbrowser\b/.test(text) && !DENIAL.test(text);
    });

    expect(kept).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D. Template layout
// ---------------------------------------------------------------------------

describe("public copy says a template decides the layout, not the owner", () => {
  /** Editing the layout: the control the Builder does not have. */
  const EDITS_LAYOUT = [
    /\b(customi[sz]e|customi[sz]ing|change|changing|changed|edit|editing|redesign|rearrange|move|drag)\b[^.]*\blayout\b/,
    /\blayout\b[^.]*\b(you can (change|customi[sz]e|edit|move)|to (change|customi[sz]e|edit)|can be (changed|customi[sz]ed|edited)|yours to change)\b/,
    /\bdrag[- ]and[- ]drop\b/,
    /\bfreeform\b/,
    /\bdesign your own (screen|layout)\b/,
  ];

  it("no public sentence offers layout editing", () => {
    for (const { where, fragment } of PROSE) {
      for (const sentence of sentences(fragment)) {
        const text = normalise(sentence);
        if (DENIAL.test(text)) continue;

        for (const rule of EDITS_LAYOUT) {
          expect(`${where}: ${rule} :: ${sentence}`).toBe(`${where}: ${rule} :: ${sentence}`);
          expect(rule.test(text)).toBe(false);
        }
      }
    }
  });

  it("the template surfaces still say where the layout comes from", () => {
    // Positive control. Removing the false claim must not leave a visitor
    // wondering whether the layout is configurable at all.
    const detail = normalise(componentProse(read("components/template-detail/TemplateActionPanel.tsx")).join(" "));
    expect(detail).toContain("the layout comes with this template");

    const homepage = normalise(componentProse(read("components/landing/BusinessTypes.tsx")).join(" "));
    expect(homepage).toContain("a template sets the layout your screen uses");
  });

  it("choosing a template — which IS how a layout is picked — stays sayable", () => {
    // The control that keeps this guard honest: "choose", "comes with" and
    // "starts with" are truthful and must not be collateral damage.
    for (const allowed of [
      "You are choosing a set of products and a layout, not a different product.",
      "The layout comes with the template rather than being a separate setting.",
      "A template sets the layout your screen uses.",
    ]) {
      for (const rule of EDITS_LAYOUT) {
        expect(`${allowed}: ${rule}`).toBe(`${allowed}: ${rule}`);
        expect(rule.test(normalise(allowed))).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The detector itself
// ---------------------------------------------------------------------------

describe("the reconciliation checks can see", () => {
  it("catches the exact sentences this task corrected", () => {
    const offlineUnqualified =
      "Selling keeps working if the connection drops.";
    const OFFLINE_CONTEXT = /\boffline\b|\bconnection (drops|goes|is out|returns)\b|\bnetwork drops\b/;
    const KEEPS_SELLING =
      /\b(keeps?|keep|continues?|still)\b[^.]*\b(selling|sell|sales)\b|\b(selling|sales)\b[^.]*\b(keeps?|works?|working|continues?)\b/;

    // It is an offline claim…
    expect(OFFLINE_CONTEXT.test(normalise(offlineUnqualified))).toBe(true);
    expect(KEEPS_SELLING.test(normalise(offlineUnqualified))).toBe(true);
    // …and it carries none of the three qualifications.
    expect(normalise(offlineUnqualified)).not.toMatch(/\bpaired\b/);
    expect(normalise(offlineUnqualified)).not.toMatch(/\blimited time\b|\bseven days\b/);

    const androidPrinting = normalise("Print a receipt from your Android till.");
    expect(/\bprint(s|ed|ing)?\b/.test(androidPrinting)).toBe(true);
    expect(/\bandroid\b/.test(androidPrinting)).toBe(true);
    expect(DENIAL.test(androidPrinting)).toBe(false);

    const layoutEditing = normalise("You can customize items, pricing, and layout.");
    expect(/\b(customi[sz]e)\b[^.]*\blayout\b/.test(layoutEditing)).toBe(true);
    expect(DENIAL.test(layoutEditing)).toBe(false);

    const blanketStock = normalise("All insufficient-stock sales are rejected.");
    expect(/\b(insufficient|not enough)\b[^.]*\b(stock|inventory)\b|\binsufficient-stock\b/.test(blanketStock)).toBe(true);
    expect(/\breject/.test(blanketStock)).toBe(true);
  });

  it("reads the surfaces it claims to read", () => {
    const where = new Set(PROSE.map((entry) => entry.where));

    expect(where.has("components/landing/Features.tsx")).toBe(true);
    expect(where.has("components/landing/HowItWorks.tsx")).toBe(true);
    expect(where.has("components/templates/TemplateGalleryHeader.tsx")).toBe(true);
    expect(where.has("components/template-detail/TemplateActionPanel.tsx")).toBe(true);
    expect(where.has("learn:one-app-not-one-per-business")).toBe(true);
    expect(where.has("template:cafe")).toBe(true);
    expect(PROSE.length).toBeGreaterThan(150);
  });
});

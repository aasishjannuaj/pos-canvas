// The POS Canvas Learn library.
//
// ONE ARTICLE, DELIBERATELY. The brief allowed a pilot article only if it could
// be written entirely from shipped truth, and explicitly forbade filler. This
// is the one subject where POS Canvas knows something a reader cannot easily
// get elsewhere and where every sentence is checkable against code that is
// released in v1.2.0: why there is one application rather than one per
// business, and what publishing and pairing actually do.
//
// EVERY CLAIM BELOW WAS CHECKED AGAINST THE IMPLEMENTATION, not the README.
// README.md is currently stale relative to v1.2.0 — it still says "No offline
// mode" and describes the Android shell as "a packaging proof, not a till",
// both of which the 24.5 offline work and the 1.2.0 releases have overtaken.
// The article is grounded in lib/platformDownloads.ts, lib/generatedPosConfig.ts,
// lib/devicePairing.ts and the release modules instead.
//
// NOTHING HERE IS INVENTED: no customer story, no statistic, no screenshot, no
// video, no testimonial, no author biography. The one visual is a diagram of
// the architecture, drawn as a real component.
import type { LearnArticle } from "@/lib/learn";

const ONE_APP: LearnArticle = {
  slug: "one-app-not-one-per-business",
  title: "Why POS Canvas is one app, not an app per business",
  deck:
    "Most POS builders promise you a custom app. POS Canvas ships one application per platform and makes it yours by pairing. Here is what that changes about updates, devices and the day you open.",
  topic: "pos-canvas-guides",
  contentType: "guide",
  status: "published",
  publishedAt: "2026-09-14",

  // Every claim rests on functionality released in v1.2.0, so this is
  // shipped-product rather than general-education: the article IS about POS
  // Canvas, and its POS Canvas claims are all released behaviour.
  productTruth: "shipped-product",
  releaseTruthNotes:
    "Checked against v1.2.0: universal Android and Windows applications (lib/platformDownloads.ts, lib/androidRelease.ts, lib/windowsRelease.ts), configuration freezing (lib/generatedPosConfig.ts), device pairing (lib/devicePairing.ts) and offline selling (lib/offlineCheckout.ts, lib/saleQueue.ts). No employee, barcode, register or cash-movement capability is described, because none is released.",

  body: [
    {
      kind: "paragraph",
      text: "If you have shopped for point-of-sale software, you have probably been offered a custom app: you fill in your products and prices, and somewhere a build runs and produces an application with your business's name on it. It is an appealing story. It is also the reason a lot of small businesses end up stuck on a version they cannot change.",
    },
    {
      kind: "paragraph",
      text: "POS Canvas works the other way round. There is one POS Canvas application for Android and one for Windows, and they are the same download for every business. What makes a device yours is not the binary — it is the configuration you publish and the device you pair to it.",
    },
    {
      kind: "heading",
      level: 2,
      id: "what-you-are-actually-building",
      text: "What you are actually building",
    },
    {
      kind: "paragraph",
      text: "When you choose a template and start changing things, you are not writing software. You are filling in a configuration: your products and the categories they sit in, their prices, the options and add-ons that change them at checkout, your tax rate and how it is shown, what your receipt says, and your business name, logo and accent colour.",
    },
    {
      kind: "paragraph",
      text: "Publishing takes that configuration and freezes it. The frozen version is what your devices read. Until you publish again, nothing about your till changes underneath you — not because an update failed, but because a published configuration is a fixed thing on purpose.",
    },
    {
      kind: "diagram",
      name: "publish-and-pair",
      caption:
        "One application per platform. Your published configuration is what a paired device reads.",
    },
    {
      kind: "heading",
      level: 2,
      id: "why-this-matters-on-an-ordinary-tuesday",
      text: "Why this matters on an ordinary Tuesday",
    },
    {
      kind: "paragraph",
      text: "The difference shows up in the small moments rather than the sales pitch.",
    },
    {
      kind: "list",
      items: [
        "Changing a price does not require anyone to download anything. You change it, you publish, and your devices pick up the newer published configuration.",
        "Adding a second counter is pairing another device to the same published configuration, not repeating a setup.",
        "An app update and a menu change are separate events. Fixing a bug in the application does not touch your prices, and changing your prices does not require a new application.",
      ],
    },
    {
      kind: "heading",
      level: 2,
      id: "what-a-template-is-and-is-not",
      text: "What a template is, and what it is not",
    },
    {
      kind: "paragraph",
      text: "A template is a starting point, not a separate product. The restaurant template and the liquor-store template run the identical point of sale; what differs is the catalogue that is already filled in and the layout the screen starts with. Choosing the closest one saves you typing, and everything in it is yours to change afterwards.",
    },
    {
      kind: "callout",
      tone: "note",
      title: "One engine, one set of fixes",
      text: "Because every template runs the same engine, a fix to checkout is a fix for every business at once. That is the quiet advantage of not having your own binary: you are never the one shop left on an old build.",
    },
    {
      kind: "heading",
      level: 2,
      id: "what-happens-when-the-internet-drops",
      text: "What happens when the internet drops",
    },
    {
      kind: "paragraph",
      text: "A paired device holds the configuration it is running. If the connection goes out mid-service, the till keeps taking sales and queues them on the device; they sync when the connection returns, and your sales history holds the record either way. This is a property of pairing rather than a separate offline product: the device already has what it needs to sell.",
    },
    {
      kind: "heading",
      level: 2,
      id: "the-honest-trade",
      text: "The honest trade",
    },
    {
      kind: "paragraph",
      text: "One application for everybody does mean you are not getting a bespoke app icon with your logo on the home screen, and it means the shape of what you can configure is the shape POS Canvas offers. If your business needs software nobody else has, this is not that. If your business needs a till that matches how you actually sell and that you can change on a Tuesday afternoon without waiting for a build, the trade is worth understanding before you pick a POS.",
    },
  ],

  cta: {
    label: "Browse the templates",
    href: "/templates",
  },

  // Declared so the validator can check them. Local paths only.
  internalLinks: ["/templates"],
};

/**
 * The library.
 *
 * Every article, draft and published. lib/learn.ts filters; nothing here
 * decides visibility, so a draft cannot leak by being placed in a different
 * list by mistake.
 */
export const learnArticles: readonly LearnArticle[] = [ONE_APP];

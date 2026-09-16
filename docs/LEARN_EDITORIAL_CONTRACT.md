# POS Canvas Learn — editorial package contract

The deterministic boundary between the **editorial workflow** (which researches,
writes and reviews) and the **repository** (which validates, renders and
publishes).

Everything here is checkable. Nothing here is a judgement about quality —
quality is the editorial workflow's job, and this document deliberately contains
no word count, no keyword rule, no source quota and no graphics quota, because a
number standing in for editorial judgement is just a number that can be gamed.

The implementation is `lib/learn.ts`. If this document and that file ever
disagree, the file is right and this document is a bug.

---

## 1. Where the boundary is

```
RESEARCH
  ↓
WRITER                      produces an ARTICLE PACKAGE
  ↓
INDEPENDENT REVIEWER        is it useful, original, people-first?
  ↓
PRODUCT-TRUTH REVIEW        does every POS Canvas claim describe RELEASED behaviour?
  ↓
MEDIA REVIEW                is every screenshot real? is every image described?
  ↓
PASS
  ↓
PUBLISHER PREPARES A REPOSITORY CHANGE      adds the package to data/learn.ts
  ↓
REPOSITORY VALIDATION                       validateLibrary() + the guard suite
  ↓
HUMAN-CONTROLLED PUBLICATION                a reviewed commit, by a person
  ↓
POS Canvas Learn
```

### `NO ARTICLE — QUALITY THRESHOLD NOT MET`

A valid outcome at every review step, and the expected outcome much of the time.

The repository has no opinion about how often the editorial workflow runs, and
**no counter anywhere ties scheduled opportunities to published articles**. Two
editorial opportunities in a day is a *maximum opportunity*, not a quota. If the
research does not support a useful article, the correct output is no package,
and nothing in this repository notices or complains. There is no scheduler, no
cron, no queue and no backlog metric here — by design, because every one of
those would create pressure to publish something rather than nothing.

### What the repository will never do

- Publish anything on its own. `status` is changed by a person, in a commit.
- Accept a package that claims unreleased functionality is available.
- Accept an image labelled as a real screenshot without capture evidence.
- Invent an author, a publisher, a company, a rating or a date.

---

## 2. The package

A package is one `LearnArticle` object added to `data/learn.ts`. There is no
second content format, no front-matter dialect and no CMS: the package **is** the
typed record, so the compiler checks it before any test does.

| Field | Required? | Notes / validation |
|---|---|---|
| `slug` | **REQUIRED** | lower-case, hyphen-separated, unique in the library |
| `title` | **REQUIRED** | non-empty |
| `deck` | **REQUIRED** | non-empty; one or two sentences; becomes the meta description unless overridden |
| `topic` | **REQUIRED** | one of the approved topic ids (§4) |
| `contentType` | **REQUIRED** | one of the content types (§4) |
| `status` | **REQUIRED** | `draft` \| `published` — the editor's intent |
| `productTruth` | **REQUIRED** | one of four classes (§3) — a statement about the world |
| `publishedAt` | **REQUIRED once `status: published`** | `YYYY-MM-DD`. **Optional on a draft** — see below |
| `body` | **REQUIRED** | typed blocks (§5); heading anchor ids must be unique |
| `updatedAt` | OPTIONAL | `YYYY-MM-DD`; requires a `publishedAt`; never before it |
| `hero` | OPTIONAL | an image record (§6) |
| `sources` | OPTIONAL | each needs a non-empty title and an absolute `http(s)` url |
| `related` | OPTIONAL | slugs; must exist, must be publicly visible, no self-reference, no duplicates |
| `internalLinks` | OPTIONAL | repository-local paths only; each must resolve (§7) |
| `cta` | OPTIONAL | `{ label, href }`; href must be a local path that resolves |
| `video` | OPTIONAL | a real video only (§8) |
| `seo` | OPTIONAL | overrides only — see DERIVED below |
| `releaseTruthNotes` | OPTIONAL | free text for the reviewer: what was checked, against what |
| `editorialNote` | OPTIONAL | how the article came to exist; rendered verbatim (§9) |

### DERIVED — never authored, never repeated

| Value | Derived from |
|---|---|
| Article URL / canonical | `slug` + the one approved production origin (`lib/seo.ts`) |
| `<title>` | `seo.title` → falls back to `title` |
| meta description | `seo.description` → falls back to `deck` |
| `og:title` | `seo.ogTitle` → `seo.title` → `title` |
| `og:description` | `seo.ogDescription` → `seo.description` → `deck` |
| `og:url`, `og:site_name`, `og:type`, `og:locale` | the shared SEO module |
| Sitemap entry | publication rules — never a separate list |
| Breadcrumb trail | Home → Learn → the article |
| Reading order / "latest" | `publishedAt`, newest first |

**The canonical URL is not overridable.** Deriving it from the slug is the only
way it can be right, and an overridable canonical is the single most damaging
field a content system can hand an author.

---

## 3. Product truth

`productTruth` says what the article's claims rest on. It is **not** the same
field as `status`, and neither can substitute for the other.

| Class | May be public? | Meaning |
|---|---|---|
| `shipped-product` | **Yes**, after editorial approval | About POS Canvas functionality that is RELEASED |
| `general-education` | **Yes**, after editorial approval | About point-of-sale / retail / small-business practice generally — publishable **even where POS Canvas does not implement the concept** |
| `implemented-not-released` | **No** | Built but not released |
| `planned` | **No** | Future work |

### What `general-education` may and may not say

**A general-education article may freely discuss capabilities POS Canvas does
not provide.** That is the point of the class. Barcode scanning, employee PINs,
time clocks, register sessions, cash-drawer counts and age verification are all
legitimate subjects for a small-business education article, and none of them is
a claim about this product.

What is forbidden is **attributing an unreleased capability to POS Canvas**:

| Allowed | Blocked |
|---|---|
| "Barcode scanning can help retail stores enter products quickly." | "POS Canvas includes barcode scanning." |
| "Many POS systems use employee PINs to identify staff." | "POS Canvas supports employee PIN login." |
| "Age verification is an important consideration for some regulated retailers." | "POS Canvas provides age verification." |
| "POS Canvas does not currently provide barcode scanning." | "POS Canvas has a built-in time clock." |

The prohibited thing is the false capability claim, **not the industry
vocabulary**. A truthful denial — naming the product and the capability in order
to say it is absent — is explicitly allowed, because a Learn article should be
able to tell a reader what this product does not do.

**This rule applies to every class.** A `shipped-product` article may not claim
an unreleased capability either.

### Deterministic detection, and its limits

`findFalseCapabilityClaims()` reads each sentence a reader sees — title, deck,
paragraphs, headings, list items, callouts, captions — and reports any sentence
that names POS Canvas *and* an unreleased capability *without* a negation.
Publishing such an article is a validation failure. Drafts are not policed:
publication is what makes a claim.

**It is a floor, not a ceiling.** It cannot catch a claim spread across two
sentences, an implication carried by page structure, or a sentence that negates
one clause while asserting another. It is a string check, not a reader.

> **PRODUCT-TRUTH REVIEW BY A HUMAN IS A REQUIRED EDITORIAL STAGE.** A green
> test is not product-truth approval and must never be treated as one. The
> deterministic gate exists to catch the obvious cases cheaply so the human
> stage can spend its attention on the rest.

So `general-education` widens *what subjects may be published*. It does not widen
*what may be claimed about POS Canvas*.

### Publication eligibility

```
isTruthEligible(article)   →  productTruth ∈ { shipped-product, general-education }
isPubliclyVisible(article) →  status === "published"  AND  isTruthEligible(article)
```

Eligibility depends on **nothing else**. Not article count, not word count, not
source count, not an SEO score, not how many scheduled runs have happened.

### Publication dates

`publishedAt` records **an actual publication**, nothing else.

| State | `publishedAt` |
|---|---|
| `draft` | **Optional.** A draft has not been published; it must not carry a date for an event that has not happened |
| `published` | **Required**, and a valid ISO date |

`updatedAt` is optional, must be a valid date, requires a `publishedAt` to exist
(an article "updated" before it was ever published is not a state that means
anything), and may not precede it.

**A publication date must never be derived from:** the time a scheduled
editorial opportunity ran, when a draft was created, when research happened, or
a file timestamp. None of those is a publication event, and the repository holds
no scheduling metadata to confuse with one. A scheduled opportunity ≠ a
publication.

Where a date is genuinely absent, `Article` structured data **omits**
`datePublished` rather than inventing one.

---

## 4. Enums

**Topics** (`TOPICS`) — the approved minimal taxonomy. Adding, removing or
renaming one is a deliberate change to `lib/learn.ts` *and* its guard, in the
same diff. There is no maximum.

- `pos-basics` — POS Basics
- `pos-canvas-guides` — POS Canvas Guides
- `running-your-business` — Running Your Business

**Content types** — `guide` · `article` · `tutorial` · `video` · `build-insight`

**Status** — `draft` · `published`

**Media provenance** — `real-product-screenshot` · `illustration` · `diagram` · `photograph`

---

## 5. Body blocks

The body is an array of typed blocks. There is no Markdown and no MDX: both
would mean a dependency, and MDX would mean arbitrary JSX inside content, which
is the wrong shape for a library an automated writer proposes drafts into.

| Block | Shape |
|---|---|
| `paragraph` | `{ text }` |
| `heading` | `{ level: 2 \| 3, id, text }` — the page owns the single `<h1>`; ids must be unique |
| `list` | `{ items, ordered? }` |
| `callout` | `{ tone: "note" \| "caution", title?, text }` |
| `diagram` | `{ name, caption }` — a **reviewed named component** |
| `figure` | `{ image, caption? }` |
| `animation` | `{ animation }` (§6) |

**Diagrams and component animations are referenced by name, never embedded.** An
article can only point at a drawing that already exists as a reviewed component.
No SVG or HTML markup travels in article data, and **`dangerouslySetInnerHTML` is
never used for editorial content** — the only use of it in Learn is `JSON.stringify`
of structured data built from typed values.

---

## 6. Media

### Images

Every image record requires `src`, `alt`, `width`, `height` and `provenance`.
Dimensions are required so nothing shifts as the page loads. `decorative: true`
renders `alt=""`; anything else needs real alt text.

### Real screenshots vs everything else

`provenance` is **required**, so the decision cannot be skipped. `real-product-screenshot`
means *captured from the running POS Canvas product*. A mockup, a recreated
interface, a generated image or a redrawn "clean" version is an `illustration` —
never a screenshot, under any pressure.

A `real-product-screenshot` additionally requires `capture`:

```ts
capture: { surface: string; capturedAt: string /* ISO */; appVersion?: string }
```

so the claim carries its own evidence, and:

- may **not** be `decorative` — evidence is not decoration
- must have non-empty alt text
- is framed and labelled "POS Canvas screenshot" in the article, so a reader can
  tell evidence from illustration without taking anyone's word for it

Nothing but a real screenshot may carry `capture` — capture metadata on a drawing
would make a mockup look like evidence.

**Never visible in a screenshot:** credentials, tokens, API keys, real customer
names or contact details, real order data, or anything that exists only in
staging.

### Animation

```ts
{ kind: "animated-webp" | "video-loop", src, width, height, description, poster, caption?, loading? }
{ kind: "component", name, width, height, description, caption? }
```

- `description` is **required** — it is the accessible description. An animation
  that cannot be described in a sentence is decoration.
- `poster` is **required** for asset-backed animation. It is what a reader sees
  before the asset loads, if it fails, and **when they have asked for reduced
  motion** — the still and the motion are both in the DOM and CSS chooses, so no
  client JavaScript decides whether a reader sees movement.
- Never carries audio. Nothing autoplays sound.
- Below-fold media is lazy-loaded.

No animation library, and no animation for decoration's sake.

---

## 7. Links and sources

**`internalLinks`** are repository-local paths, declared so they can be checked
deterministically: `/`, `/learn`, `/templates`, `/login`, `/signup`, a
`/templates/{id}` shape, or `/learn/{slug}` where that slug resolves to a
publicly visible article.

**`sources`** are external citations: title + absolute URL, with optional
publisher and dates. The repository checks the *shape*, not the internet — an
unknown "accessed" date is omitted, never guessed.

For subjects involving law, alcohol regulation, tax, payments, food safety or
employment, writers must cite current authoritative sources (regulator or
government publications), not secondary SEO commentary.

**`related`** must resolve to publicly visible articles, may not include the
article itself, and may not repeat a slug.

---

## 8. Video

Optional, and only ever real. `VideoObject` structured data is emitted **only**
when a real video with truthful `title`, `uploadDate`, `durationSeconds` and
thumbnail exists — there is currently no builder for it, so a placeholder cannot
produce one. Articles without video load no video payload. A transcript is
optional and belongs to the video.

---

## 9. Authorship and AI transparency

Articles currently carry **no byline**, and `Article` structured data omits
`author` and `publisher`. That is deliberate: **there is no approved author
identity for POS Canvas content**, and an invented writer, reviewer, credential
or biography is the most common fabrication on a content site.

**A correction to an earlier version of this document:** it claimed an
Organization author was effectively blocked by the absence of
`BRAND.legalCompanyName`. That is wrong. Google's `Article` documentation
accepts either a `Person` or an `Organization` as author, and its `Organization`
documentation treats `legalName` as **optional**. Naming POS Canvas as the
accountable editorial author is therefore **an owner policy decision, not a
technical blocker**.

It is still not being done now. The open options:

| | |
|---|---|
| **A** | No author or byline yet; use a truthful creation/process disclosure where one is appropriate. *(current behaviour)* |
| **B** | A named human author/editor, once a real person accepts responsibility and the owner approves the public identity. |
| **C** | POS Canvas as an `Organization` author — only if the owner explicitly decides POS Canvas itself is the accountable editorial author. |

None of the three is implemented. The decision is the owner's and remains open.

`editorialNote` is the disclosure channel: a factual sentence about how an
article came to exist, rendered verbatim when present. It follows Google's
guidance that AI should *not* be given an author byline, while an automation
disclosure *is* useful where a reader might reasonably ask "how was this made?".

---

## 10. Validation

`validateArticle(article, library)` returns a list of issues; `validateLibrary()`
runs it across everything. Empty means well formed. The guard suite asserts the
library validates clean, so a malformed package fails the build with its own
explanation rather than reaching the site.

Gates: slug shape and uniqueness · topic · content type · status · title and deck
present · derived SEO values non-empty · date formats · `updatedAt` ordering ·
publication/truth compatibility · false-capability-claim detection (published
only) · unique heading ids · image dimensions and alt ·
screenshot provenance and capture evidence · animation description, dimensions
and poster · video completeness · source shape · related-article resolution,
self-reference and duplicates · internal-link resolution · CTA target.

Deliberately **not** gates: word count, keyword density, source count, graphics
count, article count, topic count, "SEO score", freshness.

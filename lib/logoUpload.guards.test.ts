// Feature 19 — static security guards for the logo upload path.
//
// Source-level assertions, following this repository's existing guard
// convention. The properties below are structural: none of them can be caught
// by a behavioral test, because nothing observable breaks at the moment they
// are violated. A service-role credential reaching a browser bundle, an
// ownership check moving after an upload, or a write policy appearing on a
// PUBLIC bucket all keep working perfectly right up until they are exploited.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf-8");
}

/** Strips comments, so prose explaining a rule never trips the rule. */
function code(source: string): string {
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Strips SQL line comments, so migration prose never trips a guard either. */
function sql(source: string): string {
  return source.replace(/^\s*--.*$/gm, "");
}

function sourceFiles(relativeDir: string): string[] {
  return readdirSync(join(repoRoot, relativeDir)).flatMap((entry) => {
    const relative = join(relativeDir, entry);
    if (statSync(join(repoRoot, relative)).isDirectory()) {
      return sourceFiles(relative);
    }
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [relative] : [];
  });
}

const PURE = "lib/logoUpload.ts";
const SERVER = "lib/logoUpload.server.ts";
const ACTION = "lib/logoUpload.actions.ts";
const FIELD = "components/editor/BrandingLogoField.tsx";
const HEADER = "components/runtime/PosHeader.tsx";
const MIGRATION = "supabase/migrations/20260813120000_project_logo_storage.sql";

/** Every non-test file that runs in a browser bundle. */
const CLIENT_SOURCES = [...sourceFiles("components"), ...sourceFiles("app")];

describe("the service-role credential never reaches a browser", () => {
  it("the upload implementation is server-only", () => {
    // Without this the admin client could be pulled into a client bundle by a
    // stray import, and the build would happily ship the credential.
    expect(read(SERVER).startsWith('import "server-only";')).toBe(true);
  });

  it("no component or route imports the server upload module directly", () => {
    // The Server Action is the only permitted entry point.
    for (const file of CLIENT_SOURCES) {
      expect(code(read(file))).not.toContain("@/lib/logoUpload.server");
    }
  });

  it("no component imports the admin client or names the service-role key", () => {
    for (const file of CLIENT_SOURCES) {
      const source = code(read(file));
      expect(source).not.toContain("@/lib/supabase/admin");
      expect(source).not.toContain("createAdminClient");
      expect(source).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    }
  });

  it("the pure module touches no credential, client or transport at all", () => {
    // It is imported by the browser, the action and Vitest alike.
    const pure = code(read(PURE));
    for (const banned of [
      "supabase",
      "createClient",
      "process.env",
      "fetch(",
      "server-only",
      "node:",
    ]) {
      expect(pure).not.toContain(banned);
    }
  });

  it("the action is a server action and never logs", () => {
    expect(read(ACTION).startsWith('"use server";')).toBe(true);
    expect(code(read(ACTION))).not.toMatch(/console\.(log|info|warn|error|debug)/);
    expect(code(read(SERVER))).not.toMatch(/console\.(log|info|warn|error|debug)/);
  });
});

describe("ownership is established BEFORE anything privileged happens", () => {
  const action = code(read(ACTION));

  it("authenticates and verifies the project through getProjectById", () => {
    // The same RLS-bound helper createBuildJob uses: a project owned by someone
    // else is indistinguishable from one that does not exist.
    expect(action).toContain("getProjectById(input.projectId)");
  });

  it("calls the upload only after that check", () => {
    expect(action.indexOf("getProjectById")).toBeLessThan(
      action.indexOf("uploadProjectLogo(")
    );
  });

  it("passes the VERIFIED project id onward, not the raw input", () => {
    // So the object path is derived from validated state.
    expect(action).toContain("projectId: project.id");
    expect(action).not.toMatch(/uploadProjectLogo\(\{\s*projectId: input\.projectId/);
  });

  it("rejects a non-UUID project id before touching the database", () => {
    expect(action).toContain("isValidLogoProjectId(input.projectId)");
  });

  it("returns no bucket name, credential, signed URL or raw storage error", () => {
    // Asserted on what would actually leak. "storage" alone would match the
    // internal `storage_failed` reason code, which is a sanitized category —
    // the opposite of a leak.
    for (const banned of [
      "project-logos",
      "LOGO_BUCKET",
      "createAdminClient",
      "SUPABASE_SERVICE_ROLE_KEY",
      "createSignedUrl",
      "storage.from",
    ]) {
      expect(action).not.toContain(banned);
    }

    // The raw storage error object never reaches the returned message.
    expect(action).not.toMatch(/message:\s*\w*[eE]rror\.message/);
  });
});

describe("the browser cannot choose what gets stored", () => {
  const action = code(read(ACTION));
  const server = code(read(SERVER));

  it("the action's input surface is exactly a project id and a file", () => {
    const signature = action.slice(
      action.indexOf("export async function uploadProjectLogoAction"),
      action.indexOf("): Promise<UploadLogoActionResult>")
    );

    expect(signature).toContain("projectId: string");
    expect(signature).toContain("file: File");
    // There is nowhere to put any of these.
    for (const banned of ["path", "checksum", "width", "height", "mimeType"]) {
      expect(signature).not.toContain(banned);
    }
  });

  it("the checksum is computed from the received bytes", () => {
    expect(server).toContain('createHash("sha256").update(bytes)');
  });

  it("the path is derived server-side from the validated id", () => {
    expect(server).toContain("createLogoObjectPath({");
    expect(server).toContain("projectId: input.projectId");
  });

  it("the mime type comes from MAGIC BYTES, never from the caller", () => {
    // File.type is caller-controlled: renaming evil.svg to logo.png forges it.
    expect(server).toContain("detectImageMimeType(bytes)");
    expect(server).toContain("mimeType: detectedMimeType");
    // A claimed type that disagrees with the real one is rejected outright.
    expect(server).toContain("input.file.type !== detectedMimeType");
  });

  it("the extension comes from the detected mime, never from the filename", () => {
    expect(server).not.toContain("file.name");
  });

  it("dimensions are read from the bytes and bounded", () => {
    expect(server).toContain("readImageDimensions(bytes, detectedMimeType)");
    expect(server).toContain("MAX_LOGO_DIMENSION");
  });

  it("size is re-checked against the actual byte length, not File.size alone", () => {
    expect(server).toContain("bytes.length > MAX_LOGO_BYTES");
  });
});

describe("objects are never overwritten", () => {
  const server = code(read(SERVER));

  it("uploads with upsert:false", () => {
    // Load-bearing: an object at a content-addressed path can only have been
    // produced by those exact bytes, so overwriting would either be a no-op or,
    // if addressing were ever weakened, silently rewrite historical branding.
    expect(server).toContain("upsert: false");
    expect(server).not.toContain("upsert: true");
  });

  it("treats ONLY an already-exists collision as reuse", () => {
    expect(server).toContain("isAlreadyExistsError(uploadError)");
    // Narrow by construction: every other storage error still fails.
    expect(server).toContain("if (uploadError && !isAlreadyExistsError(uploadError))");
  });

  it("never deletes or moves a stored object", () => {
    // An older build snapshot may still reference it; a device pinned to that
    // build must keep rendering the logo it was built with.
    for (const file of [SERVER, ACTION, PURE]) {
      const source = code(read(file));
      expect(source).not.toContain(".remove(");
      expect(source).not.toContain(".move(");
      expect(source).not.toContain(".copy(");
    }
  });

  it("the editor's Remove clears the reference only", () => {
    const shell = code(read("components/editor/EditorShell.tsx"));
    expect(shell).toContain("handleBrandingChange({ logo: undefined })");
    expect(shell).not.toContain("deleteLogo");
  });
});

describe("the bucket is public-read and service-role-write only", () => {
  const migration = read(MIGRATION);

  it("creates project-logos as public", () => {
    expect(migration).toContain("'project-logos'");
    expect(migration).toContain("public = true");
  });

  it("is idempotent and self-correcting, like the build-artifacts bucket", () => {
    expect(migration).toContain("on conflict (id) do update");
  });

  it("enforces the size and type caps storage-side too", () => {
    expect(migration).toContain("524288");
    expect(migration).toContain("array['image/png', 'image/jpeg', 'image/webp']");
  });

  it("does not allow SVG at the bucket level", () => {
    // Comment-stripped: the migration EXPLAINS why svg is excluded, and that
    // explanation must not trip a guard whose subject is executable SQL.
    expect(sql(migration)).not.toContain("svg");
  });

  it("creates NO storage.objects policy of any kind", () => {
    // Deny-by-default is what stops a browser role writing here. A policy —
    // even a read one — would be a grant this feature does not need.
    expect(migration).not.toMatch(/create\s+policy/i);
    expect(migration).not.toMatch(/to\s+(anon|authenticated)/i);
  });

  it("verifies at apply time that no browser write policy exists", () => {
    expect(migration).toContain("cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')");
    expect(migration).toContain("uploads must be service-role only");
  });

  it("does not modify any earlier migration", () => {
    // WAS "this is the newest file", which is a different claim from the one
    // this test is named for and breaks the moment ANY later feature adds a
    // migration — as 24.5B did. What actually matters is that the logo bucket
    // is created in exactly one place and no other migration touches it.
    const dir = join(repoRoot, "supabase/migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));

    expect(files).toContain("20260813120000_project_logo_storage.sql");

    const others = files
      .filter((f) => f !== "20260813120000_project_logo_storage.sql")
      .filter((f) => readFileSync(join(dir, f), "utf-8").includes("project-logos"));

    expect(others).toEqual([]);
  });
});

describe("no arbitrary URL can be rendered", () => {
  it("the header builds its src only through the validated composer", () => {
    const header = code(read(HEADER));
    expect(header).toContain("createLogoPublicUrl(branding.logo.path,");
    // No other source of an image URL, and no owner-supplied URL field.
    expect(header).not.toMatch(/src=\{(?!logoUrl)/);
    expect(header).not.toContain("logoUrl:");
  });

  it("no config type carries a URL field an owner could set", () => {
    const pure = code(read(PURE));
    const brandingLogo = pure.slice(
      pure.indexOf("export type BrandingLogo"),
      pure.indexOf("// ---", pure.indexOf("export type BrandingLogo"))
    );

    expect(brandingLogo).toContain("path: string");
    expect(brandingLogo).not.toContain("url");
    expect(brandingLogo).not.toContain("src");
  });

  it("the engine never names the storage provider", () => {
    // PosRuntime's contract is that it does not know what is behind its host,
    // so the logo origin is injected exactly as submitSale and homeLink are.
    const runtime = code(read("components/runtime/PosRuntime.tsx"));
    expect(runtime).not.toContain("supabase");
    expect(runtime).toContain("logoBaseUrl");
  });

  it("a broken image hides itself and keeps the business name", () => {
    const header = code(read(HEADER));
    expect(header).toContain("onError={() => setLogoFailed(true)}");
    // The name is rendered unconditionally, outside the logo branch.
    expect(header).toContain("{businessName}");
  });
});

describe("receipts remain logo-free (MVP invariant)", () => {
  // window.print() does not wait for an image to decode, and the print-only
  // copy mounts moments before the print click. A logo on a receipt would
  // frequently print blank or shift pagination.
  const RECEIPTS = [
    "components/editor/Receipt.tsx",
    "components/runtime/AuthoritativeReceipt.tsx",
    "components/editor/ReceiptPreview.tsx",
  ];

  for (const file of RECEIPTS) {
    it(`${file} renders no image and knows nothing about logos`, () => {
      const source = code(read(file));
      expect(source).not.toContain("<img");
      expect(source).not.toContain("logo");
      expect(source).not.toContain("createLogoPublicUrl");
      expect(source).not.toContain("PosHeader");
    });
  }

  it("the print area still renders only a receipt component", () => {
    const preview = code(read("components/editor/EditorPreview.tsx"));
    const printArea = preview.slice(preview.indexOf('"receipt-print-area"'));
    expect(printArea).not.toContain("PosHeader");
  });
});

describe("scope stays where it was locked", () => {
  it("SVG appears nowhere in the logo path", () => {
    for (const file of [PURE, SERVER, ACTION, FIELD, HEADER]) {
      expect(code(read(file)).toLowerCase()).not.toContain("svg+xml");
    }
  });

  it("no cropper, resizer, or image-processing dependency was added", () => {
    const pkg = JSON.parse(read("package.json")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });

    for (const banned of ["sharp", "jimp", "image-size", "probe-image-size", "canvas"]) {
      expect(declared).not.toContain(banned);
    }
  });

  it("no new environment variable was introduced", () => {
    // The feature reuses the Supabase URL and service-role key that already
    // exist. A new secret would be a deployment change requiring approval.
    const envExample = read(".env.example");
    const referenced = [
      ...code(read(SERVER)).matchAll(/process\.env\.([A-Z0-9_]+)/g),
      ...code(read(ACTION)).matchAll(/process\.env\.([A-Z0-9_]+)/g),
    ].map((match) => match[1]);

    for (const name of referenced) {
      expect(envExample).toContain(name);
    }
  });

  it("only the Builder's Branding section renders the logo control", () => {
    expect(code(read("components/editor/EditorPropertiesPanel.tsx"))).toContain(
      "<BrandingLogoField"
    );

    // A till must never be able to change the branding it is selling under.
    for (const file of [
      "components/runtime/PosRuntime.tsx",
      "components/device/DeviceApp.tsx",
      "components/runtime/OwnerPosRuntime.tsx",
    ]) {
      const source = code(read(file));
      expect(source).not.toContain("BrandingLogoField");
      expect(source).not.toContain("logoUpload.actions");
    }
  });

  it("no per-template logo code exists", () => {
    for (const layout of ["MenuGridBrowser", "ProductGridBrowser", "ServiceGridBrowser"]) {
      const source = code(read(`components/editor/pos-layouts/${layout}.tsx`));
      expect(source).not.toContain("logo");
    }
  });

  it("both header surfaces use the ONE shared component", () => {
    for (const file of [
      "components/runtime/PosRuntime.tsx",
      "components/editor/EditorPreview.tsx",
    ]) {
      expect(code(read(file))).toContain("<PosHeader");
    }
  });
});

describe("a failed upload cannot disturb the existing logo", () => {
  const shell = code(read("components/editor/EditorShell.tsx"));

  it("branding is written only after a confirmed success", () => {
    const handler = shell.slice(
      shell.indexOf("async function handleLogoUpload"),
      shell.indexOf("function handleLogoRemove")
    );

    // Every failure branch returns before reaching handleBrandingChange.
    expect(handler.indexOf("if (!result.ok)")).toBeLessThan(
      handler.indexOf("handleBrandingChange({ logo: result.logo })")
    );
    expect(handler).toContain("handleBrandingChange({ logo: result.logo })");
  });

  it("applies nothing optimistically", () => {
    const handler = shell.slice(
      shell.indexOf("async function handleLogoUpload"),
      shell.indexOf("function handleLogoRemove")
    );

    const beforeAwait = handler.slice(0, handler.indexOf("await uploadProjectLogoAction"));
    expect(beforeAwait).not.toContain("handleBrandingChange");
  });

  it("upload state is separate from save state", () => {
    // An upload failure must never read as "your project failed to save".
    const handler = shell.slice(
      shell.indexOf("async function handleLogoUpload"),
      shell.indexOf("function handleLogoRemove")
    );
    expect(handler).not.toContain("setSaveStatus");
    expect(handler).not.toContain("setSaveError");
  });

  it("blocks upload for a project with no database row", () => {
    expect(shell).toContain("Save this project before uploading a logo.");
  });
});

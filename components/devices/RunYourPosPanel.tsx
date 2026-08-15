import PlatformDownloadRow from "@/components/platform/PlatformDownloadRow";
import { getPlatformDownloads } from "@/lib/platformDownloads";
import type { PairingReadiness } from "@/lib/devicePairing.owner";

// Feature 22 Phase 3 — the four steps between "I edited my menu" and "this till
// is taking payments", shown where the last two actually happen.
//
// WHY IT LIVES IN DEVICES AND NOT BESIDE THE PUBLISH ARTIFACT: the Publish
// section offers "Download configuration", which is this project's json_config
// snapshot. Putting "Download Android App" next to it would sit a UNIVERSAL
// binary immediately beside a PER-PROJECT artifact and invite exactly the
// conflation the whole vocabulary exists to prevent. Devices is where pairing
// happens, so it is where installing the app belongs.
//
// Steps 1 and 2 reflect the panel's real readiness state rather than static
// prose, so the list tells an owner where they actually are. Nothing here mints
// a pairing code, reads a build job, or takes a project id — the download comes
// from the shared platform model and is identical for every project.

type RunYourPosPanelProps = {
  readiness: PairingReadiness;
};

type StepState = "done" | "current" | "upcoming";

function getStepStates(readiness: PairingReadiness): StepState[] {
  // [save, publish, install, pair]
  if (readiness.state === "unsaved_project") {
    return ["current", "upcoming", "upcoming", "upcoming"];
  }

  if (readiness.state === "no_succeeded_build") {
    return ["done", "current", "upcoming", "upcoming"];
  }

  // Ready: saving and publishing are behind them. Installing and pairing are
  // both open — this panel cannot know whether the app is already on a device.
  return ["done", "done", "current", "current"];
}

const STEP_LABELS = [
  "Save your changes",
  "Publish your configuration",
  "Install POS Canvas",
  "Pair your device",
];

function getStepClassName(state: StepState): string {
  if (state === "done") {
    return "text-neutral-400 line-through";
  }

  return state === "current" ? "text-neutral-900 font-medium" : "text-neutral-500";
}

export default function RunYourPosPanel({ readiness }: RunYourPosPanelProps) {
  const downloads = getPlatformDownloads();
  const stepStates = getStepStates(readiness);

  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-6">
      <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-400">
        Run your POS
      </h3>

      <ol className="mt-3 flex list-decimal flex-col gap-1.5 pl-4 text-sm">
        {STEP_LABELS.map((label, index) => (
          <li key={label} className={getStepClassName(stepStates[index])}>
            {label}
          </li>
        ))}
      </ol>

      <p className="mt-4 text-xs text-neutral-500">
        The POS Canvas app is the same for every business — your published
        configuration loads after pairing.
      </p>

      <div className="mt-3 flex flex-col gap-2">
        {downloads.map((download) => (
          <PlatformDownloadRow
            key={download.platform}
            download={download}
            size="compact"
          />
        ))}
      </div>
    </section>
  );
}

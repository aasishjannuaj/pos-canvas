"use client";

// LF-2 Scope 2 — owner "Held sales" (REPORT §12.4). Shown only for businesses
// with local_first_enabled (the sidebar hides it otherwise, and this component
// renders nothing if the server says the business is not enabled). Every
// decision is made by the server; this page only presents what it returns.
import { useEffect, useMemo, useState } from "react";
import {
  DECISION_TEXT,
  REASON_TEXT,
  compareFacts,
  decisionEffect,
  fetchHoldDetail,
  fetchHoldList,
  heldFacts,
  reasonText,
  stockPreviewText,
  submitHoldDecision,
} from "@/lib/saleHolds";
import type { HoldDecision, HoldDetail, HoldFilters, HoldList, HoldState } from "@/lib/saleHolds";

type Props = { projectId: string };

const when = (iso: string | null) => (iso === null ? "—" : new Date(iso).toLocaleString());

export default function HeldSales({ projectId }: Props) {
  const [filters, setFilters] = useState<HoldFilters>({ state: "held", reason: null, deviceId: null, from: null, to: null });
  const [list, setList] = useState<HoldList | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void fetchHoldList(projectId, filters).then(({ list: l, error }) => {
      if (cancelled) return;
      setList(l);
      setListError(error);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, filters, refresh]);

  const devices = useMemo(() => {
    const m = new Map<string, string>();
    for (const h of list?.holds ?? []) m.set(h.pairedDeviceId, h.deviceName ?? "Unnamed till");
    return [...m.entries()];
  }, [list]);

  if (list !== null && !list.enabled) return null;

  return (
    <div className="flex min-h-0 flex-1 gap-6 overflow-y-auto bg-neutral-50 p-8" data-testid="held-sales">
      <section className="flex min-w-0 flex-1 flex-col gap-4">
        <header className="flex items-baseline justify-between">
          <h1 className="text-xl font-semibold tracking-tight text-neutral-900">Held sales</h1>
          {list && <span className="text-sm text-neutral-500" data-testid="held-count">{list.counts.held} need review</span>}
        </header>

        <div className="flex flex-wrap gap-3 text-sm" role="group" aria-label="Filters">
          <label className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-neutral-400">State</span>
            <select aria-label="State" className="rounded-lg border border-neutral-200 px-3 py-2"
              value={filters.state ?? ""} onChange={(e) => setFilters({ ...filters, state: (e.target.value || null) as HoldState | null })}>
              <option value="held">Held</option>
              <option value="accepted">Accepted</option>
              <option value="declined">Declined</option>
              <option value="">All</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-neutral-400">Reason</span>
            <select aria-label="Reason" className="rounded-lg border border-neutral-200 px-3 py-2"
              value={filters.reason ?? ""} onChange={(e) => setFilters({ ...filters, reason: e.target.value || null })}>
              <option value="">All reasons</option>
              {Object.entries(REASON_TEXT).map(([code, text]) => <option key={code} value={code}>{text}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-neutral-400">Till</span>
            <select aria-label="Till" className="rounded-lg border border-neutral-200 px-3 py-2"
              value={filters.deviceId ?? ""} onChange={(e) => setFilters({ ...filters, deviceId: e.target.value || null })}>
              <option value="">All tills</option>
              {devices.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-neutral-400">From</span>
            <input aria-label="From" type="date" className="rounded-lg border border-neutral-200 px-3 py-2"
              onChange={(e) => setFilters({ ...filters, from: e.target.value ? new Date(e.target.value).toISOString() : null })} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-neutral-400">To</span>
            <input aria-label="To" type="date" className="rounded-lg border border-neutral-200 px-3 py-2"
              onChange={(e) => setFilters({ ...filters, to: e.target.value ? new Date(new Date(e.target.value).getTime() + 86_400_000).toISOString() : null })} />
          </label>
        </div>

        {listError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{listError}</p>}
        {list && list.holds.length === 0 && <p className="text-sm text-neutral-500" data-testid="held-empty">No sales need review</p>}
        {list && list.holds.length > 0 && (
          <table className="w-full border-separate border-spacing-0 text-left text-sm" data-testid="held-table">
            <thead className="text-xs uppercase tracking-wide text-neutral-400">
              <tr>
                <th className="py-2">Received</th><th>Till</th><th>Employee (as recorded)</th><th>Total</th><th>Payment</th><th>Reason</th><th>State</th>
              </tr>
            </thead>
            <tbody>
              {list.holds.map((h) => (
                <tr key={h.holdId} onClick={() => setSelected(h.holdId)}
                  className={`cursor-pointer border-t border-neutral-200 hover:bg-white ${selected === h.holdId ? "bg-white" : ""}`}
                  data-testid="held-row">
                  <td className="py-2 pr-3">{when(h.receivedAt)}</td>
                  <td className="pr-3">{h.deviceName ?? "Unnamed till"}</td>
                  <td className="pr-3">{h.employeeName ?? "Unknown employee"}</td>
                  <td className="pr-3">{h.total === null ? "—" : `$${h.total}`}</td>
                  <td className="pr-3 capitalize">{h.paymentMethod ?? "—"}</td>
                  <td className="pr-3">{reasonText(h.reason)}</td>
                  <td className="capitalize">{h.state}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {selected !== null && (
        <HoldDetailPanel key={selected} holdId={selected} onDecided={() => setRefresh((n) => n + 1)} />
      )}
    </div>
  );
}

function HoldDetailPanel({ holdId, onDecided }: { holdId: string; onDecided: () => void }) {
  const [detail, setDetail] = useState<HoldDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [decision, setDecision] = useState<HoldDecision | null>(null);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [reload, setReload] = useState(0);
  // One decision_id per decision attempt on this panel: a double-click or a
  // retry after a lost reply re-sends the SAME id, and the server answers once.
  const [decisionId, setDecisionId] = useState(() => crypto.randomUUID());

  useEffect(() => {
    let cancelled = false;
    void fetchHoldDetail(holdId).then(({ detail: d, error: e }) => {
      if (cancelled) return;
      setDetail(d);
      setError(e);
    });
    return () => {
      cancelled = true;
    };
  }, [holdId, reload]);

  if (error) return <aside className="w-[28rem] flex-none text-sm text-red-700" role="alert">{error}</aside>;
  if (detail === null) return <aside className="w-[28rem] flex-none text-sm text-neutral-500">Loading…</aside>;

  const held = heldFacts(detail.payload);
  const differs = detail.conflict === null ? [] : compareFacts(held, detail.conflict.facts);
  const lines = Array.isArray(detail.payload.lines) ? (detail.payload.lines as Record<string, unknown>[]) : [];

  async function send() {
    if (decision === null || reason.trim() === "" || sending) return;
    setSending(true);
    setActionError(null);
    const r = await submitHoldDecision({ holdId, decision, reason: reason.trim(), decisionId });
    setSending(false);
    if (!r.ok) {
      // Keep the form and the SAME decision_id: if the server committed and only the
      // reply was lost, pressing again returns that decision instead of a second one.
      setActionError(r.error);
      return;
    }
    setConfirming(false);
    setDecisionId(crypto.randomUUID());
    setReload((n) => n + 1);
    onDecided();
  }

  return (
    <aside className="flex w-[28rem] flex-none flex-col gap-4 rounded-2xl border border-neutral-200 bg-white p-6 text-sm" data-testid="held-detail">
      <h2 className="text-base font-semibold text-neutral-900">{reasonText(detail.reason)}</h2>

      <section data-testid="held-facts" className="flex flex-col gap-1">
        <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-400">Recorded on the till</h3>
        <ul className="flex flex-col gap-1">
          {lines.map((l, i) => (
            <li key={i}>{String(l.itemId)} × {String(l.quantity)} @ ${String(l.unitPrice)} = ${String(l.lineTotal)}</li>
          ))}
        </ul>
        <p>Total ${String(detail.payload.total)} ({String(detail.payload.paymentMethod)})</p>
        <p>Sale time (as recorded on the till): {when(held.occurredAt)}</p>
        <p>Received by the server: {when(detail.receivedAt)}</p>
        <p>Employee (as recorded): {detail.employeeName ?? detail.employeeId ?? "—"}</p>
        <p>Register (as recorded): {String(detail.payload.registerClaimId ?? "—")}</p>
        <p>Menu version: {detail.buildJobId ?? "—"}</p>
        <p>Till: {detail.device?.name ?? "Unnamed till"} · App {detail.clientVersion ?? "—"}</p>
        {detail.device?.revokedAt && <p data-testid="held-revoked">Till revoked {when(detail.device.revokedAt)}; this sale received {when(detail.receivedAt)}.</p>}
        {detail.device?.unpairedAt && <p>Till unpaired {when(detail.device.unpairedAt)}; this sale received {when(detail.receivedAt)}.</p>}
      </section>

      {detail.conflict && (
        <section data-testid="held-conflict">
          <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-400">
            Compared with the existing {detail.conflict.kind === "order" ? "sale" : "held sale"}
          </h3>
          <table className="w-full text-xs">
            <thead><tr><th /><th className="text-left">This held sale</th><th className="text-left">Existing</th></tr></thead>
            <tbody>
              {(["occurredAt", "employeeId", "paymentMethod", "total", "lines"] as const).map((k) => (
                <tr key={k} data-differs={differs.includes(k) ? "true" : "false"} className={differs.includes(k) ? "bg-amber-50 font-medium" : ""}>
                  <td className="pr-2 text-neutral-500">{k}</td>
                  <td className="pr-2">{Array.isArray(held[k]) ? (held[k] as string[]).join("; ") : String(held[k] ?? "—")}</td>
                  <td>{Array.isArray(detail.conflict!.facts[k]) ? (detail.conflict!.facts[k] as string[]).join("; ") : String(detail.conflict!.facts[k] ?? "—")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {detail.stockPreview.length > 0 && detail.state === "held" && (
        <ul data-testid="held-stock" className="text-xs text-neutral-600">
          {detail.stockPreview.map((p) => <li key={p.itemId}>{stockPreviewText(p)}</li>)}
        </ul>
      )}

      {detail.state === "held" ? (
        <form className="flex flex-col gap-2" data-testid="held-decision" onSubmit={(e) => { e.preventDefault(); if (decision && reason.trim()) setConfirming(true); }}>
          <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-400">Decision</h3>
          {detail.validDecisions.map((d) => (
            <label key={d} className="flex items-center gap-2">
              <input type="radio" name="decision" value={d} checked={decision === d} onChange={() => { setDecision(d); setConfirming(false); }} />
              {DECISION_TEXT[d]}
            </label>
          ))}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-neutral-500">Reason (required)</span>
            <textarea aria-label="Decision reason" required maxLength={1000} value={reason}
              onChange={(e) => setReason(e.target.value)} className="rounded-lg border border-neutral-200 px-3 py-2" />
          </label>
          {!confirming ? (
            <button type="submit" disabled={decision === null || reason.trim() === ""}
              className="rounded-full bg-blue-600 px-4 py-2 font-medium text-white disabled:opacity-50">Review decision</button>
          ) : (
            <div className="flex flex-col gap-2 rounded-lg bg-neutral-50 p-3" data-testid="held-confirm">
              <p>{decisionEffect(decision as HoldDecision, detail.total)}</p>
              {decision !== "decline" && detail.stockPreview.length > 0 && (
                // Correction C2 — the final stock and shortfall per item, computed by the
                // same inventory step booking runs, so the confirmation is what will happen.
                <ul data-testid="held-confirm-stock" className="text-xs text-neutral-700">
                  {detail.stockPreview.map((p) => <li key={p.itemId}>{stockPreviewText(p)}</li>)}
                </ul>
              )}
              {actionError && (
                <p className="text-red-700" role="alert" data-testid="held-action-error">
                  The decision could not be confirmed ({actionError}). Press Confirm again; it will not be recorded twice.
                </p>
              )}
              <button type="button" onClick={() => void send()} disabled={sending}
                className="rounded-full bg-blue-600 px-4 py-2 font-medium text-white disabled:opacity-50">Confirm decision</button>
            </div>
          )}
        </form>
      ) : (
        <p data-testid="held-outcome">This sale was {detail.state}{detail.orderId ? " and recorded as an order." : "."}</p>
      )}

      <section data-testid="held-audit">
        <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-400">Audit history</h3>
        {detail.decisions.length === 0 ? <p className="text-neutral-500">No decisions yet.</p> : (
          <ol className="flex flex-col gap-1">
            {detail.decisions.map((d) => (
              <li key={d.decisionId}>{when(d.decidedAt)} — {DECISION_TEXT[d.decision]}: “{d.reason}” ({d.priorState} → {d.resultingState})</li>
            ))}
          </ol>
        )}
      </section>
    </aside>
  );
}

// IND-1 — probeDeviceReachability, through the REAL supabase-js client.
//
// Only fetch is fake. So these prove what goes over the wire: exactly one POST to
// /rest/v1/rpc/get_device_pairing_state per check (no retries, even on 503), the
// abort signal reaching fetch and cancelling it, and how every kind of answer is
// reported to the classifier.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";

type FetchCall = { url: string; method: string; body: unknown; signal: AbortSignal | null };

const calls: FetchCall[] = [];
let respond: (call: FetchCall) => Promise<Response> = async () => json(200, {});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const call: FetchCall = {
    url: String(input),
    method: init?.method ?? "GET",
    body: init?.body ?? null,
    signal: init?.signal ?? null,
  };

  calls.push(call);

  return respond(call);
});

const client = createClient("http://127.0.0.1:9", "ind1-synthetic-not-a-key", {
  global: { fetch: fakeFetch as unknown as typeof fetch },
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

vi.mock("@/lib/supabase/deviceClient", () => ({
  getDeviceSupabaseClient: () => client,
  DEVICE_AUTH_STORAGE_KEY: "pos-canvas-device-auth",
}));

const { probeDeviceReachability } = await import("@/lib/device.rpc");

/** Calls that went to the REST API (auth-js may read nothing here: no session). */
const restCalls = () => calls.filter((c) => c.url.includes("/rest/v1/"));

beforeEach(() => {
  calls.length = 0;
  fakeFetch.mockClear();
  respond = async () => json(200, {});
});

describe("probeDeviceReachability", () => {
  it("sends exactly one POST to the read-only pairing-state RPC, with the signal attached", async () => {
    respond = async () => json(200, { paired: true, device_id: "x" });
    const controller = new AbortController();

    const result = await probeDeviceReachability(controller.signal);

    expect(restCalls()).toHaveLength(1);
    expect(restCalls()[0].method).toBe("POST");
    expect(new URL(restCalls()[0].url).pathname).toBe("/rest/v1/rpc/get_device_pairing_state");
    expect(restCalls()[0].signal).toBeInstanceOf(AbortSignal);
    expect(result).toEqual({
      type: "response",
      status: 200,
      data: { paired: true, device_id: "x" },
      errorCode: null,
    });
  });

  it("is never retried, even on 503 / 520 (one check = one request)", async () => {
    for (const status of [503, 520, 500]) {
      calls.length = 0;
      respond = async () => json(status, { code: "", message: "down" });

      const result = await probeDeviceReachability(new AbortController().signal);

      expect(restCalls()).toHaveLength(1);
      expect(result).toMatchObject({ type: "response", status });
    }
  });

  it("reports PostgREST error codes for the classifier; a code-less error becomes 'unknown'", async () => {
    respond = async () => json(401, { code: "PGRST301", message: "JWT expired" });
    expect(await probeDeviceReachability(new AbortController().signal)).toEqual({
      type: "response",
      status: 401,
      data: null,
      errorCode: "PGRST301",
    });

    respond = async () => json(500, { message: "no code" });
    expect(await probeDeviceReachability(new AbortController().signal)).toMatchObject({
      status: 500,
      errorCode: "unknown",
    });
  });

  it("a fetch that never gets a response is a transport failure", async () => {
    respond = async () => {
      throw new TypeError("Failed to fetch");
    };

    expect(await probeDeviceReachability(new AbortController().signal)).toEqual({ type: "transport" });
    expect(restCalls()).toHaveLength(1);
  });

  it("an already-aborted signal sends nothing", async () => {
    const controller = new AbortController();

    controller.abort();

    expect(await probeDeviceReachability(controller.signal)).toEqual({ type: "aborted" });
    expect(calls).toHaveLength(0);
  });

  it("aborting mid-request cancels the real fetch and reports 'aborted'", async () => {
    let fetchSawAbort = false;

    respond = (call) =>
      new Promise<Response>((_resolve, reject) => {
        call.signal!.addEventListener("abort", () => {
          fetchSawAbort = true;
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });

    const controller = new AbortController();
    const pending = probeDeviceReachability(controller.signal);

    await vi.waitFor(() => expect(restCalls()).toHaveLength(1));
    controller.abort();

    expect(await pending).toEqual({ type: "aborted" });
    expect(fetchSawAbort).toBe(true);
    expect(restCalls()[0].signal!.aborted).toBe(true);
  });
});

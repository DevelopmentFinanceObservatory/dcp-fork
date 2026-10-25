import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HttpTransport } from "./HttpTransport";
import { normalizeResponse, type BaseIdentity } from "@/lib/contract/types";

/** Minimal identity for resubmitDataset()/resubmitDatasetStream() request-body assertions. */
function identity(over: Partial<BaseIdentity> = {}): BaseIdentity {
  return {
    identity_version: "spec1",
    shape: { kind: "statvar_schema", population_type: "Person" },
    slots: [],
    entities: { observationAbout: ["country/KEN"] },
    requested_window: { kind: "all" },
    ...over,
  };
}

/** A minimal buffered definite envelope the engine would return. */
const definiteBody = {
  schema_version: "1.0",
  status: "definite",
  interpretation: { spec_id: "spec_x" },
  query_echo: {
    entry_path: "raw_text",
    variable_text: [],
    extract_skipped: false,
  },
  diagnostics: { engine_build: "test", warnings: [] },
};

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The parsed request body of the first fetch call. */
function sentBody(fetchMock: ReturnType<typeof vi.fn>) {
  return JSON.parse(fetchMock.mock.calls[0][1].body as string);
}

describe("HttpTransport", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("resolve() POSTs a raw_text request to /api/search/resolve and returns the body", async () => {
    const fetchMock = mockFetchOnce(definiteBody);
    vi.stubGlobal("fetch", fetchMock);

    const res = await new HttpTransport().resolve("women in Kenya");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/search/resolve");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    // buffered path: NO event-stream Accept header
    expect(init.headers.Accept).toBeUndefined();

    const body = sentBody(fetchMock);
    expect(body.schema_version).toBe(1);
    expect(body.input).toEqual({ kind: "raw_text", query: "women in Kenya" });
    // Pinned literally: DataPreview renders off Spec.observations, so
    // include_observations must default on alongside the other two response
    // options -- the engine omits the trailing 'observations' event/inline
    // field entirely when it's absent (verified against the live dfo-dev
    // engine; lib/contract/types.ts's "absent also means true" doc comment
    // is stale).
    expect(body.response_options).toEqual({
      include_sentence: true,
      include_option_coverage: true,
      include_observations: true,
    });

    expect(res).toEqual(normalizeResponse(definiteBody));
  });

  it("resolveSpecId() POSTs a spec_id request to /api/search/resolve and returns the body", async () => {
    const fetchMock = mockFetchOnce(definiteBody);
    vi.stubGlobal("fetch", fetchMock);

    const res = await new HttpTransport().resolveSpecId("spec_123");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/search/resolve");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers.Accept).toBeUndefined();

    const body = sentBody(fetchMock);
    expect(body.schema_version).toBe(1);
    expect(body.input).toEqual({ kind: "spec_id", spec_id: "spec_123" });
    expect(body.response_options).toEqual({
      include_sentence: true,
      include_option_coverage: true,
      include_observations: true,
    });

    expect(res).toEqual(normalizeResponse(definiteBody));
  });

  it("can disable option coverage", async () => {
    const fetchMock = mockFetchOnce(definiteBody);
    await new HttpTransport({ includeOptionCoverage: false }).resolve("q");
    expect(sentBody(fetchMock).response_options.include_option_coverage).toBe(
      false,
    );
  });

  it("passes custom ResolveOptions like max_candidates and coverage to request options", async () => {
    const fetchMock = mockFetchOnce(definiteBody);
    await new HttpTransport({
      coverage: "prefer_exact",
      max_candidates: 5,
      include_observations: false,
    }).resolve("q");
    const sent = sentBody(fetchMock);
    expect(sent.response_options.coverage).toBe("prefer_exact");
    expect(sent.response_options.max_candidates).toBe(5);
    expect(sent.response_options.include_observations).toBe(false);
    expect(sent.response_options.include_sentence).toBe(true);
    expect(sent.response_options.include_option_coverage).toBe(true);
  });

  it("throws the engine detail on a non-2xx response", async () => {
    mockFetchOnce(
      { detail: "promote requires stat_var_dcids", code: "promote_only" },
      false,
      400,
    );
    await expect(new HttpTransport().resolve("q")).rejects.toThrow(
      "promote requires stat_var_dcids",
    );
  });

  it("resolveStream() parses SSE frames into events", async () => {
    const frames =
      'event: step\ndata: {"kind":"step","step":"extract","ran":true}\n\n' +
      'event: response\ndata: {"kind":"response","response":{"status":"definite"}}\n\n';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frames));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => "text/event-stream" },
        body: stream,
      }),
    );

    const events: unknown[] = [];
    await new HttpTransport().resolveStream("women in Kenya", (ev) =>
      events.push(ev),
    );

    expect(events).toContainEqual({ kind: "step", step: "extract", ran: true });
    expect(events).toContainEqual({
      kind: "response",
      response: normalizeResponse({ status: "definite" }),
    });
  });

  it("resolveSpecIdStream() parses SSE frames into events for spec_id input", async () => {
    const frames =
      'event: step\ndata: {"kind":"step","step":"materialise","ran":true}\n\n' +
      'event: response\ndata: {"kind":"response","response":{"status":"definite"}}\n\n';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frames));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "text/event-stream" },
      body: stream,
    });
    vi.stubGlobal("fetch", fetchMock);

    const events: unknown[] = [];
    await new HttpTransport().resolveSpecIdStream("spec_123", (ev) =>
      events.push(ev),
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/search/resolve");
    expect(init.headers.Accept).toBe("text/event-stream");
    const body = sentBody(fetchMock);
    expect(body.input).toEqual({ kind: "spec_id", spec_id: "spec_123" });

    expect(events).toContainEqual({
      kind: "step",
      step: "materialise",
      ran: true,
    });
    expect(events).toContainEqual({
      kind: "response",
      response: normalizeResponse({ status: "definite" }),
    });
  });

  it("resubmitDataset() POSTs a dataset_resubmit request with the entries list", async () => {
    const fetchMock = mockFetchOnce(definiteBody);
    const entries = [
      {
        entry_kind: "identity" as const,
        variable_text: "population",
        identity: identity(),
      },
    ];
    await new HttpTransport().resubmitDataset(entries, "population of Kenya");

    const body = sentBody(fetchMock);
    expect(body.input.kind).toBe("dataset_resubmit");
    expect(body.input.entries).toEqual(entries);
    expect(body.input.raw_query).toBe("population of Kenya");
    expect(body.response_options).toEqual({
      include_sentence: true,
      include_option_coverage: true,
      include_observations: true,
    });
  });

  it("resubmitDataset() omits raw_query when absent", async () => {
    const fetchMock = mockFetchOnce(definiteBody);
    await new HttpTransport().resubmitDataset([], undefined);
    const input = sentBody(fetchMock).input;
    expect("raw_query" in input).toBe(false);
  });

  it("resubmitDataset() throws the engine detail and carries the pointer on a non-2xx response", async () => {
    mockFetchOnce(
      {
        detail: "entries must have between 1 and 6 items",
        code: "request_invalid",
        pointer: "/input/entries",
      },
      false,
      400,
    );
    await expect(
      new HttpTransport().resubmitDataset([], undefined),
    ).rejects.toMatchObject({
      message: "entries must have between 1 and 6 items",
      code: "request_invalid",
      pointer: "/input/entries",
    });
  });

  it("resubmitDatasetStream() POSTs a dataset_resubmit request and parses SSE frames into events", async () => {
    const frames =
      'event: response\ndata: {"kind":"response","response":{"status":"definite"}}\n\n' +
      'event: observations\ndata: {"kind":"observations","spec_id":"s1","observations":{}}\n\n';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frames));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "text/event-stream" },
      body: stream,
    });
    vi.stubGlobal("fetch", fetchMock);

    const entries = [
      {
        entry_kind: "identity" as const,
        variable_text: "population",
        identity: identity(),
      },
    ];
    const events: unknown[] = [];
    await new HttpTransport().resubmitDatasetStream(
      entries,
      "population of Kenya",
      (ev) => events.push(ev),
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/search/resolve");
    expect(init.headers.Accept).toBe("text/event-stream");
    const body = sentBody(fetchMock);
    expect(body.input.kind).toBe("dataset_resubmit");
    expect(body.input.entries).toEqual(entries);

    expect(events).toContainEqual({
      kind: "response",
      response: normalizeResponse({ status: "definite" }),
    });
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "observations", spec_id: "s1" }),
    );
  });

  it("placeOptions() POSTs to /api/search/options and returns the body", async () => {
    const fetchMock = mockFetchOnce({
      options: [{ dcid: "country/KEN", label: "Kenya" }],
      complete: true,
    });
    const res = await new HttpTransport().placeOptions({
      stat_var_dcids: ["sv/1"],
      anchor_dcid: "country/ETH",
      scope: "peers",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/search/options");
    expect(sentBody(fetchMock)).toEqual({
      schema_version: 1,
      resolved_stat_var_dcids: ["sv/1"],
      for: { role: "observationAbout", scope: "peers" },
      identity: {
        identity_version: "spec1",
        shape: {
          kind: "statvar_schema",
          population_type: "Person",
          measured_property: "count",
          stat_type: "measuredValue",
        },
        slots: [],
        entities: { observationAbout: ["country/ETH"] },
        requested_window: { kind: "all" },
      },
    });
    expect(init.headers.Accept).toBeUndefined();
    expect(res).toEqual({
      options: [{ dcid: "country/KEN", label: "Kenya" }],
      complete: true,
    });
  });

  it("placeOptions() throws the typed code on an unsupported-scope 400", async () => {
    mockFetchOnce(
      {
        detail: "peers scope not supported",
        code: "unsupported_peers_anchor_type",
      },
      false,
      400,
    );
    await expect(
      new HttpTransport().placeOptions({
        stat_var_dcids: ["sv/1"],
        anchor_dcid: "geoId/06",
        scope: "peers",
      }),
    ).rejects.toMatchObject({
      message: "peers scope not supported",
      code: "unsupported_peers_anchor_type",
    });
  });
});

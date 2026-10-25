import { describe, expect, it, vi } from "vitest";
import {
  buildRequest,
  currentDonorDcid,
  DEFAULT_STALL_TIMEOUT_MS,
  keyRef,
  makeSseParser,
  placeOptions,
  resolveSpecId,
  resolveStream,
  whereSlotHasEntity,
  type SearchEvent,
} from "./searchClient";

function collect() {
  const frames: Array<{ event: string; data: string }> = [];
  const feed = makeSseParser((event, data) => frames.push({ event, data }));
  return { frames, feed };
}

describe("makeSseParser", () => {
  it("parses engine-shaped frames (event: line + single data: line)", () => {
    const { frames, feed } = collect();
    feed('event: step\ndata: {"kind":"step","ran":true}\n\n');
    expect(frames).toEqual([
      { event: "step", data: '{"kind":"step","ran":true}' },
    ]);
  });

  it("handles frames split at arbitrary chunk boundaries", () => {
    const whole =
      'event: sentence\ndata: {"kind":"sentence"}\n\nevent: done\ndata: {"kind":"done"}\n\n';
    for (let cut = 1; cut < whole.length; cut++) {
      const { frames, feed } = collect();
      feed(whole.slice(0, cut));
      feed(whole.slice(cut));
      expect(frames.map((f) => f.event)).toEqual(["sentence", "done"]);
    }
  });

  it("skips heartbeat comment frames and emits nothing for them", () => {
    const { frames, feed } = collect();
    feed(": ping\n\nevent: done\ndata: {}\n\n");
    expect(frames).toEqual([{ event: "done", data: "{}" }]);
  });

  it("joins multiple data lines with newline and tolerates CRLF", () => {
    const { frames, feed } = collect();
    feed("event: x\r\ndata: a\r\ndata: b\r\n\r\n");
    expect(frames).toEqual([{ event: "x", data: "a\nb" }]);
  });
});

describe("keyRef", () => {
  it("mirrors SlotKey.as_ref(): axis:property_dcid, empty dcid for null property", () => {
    expect(
      keyRef({
        axis: "how",
        property: { dcid: "p/x", label: "purpose" },
        label: "purpose",
      }),
    ).toBe("how:p/x");
    expect(keyRef({ axis: "when", property: null, label: "when" })).toBe(
      "when:",
    );
  });
});

describe("whereSlotHasEntity", () => {
  const whereKey = {
    axis: "where",
    property: { dcid: "p/recipient", label: "recipient" },
    label: "recipient",
  };

  it("is true for a where slot bound to a single ref (value binding)", () => {
    const slots = [
      {
        key: whereKey,
        binding: {
          kind: "value",
          value: {
            ref: { dcid: "country/KEN", label: "Kenya" },
            value_kind: "ref",
          },
        },
      },
    ];
    expect(whereSlotHasEntity(slots)).toBe(true);
  });

  it("is true for a where slot bound to a set with any ref-bearing member", () => {
    const slots = [
      {
        key: whereKey,
        binding: {
          kind: "set",
          values: [
            { literal: "x", value_kind: "literal" },
            { ref: { dcid: "country/KEN", label: "Kenya" }, value_kind: "ref" },
          ],
        },
      },
    ];
    expect(whereSlotHasEntity(slots)).toBe(true);
  });

  it("is false when the where slot is unbound", () => {
    const slots = [{ key: whereKey, binding: { kind: "unbound" } }];
    expect(whereSlotHasEntity(slots)).toBe(false);
  });

  it("is false when there is no where slot at all", () => {
    const slots = [
      {
        key: { axis: "how", property: null, label: "how" },
        binding: { kind: "unbound" },
      },
    ];
    expect(whereSlotHasEntity(slots)).toBe(false);
  });
});

describe("currentDonorDcid", () => {
  it('finds the ref.dcid of a directional "from" entity', () => {
    const entities = [
      {
        ref: { dcid: "org/DAC", label: "DAC donors" },
        role: {
          kind: "directional",
          role: { dcid: "p", label: "p" },
          direction: "from",
        },
      },
      {
        ref: { dcid: "country/KEN", label: "Kenya" },
        role: {
          kind: "directional",
          role: { dcid: "p", label: "p" },
          direction: "to",
        },
      },
    ];
    expect(currentDonorDcid(entities)).toBe("org/DAC");
  });

  it('is null when every entity is subject-only (no directional "from")', () => {
    const entities = [
      {
        ref: { dcid: "country/KEN", label: "Kenya" },
        role: { kind: "subject" },
      },
    ];
    expect(currentDonorDcid(entities)).toBeNull();
  });
});

describe("placeOptions", () => {
  it("POSTs to /api/search/options and returns the body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        options: [{ dcid: "country/ETH", label: "Ethiopia" }],
        complete: true,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const res = await placeOptions({
        stat_var_dcids: ["sv/1"],
        anchor_dcid: "country/KEN",
        scope: "peers",
      });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/search/options");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({
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
          entities: { observationAbout: ["country/KEN"] },
          requested_window: { kind: "all" },
        },
      });
      expect(res).toEqual({
        options: [{ dcid: "country/ETH", label: "Ethiopia" }],
        complete: true,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("throws the engine detail on a non-2xx response, carrying the typed code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          detail: "peers scope not supported",
          code: "unsupported_peers_anchor_type",
        }),
      }),
    );
    try {
      await expect(
        placeOptions({
          stat_var_dcids: ["sv/1"],
          anchor_dcid: "country/KEN",
          scope: "peers",
        }),
      ).rejects.toMatchObject({
        message: "peers scope not supported",
        code: "unsupported_peers_anchor_type",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/** A fetch Response double for resolveStream: just enough shape for the
 *  function under test (ok/headers/body.getReader) -- it never reads
 *  res.json() on the streaming success path. */
function streamResponse(reader: {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
  cancel: () => Promise<void>;
}) {
  return {
    ok: true,
    headers: {
      get: (h: string) =>
        h.toLowerCase() === "content-type" ? "text/event-stream" : null,
    },
    json: async () => null,
    body: { getReader: () => reader },
  };
}

describe("resolveStream stall timeout", () => {
  it("defaults the stall timeout to 45s when not overridden", () => {
    expect(DEFAULT_STALL_TIMEOUT_MS).toBe(45000);
  });

  it("emits a synthetic STALL_TIMEOUT error and cancels the reader when no data arrives within the timeout", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn().mockResolvedValue(undefined);
      const reader = {
        read: () =>
          new Promise<{ done: boolean; value?: Uint8Array }>(() => {}), // silent connection
        cancel,
      };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponse(reader)));

      const events: SearchEvent[] = [];
      const pending = resolveStream(
        {},
        (ev) => events.push(ev),
        undefined,
        1000,
      );
      await vi.advanceTimersByTimeAsync(1000);
      await pending;

      expect(cancel).toHaveBeenCalledTimes(1);
      expect(events).toEqual([
        {
          kind: "error",
          detail: "Search stream stalled — no data received for 1000ms.",
          code: "STALL_TIMEOUT",
        },
      ]);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("does not treat a user abort (AbortError) as a stall", async () => {
    vi.useFakeTimers();
    try {
      const abortError = new DOMException("Aborted", "AbortError");
      const reader = {
        read: () => Promise.reject(abortError),
        cancel: vi.fn().mockResolvedValue(undefined),
      };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponse(reader)));

      const events: SearchEvent[] = [];
      await expect(
        resolveStream({}, (ev) => events.push(ev), undefined, 1000),
      ).rejects.toBe(abortError);

      expect(events).toEqual([]); // no synthetic STALL_TIMEOUT event
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("cleans up the stall timer on normal stream completion (no leaked timer)", async () => {
    vi.useFakeTimers();
    try {
      const chunk = new TextEncoder().encode(
        'event: done\ndata: {"kind":"done"}\n\n',
      );
      let call = 0;
      const reader = {
        read: () => {
          call += 1;
          if (call === 1) return Promise.resolve({ done: false, value: chunk });
          return Promise.resolve({ done: true, value: undefined });
        },
        cancel: vi.fn().mockResolvedValue(undefined),
      };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponse(reader)));

      const events: SearchEvent[] = [];
      await resolveStream({}, (ev) => events.push(ev), undefined, 1000);

      expect(events).toEqual([{ kind: "done" }]);
      expect(reader.cancel).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("does not stall as long as chunks keep arriving within the timeout, across many reads", async () => {
    vi.useFakeTimers();
    try {
      const encoder = new TextEncoder();
      let call = 0;
      const reader = {
        // Heartbeats (": ping") produce no frames but each read() still resets
        // the per-iteration timer -- five of them well past a naive single
        // 1000ms budget must not trip the stall guard.
        read: () => {
          call += 1;
          if (call <= 5)
            return Promise.resolve({
              done: false,
              value: encoder.encode(": ping\n\n"),
            });
          return Promise.resolve({ done: true, value: undefined });
        },
        cancel: vi.fn().mockResolvedValue(undefined),
      };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponse(reader)));

      const events: SearchEvent[] = [];
      await resolveStream({}, (ev) => events.push(ev), undefined, 1000);

      expect(events).toEqual([]);
      expect(reader.cancel).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("extracts RFC 9457 type URI code and detail when stream returns non-2xx status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        headers: { get: () => "application/problem+json" },
        json: () =>
          Promise.resolve({
            type: "/codes/invalid_input",
            title: "Bad Request",
            detail: "The input format was invalid",
          }),
      }),
    );
    try {
      const events: SearchEvent[] = [];
      await resolveStream({}, (ev) => events.push(ev));

      expect(events).toEqual([
        {
          kind: "error",
          detail: "The input format was invalid",
          code: "invalid_input",
          pointer: null,
        },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("extracts a top-level RFC 9457 pointer alongside detail/code when present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        headers: { get: () => "application/problem+json" },
        json: () =>
          Promise.resolve({
            type: "/codes/request_invalid",
            title: "Bad Request",
            detail: "entries must have between 1 and 6 items",
            pointer: "/input/entries",
          }),
      }),
    );
    try {
      const events: SearchEvent[] = [];
      await resolveStream({}, (ev) => events.push(ev));

      expect(events).toEqual([
        {
          kind: "error",
          detail: "entries must have between 1 and 6 items",
          code: "request_invalid",
          pointer: "/input/entries",
        },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("normalizes a parts[]-envelope response with a nested resolved sub-object in resolveStream", async () => {
    const wirePayload = {
      schema_version: 1,
      status: "definite",
      query_echo: { raw_query: "total population of Kenya" },
      diagnostics: { warnings: [] },
      parts: [
        {
          status: "definite",
          variable_text: "total population",
          warnings: [],
          spec: {
            spec_id: "spec_123",
            definition: {
              schema_version: 1,
              identity: { shape_id: "standard", slots: [] },
            },
            resolved: {
              shape: {
                shape_id: "standard",
                label: "Standard",
                refine_supported: true,
              },
              slots: [],
              stat_vars: [{ dcid: "Count_Person", label: "Total population" }],
              entities: [
                {
                  ref: { dcid: "country/KEN", label: "Kenya" },
                  role: { kind: "subject" },
                },
              ],
              coverage: {
                kind: "exact",
                hasData: true,
                summary: "65 observations",
                observationCount: 65,
                dimensions: [],
              },
              rendered_sentence: "Total population in Kenya.",
              sentence_plan: [
                { kind: "slot", text: "Total population", axis: "what" },
              ],
            },
          },
        },
      ],
    };

    const encoder = new TextEncoder();
    const reader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({
          done: false,
          value: encoder.encode(
            `event: response\ndata: ${JSON.stringify({ kind: "response", response: wirePayload })}\n\n`,
          ),
        })
        .mockResolvedValueOnce({ done: true, value: undefined }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => "text/event-stream" },
        body: { getReader: () => reader },
      }),
    );

    try {
      const events: SearchEvent[] = [];
      await resolveStream({}, (ev) => events.push(ev));

      expect(events.length).toBe(1);
      const resEvent = events[0] as { kind: "response"; response: any };
      expect(resEvent.kind).toBe("response");
      expect(resEvent.response.status).toBe("definite");
      expect(resEvent.response.parts.length).toBe(1);
      const spec = resEvent.response.parts[0].spec;
      expect(spec).toBeDefined();
      expect(spec.spec_id).toBe("spec_123");
      expect(spec.shape.shape_id).toBe("standard");
      // Normalized from spec.resolved onto the spec itself, like every other
      // resolved field.
      expect(spec.sentence_plan).toEqual([
        { kind: "slot", text: "Total population", axis: "what" },
      ]);
      expect(spec.rendered_sentence).toBe("Total population in Kenya.");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  describe("buildRequest", () => {
    it("builds a typed ResolveRequest with options and response_options", () => {
      const req = buildRequest(
        { kind: "raw_text", query: "health in kenya" },
        { coverage: "prefer_exact", max_candidates: 3 },
      );
      expect(req.schema_version).toBe(1);
      expect(req.input).toEqual({ kind: "raw_text", query: "health in kenya" });
      expect(req.response_options).toEqual({
        include_sentence: true,
        include_option_coverage: true,
        coverage: "prefer_exact",
        max_candidates: 3,
      });
    });

    it("builds a typed ResolveRequest for spec_id input", () => {
      const req = buildRequest({ kind: "spec_id", spec_id: "spec_123" });
      expect(req.schema_version).toBe(1);
      expect(req.input).toEqual({ kind: "spec_id", spec_id: "spec_123" });
      expect(req.response_options).toEqual({
        include_sentence: true,
        include_option_coverage: true,
      });
    });

    it("passes a dataset_resubmit input through unchanged, with entries and an optional raw_query", () => {
      const entries = [
        {
          entry_kind: "identity" as const,
          variable_text: "population",
          identity: {
            identity_version: "spec1" as const,
            shape: {
              kind: "statvar_schema" as const,
              population_type: "Person",
            },
            slots: [],
            entities: { observationAbout: ["country/KEN"] },
            requested_window: { kind: "all" as const },
          },
        },
      ];
      const req = buildRequest({
        kind: "dataset_resubmit",
        entries,
        raw_query: "population and GDP in Brazil",
      });
      expect(req.input).toEqual({
        kind: "dataset_resubmit",
        entries,
        raw_query: "population and GDP in Brazil",
      });
    });
  });

  describe("resolveSpecId", () => {
    it("POSTs a spec_id request to /api/search/resolve and returns normalized response", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          schema_version: 1,
          status: "definite",
          query_echo: { raw_query: "" },
          diagnostics: { warnings: [] },
          parts: [
            { status: "definite", warnings: [], spec: { spec_id: "spec_123" } },
          ],
        }),
      });
      vi.stubGlobal("fetch", fetchMock);
      try {
        const res = await resolveSpecId("spec_123");
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe("/api/search/resolve");
        expect(init.method).toBe("POST");
        expect(JSON.parse(init.body)).toEqual({
          schema_version: 1,
          input: { kind: "spec_id", spec_id: "spec_123" },
          response_options: {
            include_sentence: true,
            include_option_coverage: true,
          },
        });
        expect(res.status).toBe("definite");
        expect(res.parts.length).toBe(1);
        const part = res.parts[0];
        if (part.status !== "definite") throw new Error("expected definite");
        expect(part.spec.spec_id).toBe("spec_123");
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});

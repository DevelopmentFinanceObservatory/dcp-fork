import { describe, it, expect } from "vitest";
import { createSpecStore as createSpecStoreImpl } from "./specStore";
import type { SearchTransport } from "../transport";
import { normalizeResponse } from "@/lib/contract/types";
import type {
  BaseIdentity,
  DatasetResubmitEntry,
  ResolveResponse,
  Slot,
  Spec,
} from "@/lib/contract/types";
import type { PromoteFields } from "@/lib/contract/promote";
import type { SearchEvent } from "@/lib/client/searchClient";
import { partAt } from "@/lib/contract/parts";
import {
  candidates,
  definiteBreadth,
  definiteBreadthSpec,
  definiteExact,
  definiteExactSpec,
  noData,
  partsCandidatesNigeria,
  partsDefiniteKenya,
  partsMixedTwoVariable,
  partsMixedBrazil,
  partsTwoDefiniteKenya,
} from "../fixtures";
import { definite, diagnostics, echo } from "../fixtures/_common";

/**
 * An `identityEdit`-shaped edit double: not part of SearchTransport (dfo-apis
 * retired the spec_resubmit request kind and no store action ever posted
 * it), but kept here purely as test-authoring shorthand. withDatasetDoor
 * below translates it into a `resubmitDataset` single-entry post, so a test
 * exercising editSlot/editDonor/chooseSpec can say "this edit resolves to
 * X" once, keyed on the edited identity, instead of hand-building the
 * entries[]-shaped resubmitDataset stub every time.
 */
type TestTransport = SearchTransport & {
  identityEdit?: (
    identity: BaseIdentity,
    promote?: PromoteFields,
    signal?: AbortSignal,
  ) => Promise<ResolveResponse>;
};

/**
 * Every test transport below expresses its edit double as `identityEdit`
 * (one part) -- the shape editSlot/editDonor/chooseSpec post through.
 * Wrapping every transport through this (via the local `createSpecStore`
 * shadow below) derives `resubmitDataset` automatically for the
 * single-part envelope every test in this file posts EXCEPT the "parts[]
 * envelope" and "editShared()" describe blocks, which edit a multi-part
 * envelope and so supply their own `resubmitDataset` (this wrapper only
 * fills the gap when one isn't already given, and only ever unwraps a
 * single identity entry -- a multi-entry `entries[]` reaching it throws
 * loudly, so a test that needed its own resubmitDataset and didn't get one
 * fails clearly rather than posting the wrong thing).
 */
function withDatasetDoor(transport: TestTransport): SearchTransport {
  if (transport.resubmitDataset || !transport.identityEdit) return transport;
  const identityEdit = transport.identityEdit;
  return {
    ...transport,
    resubmitDataset: (entries, _rawQuery, signal) => {
      const entry = entries[0];
      if (entries.length !== 1 || entry.entry_kind !== "identity") {
        throw new Error(
          "withDatasetDoor: this test posts more than one entry (or a non-identity entry) and needs its own resubmitDataset stub",
        );
      }
      const promote: PromoteFields = {
        base_spec_id: entry.base_spec_id,
        base_identity: entry.base_identity,
        removed: entry.removed,
        resolved_stat_var_dcids: entry.resolved_stat_var_dcids,
      };
      return identityEdit(entry.identity, promote, signal);
    },
  };
}

function createSpecStore(transport: TestTransport) {
  return createSpecStoreImpl(withDatasetDoor(transport));
}

/** The Spec inside a definite ResolveResponse's part at `index` (default 0).
 *  Throws on anything else -- every fixture this helper is used with is
 *  definite at that index by construction, so a mismatch here is a bug in
 *  the test, not a real state. */
function definiteSpec(response: ResolveResponse, index = 0): Spec {
  const part = partAt(response, index);
  if (part?.status !== "definite") throw new Error("expected a definite part");
  return part.spec;
}

/** Canned responses keyed by the exact query text the tests below resolve —
 *  real fixture data, no keyword routing or fallback. A lookup miss is a bug
 *  in the test (fix the query or add the fixture), not a silent default. */
const RESOLVE_BY_QUERY: Record<string, ResolveResponse> = {
  "women in Kenya": definiteExact,
  "malaria grants to Ethiopia": definiteBreadth,
  "aid to Africa": candidates,
  "GDP of Atlantis": noData,
};

function resolveByQuery(query: string): Promise<ResolveResponse> {
  const response = RESOLVE_BY_QUERY[query];
  return response
    ? Promise.resolve(response)
    : Promise.reject(new Error(`unstubbed query: ${query}`));
}

/**
 * A definite ResolveResponse for `slots` applied on top of `base`: same shape,
 * the given slots, and (for a where-slot entity edit) entities/resolved_entities
 * updated to match — enough to exercise editSlot()/editDonor() without any
 * FixtureTransport-style routing or synthesis. Not a general resubmit
 * implementation; just a deterministic "what would this edit produce" stand-in
 * for the tests below, built from real fixture Spec data.
 */
function withEditedSlots(base: Spec, slots: Slot[]): ResolveResponse {
  const whereSlot = slots.find((s) => s.key.axis === "where");
  const entities =
    whereSlot?.binding.kind === "value" &&
    whereSlot.binding.value.value_kind === "entity" &&
    whereSlot.binding.value.ref
      ? [
          {
            ref: whereSlot.binding.value.ref,
            entity_type: base.entities[0]?.entity_type,
            role: base.entities[0]?.role ?? { kind: "subject" as const },
          },
        ]
      : base.entities;
  const spec: Spec = {
    ...base,
    spec_id: `${base.spec_id}::${JSON.stringify(slots.map((s) => s.binding))}`,
    slots,
    entities,
    resolution: {
      ...base.resolution,
      resolved_entities: entities.map((e) => e.ref),
    },
  };
  return definite(
    spec,
    echo({
      raw_query: "spec_resubmit",
      variable_text: [],
      extract_skipped: true,
    }),
  );
}

/** Display labels for the handful of place dcids these tests edit the
 *  where/destination role to -- enough for withEditedIdentity to build a
 *  spec whose rendered sentence names the new place. */
const PLACE_LABELS: Record<string, string> = {
  "country/KEN": "Kenya",
  "country/NGA": "Nigeria",
  "country/ETH": "Ethiopia",
};

/**
 * A definite ResolveResponse reflecting the where-axis entity edit carried in
 * `identity` (identity.entities.destination or .observationAbout), applied on
 * top of `base`: same shape, the new place, and Spec.slots' where-binding +
 * entities/resolved_entities updated to match -- enough to exercise
 * editSlot()/chooseSpec() without any FixtureTransport-style routing or
 * synthesis. Not a general resubmit implementation; just a deterministic
 * "what would this edit produce" stand-in for the tests below, built from
 * real fixture Spec data. Carries `identity` itself forward as the result
 * spec's own definition.identity, so a second edit against the committed
 * result has something to build on.
 */
function withEditedIdentity(
  base: Spec,
  identity: BaseIdentity,
): ResolveResponse {
  const role =
    "destination" in identity.entities ? "destination" : "observationAbout";
  const dcid = identity.entities[role]?.[0];
  const ref = dcid ? { dcid, label: PLACE_LABELS[dcid] ?? dcid } : undefined;
  const whereIndex = base.slots.findIndex((s) => s.key.axis === "where");
  const slots = base.slots.map((s, i) =>
    i === whereIndex
      ? {
          ...s,
          binding: ref
            ? {
                kind: "value" as const,
                value: { value_kind: "entity" as const, ref },
              }
            : { kind: "unbound" as const },
        }
      : s,
  );
  const entities = ref
    ? [
        {
          ref,
          entity_type: base.entities[0]?.entity_type,
          role: base.entities[0]?.role ?? { kind: "subject" as const },
        },
      ]
    : base.entities;
  const spec: Spec = {
    ...base,
    spec_id: `${base.spec_id}::${JSON.stringify(identity.entities)}`,
    slots,
    entities,
    definition: { identity },
    resolution: {
      ...base.resolution,
      resolved_entities: entities.map((e) => e.ref),
    },
  };
  return definite(
    spec,
    echo({
      raw_query: "spec_resubmit",
      variable_text: [],
      extract_skipped: true,
    }),
  );
}

/** A stub transport for the "happy path" tests: resolve() looks up a canned
 *  response by exact query text, identityEdit() applies the edited identity onto
 *  definiteBreadthSpec (the only shape any freshStore() test edits). */
function freshStore() {
  const transport: TestTransport = {
    resolve: (query) => resolveByQuery(query),
    identityEdit: (identity) =>
      Promise.resolve(withEditedIdentity(definiteBreadthSpec, identity)),
  };
  // A dedicated transport instance per store keeps tests isolated.
  return createSpecStore(transport);
}

/** A resolveStream double the test drives by hand: onEvent captures the store's
 *  event handler and the returned promise doesn't settle until finish() is
 *  called — so assertions can run mid-stream, before the simulated request
 *  "completes". resolve()/identityEdit() are stubbed to the same fallback response;
 *  the tests that use this never exercise the buffered path. */
function manualStreamTransport(fallback: ResolveResponse): {
  transport: TestTransport;
  emit: (ev: SearchEvent) => void;
  finish: () => void;
} {
  let onEvent: (ev: SearchEvent) => void = () => {};
  let settle: () => void = () => {};
  const transport: TestTransport = {
    resolve: () => Promise.resolve(fallback),
    identityEdit: () => Promise.resolve(fallback),
    resolveStream: (_query, cb) => {
      onEvent = cb;
      return new Promise<void>((resolve) => {
        settle = resolve;
      });
    },
  };
  return { transport, emit: (ev) => onEvent(ev), finish: () => settle() };
}

/** A resubmitDatasetStream double for editSlot/editDonor/chooseSpec
 *  streaming tests, driven by hand: each resubmitDatasetStream() call pushes
 *  its own {emit, finish, signal} handle onto `calls` (index 0 = first
 *  call, 1 = a superseding second call, ...) so a test can drive overlapping
 *  edit-streams independently. resolve() seeds a spec to edit (every caller
 *  resolves a single-part query first, so the posted `entries[]` is always
 *  one entry); the buffered identityEdit()/resubmitDataset() paths are never
 *  exercised by these tests. */
function manualResubmitStreamTransport(): {
  transport: TestTransport;
  calls: {
    emit: (ev: SearchEvent) => void;
    finish: () => void;
    signal?: AbortSignal;
  }[];
} {
  const calls: {
    emit: (ev: SearchEvent) => void;
    finish: () => void;
    signal?: AbortSignal;
  }[] = [];
  const transport: TestTransport = {
    resolve: (query) => resolveByQuery(query),
    identityEdit: () =>
      Promise.reject(
        new Error("buffered identityEdit should not be called in a streaming test"),
      ),
    resubmitDatasetStream: (_entries, _rawQuery, cb, signal) =>
      new Promise<void>((resolve) => {
        calls.push({ emit: cb, finish: resolve, signal });
      }),
  };
  return { transport, calls };
}

describe("specStore", () => {
  it("starts idle", () => {
    const store = freshStore();
    const s = store.getState();
    expect(s.status).toBe("idle");
    expect(s.parts).toEqual([]);
  });

  it("resolve() of a definite query sets parts[0].spec + viewModel", async () => {
    const store = freshStore();
    await store.getState().resolve("women in Kenya");
    const s = store.getState();
    expect(s.status).toBe("ready");
    expect(s.parts).toHaveLength(1);
    expect(s.parts[0].part?.status).toBe("definite");
    expect(s.parts[0].spec?.spec_id).toBe(definiteExactSpec.spec_id);
    expect(s.parts[0].viewModel?.specId).toBe(definiteExactSpec.spec_id);
  });

  it("resolve() of an ambiguous query is a candidates part with no viewModel", async () => {
    const store = freshStore();
    await store.getState().resolve("aid to Africa");
    const s = store.getState();
    expect(s.status).toBe("ready");
    expect(s.parts[0].part?.status).toBe("candidates");
    expect(s.parts[0].viewModel).toBeNull();
    const part = partAt(s.response!, 0);
    expect(part?.status).toBe("candidates");
    expect(
      part?.status === "candidates" ? part.candidates.specs.length : 0,
    ).toBeGreaterThanOrEqual(2);
  });

  it("resolve() of an unknown entity is a no_data part", async () => {
    const store = freshStore();
    await store.getState().resolve("GDP of Atlantis");
    const s = store.getState();
    expect(s.status).toBe("ready");
    expect(s.parts[0].part?.status).toBe("no_data");
  });

  // A bare chooseSpec() against an idle store has no committed parts to
  // build a dataset_resubmit entries[] list from: every dataset-door edit
  // needs the whole current envelope to post entries for. The next test
  // already exercises chooseSpec() against a real committed candidates
  // part, with its own posted-fields assertions.

  it("chooseSpec() splices the candidate into parts[0] after a prior resolve", async () => {
    const captured: {
      identity?: BaseIdentity;
      promote?: PromoteFields;
    } = {};
    const store = createSpecStore({
      resolve: () => Promise.resolve(candidates),
      identityEdit: (identity, promote) => {
        captured.identity = identity;
        captured.promote = promote;
        return Promise.resolve(definiteExact);
      },
    });
    await store.getState().resolve("aid to Africa");
    expect(store.getState().parts[0].part?.status).toBe("candidates");

    await store.getState().chooseSpec(0, definiteExactSpec);
    const s = store.getState();
    expect(s.parts[0].part?.status).toBe("definite");
    expect(s.parts[0].viewModel?.specId).toBe(definiteExactSpec.spec_id);
    // The candidate's own identity, posted verbatim as both `identity` and
    // (via promoteFromSpec) `base_identity` -- byte-for-byte, so the shapes
    // trivially match and this reads as a no-op resubmit confirming the pick.
    expect(captured.identity).toEqual(definiteExactSpec.definition?.identity);
    expect(captured.promote?.base_spec_id).toBe(definiteExactSpec.spec_id);
    expect(captured.promote?.base_identity).toEqual(
      definiteExactSpec.definition?.identity,
    );
    expect(captured.promote?.resolved_stat_var_dcids).toEqual([
      "Count_Person_Female",
    ]);
  });

  it("chooseSpec() posts the candidate's own identity.requested_window verbatim", async () => {
    let captured: BaseIdentity | undefined;
    const withWindow: Spec = {
      ...definiteExactSpec,
      definition: {
        identity: {
          ...definiteExactSpec.definition!.identity!,
          requested_window: { kind: "range", start_year: 2010, end_year: 2020 },
        },
      },
    };
    const spy: TestTransport = {
      resolve: () => Promise.resolve(candidates),
      identityEdit: (identity) => {
        captured = identity;
        return Promise.resolve(definiteExact);
      },
    };
    const store = createSpecStore(spy);
    await store.getState().resolve("aid to Africa");
    await store.getState().chooseSpec(0, withWindow);

    expect(captured?.requested_window).toEqual({
      kind: "range",
      start_year: 2010,
      end_year: 2020,
    });
  });

  it("surfaces a transport failure as the run-level error state", async () => {
    const throwing: TestTransport = {
      resolve: () => Promise.reject(new Error("boom")),
      identityEdit: () => Promise.reject(new Error("boom")),
    };
    const store = createSpecStore(throwing);
    await store.getState().resolve("anything");
    expect(store.getState().status).toBe("error");
    expect(store.getState().error).toBe("boom");
  });

  it("editSlot() rebinds a slot and re-resolves, enabling undo", async () => {
    const store = freshStore();
    await store.getState().resolve("malaria grants to Ethiopia");
    const before = store.getState().parts[0].spec!;
    const whereIndex = before.slots.findIndex((s) => s.key.axis === "where");

    await store.getState().editSlot(0, whereIndex, {
      kind: "value",
      value: {
        value_kind: "entity",
        ref: { dcid: "country/KEN", label: "Kenya" },
      },
    });

    const after = store.getState();
    expect(after.status).toBe("ready");
    expect(after.parts[0].part?.status).toBe("definite");
    expect(after.parts[0].spec?.spec_id).not.toBe(before.spec_id);
    expect(
      after.parts[0].viewModel?.sentence.some((p) => p.text === "Kenya"),
    ).toBe(true);
    expect(after.canUndo).toBe(true);
    expect(after.canRedo).toBe(false);
  });

  // A standard shape's refine_supported can be true too, not only named
  // families like dev-finance. editSlot() on such a shape must still send
  // resolved_stat_var_dcids: the engine's standard promote path requires it
  // and 400s without it.
  it("editSlot() on a standard shape with refine_supported true still sends resolved_stat_var_dcids", async () => {
    const standardWithRefineSupported = {
      ...definiteExactSpec,
      shape: { ...definiteExactSpec.shape, refine_supported: true },
    };
    const canned = definite(
      standardWithRefineSupported,
      echo({ raw_query: "women in Kenya", variable_text: ["female persons"] }),
    );
    let captured: PromoteFields | undefined;
    const spy: TestTransport = {
      resolve: () => Promise.resolve(canned),
      identityEdit: (_identity, promote) => {
        captured = promote;
        return Promise.resolve(canned);
      },
    };
    const store = createSpecStore(spy);
    await store.getState().resolve("women in Kenya");

    const genderIndex = standardWithRefineSupported.slots.findIndex(
      (s) => s.key.axis === "how",
    );
    await store.getState().editSlot(0, genderIndex, {
      kind: "value",
      value: { value_kind: "enum_value", ref: { dcid: "Male", label: "male" } },
    });

    expect(captured?.resolved_stat_var_dcids).toEqual(["Count_Person_Female"]);
  });

  it("resolve() streams pipeline steps + real detail and commits the final response", async () => {
    const streaming: TestTransport = {
      resolve: (query) => resolveByQuery(query),
      resolveStream: async (query, onEvent) => {
        onEvent({
          kind: "interpretation",
          variables: ["women"],
          entities: ["Kenya"],
          dates: [{ kind: "range", start: "2015", end: "2020" }],
          expected_results: 1,
        });
        onEvent({
          kind: "shape",
          variable_index: 0,
          shape_id: "sh",
          label: "people",
          slot_keys: [],
          sentence_plan: [],
          slot_options: [],
          refine_supported: false,
        });
        onEvent({
          kind: "step",
          variable_index: 0,
          step: "extract",
          ran: true,
          ms: 12,
        });
        onEvent({
          kind: "step",
          variable_index: 0,
          step: "recall",
          ran: true,
          ms: 40,
        });
        const buffered = await resolveByQuery(query);
        onEvent({ kind: "response", response: buffered });
        onEvent({
          kind: "done",
          elapsed_ms: 120,
          timed_out: false,
          telemetry: {
            llm_usage: { prompt_tokens: 50, completion_tokens: 20 },
          },
          warnings: [{ code: "W1", severity: "warn", message: "warning 1" }],
        });
      },
    };
    const store = createSpecStore(streaming);
    await store.getState().resolve("women in Kenya");
    const s = store.getState();
    expect(s.status).toBe("ready");
    expect(s.loadingSteps[0]).toEqual(["extract", "recall"]);
    expect(s.parts[0].spec?.spec_id).toBe(definiteExactSpec.spec_id);
    expect(s.telemetry).toEqual({
      elapsedMs: 120,
      timedOut: false,
      llm_usage: { prompt_tokens: 50, completion_tokens: 20 },
    });
    expect(s.warnings).toEqual([
      { code: "W1", severity: "warn", message: "warning 1" },
    ]);
    // real detail captured from the stream, surfaced in the loading view
    expect(s.expectedParts).toEqual([{ index: 0, variableText: "women" }]);
    expect(s.progress[0]?.variables).toEqual(["women"]);
    expect(s.progress[0]?.entities).toEqual(["Kenya"]);
    expect(s.progress[0]?.dates).toEqual(["2015–2020"]);
    expect(s.progress[0]?.shapeLabel).toBe("people");
    expect(s.progress[0]?.stepMs.extract).toBe(12);
  });

  it("resolve() surfaces a streamed error event as the run-level error state", async () => {
    const streaming: TestTransport = {
      resolve: () => Promise.reject(new Error("resolve not used in this test")),
      resolveStream: async (_q, onEvent) => {
        onEvent({ kind: "error", detail: "upstream exploded", code: null });
      },
    };
    const store = createSpecStore(streaming);
    await store.getState().resolve("anything");
    expect(store.getState().status).toBe("error");
    expect(store.getState().error).toBe("upstream exploded");
  });

  it("editDonor() re-resolves with the same slots and identity.entities.origin set to the new donor", async () => {
    let captured: {
      identity: BaseIdentity;
      promote?: PromoteFields;
    } | null = null;
    const spy: TestTransport = {
      resolve: () => Promise.resolve(definiteBreadth),
      identityEdit: (identity, promote) => {
        captured = { identity, promote };
        return Promise.resolve(
          withEditedIdentity(definiteBreadthSpec, identity),
        );
      },
    };
    const store = createSpecStore(spy);
    await store.getState().resolve("malaria grants to Ethiopia");
    const before = store.getState().parts[0].spec!;

    await store.getState().editDonor(0, "country/DEU");

    expect(captured).not.toBeNull();
    expect(captured!.identity.slots).toEqual(
      before.definition?.identity?.slots,
    ); // slots unchanged
    // The directional 'from' entity role lives at identity.entities.origin;
    // there is no separate donor_dcid field on the wire.
    expect(captured!.identity.entities.origin).toEqual(["country/DEU"]);
    expect(store.getState().status).toBe("ready");
    expect(store.getState().parts[0].part?.status).toBe("definite");
    expect(store.getState().canUndo).toBe(true);
  });

  it("editSlot() sets identity.requested_window on a deliberate when-slot edit, and leaves it untouched on a constraint-slot edit", async () => {
    // A deliberate when-slot edit sets identity.requested_window to the new
    // window. Every other edit routes elsewhere in the identity, so it
    // carries the base identity's requested_window forward unchanged.
    const withWindow: Spec = {
      ...definiteBreadthSpec,
      definition: {
        identity: {
          ...definiteBreadthSpec.definition!.identity!,
          requested_window: { kind: "range", start_year: 2010, end_year: 2020 },
        },
      },
    };
    const canned = definite(
      withWindow,
      echo({ raw_query: "x", variable_text: [] }),
    );
    let captured: BaseIdentity | undefined;
    const spy: TestTransport = {
      resolve: () => Promise.resolve(canned),
      identityEdit: (identity) => {
        captured = identity;
        return Promise.resolve(canned);
      },
    };
    const store = createSpecStore(spy);
    await store.getState().resolve("anything");

    const whenIndex = withWindow.slots.findIndex((s) => s.key.axis === "when");
    const whatIndex = withWindow.slots.findIndex((s) => s.key.axis === "what");

    await store.getState().editSlot(0, whenIndex, { kind: "unbound" });
    expect(captured?.requested_window).toEqual({ kind: "all" });

    await store.getState().editSlot(0, whatIndex, {
      kind: "value",
      value: {
        value_kind: "enum_value",
        ref: { dcid: "ODAGrants", label: "ODA grants" },
      },
    });
    expect(captured?.requested_window).toEqual({
      kind: "range",
      start_year: 2010,
      end_year: 2020,
    });
  });

  // The exact CI gap the where-edit entity-precedence bug slipped through: a
  // where-slot edit on a subject-only spec (unbound where pre-edit, entities
  // carrying a plain subject) must post the NEW place binding in slots and must
  // NOT carry the stale entity role forward. entities is a plain map keyed by
  // role, and editSlot's where-axis edit rebinds observationAbout to the new
  // place directly. There is no separate entity_dcids field to go stale.
  it("editSlot() on the where-axis of a subject-only spec sends the new place under observationAbout", async () => {
    const subjectOnlySpec: Spec = {
      ...definiteExactSpec,
      spec_id: "spec_subject_only_earth",
      slots: definiteExactSpec.slots.map((s) =>
        s.key.axis === "where" ? { ...s, binding: { kind: "unbound" } } : s,
      ),
      entities: [
        {
          ref: { dcid: "Earth", label: "World" },
          entity_type: { dcid: "Place", label: "Place" },
          role: { kind: "subject" },
        },
      ],
      definition: {
        identity: {
          ...definiteExactSpec.definition!.identity!,
          entities: { observationAbout: ["Earth"] },
        },
      },
    };
    const canned = definite(
      subjectOnlySpec,
      echo({ raw_query: "world population", variable_text: ["population"] }),
    );
    let captured: BaseIdentity | undefined;
    const spy: TestTransport = {
      resolve: () => Promise.resolve(canned),
      identityEdit: (identity) => {
        captured = identity;
        return Promise.resolve(canned);
      },
    };
    const store = createSpecStore(spy);
    await store.getState().resolve("world population");

    const whereIndex = subjectOnlySpec.slots.findIndex(
      (s) => s.key.axis === "where",
    );
    await store.getState().editSlot(0, whereIndex, {
      kind: "value",
      value: {
        value_kind: "entity",
        ref: { dcid: "country/KEN", label: "Kenya" },
      },
    });

    expect(captured).not.toBeNull();
    expect(captured!.entities).toEqual({ observationAbout: ["country/KEN"] });
  });

  it("undo() and redo() step through the history", async () => {
    const store = freshStore();
    await store.getState().resolve("malaria grants to Ethiopia");
    const before = store.getState().parts[0].spec!;
    const whereIndex = before.slots.findIndex((s) => s.key.axis === "where");

    await store.getState().editSlot(0, whereIndex, { kind: "unbound" });
    const edited = store.getState().parts[0].spec!.spec_id;
    expect(edited).not.toBe(before.spec_id);

    store.getState().undo();
    expect(store.getState().parts[0].spec?.spec_id).toBe(before.spec_id);
    expect(store.getState().canRedo).toBe(true);
    // undoing a single-slot edit flashes that part+slot
    expect(store.getState().lastEditedSlot).toEqual({
      partIndex: 0,
      slotIndex: whereIndex,
    });

    store.getState().redo();
    expect(store.getState().parts[0].spec?.spec_id).toBe(edited);
    expect(store.getState().canRedo).toBe(false);
    expect(store.getState().lastEditedSlot).toEqual({
      partIndex: 0,
      slotIndex: whereIndex,
    });
  });

  it("supports multi-step undo across several edits", async () => {
    const store = freshStore();
    await store.getState().resolve("malaria grants to Ethiopia");
    const s0 = store.getState().parts[0].spec!.spec_id;
    const whereIndex = store
      .getState()
      .parts[0].spec!.slots.findIndex((s) => s.key.axis === "where");

    await store.getState().editSlot(0, whereIndex, {
      kind: "value",
      value: {
        value_kind: "entity",
        ref: { dcid: "country/KEN", label: "Kenya" },
      },
    });
    await store.getState().editSlot(0, whereIndex, {
      kind: "value",
      value: {
        value_kind: "entity",
        ref: { dcid: "country/NGA", label: "Nigeria" },
      },
    });

    store.getState().undo();
    store.getState().undo();
    expect(store.getState().parts[0].spec?.spec_id).toBe(s0);
    expect(store.getState().canUndo).toBe(false);
  });

  it("retry() replays the last resolve, recovering a flaky query", async () => {
    // Fails on the first attempt, succeeds on the retry -- exercises retry()'s
    // recovery path without depending on any magic query text.
    let attempt = 0;
    const store = createSpecStore({
      resolve: () => {
        attempt += 1;
        return attempt === 1
          ? Promise.reject(
              new Error("Temporary engine error — please try again."),
            )
          : Promise.resolve(definiteBreadth);
      },
    });
    await store.getState().resolve("flaky malaria demo");
    expect(store.getState().status).toBe("error");
    await store.getState().retry();
    expect(store.getState().status).toBe("ready");
    expect(store.getState().error).toBeNull();
  });

  it("surfaces a failed query as the run-level error state", async () => {
    const store = createSpecStore({
      resolve: () =>
        Promise.reject(new Error("The engine could not be reached.")),
    });
    await store.getState().resolve("boom please");
    expect(store.getState().status).toBe("error");
    expect(store.getState().error).toMatch(/could not be reached/);
  });

  it("editSlot() rolls back to the snapshot when the transport fails, setting parts[0].editError (not a run-level error)", async () => {
    const flaky: TestTransport = {
      resolve: () => Promise.resolve(definiteExact),
      identityEdit: () => Promise.reject(new Error("edit failed")),
    };
    const store = createSpecStore(flaky);
    await store.getState().resolve("women in Kenya");
    const before = store.getState().parts[0].spec!;

    await store.getState().editSlot(0, 0, { kind: "unbound" });

    const s = store.getState();
    expect(s.status).toBe("ready"); // rolled back, not stuck on error UI
    expect(s.error).toBeNull(); // NOT a run-level error
    expect(s.parts[0].spec?.spec_id).toBe(before.spec_id);
    expect(s.parts[0].editError).toBe("edit failed");
  });

  // An edit that resolves to no_data commits and renders in place, same as
  // any other part status, rather than being kept out and reported as an
  // editError. Undo gains a step over it.
  it("editSlot() that resolves to no_data commits the no_data outcome in place, adding an undo step", async () => {
    const noDataResponse: ResolveResponse = {
      schema_version: "1.0",
      status: "no_data",
      parts: [
        {
          status: "no_data",
          variable_text: null,
          warnings: [],
          timing_ms: null,
          rendered_sentence: null,
          sentence_plan: null,
          no_data: { reason: "no_observations" },
        },
      ],
      query_echo: {
        entry_path: "dataset_resubmit",
        variable_text: [],
        extract_skipped: true,
      },
      diagnostics: { engine_build: "test", warnings: [] },
    };
    const guard: TestTransport = {
      resolve: () => Promise.resolve(definiteExact),
      resubmitDataset: () => Promise.resolve(noDataResponse), // the edit resolves to no_data
    };
    const store = createSpecStore(guard);
    await store.getState().resolve("women in Kenya");
    const before = store.getState().parts[0].spec!;
    expect(store.getState().history).toHaveLength(1);

    await store.getState().editSlot(0, 0, { kind: "unbound" });

    const s = store.getState();
    expect(s.status).toBe("ready");
    expect(s.parts[0].part?.status).toBe("no_data"); // the outcome renders in place
    expect(s.parts[0].editError).toBeNull();
    expect(s.history).toHaveLength(2); // undo gains a step over it
    expect(s.canUndo).toBe(true);

    store.getState().undo();
    expect(store.getState().parts[0].spec?.spec_id).toBe(before.spec_id);
  });

  it("editSlot() clears a stale editError as soon as a new edit on that part starts", async () => {
    let identityEditCalls = 0;
    const spy: TestTransport = {
      resolve: () => Promise.resolve(definiteExact),
      identityEdit: (identity) => {
        identityEditCalls += 1;
        if (identityEditCalls === 1)
          return Promise.reject(new Error("first edit failed"));
        return Promise.resolve(withEditedIdentity(definiteExactSpec, identity));
      },
    };
    const store = createSpecStore(spy);
    await store.getState().resolve("women in Kenya");

    await store.getState().editSlot(0, 0, { kind: "unbound" });
    expect(store.getState().parts[0].editError).toBe("first edit failed");

    await store.getState().editSlot(0, 0, {
      kind: "value",
      value: {
        value_kind: "entity",
        ref: { dcid: "country/NGA", label: "Nigeria" },
      },
    });
    expect(store.getState().parts[0].editError).toBeNull();
  });

  it("commits the result when the response event arrives, before the stream ends", async () => {
    const definiteResponse = definiteExact;
    const { transport, emit, finish } = manualStreamTransport(definiteResponse);
    const store = createSpecStore(transport);

    const pending = store.getState().resolve("women in Kenya");
    emit({ kind: "response", response: definiteResponse });

    // committed already, while the stream promise is still open
    expect(store.getState().status).toBe("ready");
    expect(store.getState().parts[0].spec?.spec_id).toBe(
      definiteExactSpec.spec_id,
    );

    finish();
    await pending;
    expect(store.getState().status).toBe("ready");
  });

  it("merges trailing slot_options events into the committed spec and its history snapshot", async () => {
    const definiteResponse = definiteExact;
    const { transport, emit, finish } = manualStreamTransport(definiteResponse);
    const store = createSpecStore(transport);

    const pending = store.getState().resolve("women in Kenya");
    emit({ kind: "response", response: definiteResponse });

    const spec = store.getState().parts[0].spec!;
    const key = spec.slots[0].key;
    emit({
      kind: "slot_options",
      spec_id: spec.spec_id,
      key,
      options: [
        {
          value: { value_kind: "entity", ref: { dcid: "x/1", label: "X" } },
          coverage: { kind: "exact", has_data: true, observation_count: 7 },
        },
      ],
      complete: true,
    });

    finish();
    await pending;

    const s = store.getState();
    const merged = s.parts[0].spec?.slot_options?.find(
      (so) => so.key.axis === key.axis,
    );
    expect(merged?.options[0]?.coverage).toEqual({
      kind: "exact",
      has_data: true,
      observation_count: 7,
    });
    // undo/redo must see the merged counts too, so the snapshot carries them.
    expect(
      s.history[s.index].parts[0].spec?.slot_options?.[0]?.options[0]?.coverage,
    ).toEqual({
      kind: "exact",
      has_data: true,
      observation_count: 7,
    });
  });

  it("merges trailing entity_options events", async () => {
    const definiteResponse = definiteExact;
    const { transport, emit, finish } = manualStreamTransport(definiteResponse);
    const store = createSpecStore(transport);

    const pending = store.getState().resolve("women in Kenya");
    emit({ kind: "response", response: definiteResponse });

    const spec = store.getState().parts[0].spec!;
    emit({
      kind: "entity_options",
      spec_id: spec.spec_id,
      entity_ref: "country/FRA",
      role: "from",
      options: [
        {
          value: {
            value_kind: "entity",
            ref: { dcid: "country/FRA", label: "France" },
          },
          coverage: { kind: "exact", has_data: true, observation_count: 3 },
        },
      ],
      complete: true,
    });

    finish();
    await pending;

    const entry = store
      .getState()
      .parts[0].spec?.entity_options?.find(
        (eo) => eo.entity_ref === "country/FRA",
      );
    expect(entry?.role).toBe("from");
    expect(entry?.options[0]?.coverage).toEqual({
      kind: "exact",
      has_data: true,
      observation_count: 3,
    });
  });

  it("merges a trailing facet_options event", async () => {
    const definiteResponse = definiteExact;
    const { transport, emit, finish } = manualStreamTransport(definiteResponse);
    const store = createSpecStore(transport);

    const pending = store.getState().resolve("women in Kenya");
    emit({ kind: "response", response: definiteResponse });

    const spec = store.getState().parts[0].spec!;
    emit({
      kind: "facet_options",
      spec_id: spec.spec_id,
      axis: "provenance",
      options: [
        {
          value: {
            value_kind: "source",
            ref: { dcid: "dc/base/X", label: "X" },
          },
          coverage: null,
        },
      ],
      truncated: false,
    });

    finish();
    await pending;

    const merged = store
      .getState()
      .parts[0].spec?.facet_options?.find((fo) => fo.axis === "provenance");
    expect(merged?.truncated).toBe(false);
    expect(merged?.options[0]?.value?.ref?.dcid).toBe("dc/base/X");
  });

  it("a late stream error after the response does not take the result away", async () => {
    const definiteResponse = definiteExact;
    const { transport, emit, finish } = manualStreamTransport(definiteResponse);
    const store = createSpecStore(transport);

    const pending = store.getState().resolve("women in Kenya");
    emit({ kind: "response", response: definiteResponse });
    emit({ kind: "error", detail: "late failure", code: null });

    finish();
    await pending;

    const s = store.getState();
    expect(s.status).toBe("ready");
    expect(s.error).toBeNull();
  });

  it("a new resolve() supersedes an in-flight one", async () => {
    const first = definiteExact;
    const second = definiteBreadth;
    let releaseFirst!: (v: ResolveResponse) => void;
    let calls = 0;
    // buffered-only (no resolveStream): the first call hangs until released,
    // the second resolves immediately to a different fixture.
    const transport: TestTransport = {
      resolve: () => {
        calls += 1;
        if (calls === 1) {
          return new Promise<ResolveResponse>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return Promise.resolve(second);
      },
      identityEdit: () => Promise.resolve(second),
    };
    const store = createSpecStore(transport);

    const pendingFirst = store.getState().resolve("first query");
    await store.getState().resolve("second query");
    expect(store.getState().parts[0].spec?.spec_id).toBe(
      definiteBreadthSpec.spec_id,
    );

    // the superseded op's late arrival must not clobber the newer result
    releaseFirst(first);
    await pendingFirst;
    expect(store.getState().parts[0].spec?.spec_id).toBe(
      definiteBreadthSpec.spec_id,
    );
  });

  it("a raw-text resolve() aborts an edit in flight on any part", async () => {
    let editSignal: AbortSignal | undefined;
    const transport: TestTransport = {
      resolve: () => Promise.resolve(definiteExact),
      identityEdit: (_identity, _promote, signal) => {
        editSignal = signal;
        return new Promise<ResolveResponse>(() => {}); // hangs
      },
    };
    const store = createSpecStore(transport);
    await store.getState().resolve("women in Kenya");

    store.getState().editSlot(0, 0, { kind: "unbound" }); // fire, don't await: hangs
    expect(store.getState().editPending).toBe(0);
    expect(editSignal?.aborted).toBe(false);

    await store.getState().resolve("women in Kenya"); // a fresh run supersedes everything
    expect(editSignal?.aborted).toBe(true);
  });

  it("cancel() during loading restores the last committed result", async () => {
    let calls = 0;
    const transport: TestTransport = {
      resolve: () => {
        calls += 1;
        if (calls === 1) return Promise.resolve(definiteExact);
        return new Promise<ResolveResponse>(() => {}); // hangs
      },
    };
    const store = createSpecStore(transport);
    await store.getState().resolve("women in Kenya");
    const before = store.getState().parts[0].spec!;

    store.getState().resolve("anything else"); // fire, don't await: it never settles
    expect(store.getState().status).toBe("loading");

    store.getState().cancel();

    const s = store.getState();
    expect(s.status).toBe("ready");
    expect(s.parts[0].spec?.spec_id).toBe(before.spec_id);
  });

  it("cancel() during loading restores the queryText of the last committed result", async () => {
    let calls = 0;
    const transport: TestTransport = {
      resolve: () => {
        calls += 1;
        if (calls === 1) return Promise.resolve(definiteExact);
        return new Promise<ResolveResponse>(() => {}); // hangs
      },
    };
    const store = createSpecStore(transport);
    await store.getState().resolve("women in Kenya");

    store.getState().resolve("anything else"); // fire, don't await: it never settles
    expect(store.getState().status).toBe("loading");

    store.getState().cancel();

    expect(store.getState().queryText).toBe("women in Kenya");
  });

  it("cancel() with no prior result returns to idle", () => {
    const transport: TestTransport = {
      resolve: () => new Promise<ResolveResponse>(() => {}), // hangs
      identityEdit: () => new Promise<ResolveResponse>(() => {}),
    };
    const store = createSpecStore(transport);

    store.getState().resolve("anything"); // fire, don't await: it never settles
    expect(store.getState().status).toBe("loading");

    store.getState().cancel();
    expect(store.getState().status).toBe("idle");
  });

  it("editSlot() sets editPending to the part index while in flight and clears it after", async () => {
    const definiteResponse = definiteExact;
    let release!: (v: ResolveResponse) => void;
    const transport: TestTransport = {
      resolve: () => Promise.resolve(definiteExact),
      identityEdit: () =>
        new Promise<ResolveResponse>((resolve) => {
          release = resolve;
        }),
    };
    const store = createSpecStore(transport);
    await store.getState().resolve("women in Kenya");

    const pending = store.getState().editSlot(0, 0, { kind: "unbound" });
    expect(store.getState().editPending).toBe(0);

    release(definiteResponse);
    await pending;
    expect(store.getState().editPending).toBeNull();
  });

  it("liveSentences captures shape then sentence events and clears on commit", async () => {
    const definiteResponse = definiteExact;
    const { transport, emit, finish } = manualStreamTransport(definiteResponse);
    const store = createSpecStore(transport);

    const pending = store.getState().resolve("women in Kenya");

    const howKey = {
      axis: "how" as const,
      property: { dcid: "p/1", label: "method" },
      label: "method",
    };
    emit({
      kind: "shape",
      variable_index: 0,
      shape_id: "sh",
      label: "people",
      slot_keys: [howKey],
      sentence_plan: [
        {
          kind: "slot",
          text: "",
          axis: "how",
          property_dcid: "p/1",
          binding_ref: "how:p/1",
        },
      ],
      slot_options: [],
      refine_supported: false,
    });

    // skeleton: unbound, but already named from the shape event's slot_keys
    let live = store.getState().liveSentences[0];
    expect(live?.bound).toBe(false);
    expect(live?.labels["how:p/1"]).toBe("method");

    emit({
      kind: "sentence",
      variable_index: 0,
      spec_id: definiteSpec(definiteResponse).spec_id,
      sentence_plan: [
        {
          kind: "slot",
          text: "female",
          axis: "how",
          property_dcid: "p/1",
          binding_ref: "how:p/1",
        },
      ],
      slots: definiteSpec(definiteResponse).slots,
    });

    live = store.getState().liveSentences[0];
    expect(live?.bound).toBe(true);

    emit({ kind: "response", response: definiteResponse });
    expect(store.getState().liveSentences).toEqual({});

    finish();
    await pending;
  });

  it("cancel() during a pending edit restores the pre-edit result and clears editPending", async () => {
    const transport: TestTransport = {
      resolve: () => Promise.resolve(definiteExact),
      identityEdit: () => new Promise<ResolveResponse>(() => {}), // hangs
    };
    const store = createSpecStore(transport);
    await store.getState().resolve("women in Kenya");
    const before = store.getState().parts[0].spec!;

    store.getState().editSlot(0, 0, { kind: "unbound" }); // fire, don't await: it never settles
    expect(store.getState().editPending).toBe(0);
    expect(store.getState().status).toBe("ready"); // editPending edits never touch run-level status

    store.getState().cancel();

    const s = store.getState();
    expect(s.editPending).toBeNull();
    expect(s.status).toBe("ready");
    expect(s.parts[0].spec?.spec_id).toBe(before.spec_id);
  });

  it("undo() during an in-flight resolve cancels in place first, then steps the pointer on a second call", async () => {
    let calls = 0;
    const transport: TestTransport = {
      resolve: (query) => {
        calls += 1;
        if (calls <= 2) return resolveByQuery(query); // seed two committed results
        return new Promise<ResolveResponse>(() => {}); // hangs
      },
    };
    const store = createSpecStore(transport);
    await store.getState().resolve("women in Kenya");
    const first = store.getState().parts[0].spec!.spec_id;
    await store.getState().resolve("malaria grants to Ethiopia");
    const second = store.getState().parts[0].spec!.spec_id;

    store.getState().resolve("anything else"); // fire, don't await: it never settles
    expect(store.getState().status).toBe("loading");

    store.getState().undo(); // first call: cancel in place, no pointer step
    expect(store.getState().status).toBe("ready");
    expect(store.getState().parts[0].spec?.spec_id).toBe(second);

    store.getState().undo(); // second call: now actually steps back
    expect(store.getState().parts[0].spec?.spec_id).toBe(first);
  });

  it("redo() during an in-flight resolve cancels in place first, then steps the pointer on a second call", async () => {
    let calls = 0;
    const transport: TestTransport = {
      resolve: (query) => {
        calls += 1;
        if (calls <= 2) return resolveByQuery(query); // seed two committed results
        return new Promise<ResolveResponse>(() => {}); // hangs
      },
    };
    const store = createSpecStore(transport);
    await store.getState().resolve("women in Kenya");
    const first = store.getState().parts[0].spec!.spec_id;
    await store.getState().resolve("malaria grants to Ethiopia");
    const second = store.getState().parts[0].spec!.spec_id;
    store.getState().undo();
    expect(store.getState().parts[0].spec?.spec_id).toBe(first);
    expect(store.getState().canRedo).toBe(true);

    store.getState().resolve("a third query"); // fire, don't await: it never settles
    expect(store.getState().status).toBe("loading");

    store.getState().redo(); // first call: cancel in place, no pointer step
    expect(store.getState().status).toBe("ready");
    expect(store.getState().parts[0].spec?.spec_id).toBe(first);

    store.getState().redo(); // second call: now actually steps forward
    expect(store.getState().parts[0].spec?.spec_id).toBe(second);
  });

  it("undo() during a pending edit cancels in place first, then steps the pointer on a second call", async () => {
    let identityEditCalls = 0;
    const transport: TestTransport = {
      resolve: () => Promise.resolve(definiteBreadth),
      identityEdit: (identity) => {
        identityEditCalls += 1;
        if (identityEditCalls === 1)
          return Promise.resolve(
            withEditedIdentity(definiteBreadthSpec, identity),
          );
        return new Promise<ResolveResponse>(() => {}); // hangs
      },
    };
    const store = createSpecStore(transport);
    await store.getState().resolve("malaria grants to Ethiopia");
    const first = store.getState().parts[0].spec!.spec_id;
    const whereIndex = store
      .getState()
      .parts[0].spec!.slots.findIndex((s) => s.key.axis === "where");

    await store.getState().editSlot(0, whereIndex, { kind: "unbound" }); // committed: second history entry
    const second = store.getState().parts[0].spec!.spec_id;
    expect(second).not.toBe(first);

    store.getState().editSlot(0, whereIndex, {
      kind: "value",
      value: {
        value_kind: "entity",
        ref: { dcid: "country/KEN", label: "Kenya" },
      },
    }); // fire, don't await: it never settles
    expect(store.getState().editPending).toBe(0);

    store.getState().undo(); // first call: cancel the pending edit in place
    expect(store.getState().editPending).toBeNull();
    expect(store.getState().parts[0].spec?.spec_id).toBe(second); // still at the pre-edit result

    store.getState().undo(); // second call: now steps back to the first result
    expect(store.getState().parts[0].spec?.spec_id).toBe(first);
  });

  it("redo() during a pending edit cancels in place first, then steps the pointer on a second call", async () => {
    let identityEditCalls = 0;
    const transport: TestTransport = {
      resolve: () => Promise.resolve(definiteBreadth),
      identityEdit: (identity) => {
        identityEditCalls += 1;
        if (identityEditCalls === 1)
          return Promise.resolve(
            withEditedIdentity(definiteBreadthSpec, identity),
          );
        return new Promise<ResolveResponse>(() => {}); // hangs
      },
    };
    const store = createSpecStore(transport);
    await store.getState().resolve("malaria grants to Ethiopia");
    const first = store.getState().parts[0].spec!.spec_id;
    const whereIndex = store
      .getState()
      .parts[0].spec!.slots.findIndex((s) => s.key.axis === "where");

    await store.getState().editSlot(0, whereIndex, { kind: "unbound" });
    const second = store.getState().parts[0].spec!.spec_id;

    store.getState().undo();
    expect(store.getState().parts[0].spec?.spec_id).toBe(first);
    expect(store.getState().canRedo).toBe(true);

    store.getState().editSlot(0, whereIndex, {
      kind: "value",
      value: {
        value_kind: "entity",
        ref: { dcid: "country/KEN", label: "Kenya" },
      },
    }); // fire, don't await: it never settles (the 2nd identityEdit call)
    expect(store.getState().editPending).toBe(0);

    store.getState().redo(); // first call: cancel the pending edit in place
    expect(store.getState().editPending).toBeNull();
    expect(store.getState().parts[0].spec?.spec_id).toBe(first); // pointer did not step

    store.getState().redo(); // second call: now steps forward
    expect(store.getState().parts[0].spec?.spec_id).toBe(second);
  });

  it("trailing slot_options arriving BEFORE the response event still land after commit", async () => {
    const definiteResponse = definiteExact;
    const { transport, emit, finish } = manualStreamTransport(definiteResponse);
    const store = createSpecStore(transport);

    const pending = store.getState().resolve("women in Kenya");

    const key = definiteSpec(definiteResponse).slots[0].key;
    emit({
      kind: "slot_options",
      spec_id: definiteSpec(definiteResponse).spec_id,
      key,
      options: [
        {
          value: { value_kind: "entity", ref: { dcid: "x/1", label: "X" } },
          coverage: { kind: "exact", has_data: true, observation_count: 9 },
        },
      ],
      complete: true,
    });

    // pre-commit: nothing to merge into yet, so the event is buffered, not dropped
    expect(store.getState().parts).toEqual([]);

    emit({ kind: "response", response: definiteResponse });

    finish();
    await pending;

    const merged = store
      .getState()
      .parts[0].spec?.slot_options?.find((so) => so.key.axis === key.axis);
    expect(merged?.options[0]?.coverage).toEqual({
      kind: "exact",
      has_data: true,
      observation_count: 9,
    });
  });

  it("applies a trailing 'observations' event onto the committed spec/response/history and rebuilds the viewModel", async () => {
    const definiteResponse = definiteExact;
    const { transport, emit, finish } = manualStreamTransport(definiteResponse);
    const store = createSpecStore(transport);

    const pending = store.getState().resolve("women in Kenya");
    emit({ kind: "response", response: definiteResponse });

    const specId = store.getState().parts[0].spec!.spec_id;
    const viewModelBefore = store.getState().parts[0].viewModel;
    const observations = {
      series: [
        {
          stat_var_dcid: "sv/1",
          entity_dcid: "country/KEN",
          points: [{ date: "2020", value: 42 }],
          source_refs: [],
        },
      ],
      total_obs: 1,
      complete: true,
    };
    emit({ kind: "observations", spec_id: specId, observations });

    finish();
    await pending;

    const s = store.getState();
    expect(s.parts[0].spec?.observations).toEqual(observations);
    expect(definiteSpec(s.response!).observations).toEqual(observations);
    expect(s.history[s.index].parts[0].spec?.observations).toEqual(
      observations,
    );
    // the data-preview table derives from Spec.observations via buildViewModel,
    // so the viewModel must be a fresh build, not the pre-event one.
    expect(s.parts[0].viewModel).not.toBe(viewModelBefore);
  });

  it("a trailing 'observations' event arriving BEFORE the response event still lands after commit", async () => {
    const definiteResponse = definiteExact;
    const { transport, emit, finish } = manualStreamTransport(definiteResponse);
    const store = createSpecStore(transport);

    const pending = store.getState().resolve("women in Kenya");

    const specId = definiteSpec(definiteResponse).spec_id;
    const observations = {
      series: [
        {
          stat_var_dcid: "sv/1",
          entity_dcid: "country/KEN",
          points: [{ date: "2019", value: 7 }],
          source_refs: [],
        },
      ],
      total_obs: 1,
      complete: true,
    };
    emit({ kind: "observations", spec_id: specId, observations });

    // pre-commit: nothing to merge into yet, so the event is buffered, not dropped
    expect(store.getState().parts).toEqual([]);

    emit({ kind: "response", response: definiteResponse });

    finish();
    await pending;

    expect(store.getState().parts[0].spec?.observations).toEqual(observations);
  });

  it("resolve() caches a byte-identical repeat query and skips the transport on the second call", async () => {
    let calls = 0;
    const spy: TestTransport = {
      resolve: () => {
        calls += 1;
        return Promise.resolve(definiteExact);
      },
    };
    const store = createSpecStore(spy);
    await store.getState().resolve("women in Kenya");
    expect(calls).toBe(1);
    const firstSpecId = store.getState().parts[0].spec?.spec_id;

    await store.getState().resolve("  women in Kenya  "); // trimmed to the same cache key
    expect(calls).toBe(1); // second call is a cache hit -- no transport call
    expect(store.getState().parts[0].spec?.spec_id).toBe(firstSpecId);
  });

  it("resolve() of a query not yet seen populates the cache (a miss reaches the transport)", async () => {
    let calls = 0;
    const spy: TestTransport = {
      resolve: (query) => {
        calls += 1;
        return resolveByQuery(query);
      },
    };
    const store = createSpecStore(spy);
    await store.getState().resolve("women in Kenya");
    await store.getState().resolve("malaria grants to Ethiopia"); // different key: a miss
    expect(calls).toBe(2);
  });

  it("an edit does not poison the resolve() cache for the original query", async () => {
    let resolveCalls = 0;
    const spy: TestTransport = {
      resolve: () => {
        resolveCalls += 1;
        return Promise.resolve(definiteExact);
      },
      identityEdit: (identity) =>
        Promise.resolve(withEditedIdentity(definiteExactSpec, identity)),
    };
    const store = createSpecStore(spy);
    await store.getState().resolve("women in Kenya");
    const original = store.getState().parts[0].spec!;
    const whereIndex = original.slots.findIndex((s) => s.key.axis === "where");

    await store.getState().editSlot(0, whereIndex, {
      kind: "value",
      value: {
        value_kind: "entity",
        ref: { dcid: "country/NGA", label: "Nigeria" },
      },
    });
    expect(store.getState().parts[0].spec?.spec_id).not.toBe(original.spec_id);

    await store.getState().resolve("women in Kenya");
    expect(resolveCalls).toBe(1); // still a cache hit -- the edit never wrote the cache
    expect(store.getState().parts[0].spec?.spec_id).toBe(original.spec_id); // the ORIGINAL result, not the edited one
  });

  it("reset() clears the resolve() cache", async () => {
    let resolveCalls = 0;
    const spy: TestTransport = {
      resolve: () => {
        resolveCalls += 1;
        return Promise.resolve(definiteExact);
      },
    };
    const store = createSpecStore(spy);
    await store.getState().resolve("women in Kenya");
    store.getState().reset();

    await store.getState().resolve("women in Kenya");
    expect(resolveCalls).toBe(2); // reset cleared the cache -- a real transport call again
  });

  it("a superseding resolve() aborts the signal of the request it replaces", async () => {
    let calls = 0;
    let firstSignal: AbortSignal | undefined;
    const transport: TestTransport = {
      resolve: (_query, signal) => {
        calls += 1;
        if (calls === 1) {
          firstSignal = signal;
          return new Promise<ResolveResponse>(() => {}); // hangs
        }
        return Promise.resolve(noData);
      },
    };
    const store = createSpecStore(transport);

    store.getState().resolve("first query"); // fire, don't await: it never settles
    expect(firstSignal?.aborted).toBe(false);

    await store.getState().resolve("second query");
    expect(firstSignal?.aborted).toBe(true);
  });

  it("cancel() aborts the in-flight request signal", async () => {
    let calls = 0;
    let signal: AbortSignal | undefined;
    const transport: TestTransport = {
      resolve: (_query, s) => {
        calls += 1;
        if (calls === 1) return Promise.resolve(definiteExact);
        signal = s;
        return new Promise<ResolveResponse>(() => {}); // hangs
      },
    };
    const store = createSpecStore(transport);
    await store.getState().resolve("women in Kenya");

    store.getState().resolve("anything else"); // fire, don't await: it never settles
    expect(signal?.aborted).toBe(false);

    store.getState().cancel();
    expect(signal?.aborted).toBe(true);
  });

  it("undo() during an in-flight edit aborts the pending request signal", async () => {
    let signal: AbortSignal | undefined;
    const transport: TestTransport = {
      resolve: () => Promise.resolve(definiteExact),
      identityEdit: (_identity, _promote, s) => {
        signal = s;
        return new Promise<ResolveResponse>(() => {}); // hangs
      },
    };
    const store = createSpecStore(transport);
    await store.getState().resolve("women in Kenya");

    store.getState().editSlot(0, 0, { kind: "unbound" }); // fire, don't await: it never settles
    expect(signal?.aborted).toBe(false);

    store.getState().undo();
    expect(signal?.aborted).toBe(true);
  });

  it("reset() aborts the in-flight request signal", async () => {
    let signal: AbortSignal | undefined;
    const transport: TestTransport = {
      resolve: (_query, s) => {
        signal = s;
        return new Promise<ResolveResponse>(() => {}); // hangs
      },
    };
    const store = createSpecStore(transport);
    store.getState().resolve("anything"); // fire, don't await: it never settles
    expect(signal?.aborted).toBe(false);

    store.getState().reset();
    expect(signal?.aborted).toBe(true);
  });

  describe("editSlot()/editDonor() with a streaming transport (resubmitDatasetStream)", () => {
    it("commits the moment the response event arrives, before the edit stream ends", async () => {
      const { transport, calls } = manualResubmitStreamTransport();
      const store = createSpecStore(transport);
      await store.getState().resolve("malaria grants to Ethiopia");
      const before = store.getState().parts[0].spec!;
      const whereIndex = before.slots.findIndex((s) => s.key.axis === "where");
      const editedResponse = withEditedSlots(
        before,
        before.slots.map((s, i) =>
          i === whereIndex
            ? {
                ...s,
                binding: {
                  kind: "value",
                  value: {
                    value_kind: "entity",
                    ref: { dcid: "country/KEN", label: "Kenya" },
                  },
                },
              }
            : s,
        ),
      );

      const pending = store.getState().editSlot(0, whereIndex, {
        kind: "value",
        value: {
          value_kind: "entity",
          ref: { dcid: "country/KEN", label: "Kenya" },
        },
      });
      expect(store.getState().editPending).toBe(0);
      expect(store.getState().parts[0].spec?.spec_id).toBe(before.spec_id); // unchanged until the response lands

      calls[0].emit({ kind: "response", response: editedResponse });

      // committed already, while the edit stream promise is still open
      const s = store.getState();
      expect(s.status).toBe("ready");
      expect(s.parts[0].spec?.spec_id).toBe(
        definiteSpec(editedResponse).spec_id,
      );
      expect(s.editPending).toBeNull();
      expect(s.canUndo).toBe(true);

      calls[0].finish();
      await pending;
      expect(store.getState().parts[0].spec?.spec_id).toBe(
        definiteSpec(editedResponse).spec_id,
      );
    });

    it("merges a trailing slot_options event into the committed edit and its history snapshot", async () => {
      const { transport, calls } = manualResubmitStreamTransport();
      const store = createSpecStore(transport);
      await store.getState().resolve("malaria grants to Ethiopia");
      const before = store.getState().parts[0].spec!;
      const whereIndex = before.slots.findIndex((s) => s.key.axis === "where");
      const editedResponse = withEditedSlots(
        before,
        before.slots.map((s, i) =>
          i === whereIndex
            ? {
                ...s,
                binding: {
                  kind: "value",
                  value: {
                    value_kind: "entity",
                    ref: { dcid: "country/NGA", label: "Nigeria" },
                  },
                },
              }
            : s,
        ),
      );

      const pending = store.getState().editSlot(0, whereIndex, {
        kind: "value",
        value: {
          value_kind: "entity",
          ref: { dcid: "country/NGA", label: "Nigeria" },
        },
      });
      calls[0].emit({ kind: "response", response: editedResponse });

      const editedSpec = store.getState().parts[0].spec!;
      const key = editedSpec.slots[0].key;
      calls[0].emit({
        kind: "slot_options",
        spec_id: editedSpec.spec_id,
        key,
        options: [
          {
            value: { value_kind: "entity", ref: { dcid: "x/1", label: "X" } },
            coverage: { kind: "exact", has_data: true, observation_count: 9 },
          },
        ],
        complete: true,
      });

      calls[0].finish();
      await pending;

      const s = store.getState();
      const merged = s.parts[0].spec?.slot_options?.find(
        (so) => so.key.axis === key.axis,
      );
      expect(merged?.options[0]?.coverage).toEqual({
        kind: "exact",
        has_data: true,
        observation_count: 9,
      });
      // undo/redo must see the merged counts too, so the snapshot carries them.
      expect(
        s.history[s.index].parts[0].spec?.slot_options?.find(
          (so) => so.key.axis === key.axis,
        )?.options[0]?.coverage,
      ).toEqual({ kind: "exact", has_data: true, observation_count: 9 });
    });

    it("merges a trailing 'observations' event onto the committed edit and rebuilds the viewModel", async () => {
      const { transport, calls } = manualResubmitStreamTransport();
      const store = createSpecStore(transport);
      await store.getState().resolve("malaria grants to Ethiopia");
      const before = store.getState().parts[0].spec!;

      const editedResponse = withEditedSlots(
        before,
        before.slots.map((s) =>
          s.key.axis === "where"
            ? {
                ...s,
                binding: {
                  kind: "value",
                  value: {
                    value_kind: "entity",
                    ref: { dcid: "country/NGA", label: "Nigeria" },
                  },
                },
              }
            : s,
        ),
      );

      const whereIndex = before.slots.findIndex((s) => s.key.axis === "where");
      const pending = store.getState().editSlot(0, whereIndex, {
        kind: "value",
        value: {
          value_kind: "entity",
          ref: { dcid: "country/NGA", label: "Nigeria" },
        },
      });
      calls[0].emit({ kind: "response", response: editedResponse });

      const specId = store.getState().parts[0].spec!.spec_id;
      const viewModelBefore = store.getState().parts[0].viewModel;
      const observations = {
        series: [
          {
            stat_var_dcid: "sv/1",
            entity_dcid: "country/NGA",
            points: [{ date: "2020", value: 5 }],
            source_refs: [],
          },
        ],
        total_obs: 1,
        complete: true,
      };
      calls[0].emit({ kind: "observations", spec_id: specId, observations });

      calls[0].finish();
      await pending;

      const s = store.getState();
      expect(s.parts[0].spec?.observations).toEqual(observations);
      expect(s.history[s.index].parts[0].spec?.observations).toEqual(
        observations,
      );
      expect(s.parts[0].viewModel).not.toBe(viewModelBefore);
    });

    it("a pre-commit error rolls back to the current result, setting editError (not a run-level error)", async () => {
      const { transport, calls } = manualResubmitStreamTransport();
      const store = createSpecStore(transport);
      await store.getState().resolve("malaria grants to Ethiopia");
      const before = store.getState().parts[0].spec!;

      const pending = store.getState().editSlot(0, 0, { kind: "unbound" });
      expect(store.getState().editPending).toBe(0);

      calls[0].emit({
        kind: "error",
        detail: "edit stream exploded",
        code: null,
      });
      calls[0].finish();
      await pending;

      const s = store.getState();
      expect(s.status).toBe("ready");
      expect(s.error).toBeNull();
      expect(s.parts[0].spec?.spec_id).toBe(before.spec_id); // result untouched
      expect(s.parts[0].editError).toBe("edit stream exploded");
      expect(s.editPending).toBeNull();
    });

    it("a late stream error after the response does not take the edited result away", async () => {
      const { transport, calls } = manualResubmitStreamTransport();
      const store = createSpecStore(transport);
      await store.getState().resolve("malaria grants to Ethiopia");
      const before = store.getState().parts[0].spec!;
      const editedResponse = withEditedSlots(before, before.slots);

      const pending = store.getState().editSlot(0, 0, { kind: "unbound" });
      calls[0].emit({ kind: "response", response: editedResponse });
      calls[0].emit({ kind: "error", detail: "late failure", code: null });
      calls[0].finish();
      await pending;

      const s = store.getState();
      expect(s.status).toBe("ready");
      expect(s.error).toBeNull();
    });

    it("a superseding edit on the SAME part aborts the previous edit-stream signal and drops its late events", async () => {
      const { transport, calls } = manualResubmitStreamTransport();
      const store = createSpecStore(transport);
      await store.getState().resolve("malaria grants to Ethiopia");
      const before = store.getState().parts[0].spec!;
      const whereIndex = before.slots.findIndex((s) => s.key.axis === "where");

      const firstPending = store.getState().editSlot(0, whereIndex, {
        kind: "value",
        value: {
          value_kind: "entity",
          ref: { dcid: "country/KEN", label: "Kenya" },
        },
      });
      expect(calls[0].signal?.aborted).toBe(false);

      const secondPending = store.getState().editSlot(0, whereIndex, {
        kind: "value",
        value: {
          value_kind: "entity",
          ref: { dcid: "country/NGA", label: "Nigeria" },
        },
      }); // supersedes the first (same part index)

      expect(calls[0].signal?.aborted).toBe(true); // the FIRST op's signal, aborted by the second
      expect(calls).toHaveLength(2);

      // the superseded (first) stream's late response must not land
      const staleResponse = withEditedSlots(
        before,
        before.slots.map((s, i) =>
          i === whereIndex
            ? {
                ...s,
                binding: {
                  kind: "value",
                  value: {
                    value_kind: "entity",
                    ref: { dcid: "country/KEN", label: "Kenya" },
                  },
                },
              }
            : s,
        ),
      );
      calls[0].emit({ kind: "response", response: staleResponse }); // dropped: isCurrentEdit(0, op) is false
      calls[0].finish();
      await firstPending; // lets the fenced-off "after the await" check run

      expect(store.getState().parts[0].spec?.spec_id).toBe(before.spec_id); // still pre-edit: the stale commit was dropped
      expect(store.getState().editPending).toBe(0); // the SECOND (current) op is still in flight

      // now the current (second) op's own response lands
      const currentResponse = withEditedSlots(
        before,
        before.slots.map((s, i) =>
          i === whereIndex
            ? {
                ...s,
                binding: {
                  kind: "value",
                  value: {
                    value_kind: "entity",
                    ref: { dcid: "country/NGA", label: "Nigeria" },
                  },
                },
              }
            : s,
        ),
      );
      calls[1].emit({ kind: "response", response: currentResponse });
      calls[1].finish();
      await secondPending;

      const s = store.getState();
      expect(s.parts[0].spec?.spec_id).toBe(
        definiteSpec(currentResponse).spec_id,
      );
      expect(s.editPending).toBeNull();
    });

    it("never writes the resolve cache from the edit path", async () => {
      const { transport, calls } = manualResubmitStreamTransport();
      const store = createSpecStore(transport);
      await store.getState().resolve("malaria grants to Ethiopia");
      const before = store.getState().parts[0].spec!;
      const whereIndex = before.slots.findIndex((s) => s.key.axis === "where");
      const editedResponse = withEditedSlots(
        before,
        before.slots.map((s, i) =>
          i === whereIndex
            ? {
                ...s,
                binding: {
                  kind: "value",
                  value: {
                    value_kind: "entity",
                    ref: { dcid: "country/KEN", label: "Kenya" },
                  },
                },
              }
            : s,
        ),
      );

      const pending = store.getState().editSlot(0, whereIndex, {
        kind: "value",
        value: {
          value_kind: "entity",
          ref: { dcid: "country/KEN", label: "Kenya" },
        },
      });
      calls[0].emit({ kind: "response", response: editedResponse });
      calls[0].finish();
      await pending;
      expect(store.getState().parts[0].spec?.spec_id).toBe(
        definiteSpec(editedResponse).spec_id,
      );

      // a fresh resolve() of the ORIGINAL query must still return the original
      // result, not the edited one -- proving the edit never wrote the cache
      // entry keyed by that query text.
      await store.getState().resolve("malaria grants to Ethiopia");
      expect(store.getState().parts[0].spec?.spec_id).toBe(before.spec_id);
    });

    it("editDonor() also streams via resubmitDatasetStream, committing on the response event", async () => {
      const { transport, calls } = manualResubmitStreamTransport();
      const store = createSpecStore(transport);
      await store.getState().resolve("malaria grants to Ethiopia");
      const before = store.getState().parts[0].spec!;
      const editedResponse = withEditedSlots(before, before.slots);

      const pending = store.getState().editDonor(0, "country/DEU");
      expect(store.getState().editPending).toBe(0);

      calls[0].emit({ kind: "response", response: editedResponse });
      expect(store.getState().editPending).toBeNull();
      expect(store.getState().parts[0].spec?.spec_id).toBe(
        definiteSpec(editedResponse).spec_id,
      );

      calls[0].finish();
      await pending;
    });
  });

  describe("runSpecId()", () => {
    it("resolves an existing spec_id buffered and transitions status loading -> ready", async () => {
      const store = createSpecStore({
        resolve: () => Promise.reject(new Error("unused")),
        resolveSpecId: (specId) => {
          expect(specId).toBe(definiteExactSpec.spec_id);
          return Promise.resolve(definiteExact);
        },
      });

      expect(store.getState().status).toBe("idle");
      const pending = store.getState().runSpecId(definiteExactSpec.spec_id);
      expect(store.getState().status).toBe("loading");
      await pending;

      const s = store.getState();
      expect(s.status).toBe("ready");
      expect(s.parts[0].spec?.spec_id).toBe(definiteExactSpec.spec_id);
      expect(s.parts[0].viewModel?.specId).toBe(definiteExactSpec.spec_id);
      expect(s.queryText).toBe(definiteExact.query_echo.raw_query);
    });

    it("sets queryText to queryHint when provided", async () => {
      const store = createSpecStore({
        resolve: () => Promise.reject(new Error("unused")),
        resolveSpecId: () => Promise.resolve(definiteExact),
      });

      await store
        .getState()
        .runSpecId(definiteExactSpec.spec_id, "custom query hint");

      const s = store.getState();
      expect(s.status).toBe("ready");
      expect(s.queryText).toBe("custom query hint");
    });

    it("streams with resolveSpecIdStream, capturing progress and committing on response event", async () => {
      let onEventCb: (ev: SearchEvent) => void = () => {};
      let settleStream: () => void = () => {};

      const streaming: TestTransport = {
        resolve: () => Promise.reject(new Error("unused")),
        resolveSpecIdStream: (specId, cb) => {
          expect(specId).toBe(definiteBreadthSpec.spec_id);
          onEventCb = cb;
          return new Promise<void>((res) => {
            settleStream = res;
          });
        },
      };

      const store = createSpecStore(streaming);
      const pending = store.getState().runSpecId(definiteBreadthSpec.spec_id);

      expect(store.getState().status).toBe("loading");

      onEventCb({
        kind: "interpretation",
        variables: ["malaria"],
        entities: ["Ethiopia"],
        dates: [],
        expected_results: 1,
      });
      onEventCb({
        kind: "step",
        variable_index: 0,
        step: "materialise",
        ran: true,
        ms: 25,
      });

      expect(store.getState().progress[0]?.variables).toEqual(["malaria"]);
      expect(store.getState().loadingSteps[0]).toEqual(["materialise"]);

      onEventCb({ kind: "response", response: definiteBreadth });

      // Committed on response event before stream settles
      expect(store.getState().status).toBe("ready");
      expect(store.getState().parts[0].spec?.spec_id).toBe(
        definiteBreadthSpec.spec_id,
      );

      settleStream();
      await pending;
      expect(store.getState().status).toBe("ready");
    });

    it("caches result by spec_id and resolves repeat call synchronously", async () => {
      let callCount = 0;
      const store = createSpecStore({
        resolve: () => Promise.reject(new Error("unused")),
        resolveSpecId: () => {
          callCount += 1;
          return Promise.resolve(definiteExact);
        },
      });

      await store.getState().runSpecId(definiteExactSpec.spec_id);
      expect(callCount).toBe(1);

      // Second call with same spec_id hits cache
      await store.getState().runSpecId(definiteExactSpec.spec_id);
      expect(callCount).toBe(1);
      expect(store.getState().status).toBe("ready");
    });

    it("surfaces errors from resolveSpecId and supports retry()", async () => {
      let attempts = 0;
      const store = createSpecStore({
        resolve: () => Promise.reject(new Error("unused")),
        resolveSpecId: () => {
          attempts += 1;
          if (attempts === 1) {
            return Promise.reject(new Error("Failed to fetch spec"));
          }
          return Promise.resolve(definiteExact);
        },
      });

      await store.getState().runSpecId(definiteExactSpec.spec_id);
      expect(store.getState().status).toBe("error");
      expect(store.getState().error).toBe("Failed to fetch spec");

      await store.getState().retry();
      expect(store.getState().status).toBe("ready");
      expect(store.getState().parts[0].spec?.spec_id).toBe(
        definiteExactSpec.spec_id,
      );
    });
  });

  // POST /api/search/resolve sends a `parts[]` envelope; the store reads it
  // natively via partAt/patchPartSpec (lib/contract/parts), with no flat
  // top-level shape to fall back to. These tests confirm the store reaches
  // into a live-capture-derived body correctly through the streaming
  // `response` event path, the same path production uses, not just through
  // normalizeResponse directly.
  describe("parts[] envelope", () => {
    it("resolve() streams a parts[]-envelope definite response and commits it", async () => {
      const streaming: TestTransport = {
        resolve: () =>
          Promise.reject(new Error("resolve not used in this test")),
        resolveStream: async (_query, onEvent) => {
          onEvent({ kind: "response", response: partsDefiniteKenya });
        },
      };
      const store = createSpecStore(streaming);
      await store.getState().resolve("population of Kenya");

      const s = store.getState();
      expect(s.status).toBe("ready");
      expect(s.parts).toHaveLength(1);
      expect(s.parts[0].part?.status).toBe("definite");
      expect(s.parts[0].spec?.spec_id).toBe(
        "spec_567bf6828e3cc23c7d70e121cc36f2f9",
      );
      expect(s.parts[0].viewModel).not.toBeNull();
    });

    it("resolve() streams a parts[]-envelope candidates response and commits it", async () => {
      const streaming: TestTransport = {
        resolve: () =>
          Promise.reject(new Error("resolve not used in this test")),
        resolveStream: async (_query, onEvent) => {
          onEvent({ kind: "response", response: partsCandidatesNigeria });
        },
      };
      const store = createSpecStore(streaming);
      await store.getState().resolve("GDP of Nigeria");

      const s = store.getState();
      expect(s.status).toBe("ready");
      const part = partAt(s.response!, 0);
      expect(part?.status).toBe("candidates");
      if (part?.status !== "candidates") throw new Error("expected candidates");
      expect(part.candidates.specs.map((sp) => sp.spec_id)).toEqual([
        "spec_a35f69fce32d7ed22e538ca57a901d13",
        "spec_c3d30c25c63e6a26f77d77b908526edd",
      ]);
      // The wire carries no candidates-level sentences array: each candidate
      // spec's own confirmation sentence is lifted onto it by normalizeSpec,
      // same as a definite spec's.
      expect(part.candidates.specs[0].rendered_sentence).toBe(
        "Nominal gross domestic product in Nigeria, 1960 to 2024, according to World Development Indicators.",
      );
      expect(part.candidates.specs[1].rendered_sentence).toBe(
        "Nominal gross domestic product per capita in Nigeria, 1960 to 2024, according to World Development Indicators. This is a loose match for your query.",
      );
    });

    it("editSlot() commits a parts[]-envelope single-part response with no rollback notice", async () => {
      const { transport, calls } = manualResubmitStreamTransport();
      const store = createSpecStore(transport);
      await store.getState().resolve("women in Kenya");

      const pending = store.getState().editSlot(0, 0, {
        kind: "value",
        value: {
          value_kind: "entity",
          ref: { dcid: "country/KEN", label: "Kenya" },
        },
      });
      // A single-part parts[]-envelope body, as an edit response would arrive.
      calls[0].emit({ kind: "response", response: partsDefiniteKenya });
      calls[0].finish();
      await pending;

      const s = store.getState();
      expect(s.status).toBe("ready");
      expect(s.parts[0].spec?.spec_id).toBe(
        "spec_567bf6828e3cc23c7d70e121cc36f2f9",
      );
      expect(s.parts[0].editError).toBeNull();
    });

    it("re-running normalizeResponse on an already-normalized response is idempotent", async () => {
      // Mirrors production: resolveStream's SSE parser (searchClient.ts)
      // already runs normalizeResponse on the response event before the
      // store's own fromResponse normalizes it again. There's no flat/parts
      // branch to lose data across the second pass -- normalizeResponse
      // always maps parts -> parts, so running it twice is a no-op.
      const alreadyNormalized = normalizeResponse(partsDefiniteKenya);
      expect(definiteSpec(alreadyNormalized).spec_id).toBe(
        "spec_567bf6828e3cc23c7d70e121cc36f2f9",
      );

      const streaming: TestTransport = {
        resolve: () =>
          Promise.reject(new Error("resolve not used in this test")),
        resolveStream: async (_query, onEvent) => {
          onEvent({ kind: "response", response: alreadyNormalized });
        },
      };
      const store = createSpecStore(streaming);
      await store.getState().resolve("population of Kenya");

      const s = store.getState();
      expect(s.status).toBe("ready");
      expect(s.parts[0].spec?.spec_id).toBe(
        "spec_567bf6828e3cc23c7d70e121cc36f2f9",
      );
      expect(definiteSpec(s.response!).spec_id).toBe(
        "spec_567bf6828e3cc23c7d70e121cc36f2f9",
      );
    });

    // An `unsupported` part does not drive the whole store to the run-level
    // `error` state -- the run succeeded (the engine answered); this one
    // part's own outcome is "unsupported". The run-level status is "ready";
    // the detail lives on that part.
    it("resolve() of an unsupported part is a ready run with the unsupported detail on that part", async () => {
      const unsupportedResponse: ResolveResponse = {
        schema_version: "1.0",
        status: "unsupported",
        query_echo: echo({ raw_query: "convert Kenya to donuts" }),
        diagnostics: diagnostics(),
        parts: [
          {
            status: "unsupported",
            variable_text: "donuts",
            warnings: [],
            unsupported: {
              code: "unsupported_ask",
              detail: "The engine cannot model this ask.",
            },
          },
        ],
      };
      const streaming: TestTransport = {
        resolve: () =>
          Promise.reject(new Error("resolve not used in this test")),
        resolveStream: async (_query, onEvent) => {
          onEvent({ kind: "response", response: unsupportedResponse });
        },
      };
      const store = createSpecStore(streaming);
      await store.getState().resolve("convert Kenya to donuts");

      const s = store.getState();
      expect(s.status).toBe("ready");
      expect(s.error).toBeNull();
      expect(s.parts[0].part?.status).toBe("unsupported");
      expect(
        s.parts[0].part?.status === "unsupported"
          ? s.parts[0].part.unsupported.detail
          : null,
      ).toBe("The engine cannot model this ask.");
      expect(s.parts[0].spec).toBeNull();
      expect(s.parts[0].viewModel).toBeNull();
    });

    it("resolve() of an unsupported part with no detail falls back to the code, still a ready run", async () => {
      const unsupportedResponse: ResolveResponse = {
        schema_version: "1.0",
        status: "unsupported",
        query_echo: echo({ raw_query: "convert Kenya to donuts" }),
        diagnostics: diagnostics(),
        parts: [
          {
            status: "unsupported",
            variable_text: "donuts",
            warnings: [],
            unsupported: { code: "unsupported_ask" },
          },
        ],
      };
      const streaming: TestTransport = {
        resolve: () =>
          Promise.reject(new Error("resolve not used in this test")),
        resolveStream: async (_query, onEvent) => {
          onEvent({ kind: "response", response: unsupportedResponse });
        },
      };
      const store = createSpecStore(streaming);
      await store.getState().resolve("convert Kenya to donuts");

      const s = store.getState();
      expect(s.status).toBe("ready");
      expect(
        s.parts[0].part?.status === "unsupported"
          ? s.parts[0].part.unsupported.code
          : null,
      ).toBe("unsupported_ask");
    });

    it("resolve() of a response with an empty parts[] takes the run-level no-parts fallback", async () => {
      const emptyPartsResponse: ResolveResponse = {
        schema_version: "1.0",
        status: "definite",
        query_echo: echo({ raw_query: "nothing to see here" }),
        diagnostics: diagnostics(),
        parts: [],
      };
      const streaming: TestTransport = {
        resolve: () =>
          Promise.reject(new Error("resolve not used in this test")),
        resolveStream: async (_query, onEvent) => {
          onEvent({ kind: "response", response: emptyPartsResponse });
        },
      };
      const store = createSpecStore(streaming);
      await store.getState().resolve("nothing to see here");

      const s = store.getState();
      expect(s.status).toBe("error");
      expect(s.error).toBe("The response carried no parts.");
      expect(s.parts).toEqual([]);
    });

    // --- Multi-part behavior: splice, envelope status, per-part concurrency ---

    it("resolve() of a real two-part 'mixed' capture renders both parts in order", async () => {
      const streaming: TestTransport = {
        resolve: () =>
          Promise.reject(new Error("resolve not used in this test")),
        resolveStream: async (_query, onEvent) => {
          onEvent({
            kind: "interpretation",
            variables: ["population", "GDP"],
            entities: ["Brazil"],
            dates: [],
            expected_results: 2,
          });
          onEvent({ kind: "response", response: partsMixedBrazil });
        },
      };
      const store = createSpecStore(streaming);
      await store.getState().resolve("population and GDP in Brazil");

      const s = store.getState();
      expect(s.status).toBe("ready");
      expect(s.parts).toHaveLength(2);
      expect(s.parts[0].part?.status).toBe("definite");
      expect(s.parts[0].variableText).toBe("population");
      expect(s.parts[1].part?.status).toBe("candidates");
      expect(s.parts[1].variableText).toBe("GDP");
      expect(s.response?.status).toBe("mixed");
    });

    it("chooseSpec() on part 1 posts every part's own current identity and replaces the whole envelope, recomposing the envelope status", async () => {
      // Every dataset_resubmit re-resolves every part, not just the edited
      // one: the mock below returns a full 2-part envelope, part 0 built
      // from its OWN unedited spec (the fixture's own population spec,
      // proving the pick never had to touch it) and part 1 the promoted
      // candidate.
      const mixed = normalizeResponse(partsMixedBrazil);
      const population = definiteSpec(mixed, 0);
      const chosen = (() => {
        const p1 = partAt(mixed, 1);
        if (p1?.status !== "candidates") throw new Error("expected candidates");
        return p1.candidates.specs[0];
      })();
      let capturedEntries: DatasetResubmitEntry[] | undefined;
      const store = createSpecStore({
        resolve: () => Promise.resolve(mixed),
        resubmitDataset: (entries) => {
          capturedEntries = entries;
          return Promise.resolve({
            schema_version: "1.0",
            status: "definite",
            query_echo: {
              entry_path: "dataset_resubmit",
              variable_text: [],
              extract_skipped: true,
            },
            diagnostics: { engine_build: "test", warnings: [] },
            parts: [
              {
                status: "definite",
                spec: population,
                variable_text: "population",
                warnings: [],
              },
              {
                status: "definite",
                spec: chosen,
                variable_text: "GDP",
                warnings: [],
              },
            ],
          });
        },
      });
      await store.getState().resolve("population and GDP in Brazil");
      expect(store.getState().response?.status).toBe("mixed");

      // Promote the first GDP candidate -- resolving to definite should flip
      // the envelope's own computed status from "mixed" to "definite".
      await store.getState().chooseSpec(1, chosen);

      // Both parts posted, in order: part 0's own current identity carried
      // forward unedited, part 1 the pick (identity === base_identity).
      expect(capturedEntries).toHaveLength(2);
      expect(capturedEntries?.[0].entry_kind).toBe("identity");
      if (capturedEntries?.[0].entry_kind !== "identity")
        throw new Error("expected identity");
      expect(capturedEntries[0].identity).toEqual(
        population.definition?.identity,
      );
      expect(capturedEntries?.[1].entry_kind).toBe("identity");
      if (capturedEntries?.[1].entry_kind !== "identity")
        throw new Error("expected identity");
      expect(capturedEntries[1].identity).toEqual(chosen.definition?.identity);
      expect(capturedEntries[1].base_identity).toEqual(
        chosen.definition?.identity,
      );

      const s = store.getState();
      expect(s.parts[1].part?.status).toBe("definite");
      expect(s.parts[1].spec?.spec_id).toBe(chosen.spec_id);
      expect(s.parts[1].variableText).toBe("GDP");
      // part 0's own spec_id is unchanged -- the whole-envelope replace still
      // re-resolved it to the SAME identity it already had.
      expect(s.parts[0].spec?.spec_id).toBe(population.spec_id);
      expect(s.response?.status).toBe("definite");
    });

    // --- refineText: free-text phrase refine, scoped to one part ---

    it("refineText() on part 1 of partsMixedBrazil leaves part 0 untouched", async () => {
      // The candidate the refine "resolves" to, known statically from the
      // fixture -- a refine is a raw_text resolve, so the mock resolve()
      // below just needs to return a plausible single-part definite answer
      // for the refined text: refineText never posts through the dataset
      // door, so this test's `identityEdit` double is never reached.
      const chosen = (() => {
        const p1 = partAt(normalizeResponse(partsMixedBrazil), 1);
        if (p1?.status !== "candidates") throw new Error("expected candidates");
        return p1.candidates.specs[0];
      })();
      const store = createSpecStore({
        resolve: (query) =>
          query === "population and GDP in Brazil"
            ? Promise.resolve(normalizeResponse(partsMixedBrazil))
            : Promise.resolve(
                definite(
                  chosen,
                  echo({ raw_query: query, variable_text: ["nominal GDP"] }),
                ),
              ),
      });
      await store.getState().resolve("population and GDP in Brazil");
      const part0Before = store.getState().parts[0];
      expect(store.getState().response?.status).toBe("mixed");

      await store.getState().refineText(1, "nominal GDP in Brazil");

      const s = store.getState();
      expect(s.parts[1].part?.status).toBe("definite");
      expect(s.parts[1].spec?.spec_id).toBe(chosen.spec_id);
      // A refine's returned part keeps its OWN variable_text -- a raw_text
      // run supplies it directly, so there's nothing to restore from the
      // part it replaced.
      expect(s.parts[1].variableText).toBe("nominal GDP");
      // part 0 is a completely untouched object -- proof the splice never
      // rebuilt sibling parts.
      expect(s.parts[0]).toBe(part0Before);
      expect(s.response?.status).toBe("definite");
      expect(s.parts[1].editError).toBeNull();
    });

    it("refineText() returning two parts grows parts[] in place at that index", async () => {
      const store = createSpecStore({
        resolve: (query) =>
          query === "population and GDP in Brazil"
            ? Promise.resolve(normalizeResponse(partsMixedBrazil))
            : Promise.resolve(normalizeResponse(partsTwoDefiniteKenya)),
      });
      await store.getState().resolve("population and GDP in Brazil");
      const part0Before = store.getState().parts[0];
      expect(store.getState().parts).toHaveLength(2);

      // Refine part 1 (GDP candidates) into free text that happens to
      // resolve to a genuinely two-variable answer -- exercising the splice
      // mechanics (a raw_text resolve can return more than one part), not a
      // realistic query.
      await store.getState().refineText(1, "population and total population");

      const s = store.getState();
      expect(s.parts).toHaveLength(3);
      // part 0 is untouched.
      expect(s.parts[0]).toBe(part0Before);
      // The two returned parts land at index 1 and 2, in order, each with
      // its own variable_text and spec_id.
      expect(s.parts[1].part?.status).toBe("definite");
      expect(s.parts[1].variableText).toBe("population");
      expect(s.parts[2].part?.status).toBe("definite");
      expect(s.parts[2].variableText).toBe("total population");
      // Every part now agrees, so the envelope status recomputes to "definite".
      expect(s.response?.status).toBe("definite");
      expect(s.response?.parts).toHaveLength(3);
    });

    it("a rejected refineText (no_data) sets editError only on its own part, leaving the sibling and the response untouched", async () => {
      const store = createSpecStore({
        resolve: (query) =>
          query === "population and GDP in Brazil"
            ? Promise.resolve(normalizeResponse(partsMixedBrazil))
            : Promise.resolve(noData),
      });
      await store.getState().resolve("population and GDP in Brazil");
      const responseBefore = store.getState().response;
      const part1Before = store.getState().parts[1];

      // Refine part 0 (population) into text that resolves to no_data.
      await store.getState().refineText(0, "GDP of Atlantis");

      const s = store.getState();
      expect(s.parts[0].editError).toBe(
        "No data for that change. Keeping the previous result.",
      );
      // The block keeps its previous, working content -- never spliced.
      expect(s.parts[0].part?.status).toBe("definite");
      expect(s.parts).toHaveLength(2);
      // The sibling part is a completely untouched object.
      expect(s.parts[1]).toBe(part1Before);
      expect(s.parts[1].editError).toBeNull();
      // No commit happened -- the response is the same object as before.
      expect(s.response).toBe(responseBefore);
    });

    // A dataset_resubmit always resubmits the whole envelope together, so
    // there is exactly ONE dataset-edit post in flight at a time, whichever
    // part(s) it targets. Starting a second edit before the first lands
    // ABORTS the first, but builds its own entries[] from what the first one
    // already posted, so the first edit's change carries forward rather than
    // getting lost -- "concurrent edits carry the first forward".
    it("a second dataset edit starting before the first lands builds on the first's own in-flight entries, carrying it forward", async () => {
      const releases: Record<number, (r: ResolveResponse) => void> = {};
      let resubmitCalls = 0;
      const capturedEntries: DatasetResubmitEntry[][] = [];
      const mixed = normalizeResponse(partsMixedBrazil);
      const gdpCandidate = (() => {
        const p1 = partAt(mixed, 1);
        if (p1?.status !== "candidates") throw new Error("expected candidates");
        return p1.candidates.specs[0];
      })();
      const store = createSpecStore({
        resolve: () => Promise.resolve(mixed),
        resubmitDataset: (entries) => {
          capturedEntries.push(entries);
          return new Promise<ResolveResponse>((resolve) => {
            releases[resubmitCalls] = resolve;
            resubmitCalls += 1;
          });
        },
      });
      await store.getState().resolve("population and GDP in Brazil");

      // Start an edit on part 0 (population), then, before it resolves,
      // start an edit on part 1 (GDP candidate promote): the second aborts
      // the first's controller.
      const pending0 = store.getState().editSlot(0, 0, { kind: "unbound" });
      const pending1 = store.getState().chooseSpec(1, gdpCandidate);
      expect(store.getState().editPending).toBe(1); // most-recently-started edit

      expect(capturedEntries).toHaveLength(2);
      // The second post's part-0 entry is the exact object the first post
      // sent for part 0 -- carried forward, not rebuilt from the (stale)
      // committed `parts`, which would have silently dropped this edit.
      expect(capturedEntries[1][0]).toBe(capturedEntries[0][0]);
      expect(capturedEntries[1][1].entry_kind).toBe("identity");

      // The FIRST (now-superseded) post's late arrival must not land.
      releases[0](mixed);
      await pending0;
      expect(store.getState().parts[1].part?.status).toBe("candidates"); // untouched by the stale response

      // The SECOND (current) post's response carries BOTH edits at once,
      // since every dataset_resubmit answers with the full envelope.
      const editedPopulation: Spec = {
        ...definiteSpec(mixed, 0),
        spec_id: "spec_population_edited",
      };
      releases[1]({
        schema_version: "1.0",
        status: "definite",
        query_echo: {
          entry_path: "dataset_resubmit",
          variable_text: [],
          extract_skipped: true,
        },
        diagnostics: { engine_build: "test", warnings: [] },
        parts: [
          {
            status: "definite",
            spec: editedPopulation,
            variable_text: "population",
            warnings: [],
          },
          {
            status: "definite",
            spec: gdpCandidate,
            variable_text: "GDP",
            warnings: [],
          },
        ],
      });
      await pending1;

      const s = store.getState();
      expect(s.parts[0].spec?.spec_id).toBe("spec_population_edited");
      expect(s.parts[1].spec?.spec_id).toBe(gdpCandidate.spec_id);
    });

    it("starting a new dataset edit aborts whatever dataset post is still in flight, whichever part(s) it targeted", async () => {
      let firstSignal: AbortSignal | undefined;
      let secondSignal: AbortSignal | undefined;
      let call = 0;
      const mixed = normalizeResponse(partsMixedBrazil);
      const gdpCandidate = (() => {
        const p1 = partAt(mixed, 1);
        if (p1?.status !== "candidates") throw new Error("expected candidates");
        return p1.candidates.specs[0];
      })();
      const store = createSpecStore({
        resolve: () => Promise.resolve(mixed),
        resubmitDataset: (_entries, _rawQuery, signal) => {
          call += 1;
          if (call === 1) firstSignal = signal;
          else secondSignal = signal;
          return new Promise<ResolveResponse>(() => {}); // every call hangs
        },
      });
      await store.getState().resolve("population and GDP in Brazil");

      store.getState().editSlot(0, 0, { kind: "unbound" }); // part 0's edit: hangs
      expect(firstSignal?.aborted).toBe(false);

      store.getState().chooseSpec(1, gdpCandidate); // a DIFFERENT part -- still aborts the first
      expect(firstSignal?.aborted).toBe(true);
      expect(secondSignal?.aborted).toBe(false);
    });

    // editPending is shared mutable state, but it's written by two independent
    // lanes: the dataset door (this op) and refineText's own per-part fencing.
    // A dataset op's completion must only clear editPending when the value is
    // one of ITS OWN targets, never a sibling refine's -- otherwise a dataset
    // edit settling on one part can wipe the "Updating..." affordance for an
    // unrelated refine still running on a different part.
    it("a dataset edit settling on part 0 does not clear editPending for a refine still in flight on part 1", async () => {
      const mixed = normalizeResponse(partsMixedBrazil);
      let releaseDataset!: (r: ResolveResponse) => void;
      const store = createSpecStore({
        resolve: (query) =>
          query === "population and GDP in Brazil"
            ? Promise.resolve(mixed)
            : new Promise<ResolveResponse>(() => {}), // the refine's own raw_text resolve hangs
        resubmitDataset: () =>
          new Promise<ResolveResponse>((resolve) => {
            releaseDataset = resolve;
          }),
      });
      await store.getState().resolve("population and GDP in Brazil");

      // Start a dataset-door edit on part 0 only -- editPending names it.
      const pendingEdit = store.getState().editSlot(0, 0, { kind: "unbound" });
      expect(store.getState().editPending).toBe(0);

      // Before that edit lands, start a refine on a DIFFERENT part (1):
      // refineText's own fencing takes editPending over for its own target.
      store.getState().refineText(1, "nominal GDP in Brazil"); // fire, don't await: its own resolve() hangs
      expect(store.getState().editPending).toBe(1);

      // The dataset edit on part 0 now settles. Its own target was just [0],
      // so it must not steal editPending back from the still-running refine.
      releaseDataset(mixed);
      await pendingEdit;
      expect(store.getState().editPending).toBe(1);
    });

    it("a rejected dataset edit sets editError only on the part(s) the edit targeted, leaving a sibling clean", async () => {
      const store = createSpecStore({
        resolve: () => Promise.resolve(normalizeResponse(partsMixedBrazil)),
        resubmitDataset: () => Promise.reject(new Error("edit failed")),
      });
      await store.getState().resolve("population and GDP in Brazil");

      await store.getState().editSlot(0, 0, { kind: "unbound" });

      const s = store.getState();
      expect(s.parts[0].editError).toBe("edit failed");
      expect(s.parts[1].editError).toBeNull();
      // the rejected edit never touched the run-level state either.
      expect(s.status).toBe("ready");
      expect(s.error).toBeNull();
    });

    it("trailing options for a candidate spec inside a candidates part are merged by patchPartSpec searching candidates.specs", async () => {
      const { transport, emit, finish } = manualStreamTransport(
        normalizeResponse(partsMixedBrazil),
      );
      const store = createSpecStore(transport);
      const pending = store.getState().resolve("population and GDP in Brazil");
      emit({ kind: "response", response: partsMixedBrazil });

      const candidateSpecId = "spec_1a8485775cfd3807f9eb3884499aec9e"; // partsMixedBrazil's parts[1].candidates.specs[0]
      emit({
        kind: "facet_options",
        spec_id: candidateSpecId,
        axis: "unit",
        options: [
          {
            value: {
              value_kind: "enum_value",
              ref: { dcid: "USDollar", label: "US Dollar" },
            },
            coverage: null,
          },
        ],
        truncated: false,
      });

      finish();
      await pending;

      const s = store.getState();
      const part1 = s.parts[1].part;
      if (part1?.status !== "candidates")
        throw new Error("expected candidates");
      const merged = part1.candidates.specs.find(
        (sp) => sp.spec_id === candidateSpecId,
      );
      expect(
        merged?.facet_options?.find((fo) => fo.axis === "unit")?.options[0]
          ?.value?.ref?.dcid,
      ).toBe("USDollar");
      // part 0 (a different part entirely) is untouched.
      expect(s.parts[0].spec?.spec_id).not.toBe(candidateSpecId);
    });

    // Trailing events merge by spec_id across the WHOLE envelope, not scoped
    // to the edit's own target part: every dataset_resubmit re-resolves
    // every part, including the one(s) the caller didn't touch, and those
    // re-resolved specs need their own trailing coverage/observations
    // exactly like the edited one does.
    it("a dataset edit's trailing events search every part, not just the one it targeted", async () => {
      const { transport, calls } = manualResubmitStreamTransport();
      const mixed = normalizeResponse(partsMixedBrazil);
      const streamingSeed: TestTransport = {
        ...transport,
        resolveStream: async (_q, onEvent) => {
          onEvent({ kind: "response", response: partsMixedBrazil });
        },
      };
      const store = createSpecStore(streamingSeed);
      await store.getState().resolve("population and GDP in Brazil");

      const gdpPart = partAt(mixed, 1);
      if (gdpPart?.status !== "candidates")
        throw new Error("expected candidates");
      const gdpCandidateSpecId = gdpPart.candidates.specs[0].spec_id;

      // Edit part 0 only; the response re-echoes part 1's candidates
      // verbatim (unedited by this post). A trailing facet_options event
      // keyed to a GDP candidate's spec_id -- a sibling this edit never
      // targeted -- must still land, proving the merge isn't scoped to the
      // edit's own index.
      const pending = store.getState().editSlot(0, 0, { kind: "unbound" });
      calls[0].emit({ kind: "response", response: partsMixedBrazil });

      calls[0].emit({
        kind: "facet_options",
        spec_id: gdpCandidateSpecId,
        axis: "unit",
        options: [
          {
            value: {
              value_kind: "enum_value",
              ref: { dcid: "USDollar", label: "US Dollar" },
            },
            coverage: null,
          },
        ],
        truncated: false,
      });
      calls[0].finish();
      await pending;

      const s = store.getState();
      const part1 = s.parts[1].part;
      if (part1?.status !== "candidates")
        throw new Error("expected candidates");
      const merged = part1.candidates.specs.find(
        (sp) => sp.spec_id === gdpCandidateSpecId,
      );
      expect(
        merged?.facet_options?.find((fo) => fo.axis === "unit")?.options[0]
          ?.value?.ref?.dcid,
      ).toBe("USDollar");
    });

    it("a real two-definite-part capture (population and total population in Kenya) renders two independent blocks with distinct spec_ids", async () => {
      const streaming: TestTransport = {
        resolve: () =>
          Promise.reject(new Error("resolve not used in this test")),
        resolveStream: async (_query, onEvent) => {
          onEvent({ kind: "response", response: partsTwoDefiniteKenya });
        },
      };
      const store = createSpecStore(streaming);
      await store
        .getState()
        .resolve("population and total population in Kenya");

      const s = store.getState();
      expect(s.status).toBe("ready");
      expect(s.response?.status).toBe("definite"); // both parts agree
      expect(s.parts).toHaveLength(2);
      expect(s.parts[0].part?.status).toBe("definite");
      expect(s.parts[1].part?.status).toBe("definite");
      // The deployed engine keeps these two separate: distinct spec_ids, no
      // binding_folded warning on either part.
      expect(s.parts[0].spec?.spec_id).not.toBe(s.parts[1].spec?.spec_id);
      expect(s.parts[1].part?.warnings ?? []).not.toContainEqual(
        expect.objectContaining({ code: "binding_folded" }),
      );
    });

    it("a raw-text run replaces the whole envelope, including a previously-edited part", async () => {
      const store = createSpecStore({
        resolve: (query) =>
          query === "women in Kenya"
            ? Promise.resolve(definiteExact)
            : Promise.resolve(normalizeResponse(partsMixedTwoVariable)),
        identityEdit: (identity) =>
          Promise.resolve(
            withEditedIdentity(
              definiteSpec(normalizeResponse(partsMixedTwoVariable), 0),
              identity,
            ),
          ),
      });
      await store.getState().resolve("population of Kenya and GDP of Nigeria");
      await store.getState().editSlot(0, 0, { kind: "unbound" });
      expect(store.getState().parts).toHaveLength(2);

      // A fresh raw-text run of a single-part query replaces the whole
      // envelope.
      await store.getState().resolve("women in Kenya");
      expect(store.getState().parts).toHaveLength(1);
      expect(store.getState().parts[0].spec?.spec_id).toBe(
        definiteExactSpec.spec_id,
      );
    });

    // --- commitDataset: part_restated swap-back vs. length-mismatch take-whole ---

    it("commitDataset swaps a part_restated stub back for the client's own richer copy of that part, by index", async () => {
      const initialResponse: ResolveResponse = {
        schema_version: definiteExact.schema_version,
        status: "mixed",
        query_echo: echo({
          raw_query: "women in Kenya and inflation in Atlantis",
          variable_text: ["women in Kenya", "inflation in Atlantis"],
        }),
        diagnostics: diagnostics(),
        parts: [definiteExact.parts[0], noData.parts[0]],
      };
      // The dataset_resubmit answer for a placeholder entry (the no_data
      // part held its position rather than being re-evaluated): a stub with
      // no data of its own, marked `part_restated`, and (deliberately) a
      // DIFFERENT no_data reason than the client's stored copy, so a passing
      // assertion below can only mean the swap-back happened, not a
      // coincidental match.
      const editedResponse: ResolveResponse = {
        schema_version: definiteExact.schema_version,
        status: "mixed",
        query_echo: {
          entry_path: "dataset_resubmit",
          variable_text: [],
          extract_skipped: true,
        },
        diagnostics: diagnostics(),
        parts: [
          {
            status: "definite",
            variable_text: "women in Kenya",
            warnings: [],
            timing_ms: null,
            rendered_sentence: null,
            sentence_plan: null,
            spec: definiteBreadthSpec,
          },
          {
            status: "no_data",
            variable_text: "inflation in Atlantis",
            warnings: [
              { code: "part_restated", severity: "info", message: "stub" },
            ],
            timing_ms: null,
            rendered_sentence: null,
            sentence_plan: null,
            no_data: { reason: "no_observations" },
          },
        ],
      };
      const store = createSpecStore({
        resolve: () => Promise.resolve(initialResponse),
        resubmitDataset: () => Promise.resolve(editedResponse),
      });
      await store
        .getState()
        .resolve("women in Kenya and inflation in Atlantis");
      const priorPart1 = store.getState().parts[1].part;

      await store.getState().editSlot(0, 0, { kind: "unbound" });

      const s = store.getState();
      expect(s.parts).toHaveLength(2);
      // The edit's own response landed on part 0.
      expect(s.parts[0].spec?.spec_id).toBe(definiteBreadthSpec.spec_id);
      // Part 1 carried `part_restated`: the client's own stored copy is kept
      // (same content as before the edit), not the stub's "no_observations".
      expect(s.parts[1].part).toEqual(priorPart1);
      expect(
        s.parts[1].part?.status === "no_data"
          ? s.parts[1].part.no_data.reason
          : null,
      ).toBe("entity_not_resolved");
      expect(s.response?.parts[1]).toEqual(priorPart1);
    });

    it("commitDataset takes a length-mismatched dataset_resubmit response whole, without attempting a part_restated swap-back", async () => {
      const initialResponse: ResolveResponse = {
        schema_version: definiteExact.schema_version,
        status: "mixed",
        query_echo: echo({
          raw_query: "women in Kenya and inflation in Atlantis",
          variable_text: ["women in Kenya", "inflation in Atlantis"],
        }),
        diagnostics: diagnostics(),
        parts: [definiteExact.parts[0], noData.parts[0]],
      };
      // A single-part answer to a 2-entry post (e.g. a fold collapsing the
      // envelope). Its one part even carries `part_restated`, but a length
      // mismatch means there's no index alignment to swap against -- the
      // response is taken whole rather than guessed at.
      const mismatchedResponse: ResolveResponse = {
        schema_version: definiteExact.schema_version,
        status: "definite",
        query_echo: {
          entry_path: "dataset_resubmit",
          variable_text: [],
          extract_skipped: true,
        },
        diagnostics: diagnostics(),
        parts: [
          {
            status: "definite",
            variable_text: "women in Kenya",
            warnings: [
              { code: "part_restated", severity: "info", message: "stub" },
            ],
            timing_ms: null,
            rendered_sentence: null,
            sentence_plan: null,
            spec: definiteBreadthSpec,
          },
        ],
      };
      const store = createSpecStore({
        resolve: () => Promise.resolve(initialResponse),
        resubmitDataset: () => Promise.resolve(mismatchedResponse),
      });
      await store
        .getState()
        .resolve("women in Kenya and inflation in Atlantis");

      await store.getState().editSlot(0, 0, { kind: "unbound" });

      const s = store.getState();
      // Taken whole: one part, not aligned back to the 2 posted entries.
      expect(s.parts).toHaveLength(1);
      expect(s.parts[0].spec?.spec_id).toBe(definiteBreadthSpec.spec_id);
      // No swap-back attempted despite `part_restated` -- the warning rides
      // straight through from the response taken whole.
      expect(s.parts[0].part?.warnings).toContainEqual(
        expect.objectContaining({ code: "part_restated" }),
      );
      expect(s.response?.parts).toHaveLength(1);
    });
  });

  describe("editShared()", () => {
    // editShared posts ONE dataset_resubmit covering every part, rather than
    // N parallel spec_resubmit calls folded into one commit.
    it("rewrites a where edit into every definite part's own identity, in one dataset_resubmit post", async () => {
      const twoDefinite = normalizeResponse(partsTwoDefiniteKenya);
      const base0 = definiteSpec(twoDefinite, 0);
      const base1 = definiteSpec(twoDefinite, 1);
      let capturedEntries: DatasetResubmitEntry[] | undefined;
      const store = createSpecStore({
        resolve: () => Promise.reject(new Error("resolve not used")),
        resubmitDataset: (entries) => {
          capturedEntries = entries;
          return Promise.resolve({
            schema_version: "1.0",
            status: "definite",
            query_echo: {
              entry_path: "dataset_resubmit",
              variable_text: [],
              extract_skipped: true,
            },
            diagnostics: { engine_build: "test", warnings: [] },
            parts: [
              {
                status: "definite",
                spec: {
                  ...base0,
                  entities: [
                    {
                      ...base0.entities[0],
                      ref: { dcid: "country/NGA", label: "Nigeria" },
                    },
                  ],
                },
                variable_text: "population",
                warnings: [],
              },
              {
                status: "definite",
                spec: {
                  ...base1,
                  entities: [
                    {
                      ...base1.entities[0],
                      ref: { dcid: "country/NGA", label: "Nigeria" },
                    },
                  ],
                },
                variable_text: "total population",
                warnings: [],
              },
            ],
          });
        },
        resolveStream: async (_query, onEvent) => {
          onEvent({ kind: "response", response: partsTwoDefiniteKenya });
        },
      });
      await store
        .getState()
        .resolve("population and total population in Kenya");
      expect(store.getState().parts).toHaveLength(2);
      expect(store.getState().history).toHaveLength(1);

      await store.getState().editShared({
        axis: "where",
        binding: {
          kind: "value",
          value: {
            value_kind: "entity",
            ref: { dcid: "country/NGA", label: "Nigeria" },
          },
        },
      });

      // One post, both parts' identities rewritten on the same axis, each
      // keeping its OWN base -- not one part's base reused for the other.
      expect(capturedEntries).toHaveLength(2);
      for (const entry of capturedEntries ?? []) {
        if (entry.entry_kind !== "identity")
          throw new Error("expected identity");
        expect(entry.identity.entities.observationAbout).toEqual([
          "country/NGA",
        ]);
      }
      const [entry0, entry1] = capturedEntries ?? [];
      if (entry0.entry_kind !== "identity" || entry1.entry_kind !== "identity")
        throw new Error("expected identity entries");
      expect(entry0.base_spec_id).toBe(base0.spec_id);
      expect(entry1.base_spec_id).toBe(base1.spec_id);

      const s = store.getState();
      expect(s.parts[0].spec?.entities[0]?.ref.dcid).toBe("country/NGA");
      expect(s.parts[1].spec?.entities[0]?.ref.dcid).toBe("country/NGA");
      // The whole fan-out lands as ONE new history entry, not one per part.
      expect(s.history).toHaveLength(2);
      expect(s.canUndo).toBe(true);
    });

    it("on a mixed response, rewrites only the definite part's identity; the candidates part posts as an unedited candidates entry", async () => {
      const mixed = normalizeResponse(partsMixedBrazil);
      const population = definiteSpec(mixed, 0);
      const gdpPart = partAt(mixed, 1);
      if (gdpPart?.status !== "candidates")
        throw new Error("expected candidates");
      let capturedEntries: DatasetResubmitEntry[] | undefined;
      const store = createSpecStore({
        resolve: () => Promise.reject(new Error("resolve not used")),
        resubmitDataset: (entries) => {
          capturedEntries = entries;
          return Promise.resolve({
            schema_version: "1.0",
            status: "mixed",
            query_echo: {
              entry_path: "dataset_resubmit",
              variable_text: [],
              extract_skipped: true,
            },
            diagnostics: { engine_build: "test", warnings: [] },
            parts: [
              {
                status: "definite",
                spec: {
                  ...population,
                  entities: [
                    {
                      ...population.entities[0],
                      ref: { dcid: "country/KEN", label: "Kenya" },
                    },
                  ],
                },
                variable_text: "population",
                warnings: [],
              },
              gdpPart, // unedited, echoed back verbatim
            ],
          });
        },
        resolveStream: async (_query, onEvent) => {
          onEvent({ kind: "response", response: partsMixedBrazil });
        },
      });
      await store.getState().resolve("population and GDP in Brazil");
      expect(store.getState().response?.status).toBe("mixed");

      await store.getState().editShared({
        axis: "where",
        binding: {
          kind: "value",
          value: {
            value_kind: "entity",
            ref: { dcid: "country/KEN", label: "Kenya" },
          },
        },
      });

      expect(capturedEntries).toHaveLength(2);
      expect(capturedEntries?.[0].entry_kind).toBe("identity");
      if (capturedEntries?.[0].entry_kind !== "identity")
        throw new Error("expected identity");
      expect(capturedEntries[0].identity.entities.observationAbout).toEqual([
        "country/KEN",
      ]);
      // editShared's rewrite only ever touches identity-kind entries -- the
      // candidates part posts as-is (buildDatasetEntries's own editShared
      // override).
      expect(capturedEntries?.[1].entry_kind).toBe("candidates");

      const s = store.getState();
      expect(s.parts[0].spec?.entities[0]?.ref.dcid).toBe("country/KEN");
      expect(s.parts[1].part?.status).toBe("candidates");
      expect(s.response?.status).toBe("mixed");
    });

    it("with an origin edit, rewrites only a definite part whose identity already carries a donor role, in one post", async () => {
      // definiteBreadthSpec ("malaria grants to Ethiopia") ships with no
      // donor bound yet (only the recipient role) -- editShared only ever
      // fires from an already-hoisted donor chip, so give this part one, as
      // if a prior editDonor had already bound it.
      const donorSpec: Spec = {
        ...definiteBreadthSpec,
        entities: [
          ...definiteBreadthSpec.entities,
          {
            ref: { dcid: "country/FRA", label: "France" },
            role: {
              kind: "directional",
              role: { dcid: "donor", label: "donor" },
              direction: "from",
            },
          },
        ],
        definition: {
          identity: {
            ...definiteBreadthSpec.definition!.identity!,
            entities: {
              ...definiteBreadthSpec.definition!.identity!.entities,
              origin: ["country/FRA"],
            },
          },
        },
      };
      const noDonorSpec = definiteSpec(
        normalizeResponse(partsTwoDefiniteKenya),
        1,
      ); // "population of Kenya" -- no donor role at all
      const rawResponse: ResolveResponse = {
        schema_version: 1,
        status: "definite",
        query_echo: {
          entry_path: "raw_text",
          raw_query: "malaria grants to Ethiopia and population of Kenya",
          variable_text: ["malaria grants", "population"],
          extract_skipped: false,
        },
        diagnostics: { engine_build: "test", warnings: [] },
        parts: [
          {
            status: "definite",
            spec: donorSpec,
            variable_text: "malaria grants",
            warnings: [],
          },
          {
            status: "definite",
            spec: noDonorSpec,
            variable_text: "population",
            warnings: [],
          },
        ],
      };

      let capturedEntries: DatasetResubmitEntry[] | undefined;
      const store = createSpecStore({
        resolve: () => Promise.reject(new Error("resolve not used")),
        resubmitDataset: (entries) => {
          capturedEntries = entries;
          return Promise.resolve({
            ...rawResponse,
            parts: [
              {
                status: "definite",
                spec: {
                  ...donorSpec,
                  entities: donorSpec.entities.map((e) =>
                    e.role.kind === "directional" && e.role.direction === "from"
                      ? { ...e, ref: { dcid: "country/DEU", label: "Germany" } }
                      : e,
                  ),
                },
                variable_text: "malaria grants",
                warnings: [],
              },
              rawResponse.parts[1],
            ],
          });
        },
        resolveStream: async (_query, onEvent) => {
          onEvent({ kind: "response", response: rawResponse });
        },
      });
      await store
        .getState()
        .resolve("malaria grants to Ethiopia and population of Kenya");
      expect(store.getState().parts).toHaveLength(2);
      expect(store.getState().history).toHaveLength(1);

      await store
        .getState()
        .editShared({ axis: "origin", dcid: "country/DEU" });

      expect(capturedEntries).toHaveLength(2);
      expect(capturedEntries?.[0].entry_kind).toBe("identity");
      if (capturedEntries?.[0].entry_kind !== "identity")
        throw new Error("expected identity");
      expect(capturedEntries[0].identity.entities.origin).toEqual([
        "country/DEU",
      ]);
      expect(capturedEntries?.[1].entry_kind).toBe("identity");
      if (capturedEntries?.[1].entry_kind !== "identity")
        throw new Error("expected identity");
      // no donor role on this part's identity -- the rewrite leaves it
      // untouched (same object, not a rebuild).
      expect(capturedEntries[1].identity).toBe(
        noDonorSpec.definition?.identity,
      );

      const s = store.getState();
      // The fan-out lands as ONE new history entry, same as the other axes.
      expect(s.history).toHaveLength(2);
      expect(s.canUndo).toBe(true);
    });
  });
});

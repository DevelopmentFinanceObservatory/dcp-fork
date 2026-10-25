// @vitest-environment jsdom

/**
 * SearchClient-level check that free-text phrase refinement is actually
 * wired end to end: typing over a phrase's PhrasePopover triggers
 * refineText(partIndex, splicedSentence) -- a per-part edit, fenced and
 * spliced exactly like editSlot/editDonor/chooseSpec (specStore.refineText),
 * never a whole-query resolve() -- so a refine on one part of a multi-part
 * result never touches its siblings. The splice math itself is covered by
 * refineQuery.test.ts and lib/contract/parts.test.ts; this only checks the
 * store action gets called with the right (partIndex, text) and that a
 * sibling part's own content survives it.
 *
 * Deliberately self-contained (a hand-rolled stub transport + a minimal Spec
 * built inline, rather than app/search/lib/fixtures + FixtureTransport, both
 * of which other concurrent work in this tree is actively restructuring) so
 * this test doesn't take a dependency on either.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createSpecStore } from "./lib/store/specStore";
import type { ResolveResponse, Spec, SlotKey } from "@/lib/contract/types";

// vi.mock is hoisted above these imports, so SearchClient's own
// `import { useSpecStore } from './lib/store'` resolves to this instance.
// Everything the mocked store needs is built INSIDE the factory (rather than
// referenced from module-level consts) to sidestep vi.mock's hoisting TDZ.
vi.mock("./lib/store", () => {
  const whatKey: SlotKey = {
    axis: "what",
    property: { dcid: "flowType", label: "flow type" },
    label: "flow",
  };
  const howKey: SlotKey = {
    axis: "how",
    property: { dcid: "purpose", label: "purpose" },
    label: "purpose",
  };

  const spec: Spec = {
    spec_id: "s1",
    shape: {
      shape_id: "sh1",
      label: "flows",
      population_type: null,
      measured_property: null,
      stat_type: null,
      slot_keys: [whatKey, howKey],
      member_count: 1,
      refine_supported: true,
    },
    slots: [
      {
        key: whatKey,
        binding: {
          kind: "value",
          value: {
            value_kind: "enum_value",
            ref: { dcid: "ODA", label: "ODA" },
          },
        },
      },
      {
        key: howKey,
        binding: {
          kind: "value",
          value: {
            value_kind: "enum_value",
            ref: { dcid: "MalariaControl", label: "malaria control" },
          },
        },
      },
    ],
    // Engine-surfaced options (optionsFromSpec prefers these over the
    // fixtures fallback), so the popover opens with a real, non-empty option
    // list -- the refine field then renders at the bottom, unfocused.
    slot_options: [
      {
        key: howKey,
        options: [
          {
            value: {
              value_kind: "enum_value",
              ref: { dcid: "MalariaControl", label: "malaria control" },
            },
          },
          {
            value: {
              value_kind: "enum_value",
              ref: { dcid: "Education", label: "education" },
            },
          },
        ],
        complete: true,
        source: "observed",
      },
    ],
    stat_vars: [],
    entities: [],
    coverage: { kind: "bare", has_data: true },
    resolution: {
      resolved_stat_vars: [],
      resolved_entities: [],
      resolved_sources: [],
      slot_filters: [],
      pipeline_trace: [],
    },
  };

  const response: ResolveResponse = {
    schema_version: "1.0",
    status: "definite",
    parts: [
      {
        status: "definite",
        variable_text: "ODA",
        warnings: [],
        timing_ms: null,
        rendered_sentence: null,
        sentence_plan: null,
        spec,
      },
    ],
    query_echo: {
      entry_path: "raw_text",
      raw_query: "ODA malaria control",
      variable_text: ["ODA"],
      extract_skipped: false,
    },
    diagnostics: { engine_build: "test", warnings: [] },
  };

  // A second, unrelated definite part -- a plain confirmed sentence, no
  // editable phrases of its own -- to prove a refine on `spec`'s part never
  // touches it. Reuses the same `spec` above at index 1, so clicking "purpose:
  // malaria control" in the multi-part test opens the exact same popover as
  // the single-part test above.
  const populationSpec: Spec = {
    spec_id: "pop-kenya",
    shape: {
      shape_id: "pop-shape",
      label: "population",
      population_type: null,
      measured_property: null,
      stat_type: null,
      slot_keys: [],
      member_count: 1,
      refine_supported: true,
    },
    slots: [],
    stat_vars: [],
    entities: [],
    coverage: { kind: "bare", has_data: true },
    resolution: {
      resolved_stat_vars: [],
      resolved_entities: [],
      resolved_sources: [],
      slot_filters: [],
      pipeline_trace: [],
    },
    rendered_sentence: "Total population in Kenya.",
    sentence_plan: [{ kind: "text", text: "Total population in Kenya." }],
  };

  // A minimal but genuine composed envelope plan: part 0's whole phrase is
  // shared connective-free text, part 1's what-phrase plus its "purpose"
  // qualifier ride in a part-indexed parenthetical, same shape a real
  // composed response uses (ComposedSentence never falls back to a minted
  // " and "/"." skeleton for a response with no envelope plan of its own).
  const twoPartResponse: ResolveResponse = {
    schema_version: "1.0",
    status: "definite",
    parts: [
      {
        status: "definite",
        variable_text: "population",
        warnings: [],
        timing_ms: null,
        rendered_sentence: null,
        sentence_plan: null,
        spec: populationSpec,
      },
      {
        status: "definite",
        variable_text: "ODA",
        warnings: [],
        timing_ms: null,
        rendered_sentence: null,
        sentence_plan: null,
        spec,
      },
    ],
    query_echo: {
      entry_path: "raw_text",
      raw_query: "population and ODA malaria control",
      variable_text: ["population", "ODA"],
      extract_skipped: false,
    },
    diagnostics: { engine_build: "test", warnings: [] },
    rendered_sentence: "Total population in Kenya and ODA (malaria control).",
    sentence_plan: [
      {
        kind: "text",
        text: "Total population in Kenya",
        entity_refs: [],
        part_index: 0,
      },
      { kind: "text", text: " and ", entity_refs: [] },
      {
        kind: "slot",
        text: "ODA",
        axis: "what",
        property_dcid: "flowType",
        binding_ref: "what:flowType",
        entity_refs: [],
        part_index: 1,
      },
      { kind: "text", text: " (", entity_refs: [], part_index: 1 },
      {
        kind: "slot",
        text: "malaria control",
        axis: "how",
        property_dcid: "purpose",
        binding_ref: "how:purpose",
        entity_refs: [],
        part_index: 1,
      },
      { kind: "text", text: ")", entity_refs: [], part_index: 1 },
      { kind: "text", text: ".", entity_refs: [] },
    ],
  };

  // Structurally satisfies SearchTransport (resolve); streaming, resubmitDataset
  // and placeOptions are optional on the interface, so the store falls back to
  // its buffered paths without them.
  class StubTransport {
    async resolve(query: string): Promise<ResolveResponse> {
      if (query === "population and ODA malaria control")
        return twoPartResponse;
      // Both the initial single-part submit ("anything", ignored) and any
      // refine's own spliced text resolve to the same single-part definite
      // response -- these tests only check refineText's own (partIndex,
      // text) arguments and that a sibling part survives, not that the
      // refined content itself changes.
      return response;
    }
  }

  return { useSpecStore: createSpecStore(new StubTransport()) };
});

import SearchClient from "./SearchClient";
import { useSpecStore } from "./lib/store";

describe("<SearchClient> — free-text phrase refine", () => {
  it("typing over a phrase resolves the spliced sentence via refineText, scoped to that part", async () => {
    // refineText is a stable action reference for the lifetime of the store
    // (see specStore.ts -- set() never reassigns an action), so spying on it
    // now stays wired through every later render.
    const refineTextSpy = vi.spyOn(useSpecStore.getState(), "refineText");

    render(<SearchClient />);

    fireEvent.change(screen.getByLabelText(/describe the data you want/i), {
      target: { value: "anything" }, // the stub transport ignores the query text
    });
    fireEvent.submit(screen.getByRole("search"));

    const phrase = await screen.findByRole("button", {
      name: /purpose: malaria control/i,
    });
    fireEvent.click(phrase);

    const field = await screen.findByRole("textbox", {
      name: "Search for something different",
    });
    fireEvent.change(field, { target: { value: "polio eradication" } });
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() =>
      expect(refineTextSpy).toHaveBeenCalledWith(0, "ODA polio eradication"),
    );

    // A per-part refine is fenced/spliced like every other per-part edit
    // (editSlot/editDonor/chooseSpec) -- none of those sync the top search
    // bar's typed text either, only a whole-query resolve()/runQuery() does.
    expect(screen.getByLabelText(/describe the data you want/i)).toHaveValue(
      "anything",
    );
  });

  it("refining a phrase on part 1 of a two-part result leaves part 0 untouched", async () => {
    const refineTextSpy = vi.spyOn(useSpecStore.getState(), "refineText");

    render(<SearchClient />);

    fireEvent.change(screen.getByLabelText(/describe the data you want/i), {
      target: { value: "population and ODA malaria control" },
    });
    fireEvent.submit(screen.getByRole("search"));

    // Part 0's own phrase is on screen before the edit -- part of the one
    // composed sentence, not a dedicated element of its own, so this checks
    // the page's text rather than a single node's exact content.
    const phrase = await screen.findByRole("button", {
      name: /purpose: malaria control/i,
    });
    expect(document.body.textContent).toContain("Total population in Kenya");
    fireEvent.click(phrase);

    const field = await screen.findByRole("textbox", {
      name: "Search for something different",
    });
    fireEvent.change(field, { target: { value: "polio eradication" } });
    fireEvent.keyDown(field, { key: "Enter" });

    // The edit targets part 1 (index 1) with just its own spliced sentence --
    // never the whole envelope.
    await waitFor(() =>
      expect(refineTextSpy).toHaveBeenCalledWith(1, "ODA polio eradication"),
    );

    // Part 0's own phrase is still on screen, untouched by part 1's refine.
    expect(document.body.textContent).toContain("Total population in Kenya.");
  });
});

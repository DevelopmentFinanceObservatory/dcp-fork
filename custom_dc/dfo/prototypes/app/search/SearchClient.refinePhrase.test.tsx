// @vitest-environment jsdom

/**
 * SearchClient-level check for the shape-label fallback case: a rendered
 * phrase with neither a real Spec.slots index nor a directional entity role
 * (e.g. "Floods" in "Floods in Pakistan…", or "Total population" in "total
 * population of Kenya") — buildViewModel marks these `editable: true`,
 * addressed by their position in the rendered sentence via
 * SentenceRenderer's onEditPhrase / refineQuery's PhraseTarget. Editing
 * "Floods" over free text keeps the rest of the sentence intact.
 *
 * Self-contained (hand-rolled stub transport + inline Spec/sentence_plan),
 * same pattern as SearchClient.refine.test.tsx.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createSpecStore } from "./lib/store/specStore";
import type {
  ResolveResponse,
  SentenceToken,
  Slot,
  SlotKey,
  Spec,
} from "@/lib/contract/types";

vi.mock("./lib/store", () => {
  const whereKey: SlotKey = { axis: "where", property: null, label: "place" };

  const slots: Slot[] = [
    {
      key: whereKey,
      binding: {
        kind: "value",
        value: {
          value_kind: "entity",
          ref: { dcid: "country/PAK", label: "Pakistan" },
        },
      },
    },
  ];

  // "Floods" has no binding_ref and no role -- buildSentenceTokens' shape-label
  // fallback branch (no confirmable sibling to construct a real edit from).
  const sentencePlan: SentenceToken[] = [
    { kind: "slot", text: "Floods", axis: "what" },
    { kind: "text", text: " in " },
    { kind: "slot", text: "Pakistan", axis: "where", binding_ref: "where:" },
  ];

  const spec: Spec = {
    spec_id: "s3",
    shape: {
      shape_id: "sh3",
      label: "flood events",
      population_type: null,
      measured_property: null,
      stat_type: null,
      slot_keys: [whereKey],
      member_count: 1,
      refine_supported: true,
    },
    slots,
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
    // Wire reality: a definite spec carries its own confirmation sentence.
    rendered_sentence: "Floods in Pakistan.",
    sentence_plan: sentencePlan,
  };

  const response: ResolveResponse = {
    schema_version: "1.0",
    status: "definite",
    parts: [
      {
        status: "definite",
        variable_text: "Floods",
        warnings: [],
        timing_ms: null,
        rendered_sentence: null,
        sentence_plan: null,
        spec,
      },
    ],
    query_echo: {
      entry_path: "raw_text",
      raw_query: "floods in pakistan",
      variable_text: ["Floods"],
      extract_skipped: false,
    },
    diagnostics: { engine_build: "test", warnings: [] },
  };

  class StubTransport {
    async resolve(): Promise<ResolveResponse> {
      return response;
    }
  }

  return { useSpecStore: createSpecStore(new StubTransport()) };
});

import SearchClient from "./SearchClient";
import { useSpecStore } from "./lib/store";

describe("<SearchClient> — refining a shape-label fallback phrase (variable read-back)", () => {
  it("renders the phrase as an enabled button, opens with zero options auto-focused, and refines on Enter", async () => {
    // refineText (not resolve) is the store action a phrase free-text refine
    // goes through: a per-part edit, fenced/spliced into parts[0] like
    // editSlot/editDonor/chooseSpec (specStore.refineText), never a
    // whole-query run.
    const refineTextSpy = vi.spyOn(useSpecStore.getState(), "refineText");

    render(<SearchClient />);

    fireEvent.change(screen.getByLabelText(/describe the data you want/i), {
      target: { value: "anything" },
    });
    fireEvent.submit(screen.getByRole("search"));

    const phrase = await screen.findByRole("button", { name: "Floods" });
    // Enabled even with zero refine options for this phrase.
    expect(phrase).toBeEnabled();
    fireEvent.click(phrase);

    // Zero options for this phrase -- the refine field replaces the dead-end
    // text and is auto-focused (PhrasePopover's no-options branch).
    const field = await screen.findByRole("textbox", {
      name: "Search for something different",
    });
    expect(field).toHaveFocus();

    fireEvent.change(field, { target: { value: "droughts" } });
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() =>
      expect(refineTextSpy).toHaveBeenCalledWith(0, "droughts in Pakistan"),
    );
    // A per-part refine never syncs the top search bar's typed text -- only
    // a whole-query resolve()/runQuery() does that (same as editSlot/
    // editDonor/chooseSpec, none of which sync it either).
    expect(screen.getByLabelText(/describe the data you want/i)).toHaveValue(
      "anything",
    );
  });
});

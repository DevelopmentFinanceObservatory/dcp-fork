// @vitest-environment jsdom

/**
 * SearchClient-level check for the donor read-back with no entity_options:
 * buildViewModel marks the directional entity read-back `editable: true`
 * unconditionally, so a donor with no curated options still gets
 * EntityPopover's free-text refine field instead of a disabled dead end.
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
  Spec,
} from "@/lib/contract/types";

vi.mock("./lib/store", () => {
  const sentencePlan: SentenceToken[] = [
    { kind: "text", text: "ODA from " },
    {
      kind: "slot",
      text: "France",
      role: "from",
      entity_refs: ["country/FRA"],
    },
  ];

  const spec: Spec = {
    spec_id: "s4",
    shape: {
      shape_id: "sh4",
      label: "development finance flows",
      population_type: null,
      measured_property: null,
      stat_type: null,
      slot_keys: [],
      member_count: 1,
      refine_supported: true,
    },
    slots: [],
    // Deliberately no entity_options for role 'from' -- the case this test covers.
    stat_vars: [],
    entities: [
      {
        ref: { dcid: "country/FRA", label: "France" },
        role: {
          kind: "directional",
          role: { dcid: "donor", label: "donor" },
          direction: "from",
        },
      },
    ],
    coverage: { kind: "bare", has_data: true },
    resolution: {
      resolved_stat_vars: [],
      resolved_entities: [],
      resolved_sources: [],
      slot_filters: [],
      pipeline_trace: [],
    },
    // Wire reality: a definite spec carries its own confirmation sentence.
    rendered_sentence: "ODA from France.",
    sentence_plan: sentencePlan,
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
      raw_query: "oda from france",
      variable_text: ["ODA"],
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

describe("<SearchClient> — refining a donor phrase with no entity_options", () => {
  it("renders the donor phrase as an enabled button, opens with zero options auto-focused, and refines on Enter", async () => {
    // refineText (not resolve) is the store action a donor free-text refine
    // goes through: a per-part edit, fenced/spliced into parts[0] like
    // editSlot/editDonor/chooseSpec (specStore.refineText), never a
    // whole-query run.
    const refineTextSpy = vi.spyOn(useSpecStore.getState(), "refineText");

    render(<SearchClient />);

    fireEvent.change(screen.getByLabelText(/describe the data you want/i), {
      target: { value: "anything" },
    });
    fireEvent.submit(screen.getByRole("search"));

    const phrase = await screen.findByRole("button", { name: "France" });
    // Enabled even though the spec carries no entity_options for this role.
    expect(phrase).toBeEnabled();
    fireEvent.click(phrase);

    const field = await screen.findByRole("textbox", {
      name: "Search for something different",
    });
    expect(field).toHaveFocus();

    fireEvent.change(field, { target: { value: "Germany" } });
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() =>
      expect(refineTextSpy).toHaveBeenCalledWith(0, "ODA from Germany"),
    );
    // A per-part refine never syncs the top search bar's typed text -- only
    // a whole-query resolve()/runQuery() does that (same as editSlot/
    // editDonor/chooseSpec, none of which sync it either).
    expect(screen.getByLabelText(/describe the data you want/i)).toHaveValue(
      "anything",
    );
  });
});

// @vitest-environment jsdom

/**
 * SearchClient-level check that the composed envelope plan drives the one
 * hero sentence: "population and GDP in Brazil" (mixed — population
 * definite, GDP candidates) renders one heading with every part-indexed
 * token inline and editable, and GDP's own marked what-token opens a
 * candidates menu listing every reading; a single-part fixture renders the
 * same heading it always has. Also covers two multi-part edge cases: a
 * qualifier hoisted (shared) across every definite part must not come back
 * as a redundant per-part "narrow further" pill, and a part folded onto an
 * earlier part's identical spec_id must dedupe out of the preview/coverage
 * surfaces and show only its own collapse notice.
 *
 * Self-contained (a hand-rolled stub transport over the real fixtures), same
 * pattern as SearchClient.refine.test.tsx.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  within,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { createSpecStore } from "./lib/store/specStore";
import { partsComposedBrazil, partsDefiniteKenya } from "./lib/fixtures";
import type { ResolveResponse, Spec, SlotKey } from "@/lib/contract/types";

vi.mock("./lib/store", () => {
  class StubTransport {
    async resolve(query: string): Promise<ResolveResponse> {
      if (query === "population and GDP in Brazil") {
        return partsComposedBrazil as unknown as ResolveResponse;
      }
      if (query === "population and fertility rate in Brazil") {
        return hoistedWhereResponse;
      }
      if (query === "population and people in Brazil") {
        return foldedPartResponse;
      }
      return partsDefiniteKenya as unknown as ResolveResponse;
    }
  }
  return { useSpecStore: createSpecStore(new StubTransport()) };
});

import SearchClient from "./SearchClient";
import { useSpecStore } from "./lib/store";

// -----------------------------------------------------------------------
// Fixture: two definite parts sharing a hoisted "where" qualifier (both
// bound to Brazil), for the "no duplicate narrow-further pill" case below.
// -----------------------------------------------------------------------

const whereKeyBrazil: SlotKey = {
  axis: "where",
  property: null,
  label: "place",
};

function definiteBrazilSpec(specId: string, label: string, dcid: string): Spec {
  const whatKey: SlotKey = { axis: "what", property: null, label: "measure" };
  return {
    spec_id: specId,
    shape: {
      shape_id: `shape-${specId}`,
      label,
      population_type: null,
      measured_property: null,
      stat_type: null,
      slot_keys: [whatKey, whereKeyBrazil],
      member_count: 1,
      refine_supported: true,
    },
    slots: [
      {
        key: whatKey,
        binding: {
          kind: "value",
          value: { value_kind: "enum_value", ref: { dcid, label } },
        },
      },
      {
        key: whereKeyBrazil,
        binding: {
          kind: "value",
          value: {
            value_kind: "entity",
            ref: { dcid: "country/BRA", label: "Brazil" },
          },
        },
      },
    ],
    stat_vars: [],
    entities: [
      {
        ref: { dcid: "country/BRA", label: "Brazil" },
        entity_type: { dcid: "Country", label: "Country" },
        role: { kind: "subject" },
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
  };
}

const hoistedWhereResponse: ResolveResponse = {
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
      spec: definiteBrazilSpec("pop-bra", "Total population", "Count_Person"),
    },
    {
      status: "definite",
      variable_text: "fertility rate",
      warnings: [],
      timing_ms: null,
      rendered_sentence: null,
      sentence_plan: null,
      spec: definiteBrazilSpec(
        "fert-bra",
        "Total fertility rate",
        "FertilityRate_Person_Female",
      ),
    },
  ],
  query_echo: {
    entry_path: "raw_text",
    raw_query: "population and fertility rate in Brazil",
    variable_text: ["population", "fertility rate"],
    extract_skipped: false,
  },
  diagnostics: { engine_build: "test", warnings: [] },
  rendered_sentence: "Total population and Total fertility rate in Brazil.",
  sentence_plan: [
    {
      kind: "slot",
      text: "Total population",
      axis: "what",
      entity_refs: [],
      part_index: 0,
    },
    { kind: "text", text: " and ", entity_refs: [] },
    {
      kind: "slot",
      text: "Total fertility rate",
      axis: "what",
      entity_refs: [],
      part_index: 1,
    },
    { kind: "text", text: " in ", entity_refs: [] },
    // Hoisted: shared by both parts, so it carries no part_index of its own.
    {
      kind: "slot",
      text: "Brazil",
      axis: "where",
      binding_ref: "where:",
      entity_refs: [],
    },
    { kind: "text", text: ".", entity_refs: [] },
  ],
};

// -----------------------------------------------------------------------
// Fixture: a part folded onto an earlier part's identical spec_id, for the
// "one preview, one coverage rail, one collapse notice" case below.
// -----------------------------------------------------------------------

const foldedSpec: Spec = {
  spec_id: "spec-fold-bra",
  shape: {
    shape_id: "shape-fold-bra",
    label: "Total population",
    population_type: null,
    measured_property: null,
    stat_type: null,
    slot_keys: [],
    member_count: 1,
    refine_supported: true,
  },
  slots: [],
  stat_vars: [
    {
      ref: { dcid: "Count_Person", label: "Total population" },
      shape_id: "shape-fold-bra",
      slot_values: [],
    },
  ],
  entities: [
    {
      ref: { dcid: "country/BRA", label: "Brazil" },
      entity_type: { dcid: "Country", label: "Country" },
      role: { kind: "subject" },
    },
  ],
  coverage: { kind: "exact", has_data: true, observation_count: 1 },
  resolution: {
    resolved_stat_vars: [],
    resolved_entities: [],
    resolved_sources: [],
    slot_filters: [],
    pipeline_trace: [],
  },
  observations: {
    series: [
      {
        stat_var_dcid: "Count_Person",
        entity_dcid: "country/BRA",
        points: [{ date: "2020", value: 213993441 }],
        source_refs: [],
      },
    ],
    total_obs: 1,
    complete: true,
  },
  rendered_sentence: "Total population in Brazil.",
  sentence_plan: [{ kind: "text", text: "Total population in Brazil." }],
};

const foldedPartResponse: ResolveResponse = {
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
      spec: foldedSpec,
    },
    {
      status: "definite",
      variable_text: "people",
      warnings: [
        {
          code: "binding_folded",
          severity: "info",
          message: "Same shape as an earlier part.",
        },
      ],
      timing_ms: null,
      rendered_sentence: null,
      sentence_plan: null,
      spec: foldedSpec,
    },
  ],
  query_echo: {
    entry_path: "raw_text",
    raw_query: "population and people in Brazil",
    variable_text: ["population", "people"],
    extract_skipped: false,
  },
  diagnostics: { engine_build: "test", warnings: [] },
};

describe("<SearchClient> — composed sentence rendering", () => {
  beforeEach(() => {
    useSpecStore.getState().reset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renders one heading with population's own qualifiers inline and a two-entry candidates menu for GDP, no separate variable lines", async () => {
    // The dev-only DebugPanel (gated on NODE_ENV) would otherwise render this
    // fixture's full ~7000-line payload -- JsonViewer has no virtualization,
    // slow enough in jsdom to blow past the default per-test budget. Not
    // needed for what this test actually checks.
    vi.stubEnv("NODE_ENV", "production");
    render(<SearchClient />);

    fireEvent.change(screen.getByLabelText(/describe the data you want/i), {
      target: { value: "population and GDP in Brazil" },
    });
    fireEvent.submit(screen.getByRole("search"));

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Total population (Brazil, 1940 to June 2026, 6 sources) and GDP.",
      ),
    );

    // Population's own qualifiers render inline in the one heading, each its
    // own editable chip — not folded away into a separate line.
    expect(
      screen.getByRole("button", { name: "place: Brazil" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /time window: 1940 to June 2026/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "data source: 6 sources" }),
    ).toBeInTheDocument();

    expect(screen.queryByLabelText("Variables")).not.toBeInTheDocument();

    const gdpMenu = await screen.findByRole("button", { name: "GDP" });
    fireEvent.click(gdpMenu);

    const menu = await screen.findByRole("region", {
      name: "Multiple matches",
    });
    expect(within(menu).getAllByRole("button")).toHaveLength(2);
  });

  it("renders the same heading as before for a single-part result", async () => {
    render(<SearchClient />);

    fireEvent.change(screen.getByLabelText(/describe the data you want/i), {
      target: { value: "population of Kenya" },
    });
    fireEvent.submit(screen.getByRole("search"));

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Total population in Kenya, 1960 to 2024, according to 4 sources.",
      ),
    );
    expect(screen.queryByLabelText("Variables")).not.toBeInTheDocument();
  });

  it("does not re-offer a qualifier hoisted across every definite part as a per-part narrow-further pill", async () => {
    render(<SearchClient />);

    fireEvent.change(screen.getByLabelText(/describe the data you want/i), {
      target: { value: "population and fertility rate in Brazil" },
    });
    fireEvent.submit(screen.getByRole("search"));

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Total population and Total fertility rate in Brazil.",
      ),
    );

    // The hoisted "Brazil" phrase is one shared chip, addressing both
    // parts' own where-slot at once — it must not also come back as a
    // "narrow further" pill on either part (that would route through
    // editSlot for one part alone and un-hoist it).
    expect(
      screen.getByRole("button", { name: "place: Brazil" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "+ narrow further" }),
    ).not.toBeInTheDocument();
  });

  it("folds a part sharing an earlier part's spec_id into one preview entry, one coverage rail, and a collapse notice", async () => {
    render(<SearchClient />);

    fireEvent.change(screen.getByLabelText(/describe the data you want/i), {
      target: { value: "population and people in Brazil" },
    });
    fireEvent.submit(screen.getByRole("search"));

    await waitFor(() =>
      expect(screen.getAllByLabelText("Coverage")).toHaveLength(1),
    );

    // One preview row (the representative's), not two of the same value —
    // the folded duplicate never reaches the merged preview table, so it
    // stays in the single-part shape (no Variable column, one data row).
    expect(
      screen.queryByRole("columnheader", { name: "Variable" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(2); // header + one data row

    expect(screen.getByText(/Same result as/).textContent).toContain(
      "population",
    );
  });
});

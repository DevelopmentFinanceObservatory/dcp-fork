// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createSpecStore } from "./lib/store/specStore";
import type {
  DefinitePart,
  ResolveResponse,
  Spec,
  SlotKey,
} from "@/lib/contract/types";

vi.mock("./lib/store", () => {
  const whatKey: SlotKey = {
    axis: "what",
    property: { dcid: "flowType", label: "flow type" },
    label: "flow",
  };

  const spec1: Spec = {
    spec_id: "spec_test_1",
    shape: {
      shape_id: "sh1",
      label: "ODA grants",
      population_type: null,
      measured_property: null,
      stat_type: null,
      slot_keys: [whatKey],
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

  const part1: DefinitePart = {
    status: "definite",
    variable_text: "ODA",
    warnings: [],
    timing_ms: null,
    rendered_sentence: null,
    sentence_plan: null,
    spec: spec1,
  };

  const response1: ResolveResponse = {
    schema_version: "1.0",
    status: "definite",
    parts: [part1],
    query_echo: {
      entry_path: "raw_text",
      raw_query: "ODA flows",
      variable_text: ["ODA"],
      extract_skipped: true,
    },
    diagnostics: { engine_build: "test", warnings: [] },
  };

  class StubTransport {
    async resolve(query: string): Promise<ResolveResponse> {
      return {
        ...response1,
        query_echo: {
          ...response1.query_echo,
          raw_query: query,
        },
      };
    }
    async resolveSpecId(specId: string): Promise<ResolveResponse> {
      return {
        ...response1,
        parts: [{ ...part1, spec: { ...spec1, spec_id: specId } }],
      };
    }
  }

  return { useSpecStore: createSpecStore(new StubTransport()) };
});

import SearchClient from "./SearchClient";
import { useSpecStore } from "./lib/store";

describe("<SearchClient> spec_id hydration and URL sync", () => {
  beforeEach(() => {
    useSpecStore.getState().reset();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    window.history.replaceState(null, "", "/search");
  });

  it("hydrates from ?spec=...&q=... on mount, populating query input and resolving query", async () => {
    window.history.replaceState(
      null,
      "",
      "/search?spec=spec_custom_123&q=custom+query",
    );
    const resolveSpy = vi.spyOn(useSpecStore.getState(), "resolve");

    render(<SearchClient />);

    expect(resolveSpy).toHaveBeenCalledWith("custom query");
    expect(screen.getByLabelText(/describe the data you want/i)).toHaveValue(
      "custom query",
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /flow: ODA/i }),
      ).toBeInTheDocument(),
    );
  });

  it("hydrates from ?spec=... without q parameter on mount", async () => {
    window.history.replaceState(null, "", "/search?spec=spec_only_456");
    const runSpecIdSpy = vi.spyOn(useSpecStore.getState(), "runSpecId");

    render(<SearchClient />);

    expect(runSpecIdSpy).toHaveBeenCalledWith("spec_only_456");

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /flow: ODA/i }),
      ).toBeInTheDocument(),
    );
  });

  it("hydrates from ?q=... when spec is absent", async () => {
    window.history.replaceState(null, "", "/search?q=health+spending");
    const resolveSpy = vi.spyOn(useSpecStore.getState(), "resolve");

    render(<SearchClient />);

    expect(resolveSpy).toHaveBeenCalledWith("health spending");
    expect(screen.getByLabelText(/describe the data you want/i)).toHaveValue(
      "health spending",
    );
  });

  it("pushes updated URL with ?spec=... when query resolves to definite", async () => {
    window.history.replaceState(null, "", "/search");
    const pushStateSpy = vi.spyOn(window.history, "pushState");

    render(<SearchClient />);

    fireEvent.change(screen.getByLabelText(/describe the data you want/i), {
      target: { value: "ODA flows" },
    });
    fireEvent.submit(screen.getByRole("search"));

    await waitFor(() => {
      expect(pushStateSpy).toHaveBeenCalled();
    });

    const lastCallUrl = pushStateSpy.mock.calls[
      pushStateSpy.mock.calls.length - 1
    ][2] as string;
    expect(lastCallUrl).toContain("spec=spec_test_1");
    expect(lastCallUrl).toContain("q=ODA+flows");
  });

  it("clears ?q= and ?spec= when Start over is clicked", async () => {
    window.history.replaceState(
      null,
      "",
      "/search?spec=spec_test_1&q=ODA+flows",
    );
    const pushStateSpy = vi.spyOn(window.history, "pushState");

    render(<SearchClient />);

    await waitFor(() =>
      expect(screen.getByText("Start over")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByText("Start over"));

    expect(useSpecStore.getState().status).toBe("idle");
    expect(pushStateSpy).toHaveBeenCalledWith(null, "", "/search");
  });

  it("toggles SharePopover when Share toolbar button is clicked", async () => {
    window.history.replaceState(
      null,
      "",
      "/search?spec=spec_test_1&q=ODA+flows",
    );

    render(<SearchClient />);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Share search link" }),
      ).toBeInTheDocument(),
    );

    expect(screen.queryByRole("dialog", { name: /share/i })).toBeNull();

    // Click Share button to open popover
    fireEvent.click(screen.getByRole("button", { name: "Share search link" }));
    expect(screen.getByRole("dialog", { name: /share/i })).toBeInTheDocument();
    expect(screen.getByText("Share results")).toBeInTheDocument();
    expect(screen.getByText("Share query")).toBeInTheDocument();

    // Close via close button in popover
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: /share/i })).toBeNull();
  });

  it("handles browser popstate navigation across URLs", async () => {
    window.history.replaceState(
      null,
      "",
      "/search?spec=spec_test_1&q=ODA+flows",
    );
    const runSpecIdSpy = vi.spyOn(useSpecStore.getState(), "runSpecId");
    const resolveSpy = vi.spyOn(useSpecStore.getState(), "resolve");
    const resetSpy = vi.spyOn(useSpecStore.getState(), "reset");

    render(<SearchClient />);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /flow: ODA/i }),
      ).toBeInTheDocument(),
    );

    // Simulate browser back navigation to a different spec/query
    window.history.replaceState(
      null,
      "",
      "/search?spec=spec_pop_2&q=new+query",
    );
    fireEvent(window, new PopStateEvent("popstate"));

    expect(resolveSpy).toHaveBeenCalledWith("new query");
    expect(screen.getByLabelText(/describe the data you want/i)).toHaveValue(
      "new query",
    );

    // Simulate browser back navigation to home /search (start over state)
    window.history.replaceState(null, "", "/search");
    fireEvent(window, new PopStateEvent("popstate"));

    expect(resetSpy).toHaveBeenCalled();
    expect(screen.getByLabelText(/describe the data you want/i)).toHaveValue(
      "",
    );
  });
});

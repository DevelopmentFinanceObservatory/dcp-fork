/**
 * HttpTransport buffered engine implementation of SearchTransport.
 *
 * Communicates with the search engine over JSON where POST /api/search/resolve
 * without an `Accept: text/event-stream` header returns a buffered body.
 *
 * The request builder and fetch/error handling are shared with `lib/client/searchClient.ts`.
 * `include_sentence` and `include_option_coverage` are enabled, so the rendered
 * sentence and option coverage counts arrive inline.
 */

import type {
  DatasetResubmitEntry,
  PlaceOptionsRequest,
  PlaceOptionsResponse,
  ResolveOptions,
  ResolveResponse,
} from "@/lib/contract/types";
import {
  buildRequest,
  placeOptions as searchPlaceOptions,
  resolveBuffered,
  resolveStream as searchResolveStream,
  type SearchEvent,
  type SearchInput,
} from "@/lib/client/searchClient";
import type { SearchTransport } from "./SearchTransport";

/** Shared dataset_resubmit field mapping for resubmitDataset()/
 *  resubmitDatasetStream(). `raw_query` omitted when absent, spread in only
 *  when present. */
function resubmitDatasetInput(
  entries: DatasetResubmitEntry[],
  rawQuery?: string,
): SearchInput {
  return {
    kind: "dataset_resubmit",
    entries,
    ...(rawQuery ? { raw_query: rawQuery } : {}),
  };
}

export interface HttpTransportOptions extends ResolveOptions {
  /**
   * Send `include_option_coverage` so each SlotOption.coverage carries an
   * observation count inline (opt-in latency on the engine). Default true.
   * Alias / convenience for ResolveOptions.include_option_coverage.
   */
  includeOptionCoverage?: boolean;
}

export class HttpTransport implements SearchTransport {
  private readonly requestOptions: ResolveOptions;

  constructor(options: HttpTransportOptions = {}) {
    const { includeOptionCoverage, ...rest } = options;
    this.requestOptions = {
      include_sentence: true,
      include_option_coverage:
        includeOptionCoverage ?? options.include_option_coverage ?? true,
      // DataPreview (app/search/components/DataPreview.tsx) renders off
      // Spec.observations, so every resolve/edit needs the engine to
      // populate it -- either inline on the buffered path or via the
      // trailing 'observations' SSE event the store's applyObservations
      // already handles. Absent this flag the engine omits observations
      // entirely (contrary to lib/contract/types.ts's stale "absent means
      // true" doc comment, verified against the live dfo-dev engine).
      include_observations: options.include_observations ?? true,
      ...rest,
    };
  }

  private async run(
    input: SearchInput,
    signal?: AbortSignal,
  ): Promise<ResolveResponse> {
    const body = await resolveBuffered(
      buildRequest(input, this.requestOptions),
      signal,
    );
    return body as ResolveResponse;
  }

  resolve(query: string, signal?: AbortSignal): Promise<ResolveResponse> {
    return this.run({ kind: "raw_text", query }, signal);
  }

  /** Streaming resolve using the same request built with the SSE parser from the reference
   *  client, which emits every parsed event (including the terminal response/done). */
  resolveStream(
    query: string,
    onEvent: (event: SearchEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return searchResolveStream(
      buildRequest({ kind: "raw_text", query }, this.requestOptions),
      onEvent,
      signal,
    );
  }

  /** Direct resolution from an existing spec_id via buffered POST /api/search/resolve. */
  resolveSpecId(
    specId: string,
    signal?: AbortSignal,
  ): Promise<ResolveResponse> {
    return this.run({ kind: "spec_id", spec_id: specId }, signal);
  }

  /** Streaming resolve for an existing spec_id. */
  resolveSpecIdStream(
    specId: string,
    onEvent: (event: SearchEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return searchResolveStream(
      buildRequest({ kind: "spec_id", spec_id: specId }, this.requestOptions),
      onEvent,
      signal,
    );
  }

  resubmitDataset(
    entries: DatasetResubmitEntry[],
    rawQuery: string | undefined,
    signal?: AbortSignal,
  ): Promise<ResolveResponse> {
    return this.run(resubmitDatasetInput(entries, rawQuery), signal);
  }

  /** Streaming resubmitDataset, same request/field mapping as
   *  resubmitDataset(), routed through the same SSE parser resolveStream
   *  uses. */
  resubmitDatasetStream(
    entries: DatasetResubmitEntry[],
    rawQuery: string | undefined,
    onEvent: (event: SearchEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return searchResolveStream(
      buildRequest(
        resubmitDatasetInput(entries, rawQuery),
        this.requestOptions,
      ),
      onEvent,
      signal,
    );
  }

  /** Delegates to the reference client's placeOptions verbatim with the same
   *  fetch/error-handling contract as resolveBuffered, just a different route. */
  placeOptions(
    req: PlaceOptionsRequest,
    signal?: AbortSignal,
  ): Promise<PlaceOptionsResponse> {
    return searchPlaceOptions(req, signal);
  }
}

/** Default HttpTransport singleton instance. */
export const httpTransport = new HttpTransport();

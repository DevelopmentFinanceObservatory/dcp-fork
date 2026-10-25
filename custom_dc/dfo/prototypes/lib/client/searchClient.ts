/**
 * Browser-side search client for the /prototype gut-check page.
 *
 * Streaming: POST + `Accept: text/event-stream` parsed off a ReadableStream
 * (EventSource can't POST). Buffered: the same POST minus the Accept header.
 *
 * Base URL: same-origin '/api/search/*' everywhere — nginx routes it to Next.js
 * (:3000) which rewrites it to the website (the DFO_SITE_ORIGIN origin baked
 * in at build time), and the website proxies to dfo-apis, so no CORS setup is
 * needed. Override NEXT_PUBLIC_SEARCH_API_BASE only to hit a remote engine
 * origin directly.
 *
 * MIRROR: A deliberately-shallow type layer of the engine contract. See the
 * fuller types in `lib/contract/types.ts` (source of truth: the apis repo's
 * `src/search/models/`). Keep this layer in sync as the contract evolves.
 */

import {
  normalizeResponse,
  type BaseIdentity,
  type DatasetResubmitEntry,
  type ResolveOptions,
  type ResolveRequest,
  type ResolveResponse,
} from "../contract/types";

export const SEARCH_BASE = process.env.NEXT_PUBLIC_SEARCH_API_BASE ?? "";

// Deliberately shallow types: the gut-check renders whatever the engine
// sends, so only the fields the page dereferences are typed. The rest
// stays `any`.
export type SlotKey = {
  axis: string;
  property: { dcid: string; label: string } | null;
  label: string;
};

export type SentenceToken = {
  kind: "text" | "slot";
  text: string;
  axis?: string | null;
  property_dcid?: string | null;
  role?: "from" | "to" | null;
  binding_ref?: string | null;
  entity_refs?: string[];
};

export type SlotOptionsData = {
  key: SlotKey;
  options: any[];
  complete: boolean;
  source?: "observed" | "seed";
};

export type SearchEvent =
  | {
      kind: "interpretation";
      variables: string[];
      entities: string[];
      dates: any[];
      expected_results: number;
    }
  | {
      kind: "shape";
      variable_index: number;
      shape_id: string;
      label: string;
      slot_keys: SlotKey[];
      sentence_plan: SentenceToken[];
      slot_options: SlotOptionsData[];
      refine_supported: boolean;
    }
  | {
      kind: "sentence";
      variable_index: number;
      spec_id: string;
      sentence_plan: SentenceToken[];
      slots: any[];
    }
  | {
      kind: "step";
      variable_index: number | null;
      step: string;
      ran: boolean;
      ms?: number | null;
    }
  | { kind: "response"; response: any }
  | {
      kind: "slot_options";
      spec_id: string;
      key: SlotKey;
      options: any[];
      complete: boolean;
    }
  | {
      kind: "entity_options";
      spec_id: string;
      entity_ref: string;
      role: "from" | "to";
      options: any[];
      complete: boolean;
    }
  | {
      kind: "facet_options";
      spec_id: string;
      axis: string;
      options: any[];
      /** The wire's own field name for this event is `truncated`, mapping
       *  straight onto Spec.facet_options[].truncated with no inversion
       *  (slot_options/entity_options instead use `complete`). */
      truncated: boolean;
    }
  | {
      kind: "observations";
      spec_id: string;
      /** SpecObservations (see lib/contract/types.ts): same shape the buffered
       *  path embeds at Spec.observations, deferred to a trailing event on SSE
       *  so the response isn't blocked on the observation fetch. */
      observations: any;
    }
  | {
      kind: "done";
      elapsed_ms: number;
      timed_out: boolean;
      telemetry: { llm_usage?: Record<string, number> | null };
      warnings: any[];
    }
  | {
      kind: "error";
      detail: string;
      code?: string | null;
      /** RFC 9457 pointer, top-level alongside type/title/status/detail/code/
       *  trace_id: on a dataset_resubmit refusal, `/input/entries/{i}/...`
       *  locates the entry at fault, so editError can key to that part
       *  instead of a page-level message. */
      pointer?: string | null;
    };

/** Mirrors SlotKey.as_ref(): the "axis:property_dcid" join key shared by
 * SentenceToken.binding_ref, Slot.key, and SlotOptions.key. */
export function keyRef(key: SlotKey): string {
  return `${key.axis}:${key.property?.dcid ?? ""}`;
}

/** True when the shape's where-axis slot is bound to a graph entity (a
 * value ref, or a set with any ref-bearing member): the dev-finance
 * recipient case, where a flat top-level `entity_dcids[0]` field would
 * otherwise silently override the where-slot's own binding on a
 * dataset_resubmit edit. */
export function whereSlotHasEntity(slots: any[]): boolean {
  const slot = (slots ?? []).find((s) => s?.key?.axis === "where");
  const b = slot?.binding;
  if (!b) return false;
  if (b.kind === "value") return b.value?.ref != null;
  if (b.kind === "set")
    return (b.values ?? []).some((v: any) => v?.ref != null);
  return false;
}

/** dcid of the currently-bound donor entity (role {kind:'directional',
 * direction:'from'}), or null when the spec has no directional donor. */
export function currentDonorDcid(entities: any[]): string | null {
  const donor = (entities ?? []).find(
    (e) => e?.role?.kind === "directional" && e.role?.direction === "from",
  );
  return donor?.ref?.dcid ?? null;
}

/**
 * Contract v1: a dataset_resubmit entry posts the complete edited `identity`
 * plus `base_spec_id`/`base_identity` (the prior spec being edited, verified
 * by hash) and, for a standard shape, `resolved_stat_var_dcids` (a sibling of
 * `identity`, not a member — pure graph state, never hashed into spec_id).
 * `extra="forbid"` on the wire rejects any top-level `shape`/`slots`/
 * `shape_id`/`donor_dcid`/`entity_dcids`/`requested_window` field outside
 * `identity`. Where/when/source are not identity slots — see
 * lib/contract/promote.ts's withResolvedSlotEdit for how an edit routes into
 * `identity`.
 */
export type SearchInput =
  | { kind: "raw_text"; query: string }
  | { kind: "spec_id"; spec_id: string }
  | {
      /** dataset_resubmit: every part of the current envelope at once (dfo-
       *  apis #593/#606). `entries` is 1 to 6, in response part order;
       *  `raw_query` echoes the originating typed query, when there was one. */
      kind: "dataset_resubmit";
      entries: DatasetResubmitEntry[];
      raw_query?: string;
    };

export function buildRequest(
  input: SearchInput,
  options?: boolean | ResolveOptions,
): ResolveRequest {
  const response_options: ResolveOptions =
    typeof options === "boolean"
      ? {
          include_sentence: true,
          include_option_coverage: options,
        }
      : {
          include_sentence: true,
          include_option_coverage: true,
          ...options,
        };

  return {
    schema_version: 1,
    input,
    response_options,
  };
}

/**
 * Incremental SSE frame parser. Feed it decoded text chunks (any split points);
 * it calls onFrame(eventName, data) per complete frame. Comment lines (": ping"
 * heartbeats) are skipped; multiple data: lines join with '\n' per the SSE spec.
 */
export function makeSseParser(onFrame: (event: string, data: string) => void) {
  let buf = "";
  return (chunk: string) => {
    buf += chunk;
    let idx: number;
    // Frames end at a blank line. The engine emits \n\n. Tolerate \r\n\r\n too.
    while ((idx = buf.search(/\n\n|\r\n\r\n/)) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + (buf[idx] === "\r" ? 4 : 2));
      let event = "message";
      const data: string[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (!line || line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
      if (data.length) onFrame(event, data.join("\n"));
    }
  };
}

// ---------------------------------------------------------------------------
// Options: on-demand slot alternatives (POST /api/search/options)
// ---------------------------------------------------------------------------

export type { BaseIdentity } from "../contract/types";

export type PlaceOptionsScope = "peers" | "children";

export type OptionsRequest = {
  schema_version?: number | string;
  identity?: BaseIdentity;
  for?: {
    role?: string;
    scope?: PlaceOptionsScope;
  };
  resolved_stat_var_dcids?: string[];
  // Backwards compatibility for callers sending placeOptions fields directly
  stat_var_dcids?: string[];
  anchor_dcid?: string;
  scope?: PlaceOptionsScope;
};

export type OptionItem = { dcid: string; label: string; value?: any };

export type OptionsResponse = { options: OptionItem[]; complete: boolean };

export type PlaceOptionsRequest = {
  stat_var_dcids?: string[];
  resolved_stat_var_dcids?: string[];
  anchor_dcid?: string;
  scope: PlaceOptionsScope;
  identity?: any;
};

export type PlaceOption = { dcid: string; label: string };

export type PlaceOptionsResponse = {
  options: PlaceOption[];
  complete: boolean;
};

/**
 * Extracts error message, typed machine-readable code, and JSON pointer from
 * an error payload. Supports:
 * - RFC 9457 Problem Details (`detail`, `title`, `type` e.g. `/codes/{code}`)
 * - FastAPI validation failures (`detail` as a list)
 * - Standard `{ detail, code }` objects
 *
 * `pointer` rides as a TOP-LEVEL field alongside type/title/status/detail/
 * code/trace_id (verified on dfo-dev): on a dataset_resubmit refusal it's
 * `/input/entries/{i}/...`, locating the entry at fault so a caller (the
 * store's editError) can key to that part instead of a page-level message.
 * Absent on a refusal the engine can't localise to one entry (e.g. entries
 * out of the 1..6 range).
 */
function parseErrorPayload(
  body: any,
  status: number,
): { detail: string; code: string | null; pointer: string | null } {
  let detail = `Search API ${status}`;
  let code: string | null = body?.code ?? null;
  const pointer: string | null =
    typeof body?.pointer === "string" ? body.pointer : null;

  if (!code && typeof body?.type === "string") {
    const match = body.type.match(/\/codes\/([a-zA-Z0-9_-]+)/);
    if (match) {
      code = match[1];
    }
  }

  const d = body?.detail ?? body?.title;
  if (typeof d === "string") {
    detail = d;
  } else if (d != null) {
    detail = JSON.stringify(d);
  }

  return { detail, code, pointer };
}

/** Buffered path: plain JSON request/response. Throws Error(detail) on non-2xx,
 * carrying the machine-readable `code` (when present) as `err.code`. */
export async function resolveBuffered(
  req: any,
  signal?: AbortSignal,
): Promise<any> {
  const payload =
    typeof req === "object" && req !== null && !("schema_version" in req)
      ? { schema_version: 1, ...req }
      : req;

  const res = await fetch(`${SEARCH_BASE}/api/search/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const { detail, code, pointer } = parseErrorPayload(body, res.status);
    const err = new Error(detail) as Error & {
      code?: string | null;
      pointer?: string | null;
    };
    err.code = code;
    err.pointer = pointer;
    throw err;
  }
  if (body == null)
    throw new Error("Search API returned an unparsable response");
  return normalizeResponse(body);
}

/**
 * Direct resolution of an existing spec_id via POST /api/search/resolve.
 */
export async function resolveSpecId(
  specId: string,
  options?: boolean | ResolveOptions,
  signal?: AbortSignal,
): Promise<ResolveResponse> {
  return resolveBuffered(
    buildRequest({ kind: "spec_id", spec_id: specId }, options),
    signal,
  );
}

/**
 * On-demand slot/place alternatives: calls POST /api/search/options with fallback
 * adapter to support legacy /api/search/place_options shapes.
 */
export async function searchOptions(
  req: OptionsRequest | PlaceOptionsRequest,
  signal?: AbortSignal,
): Promise<OptionsResponse> {
  // Normalize payload to dfo-apis V1 OptionsRequest
  const payload: Record<string, any> = {
    schema_version: 1,
    ...req,
  };

  // If passed legacy PlaceOptionsRequest format, populate canonical V1 fields
  if (
    "stat_var_dcids" in req &&
    req.stat_var_dcids &&
    !payload.resolved_stat_var_dcids
  ) {
    payload.resolved_stat_var_dcids = req.stat_var_dcids;
  }
  const scope = "scope" in req ? req.scope : (payload.for?.scope ?? "peers");
  let role = payload.for?.role ?? "observationAbout";
  if (role === "where") {
    role = "observationAbout";
  }
  payload.for = { role, scope };

  const anchorDcid =
    "anchor_dcid" in req
      ? req.anchor_dcid
      : (payload.identity?.anchor_dcid ?? "");
  if (req.identity) {
    payload.identity = {
      ...req.identity,
      ...(anchorDcid
        ? {
            entities: {
              ...req.identity.entities,
              observationAbout: [anchorDcid],
            },
          }
        : {}),
    };
  } else if (anchorDcid && !payload.identity?.entities?.observationAbout) {
    payload.identity = {
      identity_version: "spec1",
      shape: payload.identity?.shape ?? {
        kind: "statvar_schema",
        population_type: "Person",
        measured_property: "count",
        stat_type: "measuredValue",
      },
      slots: payload.identity?.slots ?? [],
      entities: { observationAbout: [anchorDcid] },
      requested_window: payload.identity?.requested_window ?? { kind: "all" },
      ...payload.identity,
    };
  }
  delete payload.stat_var_dcids;
  delete payload.anchor_dcid;
  delete payload.scope;

  const res = await fetch(`${SEARCH_BASE}/api/search/options`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const { detail, code } = parseErrorPayload(body, res.status);
    const err = new Error(detail) as Error & { code?: string | null };
    err.code = code;
    throw err;
  }
  if (body == null)
    throw new Error("Search API returned an unparsable response");

  let options: OptionItem[] = [];
  let complete = true;
  if (Array.isArray(body.options)) {
    options = body.options;
    complete = body.complete ?? true;
  } else if (body.options?.items && Array.isArray(body.options.items)) {
    options = body.options.items.map((item: any) => ({
      dcid: item.value?.ref?.dcid ?? item.dcid ?? "",
      label:
        item.value?.ref?.label ??
        item.label ??
        item.value?.literal ??
        item.dcid ??
        "",
      value: item.value,
    }));
    complete = !body.options.truncated;
  }

  return { options, complete };
}

/**
 * On-demand where-slot alternatives: lazy, fetched only when a user opens
 * the where editor, never as part of resolveBuffered/resolveStream. Adapts
 * to searchOptions calling POST /api/search/options with backwards
 * compatibility.
 */
export async function placeOptions(
  req: PlaceOptionsRequest,
  signal?: AbortSignal,
): Promise<PlaceOptionsResponse> {
  return searchOptions(req, signal);
}

/** Default inactivity ceiling between reader.read() completions (see
 *  resolveStream). The engine sends ': ping' heartbeat comments, so a
 *  healthy stream never goes this long between chunks. Exported so tests
 *  can assert the wired-through default without hardcoding the number
 *  twice. */
export const DEFAULT_STALL_TIMEOUT_MS = 45000;

/** Race a single reader.read() against an inactivity timer. Resolves
 *  'stalled' if the timer wins. Otherwise resolves the read result (or
 *  rejects with whatever reader.read() rejected with, e.g. AbortError on a
 *  user abort) and clears the timer either way, so nothing outlives one
 *  iteration. */
function readOrStall(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms: number,
): Promise<ReadableStreamReadResult<Uint8Array> | "stalled"> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve("stalled"), ms);
    reader.read().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Streaming path. Emits every parsed event through onEvent, including the
 * terminal done/error. Route-level failures (non-2xx JSON body, or a JSON
 * body where a stream was expected, meaning streaming is broken upstream)
 * are surfaced as synthetic 'error' / 'response' events so the timeline
 * shows them.
 *
 * `stallTimeoutMs` bounds the gap between reader.read() completions. A
 * silently dead connection (no engine error, no close, just nothing) would
 * otherwise spin the loading view forever. On a stall the reader is
 * cancelled and a synthetic 'error' event is emitted (STALL_TIMEOUT),
 * matching the route-level-failure treatment above. A user abort
 * (AbortSignal) is a different case: reader.read() rejects with
 * AbortError, and this just propagates it.
 */
export async function resolveStream(
  req: unknown,
  onEvent: (ev: SearchEvent) => void,
  signal?: AbortSignal,
  stallTimeoutMs: number = DEFAULT_STALL_TIMEOUT_MS,
): Promise<void> {
  const res = await fetch(`${SEARCH_BASE}/api/search/resolve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(req),
    signal,
  });
  const ctype = res.headers.get("content-type") ?? "";
  if (!res.ok || !ctype.includes("text/event-stream")) {
    const body = await res.json().catch(() => null);
    if (res.ok && body != null) {
      // Server ignored the Accept header, a gut-check finding in itself.
      onEvent({ kind: "response", response: normalizeResponse(body) });
      onEvent({
        kind: "error",
        detail:
          "expected text/event-stream, got buffered JSON — streaming broke upstream",
        code: "NOT_A_STREAM",
      });
    } else {
      const { detail, code, pointer } = parseErrorPayload(body, res.status);
      onEvent({
        kind: "error",
        detail,
        code,
        pointer,
      });
    }
    return;
  }
  if (!res.body) {
    onEvent({
      kind: "error",
      detail: "response has no body stream",
      code: null,
    });
    return;
  }
  const parse = makeSseParser((_event, data) => {
    // `kind` inside the payload duplicates the `event:` line. Trust the payload.
    try {
      const parsed = JSON.parse(data);
      if (parsed?.kind === "response" && parsed?.response) {
        parsed.response = normalizeResponse(parsed.response);
      }
      onEvent(parsed);
    } catch {
      onEvent({
        kind: "error",
        detail: `unparsable frame: ${data.slice(0, 200)}`,
        code: null,
      });
    }
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const result = await readOrStall(reader, stallTimeoutMs);
    if (result === "stalled") {
      await reader.cancel().catch(() => {});
      onEvent({
        kind: "error",
        detail: `Search stream stalled — no data received for ${stallTimeoutMs}ms.`,
        code: "STALL_TIMEOUT",
      });
      return;
    }
    if (result.done) break;
    parse(decoder.decode(result.value, { stream: true }));
  }
}

/**
 * Hand-rolled Server-Sent-Events parser over a fetch `ReadableStream`
 * (DESIGN.md §8): frames split on blank lines, multi-`data:` lines are
 * accumulated (joined with `\n`), `:` comment lines (keep-alives) and
 * `id:`/`retry:` fields are ignored. No reconnect logic in v1.
 */

import { WritConnectionError, WritError } from "./errors.js";

/** One parsed SSE frame: the `event:` name (if any) and the joined data. */
export interface SseFrame {
  event: string | null;
  data: string;
}

/**
 * Iterate the SSE frames of a `text/event-stream` body. Yields only frames
 * with a non-empty data buffer (per the SSE spec, an empty data buffer is not
 * dispatched — this silently swallows keep-alive comment frames). The reader
 * is cancelled when iteration stops early.
 */
export async function* iterateSseFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  let event: string | null = null;
  let dataLines: string[] = [];

  try {
    for (;;) {
      let chunk: { done: boolean; value: Uint8Array | undefined };
      try {
        const result = await reader.read();
        chunk = { done: result.done, value: result.value };
      } catch (err) {
        throw err instanceof WritError
          ? err
          : new WritConnectionError(`SSE stream failed: ${err instanceof Error ? err.message : String(err)}`, {
              cause: err,
            });
      }

      if (chunk.value !== undefined) {
        buf += decoder.decode(chunk.value, { stream: true });
      }
      if (chunk.done) {
        buf += decoder.decode();
      }

      let newline: number;
      while ((newline = buf.indexOf("\n")) >= 0) {
        let line = buf.slice(0, newline);
        buf = buf.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);

        if (line === "") {
          // Frame boundary: dispatch if the data buffer is non-empty.
          if (dataLines.length > 0) {
            yield { event, data: dataLines.join("\n") };
          }
          event = null;
          dataLines = [];
          continue;
        }
        if (line.startsWith(":")) continue; // comment / keep-alive

        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);

        switch (field) {
          case "event":
            event = value;
            break;
          case "data":
            dataLines.push(value);
            break;
          default:
            // `id:` / `retry:` / unknown fields — ignored.
            break;
        }
      }

      if (chunk.done) {
        // A final frame not terminated by a blank line still dispatches.
        if (dataLines.length > 0) {
          yield { event, data: dataLines.join("\n") };
        }
        return;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // already closed/errored — nothing to release
    }
  }
}

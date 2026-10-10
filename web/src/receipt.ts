/**
 * Signed receipts (CONTRACT.md §12.1) as the page receives them.
 *
 * The page never verifies a receipt and never edits one: it is signed over its canonical JSON,
 * and only the site's server can tell whether to trust it (`bridge.verify(receipt, ...)` in
 * `@usewrit/server` / Python `usewrit`). The library only makes a frozen JSON copy, so a listener
 * cannot change the object another listener, or the page bridge, forwards.
 */

import { cloneJsonValue, deepFreeze, isPlainObject } from "./json.js";
import type { WritReceipt } from "./types.js";

/** Deepest nesting a receipt has (the `device` and `writ` objects); copies stop well past it. */
const MAX_RECEIPT_DEPTH = 8;

/**
 * The receipt a call event carried, or null when there is none or it is not a JSON object.
 * Fields are not checked one by one: a newer Writ may sign a newer receipt shape, and the
 * server's verifier is the one that decides.
 */
export function parseReceipt(raw: unknown): WritReceipt | null {
  if (!isPlainObject(raw)) return null;
  try {
    return deepFreeze(cloneJsonValue(raw, "receipt", MAX_RECEIPT_DEPTH)) as unknown as WritReceipt;
  } catch {
    return null;
  }
}

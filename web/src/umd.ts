/**
 * Entry of the script-tag build (`dist/writ-web.iife.js`, built with esbuild):
 *
 * ```html
 * <script src="https://unpkg.com/@usewrit/web@0.2.0/dist/writ-web.iife.js"></script>
 * <script>
 *   const bridge = WritWeb.createWritBridge({ contract, app: "Arrivos", mode: "required" });
 * </script>
 * ```
 *
 * It defines `window.WritWeb` and nothing else. `window.writ` belongs to the extension and is
 * never touched.
 */

import {
  connectWrit,
  contractFunctions,
  createWritBridge,
  createWritClient,
  definePackage,
  isWritError,
  mountWritBanner,
  validateContract,
  VERSION,
  WritError,
} from "./index.js";

/** The `window.WritWeb` global of the script-tag build. */
export interface WritWebGlobal {
  readonly createWritBridge: typeof createWritBridge;
  readonly connectWrit: typeof connectWrit;
  readonly mountWritBanner: typeof mountWritBanner;
  readonly createWritClient: typeof createWritClient;
  readonly validateContract: typeof validateContract;
  readonly contractFunctions: typeof contractFunctions;
  readonly definePackage: typeof definePackage;
  readonly WritError: typeof WritError;
  readonly isWritError: typeof isWritError;
  readonly version: string;
}

const api: WritWebGlobal = Object.freeze({
  createWritBridge,
  connectWrit,
  mountWritBanner,
  createWritClient,
  validateContract,
  contractFunctions,
  definePackage,
  WritError,
  isWritError,
  version: VERSION,
});

(globalThis as unknown as { WritWeb?: WritWebGlobal }).WritWeb = api;

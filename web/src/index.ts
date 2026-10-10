/**
 * @usewrit/web: let a website run Writ workflows on the visitor's own computer, through the
 * Writ browser extension (`window.writ`).
 *
 * The recommended way is the Writ Bridge (CONTRACT.md §12): one object, the same calls as on
 * your server, with the banner shown by itself according to `mode`.
 *
 * ```ts
 * import { createWritBridge } from "@usewrit/web";
 * import contract from "./writ-contract.json";
 * import type { WritFunctions } from "./writ-functions";
 *
 * const bridge = createWritBridge<WritFunctions>({ contract, app: "Arrivos", mode: "required" });
 * const { data, venue } = await bridge.pos.receive({ invoice_no: "F-1029" });
 * ```
 *
 * Lower level, with the banner and the typed client yourself:
 *
 * ```ts
 * import { createWritClient, mountWritBanner } from "@usewrit/web";
 * import contract from "./writ-contract.json";
 * import type { WritFunctions } from "./writ-functions";
 *
 * mountWritBanner({
 *   app: "Arrivos",
 *   contract,
 *   onReady(session) {
 *     const pos = createWritClient<WritFunctions>(session, contract);
 *     pos.pos.receive({ invoice_no: "F-1029" }).result.then(({ data }) => showReceived(data));
 *   },
 * });
 * ```
 *
 * Linked workflows (CONTRACT.md §11) use the same code: the contract decides. One in `token` mode
 * needs `getRunToken` (on the bridge, the banner, `connect()` or the typed client).
 *
 * Wire contract: docs/browser-extension/CONTRACT.md §1, §8, §9, §10, §11, §12.
 */

export { connectWrit } from "./client.js";
export type { WritClient, WritSession } from "./client.js";
export type { WritCall } from "./call.js";
export {
  WritError,
  WRIT_ERROR_CODES,
  isWritError,
  isWritErrorCode,
} from "./errors.js";
export type { WritErrorCode, WritErrorOptions } from "./errors.js";
export { detectBrowser, installUrlFor } from "./discovery.js";
export { definePackage } from "./package.js";
export { validateContract, contractFunctions, createWritClient } from "./contract.js";
export type {
  ContractFunctionsOptions,
  WritClientFor,
  WritClientOptions,
  WritClientMethod,
  WritDynamicClient,
  WritFunctionMap,
  WritFunctionSpec,
  WritTypedClient,
} from "./contract.js";
export { createWritBridge } from "./bridge.js";
export type {
  WritBridge,
  WritBridgeBannerOptions,
  WritBridgeControls,
  WritBridgeFor,
  WritBridgeMethod,
  WritBridgeOptions,
  WritBridgeResult,
  WritBridgeStatus,
  WritBridgeVenue,
  WritBridgeWindow,
  WritDynamicBridge,
  WritTypedBridge,
} from "./bridge.js";
export type { WritBridgeChannelState } from "./bridge-channel.js";
export { mountWritBanner } from "./banner.js";
export type { WritBanner, WritBannerOptions, WritBannerWindow } from "./banner.js";
export { WRIT_BANNER_LOCALES } from "./banner-strings.js";
export type { WritBannerLocale } from "./banner-strings.js";
export {
  VERSION,
  WRIT_PROTOCOL,
  CHROME_WEB_STORE_URL,
  EDGE_ADDONS_URL,
  ANNOUNCE_PROVIDER_EVENT,
  REQUEST_PROVIDER_EVENT,
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  DEFAULT_CALL_TIMEOUT_MS,
  MIN_CALL_TIMEOUT_MS,
  MAX_CALL_TIMEOUT_MS,
  CALL_TIMEOUT_GRACE_MS,
  MAX_INPUT_BYTES,
  MAX_APP_NAME_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  FUNCTION_KEY_PATTERN,
  PACKAGE_FORMAT,
  PACKAGE_ID_PATTERN,
  MAX_PACKAGE_BYTES,
  MAX_PACKAGE_STEPS,
  MAX_PACKAGE_NAME_LENGTH,
  MAX_PACKAGE_CREDENTIALS,
  CREDENTIAL_KEY_PATTERN,
  MAX_PACKAGE_SETTINGS,
  SETTING_KEY_PATTERN,
  SETTING_KINDS,
  MAX_SUGGESTED_SETTINGS,
  MAX_SETTING_VALUE_LENGTH,
  MAX_LOCAL_NETWORK_HOSTS,
  REFUSED_PACKAGE_STEP_TYPES,
  CONTRACT_FORMAT,
  LINKED_PACKAGE_FORMAT,
  MANIFEST_FORMAT,
  DEFAULT_PUBLICATION_BASE,
  PUBLICATION_ID_PATTERN,
  PUBLISHABLE_KEY_PATTERN,
  RECIPE_CACHE_MODES,
  RUN_TOKEN_REFRESH_MARGIN_MS,
  WRIT_DESKTOP_URL,
  WRIT_BRIDGE_MODES,
  DEFAULT_BRIDGE_ENDPOINT,
  MAX_CHALLENGE_LENGTH,
} from "./constants.js";
export type {
  BrowserKind,
  CallEngine,
  CallEvent,
  CallOptions,
  CallResult,
  CallStatus,
  ConnectRequest,
  ConnectWritOptions,
  FunctionInput,
  FunctionMatch,
  FunctionRequest,
  GrantedFunction,
  GrantedPackage,
  JsonObject,
  JsonValue,
  NeedsUserReason,
  ResumeOptions,
  WritCallEventName,
  WritCallEvents,
  WritNavigator,
  WritProvider,
  WritProviderAnnouncement,
  WritProviderInfo,
  WritStatus,
  WritBridgeMode,
  WritCloudMapping,
  WritReceipt,
  WritContract,
  WritContractFunction,
  WritContractInput,
  WritContractPackage,
  WritContractSetting,
  WritLinkedAccess,
  WritLinkedOptions,
  WritLinkedPackage,
  WritManifest,
  WritManifestFunction,
  WritPublicationRef,
  WritRecipeCache,
  WritPackage,
  WritPackageCredential,
  WritPackageInput,
  WritPackageLocalNetwork,
  WritSetting,
  WritSettingKind,
  WritSettingSuggestions,
  WritSettingValues,
  WritUnavailable,
  WritWindow,
} from "./types.js";

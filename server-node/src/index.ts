/**
 * @usewrit/server: the server side of the Writ Bridge for Node. Run your website's Writ functions
 * on a signed-in user's own computer, with a signed receipt for every result, or on Writ Cloud,
 * from one typed object behind one route.
 *
 * ```ts
 * import express from "express";
 * import { createWritBridge } from "@usewrit/server";
 * import contract from "./writ-contract.json" with { type: "json" };
 * import type { WritFunctions } from "./writ-functions";
 *
 * const bridge = createWritBridge<WritFunctions>({ contract, mode: "required" });
 * const app = express();
 * app.all("/writ-bridge", bridge.express());
 * app.get("/me", (req, res) => res.json({ writToken: bridge.userToken(req.user.id) }));
 *
 * const { data } = await bridge.user(userId).pos.receive({ invoice_no: "F-1029" });
 * ```
 *
 * Linked workflows in `token` mode (CONTRACT.md §11) need a run token your backend mints:
 * `mintRunToken(process.env.WRIT_PUBLICATION_SECRET, { publication, sub })`.
 *
 * Wire contract: docs/browser-extension/CONTRACT.md §10, §11 (run tokens) and §12.
 */

export { createWritBridge } from "./bridge.js";
export type {
  WritBridge,
  WritBridgeCore,
  WritBridgeOptions,
  WritChallengeOptions,
  WritCloudCallOptions,
  WritUserCallOptions,
  WritVerifyOptions,
} from "./bridge.js";
export type { WritDevicePolicy, WritVerifyResult } from "./verify.js";
export {
  WritBridgeError,
  WRIT_BRIDGE_ERROR_CODES,
  isWritBridgeError,
  isWritBridgeErrorCode,
  defaultMessage,
} from "./errors.js";
export type { WritBridgeErrorCode, WritBridgeErrorOptions, WritBridgeOwnCode, WritVisitorCode } from "./errors.js";
export { validateContract, checkInputs, WRIT_BRIDGE_MODES } from "./contract.js";
export type {
  WritBridgeMethod,
  WritBridgeMode,
  WritCallResult,
  WritCloudMapping,
  WritContract,
  WritContractFunction,
  WritContractInput,
  WritContractPackage,
  WritContractSetting,
  WritDynamicFunctions,
  WritFunctionMap,
  WritFunctionSpec,
  WritFunctionsFor,
  WritNestedFunctions,
} from "./contract.js";
export { memoryStore } from "./store.js";
export type {
  MemoryStoreOptions,
  WritBridgeStore,
  WritCommand,
  WritCommandOutcome,
  WritDeviceCheck,
  WritPendingCommand,
  WritPresence,
  WritTakeOptions,
} from "./store.js";
export { redisStore } from "./redis-store.js";
export type { RedisStoreOptions, WritRedisClient } from "./redis-store.js";
export { canonicalJson, dataHash, inputsHash, sha256Hex } from "./canonical.js";
export { kidOf, parseReceipt, receiptSigningBytes, verifyReceiptSignature } from "./receipt.js";
export type { WritReceipt, WritReceiptDevice, WritReceiptOutcome } from "./receipt.js";
export { mintChallenge, mintUserToken, openToken, readChallenge, readUserToken, signToken } from "./tokens.js";
export type { WritChallengePayload, WritUserTokenPayload } from "./tokens.js";
export { mintRunToken } from "./run-token.js";
export type { MintRunTokenOptions, WritRunTokenClaims } from "./run-token.js";
export type { CloudPollTiming } from "./cloud.js";
export type { WritBridgeHandler, WritExpressMiddleware, WritNextHandlers } from "./adapters.js";
export type { JsonObject, JsonValue } from "./json.js";
export {
  VERSION,
  CONTRACT_FORMAT,
  DEFAULT_CLOUD_BASE,
  DEFAULT_POLL_SECONDS,
  PRESENCE_TTL_MS,
  DEFAULT_USER_TOKEN_TTL_SECONDS,
  DEFAULT_CHALLENGE_TTL_SECONDS,
  DEFAULT_RUN_TOKEN_TTL_SECONDS,
  MAX_RUN_TOKEN_TTL_SECONDS,
  MIN_SECRET_BYTES,
  DEFAULT_CALL_TIMEOUT_MS,
  MIN_CALL_TIMEOUT_MS,
  MAX_CALL_TIMEOUT_MS,
  MAX_INPUT_BYTES,
} from "./constants.js";

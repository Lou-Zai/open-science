// The ACP client layer's browser-safe barrel (#14, #25).
//
// `./stdio` is deliberately NOT re-exported here: it imports `child_process`, so
// pulling it into this barrel would break the webview bundle. Node callers
// import `@ai4s/sdk/acp/stdio` directly.
export { AcpRuntime, mapToolStatus, pickPermissionOption } from "./AcpRuntime";
export type { AcpRuntimeOptions } from "./AcpRuntime";
export {
  ACP_PROTOCOL_VERSION,
  JsonRpcError,
  JsonRpcPeer,
} from "./protocol";
export type {
  AcpAgentCapabilities,
  AcpAgentInfo,
  AcpAuthMethod,
  AcpCommand,
  AcpConfigOption,
  AcpConfigOptionValue,
  AcpConfigOptionsResult,
  AcpInitializeResult,
  AcpModelInfo,
  AcpNewSessionResult,
  AcpPermissionRequest,
  AcpPromptResult,
  AcpSessionCapabilities,
  AcpSessionInfo,
  AcpSessionListResult,
  AcpSessionNotification,
  AcpSessionUpdate,
  AcpToolCallUpdate,
  JsonRpcTransport,
  PeerHandlers,
} from "./protocol";
export type { OpenCodeEvent, PermissionReply, RuntimeStatus } from "../types";

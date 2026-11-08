/**
 * Tool-layer names for the single write-path policy.
 *
 * The policy itself (write roots from INDESIGN_MCP_WRITE_ROOTS, protected test
 * master, realpath normalisation and the Downloads rule: paths under a
 * "Downloads" folder are refused unless that Downloads folder, or a folder
 * inside it, is listed explicitly in INDESIGN_MCP_WRITE_ROOTS) lives in
 * src/bridge/safety.ts and is enforced by its isUnderWriteRoots /
 * assertSafeWritePath / assertSafeWriteDir and, in-script, by
 * __mcpIsWritablePath / __mcpAssertWritable. This module only re-exports it so
 * existing callers (textPipelineShared, batchC_layoutKit, export) compile
 * unchanged.
 */
export {
  downloadsBlockReason,
  isWritablePath,
  assertNotBlockedDownloads,
  writeRootKeysForScript,
} from "../bridge/safety.js";

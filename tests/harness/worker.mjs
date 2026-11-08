// Worker thread that hosts the compiled InDesign bridge + all tool handlers.
// The bridge uses execSync, which blocks the thread it runs on. Running it in a
// worker keeps the harness main thread free so a wall-clock guard can fire.
import { parentPort, workerData } from 'node:worker_threads';
import { InDesignBridge } from '../../dist/bridge/index.js';
import { registerDocumentTools } from '../../dist/tools/document.js';
import { registerPageTools } from '../../dist/tools/page.js';
import { registerTextTools } from '../../dist/tools/text.js';
import { registerStyleTools } from '../../dist/tools/style.js';
import { registerTableTools } from '../../dist/tools/table.js';
import { registerImageTools } from '../../dist/tools/image.js';
import { registerColorTools } from '../../dist/tools/color.js';
import { registerExportTools } from '../../dist/tools/export.js';
import { registerTemplateTools } from '../../dist/tools/template.js';
import { registerBatchTools } from '../../dist/tools/batch.js';
import { registerContentTools } from '../../dist/tools/content.js';
import { invokeTool } from '../../dist/bridge/toolDispatch.js';

const bridge = new InDesignBridge({ timeout: (workerData && workerData.bridgeTimeout) || 900000 });

// Build the name -> tool map exactly like src/index.ts loadAllTools()
const registry = new Map();
for (const mod of [
  registerDocumentTools(bridge),
  registerPageTools(bridge),
  registerTextTools(bridge),
  registerStyleTools(bridge),
  registerTableTools(bridge),
  registerImageTools(bridge),
  registerColorTools(bridge),
  registerExportTools(bridge),
  registerTemplateTools(bridge),
  registerBatchTools(bridge),
  registerContentTools(bridge),
]) {
  for (const [name, tool] of Object.entries(mod)) registry.set(name, tool);
}

parentPort.on('message', async (msg) => {
  if (msg.type === 'list') {
    parentPort.postMessage({ id: msg.id, ok: true, result: Array.from(registry.keys()) });
    return;
  }
  if (msg.type === 'connect') {
    try {
      const r = await bridge.connect();
      parentPort.postMessage({ id: msg.id, ok: true, result: r });
    } catch (e) {
      parentPort.postMessage({ id: msg.id, ok: false, error: String(e && e.message || e) });
    }
    return;
  }
  const tool = registry.get(msg.name);
  if (!tool) {
    parentPort.postMessage({ id: msg.id, ok: false, error: `Unknown tool: ${msg.name}` });
    return;
  }
  try {
    // Exactly the MCP CallTool path of src/index.ts: invokeTool binds document_id centrally
    // (AsyncLocalStorage) and maps failures to isError.
    const mcp = await invokeTool(tool, msg.args ?? {});
    const mcpText = mcp.content && mcp.content[0] ? mcp.content[0].text : '';
    let parsed;
    try { parsed = JSON.parse(mcpText); } catch { parsed = mcpText; }
    let result;
    if (mcp.isError) {
      // qa-r2-01: failures keep their diagnostic payload ({ok:false, error, code?, data?, raw?}) — pass data through.
      result = { success: false, error: parsed && typeof parsed === 'object' ? (parsed.error ?? parsed.message ?? mcpText) : mcpText, code: parsed && parsed.code, raw: parsed && parsed.raw, data: parsed && typeof parsed === 'object' ? parsed.data : undefined };
    } else {
      result = { success: true, data: parsed };
    }
    parentPort.postMessage({ id: msg.id, ok: true, result, mcpText, isError: !!mcp.isError });
  } catch (e) {
    parentPort.postMessage({ id: msg.id, ok: false, error: String(e && e.message || e), thrown: true });
  }
});

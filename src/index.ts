import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { InDesignBridge } from "./bridge/index.js";
import { invokeTool, withDocumentIdSchema, type ToolDef } from "./bridge/toolDispatch.js";
import { registerDocumentTools } from "./tools/document.js";
import { registerPageTools } from "./tools/page.js";
import { registerTextTools } from "./tools/text.js";
import { registerStyleTools } from "./tools/style.js";
import { registerTableTools } from "./tools/table.js";
import { registerImageTools } from "./tools/image.js";
import { registerColorTools } from "./tools/color.js";
import { registerExportTools } from "./tools/export.js";
import { registerTemplateTools } from "./tools/template.js";
import { registerBatchTools } from "./tools/batch.js";
import { registerContentTools } from "./tools/content.js";
import { registerExtractTools } from "./tools/extract.js";
import { registerMemoryTools } from "./tools/memory.js";
import { registerReviewTools } from "./domains/review/index.js";

const bridge = new InDesignBridge();

const toolRegistry = new Map<string, ToolDef>();

function loadAllTools() {
  const modules = [
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
    registerExtractTools(bridge),
    registerMemoryTools(),
    registerReviewTools(),
  ];

  for (const mod of modules) {
    for (const [name, tool] of Object.entries(mod)) {
      if (toolRegistry.has(name)) process.stderr.write(`[indesign-mcp] duplicate tool name '${name}' — later definition wins\n`);
      toolRegistry.set(name, tool as ToolDef);
    }
  }
}

async function main() {
  loadAllTools();

  const server = new Server(
    { name: "indesign-mcp-server", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Array.from(toolRegistry.entries()).map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: withDocumentIdSchema(name, t.inputSchema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolRegistry.get(name);
    if (!tool) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Unknown tool: ${name}`, code: "UNKNOWN_TOOL" }) }],
        isError: true,
      };
    }
    return invokeTool(tool, (args ?? {}) as Record<string, unknown>, name);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`Fatal: ${error}\n`);
  process.exit(1);
});

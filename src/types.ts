export interface ScriptResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface BridgeOptions {
  indesignVersion?: string;
  timeout?: number;
}

export interface DocumentInfo {
  name: string;
  fullName: string;
  saved: boolean;
  modified: boolean;
  pageCount: number;
  spreadCount: number;
  documentPreferences: {
    pageWidth: string;
    pageHeight: string;
    facingPages: boolean;
    pagesPerDocument: number;
  };
}

export interface PageInfo {
  id: number;
  name: string;
  bounds: number[];
  appliedMaster: string | null;
  pageItems: number;
}

export interface TextFrameInfo {
  id: number;
  contents: string;
  geometricBounds: number[];
  parentPage: string | null;
  overflows: boolean;
  nextTextFrame: number | null;
  previousTextFrame: number | null;
}

export interface StyleInfo {
  name: string;
  basedOn: string | null;
  fontFamily?: string;
  fontSize?: number;
  leading?: number | string;
}

export interface SwatchInfo {
  name: string;
  colorType: string;
  colorValue: number[];
  colorSpace: string;
}

export interface TableInfo {
  id: number;
  rowCount: number;
  columnCount: number;
  bodyRowCount: number;
  headerRowCount: number;
  footerRowCount: number;
}

export interface ImageInfo {
  id: number;
  name: string;
  filePath: string;
  actualPpi: number[];
  effectivePpi: number[];
  imageType: string;
  geometricBounds: number[];
}

export interface ExportPreset {
  name: string;
  format: string;
}

export type ToolCategory =
  | "document"
  | "page"
  | "text"
  | "style"
  | "table"
  | "image"
  | "color"
  | "export"
  | "import"
  | "template"
  | "batch"
  | "layout"
  | "production"
  | "utility";

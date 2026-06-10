export type OcrProviderName =
  | 'openrouter'
  | 'azure-document-intelligence'
  | 'google-document-ai'
  | 'tesseract';

export type OcrExtractInput = {
  fileName?: string | null;
  mimeType?: string | null;
  buffer: Buffer;
};

export type OcrExtractOutput = {
  text: string;
  provider: OcrProviderName;
  method: string;
};

export interface AzureDocumentIntelligenceClient {
  extractTextFromPdf(input: OcrExtractInput): Promise<OcrExtractOutput>;
}

export interface GoogleDocumentAiClient {
  extractTextFromPdf(input: OcrExtractInput): Promise<OcrExtractOutput>;
}

export interface TesseractClient {
  extractTextFromPdf(input: OcrExtractInput): Promise<OcrExtractOutput>;
}


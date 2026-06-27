/** One detected order carved out of a (possibly multi-order) document. */
export interface OrderChunk {
  /** 1-based position within the batch. */
  sequence: number;
  /** Client/external reference, e.g. "26TR001408-LT05". */
  externalReference: string | null;
  /** Invoice reference (BA number), when present. */
  invoiceReference: string | null;
  /** Only the text belonging to this order. */
  rawText: string;
  /** Deterministic fields derived from the client profile for this chunk. */
  derivedFields: Record<string, string>;
}

export interface SplitResult {
  /** True only when more than one order was detected. */
  isBatch: boolean;
  /** Which engine produced the result: a profile strategy, our heuristic, or single. */
  source: 'derix-tr-lt' | 'heuristic' | 'single';
  reason: string;
  orders: OrderChunk[];
}

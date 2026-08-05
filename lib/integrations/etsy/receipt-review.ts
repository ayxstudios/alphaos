export type EtsyVariationPair = {
  label: string;
  value: string;
};

export type EtsyReviewTransaction = {
  id: string | null;
  title: string | null;
  quantity: number | null;
  fulfillment: "physical" | "digital" | null;
  expectedShipDateIso: string | null;
  variations: EtsyVariationPair[];
  personalization: string | null;
  figureCount: number | null;
  productAttributes: EtsyVariationPair[];
  productCategory: string | null;
};

export type EtsyReceiptReview = {
  receiptNumber: string | null;
  buyerName: string | null;
  buyerEmail: string | null;
  orderDateIso: string | null;
  expectedShipDateIso: string | null;
  buyerNote: string | null;
  transactions: EtsyReviewTransaction[];
  inferredFigureCount: number | null;
  inferredFulfillment: "physical" | "digital" | null;
  inferredProductCategory: string | null;
  combinedPersonalization: string | null;
};

export type SavedOrderDetails = {
  customerName?: string | null;
  customerEmail?: string | null;
  figureCount?: number | null;
  style?: string | null;
  productTitle?: string | null;
  productType?: "physical" | "digital" | null;
  notes?: string | null;
  photoCount?: number | null;
};

export type EtsyReviewDefaults = {
  customerName: string;
  customerEmail: string;
  figureCount: string;
  style: string;
  productTitle: string;
  productType: "physical" | "digital";
  notes: string;
};

export type MissingField = "Customer email" | "Style" | "Reference photos";

const FIGURE_LABELS = new Set([
  "number of pets",
  "number of people",
  "number of figures",
  "figures",
]);

const PRODUCT_ATTRIBUTE_LABELS = [
  /size/i,
  /print on/i,
  /background/i,
  /paper/i,
  /canvas/i,
  /frame/i,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function unixToIso(value: unknown): string | null {
  const n = asNumber(value);
  if (!n || n <= 0) return null;
  const date = new Date(n * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function firstInteger(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(/\d+/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseVariations(value: unknown): EtsyVariationPair[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => {
    if (!isRecord(v)) return [];
    const label = asString(v.formatted_name);
    const rawValue = asString(v.formatted_value);
    if (!label || !rawValue) return [];
    return [{ label: label.replace(/:$/, "").trim(), value: rawValue }];
  });
}

function extractFigureCount(variations: EtsyVariationPair[]): number | null {
  for (const variation of variations) {
    if (FIGURE_LABELS.has(variation.label.toLowerCase())) {
      const n = firstInteger(variation.value);
      if (n) return n;
    }
  }
  return null;
}

function productAttributes(variations: EtsyVariationPair[]): EtsyVariationPair[] {
  return variations.filter((variation) =>
    PRODUCT_ATTRIBUTE_LABELS.some((pattern) => pattern.test(variation.label)),
  );
}

export function inferProductCategory(title: string | null, variations: EtsyVariationPair[] = []): string | null {
  const haystack = [title, ...variations.flatMap((v) => [v.label, v.value])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (!haystack) return null;
  if (/\bmug|cup\b/.test(haystack)) return "Mug";
  if (/\bcanvas\b/.test(haystack)) return "Canvas";
  if (/\bposter|print\b/.test(haystack)) return "Print";
  if (/\bframe|framed\b/.test(haystack)) return "Frame";
  if (/\bpillow\b/.test(haystack)) return "Pillow";
  if (/\bshirt|t-shirt|tee\b/.test(haystack)) return "T-Shirt";
  return null;
}

function transactionId(tx: Record<string, unknown>): string | null {
  const id = asNumber(tx.transaction_id);
  return id == null ? null : String(id);
}

export function parseEtsyReceiptReview(rawImport: unknown): EtsyReceiptReview {
  if (!isRecord(rawImport)) {
    return emptyReview();
  }

  const rawTransactions = Array.isArray(rawImport.transactions)
    ? rawImport.transactions
    : [];
  const transactions: EtsyReviewTransaction[] = rawTransactions.flatMap((rawTx) => {
    if (!isRecord(rawTx)) return [];
    const title = asString(rawTx.title);
    const quantity = asNumber(rawTx.quantity);
    const fulfillment =
      typeof rawTx.is_digital === "boolean"
        ? rawTx.is_digital ? "digital" : "physical"
        : null;
    const variations = parseVariations(rawTx.variations);
    const personalization =
      variations.find((v) => v.label.toLowerCase() === "personalization")?.value ?? null;
    const figureCount = extractFigureCount(variations);
    return [{
      id: transactionId(rawTx),
      title,
      quantity: quantity == null ? null : Math.floor(quantity),
      fulfillment,
      expectedShipDateIso: unixToIso(rawTx.expected_ship_date),
      variations,
      personalization,
      figureCount,
      productAttributes: productAttributes(variations),
      productCategory: inferProductCategory(title, variations),
    }];
  });

  const expectedShipDateIso =
    transactions.map((t) => t.expectedShipDateIso).find(Boolean) ?? null;
  const figureCounts = transactions
    .map((t) => t.figureCount)
    .filter((n): n is number => typeof n === "number");
  const categories = transactions
    .map((t) => t.productCategory)
    .filter((p): p is string => !!p);
  const personalizations = transactions
    .map((t) => t.personalization)
    .filter((p): p is string => !!p);
  const fulfillments = transactions
    .map((t) => t.fulfillment)
    .filter((f): f is "physical" | "digital" => !!f);

  return {
    receiptNumber: asNumber(rawImport.receipt_id) != null ? String(asNumber(rawImport.receipt_id)) : null,
    buyerName: asString(rawImport.name),
    buyerEmail: asString(rawImport.buyer_email),
    orderDateIso: unixToIso(rawImport.created_timestamp ?? rawImport.create_timestamp),
    expectedShipDateIso,
    buyerNote: asString(rawImport.message_from_buyer ?? rawImport.message_from_payment),
    transactions,
    inferredFigureCount: figureCounts.length === 1 ? figureCounts[0] : null,
    inferredFulfillment:
      fulfillments.length > 0 && fulfillments.every((f) => f === "digital")
        ? "digital"
        : fulfillments.length > 0
          ? "physical"
          : null,
    inferredProductCategory:
      categories.length > 0 && categories.every((p) => p === categories[0])
        ? categories[0]
        : null,
    combinedPersonalization: personalizations.length ? personalizations.join("\n\n") : null,
  };
}

export function reviewDefaults(
  review: EtsyReceiptReview,
  saved: SavedOrderDetails = {},
): EtsyReviewDefaults {
  return {
    customerName: saved.customerName?.trim() || review.buyerName || "",
    customerEmail: saved.customerEmail?.trim() || review.buyerEmail || "",
    figureCount:
      typeof saved.figureCount === "number" && saved.figureCount > 0
        ? String(saved.figureCount)
        : review.inferredFigureCount
          ? String(review.inferredFigureCount)
          : "",
    style: saved.style?.trim() || "",
    productTitle: saved.productTitle?.trim() || review.inferredProductCategory || "",
    productType: saved.productType ?? review.inferredFulfillment ?? "physical",
    notes: saved.notes?.trim() || review.combinedPersonalization || review.buyerNote || "",
  };
}

export function missingReviewFields(input: {
  customerEmail?: string | null;
  style?: string | null;
  photoCount?: number | null;
}): MissingField[] {
  const missing: MissingField[] = [];
  if (!input.customerEmail?.trim()) missing.push("Customer email");
  if (!input.style?.trim()) missing.push("Style");
  if (!input.photoCount || input.photoCount <= 0) missing.push("Reference photos");
  return missing;
}

function emptyReview(): EtsyReceiptReview {
  return {
    receiptNumber: null,
    buyerName: null,
    buyerEmail: null,
    orderDateIso: null,
    expectedShipDateIso: null,
    buyerNote: null,
    transactions: [],
    inferredFigureCount: null,
    inferredFulfillment: null,
    inferredProductCategory: null,
    combinedPersonalization: null,
  };
}

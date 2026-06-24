import "./env.js"; // must run before any process.env access

// ---------------------------------------------------------------------------
// Embedding model config — single source of truth.
// Both ingest and query MUST use the same model and size.
// ---------------------------------------------------------------------------
export const MODEL_DIMENSIONS = {
  "voyage-3.5":      1024,
  "voyage-3.5-lite":  512,
  "voyage-4":        1024,
  "voyage-4-lite":   1024,
};

export const EMBEDDING_MODEL = process.env.VOYAGE_MODEL || "voyage-3.5";

if (!MODEL_DIMENSIONS[EMBEDDING_MODEL]) {
  console.warn(
    `[config] Unknown VOYAGE_MODEL "${EMBEDDING_MODEL}" — assuming 1024 dims. Update MODEL_DIMENSIONS if needed.`
  );
}

export const EXPECTED_DENSE_SIZE = MODEL_DIMENSIONS[EMBEDDING_MODEL] ?? 1024;

// ---------------------------------------------------------------------------
// Qdrant
// ---------------------------------------------------------------------------
export const COLLECTION = process.env.QDRANT_COLLECTION || "investment_memos";

// ---------------------------------------------------------------------------
// File upload / MIME
// ---------------------------------------------------------------------------
export const ALLOWED_EXTENSIONS = new Set([".pdf", ".txt", ".md"]);

export const MIME_MAP = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md":  "text/markdown",
};

export const ALLOWED_S3_EXTENSIONS = new Set([".pdf", ".txt", ".md", ".docx"]);

// ---------------------------------------------------------------------------
// S3
// ---------------------------------------------------------------------------
export const S3_BUCKET   = process.env.S3_BUCKET;
export const S3_PREFIX   = "uploads/";
export const PRESIGN_TTL = 300; // seconds

// ---------------------------------------------------------------------------
// Meta-query tags — financial topics used to annotate each chunk.
// Stored in the Qdrant payload so Dify can filter/rank by topic.
// ---------------------------------------------------------------------------
export const META_QUERY_TAGS = [
  "revenue","sales_growth","net_income","gross_profit","operating_profit",
  "ebit","ebitda","profit_margin","gross_margin","operating_margin",
  "cash_flow","operating_cash_flow","free_cash_flow","investing_cash_flow",
  "financing_cash_flow","capital_expenditure","working_capital","liquidity",
  "current_ratio","quick_ratio","debt","short_term_debt","long_term_debt",
  "interest_expense","leverage","credit_rating","assets","current_assets",
  "fixed_assets","inventory","accounts_receivable","accounts_payable",
  "equity","shareholders_equity","retained_earnings","dividends",
  "share_buybacks","earnings_per_share","valuation","market_cap",
  "enterprise_value","price_to_earnings","price_to_book","price_to_sales",
  "guidance","forecast","financial_targets","growth_strategy",
  "investment_strategy","mergers_acquisitions","acquisition","divestiture",
  "business_segments","geographic_revenue","customers","customer_concentration",
  "suppliers","competition","market_share","risk_factors","regulatory_risk",
  "legal_risk","cybersecurity_risk","operational_risk","liquidity_risk",
  "credit_risk","interest_rate_risk","foreign_exchange_risk","inflation_risk",
  "sustainability","esg","carbon_emissions","governance","executive_compensation",
  "board_of_directors","shareholder_meeting","tax","effective_tax_rate",
  "research_and_development","innovation","artificial_intelligence",
  "technology_investment","cloud_business","subscription_revenue",
  "recurring_revenue","cost_reduction","restructuring","layoffs","headcount",
  "employee_costs","earnings_call","quarterly_results","annual_report",
  "investor_relations",
];

export const META_QUERY_TAG_SET = new Set(META_QUERY_TAGS);

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
export const ALLOWED_DOMAIN  = "collider.vc";
export const ALLOWED_EMAILS  = new Set(["devtop411@gmail.com"]);

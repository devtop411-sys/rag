# RAG Demo — PDF → Voyage AI → Qdrant → Dify

A minimal RAG pipeline: upload a PDF, index it into Qdrant with Voyage AI embeddings, and ask questions via Dify (you choose the LLM inside Dify).

---

## Quick Start

### 1. Configure environment

Copy `.env` and fill in your API keys:

```env
PORT=3001

VOYAGE_API_KEY=your_voyage_api_key

QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=
QDRANT_COLLECTION=investment_memos
```

### 2. Start Qdrant

```bash
docker run -p 6333:6333 -p 6334:6334 \
  -v qdrant_storage:/qdrant/storage \
  qdrant/qdrant
```

### 3. Install dependencies

```bash
npm install
```

### 4. Start the backend

```bash
npm run dev
```

### 5. Upload a PDF

```bash
curl -X POST http://localhost:3001/ingest \
  -F "file=@investment-memo.pdf" \
  -F "source=investment-memo.pdf"
```

### 6. Test retrieval

```bash
curl -X POST http://localhost:3001/retrieve \
  -H "Content-Type: application/json" \
  -d '{"query": "What is the investment thesis?", "topK": 5}'
```

### 7. Expose to Dify Cloud via ngrok

```bash
ngrok http 3001
```

Use the generated HTTPS URL in Dify's HTTP Request node.

---

## API Reference

### `POST /ingest`

Upload and index a PDF file.

| Field | Type | Required |
|---|---|---|
| `file` | PDF (multipart) | Yes |
| `source` | string | No |

**Response:**
```json
{ "ok": true, "document_id": "uuid", "source": "...", "chunks": 42 }
```

---

### `POST /retrieve`

Retrieve the most relevant chunks for a query.

```json
{ "query": "...", "topK": 5, "source": "optional-filter" }
```

**Response:** returns `matches` array and a formatted `context` string ready for Dify.

---

## Dify Workflow

```
Start (query variable)
  ↓
HTTP Request → POST /retrieve → extract body.context
  ↓
LLM (any model in Dify) — system prompt + {{query}} + {{Retrieve Context.body.context}}
  ↓
Answer
```

System prompt for the LLM node:
```
You are a strict document QA assistant.
Answer only using the retrieved context.
If the context does not contain the answer, say:
"I don't have enough information in the provided document."
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Dify cannot reach localhost | Run `ngrok http 3001` and use the HTTPS URL |
| Empty text from PDF | PDF is a scanned image — use OCR (Tesseract, AWS Textract) |
| Bad retrieval quality | Adjust `chunkSize` (800–1500) / `chunkOverlap` (150–300) / `topK` (5–8) |
| Vector size mismatch | `curl -X DELETE http://localhost:6333/collections/investment_memos` then re-ingest |

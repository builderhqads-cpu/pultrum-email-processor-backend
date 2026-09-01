# docling-service

Document-extraction microservice: PDF / DOCX / XLSX → clean structured text
(Markdown, tables included) via [docling](https://github.com/DS4SD/docling). The
NestJS backend calls it over HTTP; it is internal-only (no public port).

## Endpoints

- `GET  /health` → `{ "status": "ok", "ocr": false }`
- `POST /extract` → multipart file upload → `{ filename, format, ocr, chars, text }`
- `POST /extract-base64` → `{ filename, contentBase64 }` → same result (used by the backend)

## Config

- `DOCLING_OCR` (default `false`) — OCR is only needed for **scanned** PDFs and is
  heavy. Order documents are digital text, so it stays off.

## Run (local)

Part of the local `docker-compose.yml`:

```bash
docker compose up -d --build docling
curl http://localhost:8000/health
curl -F "file=@some.pdf" http://localhost:8000/extract
```

> First build pulls docling + torch (image is several GB). The first request
> downloads the models (~GBs) into the `docling_models` volume; later runs reuse it.

## Notes

- Same image serves local, EasyPanel and the Pultrum VM — only the caller's
  `DOCLING_URL` changes (`http://localhost:8000` locally, `http://docling:8000`
  inside a compose/EasyPanel network).

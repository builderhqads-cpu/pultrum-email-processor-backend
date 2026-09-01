"""
Pultrum document-extraction microservice.

Turns an uploaded PDF / DOCX / XLSX into clean, structured text (Markdown, tables
included) using docling. The NestJS backend calls this over HTTP on the internal
network; nothing here is public.

OCR is heavy and only needed for SCANNED PDFs. Order documents (Dispolisten,
Transport Orders, ...) are digital text, so OCR is OFF by default (much faster,
lighter). Turn it on with DOCLING_OCR=true if scanned files start arriving.
"""

import base64
import os
import tempfile
from contextlib import suppress

from fastapi import FastAPI, File, HTTPException, UploadFile
from pydantic import BaseModel

from docling.document_converter import DocumentConverter, PdfFormatOption
from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions

def _bool_env(name: str, default: str) -> bool:
    return os.getenv(name, default).strip().lower() in {"1", "true", "yes", "on"}


DO_OCR = _bool_env("DOCLING_OCR", "false")
# Table structure forces a grid. For dense / irregular planning tables
# (Dispolisten) turning it OFF gives linear reading-order text, which an LLM
# often parses better than a broken grid. Default on; toggle via env.
DO_TABLE = _bool_env("DOCLING_TABLE_STRUCTURE", "true")

_pdf_opts = PdfPipelineOptions()
_pdf_opts.do_ocr = DO_OCR
_pdf_opts.do_table_structure = DO_TABLE

# Built once at startup and reused (loading the models per request would be slow).
_converter = DocumentConverter(
    format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=_pdf_opts)}
)

app = FastAPI(title="Pultrum docling extractor", version="1.0.0")


class ExtractBase64(BaseModel):
    filename: str
    contentBase64: str


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "ocr": DO_OCR, "table_structure": DO_TABLE}


@app.post("/extract")
async def extract(file: UploadFile = File(...)) -> dict:
    """Multipart upload → structured text."""
    data = await file.read()
    return _run(data, file.filename or "upload")


@app.post("/extract-base64")
def extract_base64(body: ExtractBase64) -> dict:
    """Base64 body → structured text (what the NestJS backend uses; it already
    stores attachments as base64)."""
    try:
        data = base64.b64decode(body.contentBase64, validate=False)
    except Exception:  # noqa: BLE001 - report a clean 400, keep the API up
        raise HTTPException(status_code=400, detail="invalid base64")
    return _run(data, body.filename or "upload")


def _run(data: bytes, filename: str) -> dict:
    if not data:
        raise HTTPException(status_code=400, detail="empty file")

    # docling detects the format by extension, so keep the original suffix.
    suffix = os.path.splitext(filename)[1] or ".bin"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        tmp.write(data)
        tmp.flush()
        tmp.close()

        result = _converter.convert(tmp.name)
        markdown = result.document.export_to_markdown() or ""
        return {
            "filename": filename,
            "format": "markdown",
            "ocr": DO_OCR,
            "chars": len(markdown),
            "text": markdown,
        }
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - never crash the service on one bad file
        raise HTTPException(status_code=422, detail=f"extraction failed: {exc}")
    finally:
        with suppress(OSError):
            os.unlink(tmp.name)

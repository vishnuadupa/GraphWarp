"""Tiny conversion sidecar: any file in -> Markdown text out, via Microsoft's
markitdown. Called by the Next.js Inngest pipeline for every uploaded document
format (docx, pdf, txt, csv, xlsx, xls) so the app has one converter instead
of a parser per format.
"""
import os
import tempfile

from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from markitdown import MarkItDown

SERVICE_TOKEN = os.environ.get("MARKITDOWN_SERVICE_TOKEN")

app = FastAPI(title="markitdown-service")
converter = MarkItDown()


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/convert")
async def convert(
    file: UploadFile = File(...),
    x_service_token: str | None = Header(default=None),
):
    if SERVICE_TOKEN and x_service_token != SERVICE_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid or missing service token")

    suffix = os.path.splitext(file.filename or "")[1]
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    try:
        result = converter.convert(tmp_path)
    except Exception as exc:  # noqa: BLE001 — surfaced as a client error, file may be corrupt/unsupported
        raise HTTPException(status_code=422, detail=f"Conversion failed: {exc}") from exc
    finally:
        os.unlink(tmp_path)

    return {"markdown": result.text_content}

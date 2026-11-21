import hashlib
import json
import re
import unicodedata
from pathlib import Path

LABELS = {"soporte_tecnico", "facturacion", "consulta_planes", "cancelacion", "portabilidad"}
# Identifiers are redacted without removing short error codes such as E-202.
def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).lower()
    text = re.sub(r"[\w.+-]+@[\w.-]+\.[a-z]{2,}", " <email> ", text)
    text = re.sub(r"(?<!\w)\+?\d[\d .()-]{7,}\d(?!\w)", " <id> ", text)
    return " ".join(text.split())

def group(text: str) -> str:
    return re.sub(r"\d+", "#", normalize(text))

def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()

def load_bundle(path: Path):
    import skops.io as sio
    manifest = json.loads((path / "manifest.json").read_text())
    model_bytes = (path / "model.skops").read_bytes()
    if digest(model_bytes) != manifest["sha256"] or manifest.get("mode") != "shadow":
        raise ValueError("bundle checksum or mode invalid")
    # Explicit allowlist: never trust arbitrary types supplied by the bundle.
    allowed = {"sklearn.pipeline.Pipeline", "sklearn.feature_extraction.text.TfidfVectorizer", "sklearn.feature_extraction.text.TfidfTransformer", "sklearn.linear_model._logistic.LogisticRegression"}
    unknown = set(sio.get_untrusted_types(data=model_bytes))
    if unknown - allowed:
        raise ValueError("unapproved model types")
    model = sio.loads(model_bytes, trusted=sorted(unknown))
    if not manifest.get("signature") or set(model.classes_) != LABELS or manifest.get("labels") != sorted(LABELS):
        raise ValueError("invalid model signature")
    return model, manifest

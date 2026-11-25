"""Initialize the demo's two MLflow models from private synthetic inputs."""
import hashlib
import os
from pathlib import Path
import subprocess
import sys
from urllib.request import urlopen

from app.e5 import ENCODER_FILES, ENCODER_REVISION


def fetch_encoder_files(encoder):
    for name, expected in ENCODER_FILES.items():
        path = encoder / name
        if path.is_file():
            with path.open("rb") as existing:
                if hashlib.file_digest(existing, "sha256").hexdigest() == expected:
                    continue

        partial = path.with_suffix(".partial")
        url = f"https://huggingface.co/intfloat/multilingual-e5-small/resolve/{ENCODER_REVISION}/onnx/{name}"
        checksum = hashlib.sha256()
        with urlopen(url, timeout=120) as response, partial.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
                checksum.update(chunk)
        if checksum.hexdigest() != expected:
            raise ValueError(f"Unexpected SHA-256 for {name}")
        partial.replace(path)


if __name__ == "__main__":
    releases = Path("/models/releases")
    if all((releases / model / "manifest.json").is_file() for model in ("intent-e5-svm-1", "churn-logistic-1")):
        sys.exit(0)

    fetch_encoder_files(Path("/encoder"))
    os.execv(sys.executable, [
        sys.executable, "-m", "app.train_advisory",
        "--tickets", "/inputs/ml/data/tickets.csv",
        "--clients", "/inputs/ml/data/clientes_churn.csv",
        "--encoder-dir", "/encoder",
        "--output", str(releases),
    ])

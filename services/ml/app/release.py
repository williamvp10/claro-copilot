"""Resolve an exact registry version, validate it and atomically publish an immutable bundle."""
import argparse
import json
import os
import shutil
import tempfile
from pathlib import Path
import mlflow
from .common import LABELS, canonical, digest, load_bundle


def release(name: str, version: str, output: str):
    if not version.isdecimal() or int(version) < 1:
        raise ValueError("version must be a positive numeric registry version")
    client = mlflow.MlflowClient()
    registered = client.get_model_version(name, version)
    output = Path(output)
    if output.exists():
        raise FileExistsError("release directory already exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent) as temp:
        root = Path(temp)
        downloaded = Path(mlflow.artifacts.download_artifacts(artifact_uri=f"models:/{name}/{version}", dst_path=str(root)))
        meta = (downloaded / "MLmodel").read_text()
        metadata = mlflow.models.Model.load(str(downloaded / "MLmodel"))
        if "skops" not in meta or metadata.signature is None:
            raise ValueError("model lacks skops format or signature")
        files = list(downloaded.glob("*.skops"))
        if len(files) != 1:
            raise ValueError("expected one skops model")
        bundle = root / "bundle"; bundle.mkdir()
        shutil.copyfile(files[0], bundle / "model.skops")
        evaluation = Path(mlflow.artifacts.download_artifacts(run_id=registered.run_id, artifact_path="evaluation/evaluation.json", dst_path=str(root)))
        shutil.copyfile(evaluation, bundle / "evaluation.json")
        manifest = {"model_name":name, "model_version":str(version), "run_id":registered.run_id, "experiment_id":client.get_run(registered.run_id).info.experiment_id, "sha256":digest((bundle/"model.skops").read_bytes()), "evaluation_sha256":digest((bundle/"evaluation.json").read_bytes()), "labels":sorted(LABELS), "signature":metadata.signature.to_dict(), "mode":"shadow", "image_digest":os.getenv("ML_IMAGE_DIGEST", "unknown")}
        (bundle / "manifest.json").write_bytes(canonical(manifest))
        load_bundle(bundle)
        os.rename(bundle, output)
    return manifest

if __name__ == "__main__":
    p=argparse.ArgumentParser(); p.add_argument("version"); p.add_argument("output"); p.add_argument("--model-name",default="claro_copiloto_intencion")
    a=p.parse_args(); print(json.dumps(release(a.model_name,a.version,a.output)))

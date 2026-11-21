"""Train from a read-only CSV and register an MLflow version; no source rows are logged."""
import argparse
import hashlib
import json
import os
import tempfile
from pathlib import Path

import mlflow
import skops.io as sio
from mlflow.models import Model
import pandas as pd
from mlflow.models import infer_signature
from sklearn.dummy import DummyClassifier
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report, confusion_matrix, f1_score
from sklearn.model_selection import StratifiedGroupKFold
from sklearn.pipeline import make_pipeline
from .common import LABELS, canonical, digest, group, normalize


def pipeline():
    return make_pipeline(TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True), LogisticRegression(C=1, solver="lbfgs", class_weight="balanced", max_iter=1000))


def train(csv_path: str, model_name: str = "claro_copiloto_intencion"):
    raw = Path(csv_path).read_bytes()
    df = pd.read_csv(csv_path, dtype=str).fillna("")
    if not {"descripcion", "categoria"}.issubset(df.columns):
        raise ValueError("CSV requires descripcion and categoria")
    before = len(df)
    df = df.drop_duplicates().reset_index(drop=True)
    duplicates = before - len(df)
    df = df[["descripcion", "categoria"]].copy()
    df["descripcion"] = df.descripcion.map(normalize)
    df["categoria"] = df.categoria.str.strip().str.lower()
    if set(df.categoria) != LABELS or (df.descripcion == "").any():
        raise ValueError("expected five domain labels and nonempty descriptions")
    df["group"] = df.descripcion.map(group)
    conflicts = df.groupby("group").categoria.nunique()
    excluded = set(conflicts[conflicts > 1].index)
    # Preserve ambiguous groups for an honest evaluation, keeping every group in one fold.
    # Their hashed identities and label counts are reported for human review.
    folds = None
    for n in range(5, 1, -1):
        candidate = list(StratifiedGroupKFold(n_splits=n, shuffle=True, random_state=42).split(df.descripcion, df.categoria, df.group))
        if all(set(df.categoria.iloc[a]) == LABELS and set(df.categoria.iloc[b]) == LABELS for a,b in candidate):
            folds = candidate
            break
    if not folds:
        raise ValueError("insufficient grouped coverage for evaluation")
    y, baseline = [None] * len(df), [None] * len(df)
    per_fold, manifest = [], []
    for i, (tr, te) in enumerate(folds):
        model, dummy = pipeline(), DummyClassifier(strategy="most_frequent")
        model.fit(df.descripcion.iloc[tr], df.categoria.iloc[tr]); dummy.fit(df.descripcion.iloc[tr], df.categoria.iloc[tr])
        pred, base = model.predict(df.descripcion.iloc[te]), dummy.predict(df.descripcion.iloc[te])
        for idx, p, b in zip(te, pred, base): y[idx], baseline[idx] = p, b
        per_fold.append({"fold": i, "macro_f1": f1_score(df.categoria.iloc[te], pred, average="macro")})
        manifest.append({"fold": i, "test_groups_sha256": sorted(digest(x.encode()) for x in set(df.group.iloc[te]))})
    labels = sorted(LABELS)
    report = classification_report(df.categoria, y, labels=labels, output_dict=True, zero_division=0)
    metrics = {"macro_f1": report["macro avg"]["f1-score"], "baseline_macro_f1": f1_score(df.categoria, baseline, average="macro"), "cancelacion_recall": report["cancelacion"]["recall"]}
    model = pipeline().fit(df.descripcion, df.categoria)
    mlflow.set_experiment("claro-intent")
    with mlflow.start_run() as run:
        mlflow.log_params({"dataset_sha256": digest(raw), "folds": len(folds), "rows_input": before, "rows_deduplicated": duplicates, "conflicting_groups": len(excluded), "conflict_policy": "retain_grouped_for_review", "git_sha": os.getenv("GIT_SHA", "unknown"), "vectorizer": "tfidf_1_2", "class_weight": "balanced"})
        mlflow.log_metrics(metrics)
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            (p/"evaluation.json").write_bytes(canonical({"metrics":metrics, "per_fold":per_fold, "classification_report":report, "confusion_matrix":confusion_matrix(df.categoria, y, labels=labels).tolist(), "labels": labels}))
            (p/"folds.json").write_bytes(canonical(manifest))
            (p/"conflicts.json").write_bytes(canonical([{ "group_sha256":digest(g.encode()), "labels": sorted(df.loc[df.group == g, "categoria"].unique().tolist()), "rows": int((df.group == g).sum()) } for g in sorted(excluded)]))
            mlflow.log_artifacts(tmp, artifact_path="evaluation")
        example = ["necesito revisar mi factura"]
        # MLflow 2.22 sklearn flavor does not support skops. Log a signed
        # model directory and register its run URI; only our allowlisted loader reads it.
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            sio.dump(model, p / "model.skops")
            metadata = Model(signature=infer_signature(example, model.predict(example)))
            metadata.add_flavor("claro_skops", serialization_format="skops", data="model.skops")
            metadata.save(str(p / "MLmodel"))
            (p / "input_example.json").write_bytes(canonical(example))
            mlflow.log_artifacts(tmp, artifact_path="model")
        client = mlflow.MlflowClient()
        try:
            client.create_registered_model(model_name)
        except mlflow.exceptions.MlflowException as exc:
            if exc.error_code != "RESOURCE_ALREADY_EXISTS": raise
        uri = f"runs:/{run.info.run_id}/model"
        version = client.create_model_version(model_name, uri, run.info.run_id).version
        client.set_registered_model_alias(model_name, "candidate", version)
        return {"run_id":run.info.run_id, "version":str(version), "metrics":metrics, "model_uri":uri}

if __name__ == "__main__":
    parser = argparse.ArgumentParser(); parser.add_argument("csv"); parser.add_argument("--model-name", default="claro_copiloto_intencion")
    args = parser.parse_args(); print(json.dumps(train(args.csv, args.model_name)))

"""Reproduce the notebook candidates and write immutable bundles for FastAPI."""
import argparse
import hashlib
import json
import os
import sys
import shutil
import tempfile
from datetime import date, timedelta
from contextlib import contextmanager, redirect_stdout
from pathlib import Path

import numpy as np
import pandas as pd
import skops.io as sio
from sklearn.base import clone
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    average_precision_score, brier_score_loss, f1_score, precision_score, recall_score, roc_auc_score,
)
from sklearn.model_selection import StratifiedGroupKFold, StratifiedKFold, train_test_split
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from sklearn.svm import LinearSVC

from .churn import CATEGORICAL, FEATURE_NAMES, HISTORY_CATEGORIES, churn_features
from .common import LABELS, canonical, digest, group, normalize
from .e5 import EMBEDDING_SIZE, ENCODER_FILES, ENCODER_REVISION, E5Encoder, svm_scores

SEED = 42


def evaluate_intent(tickets: pd.DataFrame, encoder: E5Encoder):
    texts = tickets["descripcion"].map(normalize)
    actual = tickets["categoria"].str.lower().str.strip().to_numpy()
    if not texts.ne("").all() or set(actual) != LABELS:
        raise ValueError("expected nonempty descriptions and five intent classes")
    groups = texts.map(group).to_numpy()
    embeddings = encoder.encode(texts.tolist())
    classifier = LinearSVC(C=1.0, class_weight="balanced", random_state=SEED)
    predictions = np.empty(len(tickets), dtype=object)
    baseline = np.empty(len(tickets), dtype=object)
    scores = np.empty(len(tickets))
    for count in range(5, 1, -1):
        splitter = StratifiedGroupKFold(n_splits=count, shuffle=True, random_state=SEED)
        folds = list(splitter.split(embeddings, actual, groups))
        if all(set(actual[idx]) == LABELS for fold in folds for idx in fold):
            break
    else:
        raise ValueError("insufficient grouped coverage for intent evaluation")
    for train, test in folds:
        fitted = clone(classifier).fit(embeddings[train], actual[train])
        predictions[test], scores[test] = svm_scores(fitted, embeddings[test])
        values, totals = np.unique(actual[train], return_counts=True)
        baseline[test] = values[totals.argmax()]

    # Estimate selective precision per predicted class. Revisit these operating
    # points on fresh first-turn labels before presenting them as guidance in a pilot.
    thresholds = {}
    for label in sorted(LABELS - {"cancelacion"}):
        thresholds[label] = None
        for candidate in np.arange(0, 1, 0.05):
            selected = (predictions == label) & (scores >= candidate)
            templates = len(set(groups[selected]))
            if selected.sum() < 30 or templates < 3:
                continue
            precision = float(np.mean(actual[selected] == label))
            if precision >= 0.90:
                thresholds[label] = {
                    "score": float(candidate), "precision": precision,
                    "sample": int(selected.sum()), "templates": templates,
                }
                break
    cancellation = actual == "cancelacion"
    predicted_cancellation = predictions == "cancelacion"
    evaluation = {
        "metrics": {
            "macro_f1": f1_score(actual, predictions, average="macro"),
            "baseline_macro_f1": f1_score(actual, baseline, average="macro"),
            "cancelacion_recall": recall_score(cancellation, predicted_cancellation),
            "cancelacion_precision": precision_score(cancellation, predicted_cancellation, zero_division=0),
        },
        "rows": len(tickets), "templates": len(set(groups)), "folds": len(folds),
        "guidance_thresholds": thresholds, "guidance_precision_target": 0.90,
    }
    return classifier.fit(embeddings, actual), evaluation


def training_churn_data(clients: pd.DataFrame, tickets: pd.DataFrame):
    if clients["cliente_id"].isna().any() or not clients["cliente_id"].is_unique:
        raise ValueError("each client must have exactly one snapshot")
    if clients["fecha_corte"].isna().any() or clients["fecha_corte"].nunique() != 1:
        raise ValueError("this experiment requires one cohort date")
    cohort_date = date.fromisoformat(clients["fecha_corte"].iloc[0])
    next_day = cohort_date + timedelta(days=1)
    cutoff = pd.Timestamp(next_day)
    tickets = tickets.assign(fecha_creacion=pd.to_datetime(tickets["fecha_creacion"], errors="raise"))
    history = tickets.loc[tickets["fecha_creacion"].lt(cutoff)].copy()
    duration = history["tiempo_resolucion_horas"].where(history["tiempo_resolucion_horas"].between(0, 9999, inclusive="left"))
    close = history["fecha_creacion"] + pd.to_timedelta(duration, unit="h")
    history["categoria"] = history["categoria"].str.strip().str.lower().where(
        close.lt(cutoff), "categoria_no_disponible"
    )
    if not history["categoria"].isin(HISTORY_CATEGORIES).all():
        raise ValueError("unexpected historical category")
    frame = clients.copy()
    for days in (30, 90):
        recent = history.loc[history["fecha_creacion"].ge(pd.Timestamp(next_day - timedelta(days=days)))]
        counts = pd.crosstab(recent["cliente_id"], recent["categoria"]).reindex(
            columns=HISTORY_CATEGORIES, fill_value=0
        )
        for category in HISTORY_CATEGORIES:
            frame[f"{category}_ultimos_{days}d"] = frame["cliente_id"].map(counts[category]).fillna(0)
    last = history.groupby("cliente_id")["fecha_creacion"].max()
    frame["dias_desde_ultimo_ticket"] = (cutoff - frame["cliente_id"].map(last)).dt.total_seconds() / 86400
    totals = frame[[f"{category}_ultimos_90d" for category in HISTORY_CATEGORIES]].sum(axis=1)
    if not totals.eq(frame["tickets_90d"]).all():
        raise ValueError("client snapshot and ticket history do not reconcile")
    if set(frame["churn_90d"]) != {0, 1}:
        raise ValueError("the churn target must have both binary classes")
    return frame, cohort_date


def evaluate_churn(frame: pd.DataFrame):
    X, y = churn_features(frame), frame["churn_90d"].astype(int)
    numeric = [field for field in FEATURE_NAMES if field not in CATEGORICAL]
    preprocess = ColumnTransformer([
        ("categoricas", OneHotEncoder(handle_unknown="ignore"), CATEGORICAL),
        ("numericas", make_pipeline(
            SimpleImputer(strategy="median", add_indicator=True, keep_empty_features=True),
            StandardScaler(),
        ), numeric),
    ])
    model = make_pipeline(preprocess, LogisticRegression(
        C=0.1, penalty="l2", solver="liblinear", max_iter=1000, random_state=SEED,
    ))
    dev, test = train_test_split(np.arange(len(frame)), test_size=0.2, random_state=SEED, stratify=y)
    scores_dev = np.empty(len(dev))
    splitter = StratifiedKFold(n_splits=5, shuffle=True, random_state=SEED)
    for train, validation in splitter.split(dev, y.iloc[dev]):
        fitted = clone(model).fit(X.iloc[dev[train]], y.iloc[dev[train]])
        scores_dev[validation] = fitted.predict_proba(X.iloc[dev[validation]])[:, 1]
    p50, p80 = np.quantile(scores_dev, [0.50, 0.80])
    model.fit(X.iloc[dev], y.iloc[dev])
    actual = y.iloc[test].to_numpy()
    scores = model.predict_proba(X.iloc[test])[:, 1]
    tie_break = np.random.default_rng(SEED).permutation(len(test))
    count = int(np.ceil(0.20 * len(test)))
    top = np.lexsort((tie_break, -scores))[:count]
    threshold_selection = scores >= p80
    positives = int(actual.sum())
    captured = int(actual[top].sum())
    evaluation = {
        "metrics": {
            "roc_auc": roc_auc_score(actual, scores),
            "average_precision": average_precision_score(actual, scores),
            "brier_score": brier_score_loss(actual, scores),
            "recall_at_20": captured / positives,
        },
        "holdout": {"size": len(test), "positives": positives, "top_20_reviewed": count, "top_20_captured": captured},
        "priority_thresholds": {"p50": float(p50), "p80": float(p80)},
        "p80_holdout": {"reviewed": int(threshold_selection.sum()), "captured": int(actual[threshold_selection].sum())},
    }
    return model, evaluation


@contextmanager
def tracking_run(task: str, version: str):
    """Track only when explicitly configured; never log source rows or text."""
    uri = os.getenv("MLFLOW_TRACKING_URI", "").strip()
    if not uri:
        yield None
        return
    import mlflow

    mlflow.set_tracking_uri(uri)
    mlflow.set_experiment(f"claro-{task}-advisory")
    with redirect_stdout(sys.stderr), mlflow.start_run(run_name=version, tags={"task": task, "mode": "shadow"}) as run:
        yield run


def publish(root: Path, version: str, model, evaluation: dict, metadata: dict, assets: Path | None = None, run=None):
    destination = root / version
    if destination.exists():
        raise FileExistsError(destination)
    root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=root) as temp:
        staging = Path(temp) / "bundle"
        staging.mkdir()
        model_bytes = sio.dumps(model)
        evaluation_bytes = canonical(evaluation)
        (staging / "model.skops").write_bytes(model_bytes)
        (staging / "evaluation.json").write_bytes(evaluation_bytes)
        manifest = {
            "model_version": version, "mode": "shadow", "sha256": digest(model_bytes),
            "evaluation_sha256": digest(evaluation_bytes), **metadata,
        }
        if run is not None:
            manifest.update(run_id=run.info.run_id, experiment_id=run.info.experiment_id)
        (staging / "manifest.json").write_bytes(canonical(manifest))
        if assets:
            folder = staging / "encoder"
            folder.mkdir()
            for filename in ENCODER_FILES:
                shutil.copyfile(assets / filename, folder / filename)
                with (folder / filename).open("rb") as stream:
                    if hashlib.file_digest(stream, "sha256").hexdigest() != ENCODER_FILES[filename]:
                        raise ValueError(f"failed checksum for {filename}")
        if run is not None:
            import mlflow

            source = metadata.get("source_sha256", {})
            params = {
                "model_version": version, "algorithm": metadata["algorithm"],
                "mode": "shadow", "seed": SEED, "git_sha": os.getenv("GIT_SHA", "unknown"),
            }
            if isinstance(source, str):
                params["tickets_sha256"] = source
            elif isinstance(source, dict):
                params.update({f"{key}_sha256": value for key, value in source.items()})
            if "cohort_date" in metadata:
                params["cohort_date"] = metadata["cohort_date"]
            for key in ("rows", "templates", "folds"):
                if key in evaluation:
                    params[key] = evaluation[key]
            mlflow.log_params(params)
            mlflow.log_metrics(evaluation["metrics"])
            mlflow.log_artifact(str(staging / "model.skops"), artifact_path="model")
            mlflow.log_artifact(str(staging / "evaluation.json"), artifact_path="evaluation")
            mlflow.log_artifact(str(staging / "manifest.json"), artifact_path="manifest")
        staging.rename(destination)
    return {"bundle": str(destination), **({"run_id": run.info.run_id, "experiment_id": run.info.experiment_id} if run is not None else {}), **evaluation}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tickets", type=Path, required=True)
    parser.add_argument("--clients", type=Path, required=True)
    parser.add_argument("--encoder-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    tickets = pd.read_csv(args.tickets).drop_duplicates().reset_index(drop=True)
    clients = pd.read_csv(args.clients).drop_duplicates().reset_index(drop=True)
    frame, cohort = training_churn_data(clients, tickets)
    with tracking_run("intent", "intent-e5-svm-1") as run:
        intent_model, intent_eval = evaluate_intent(tickets, E5Encoder(args.encoder_dir))
        intent = publish(args.output, "intent-e5-svm-1", intent_model, intent_eval, {
            "algorithm": "e5_linear_svm", "encoder_revision": ENCODER_REVISION,
            "labels": sorted(LABELS), "signature": {"inputs": "text", "embedding_size": EMBEDDING_SIZE},
            "guidance_thresholds": intent_eval["guidance_thresholds"],
            "source_sha256": digest(args.tickets.read_bytes()),
        }, args.encoder_dir, run=run)
    with tracking_run("churn", "churn-logistic-1") as run:
        churn_model, churn_eval = evaluate_churn(frame)
        churn = publish(args.output, "churn-logistic-1", churn_model, churn_eval, {
            "algorithm": "churn_logistic", "cohort_date": cohort.isoformat(),
            "feature_schema": FEATURE_NAMES, "priority_thresholds": churn_eval["priority_thresholds"],
            "source_sha256": {"clients": digest(args.clients.read_bytes()), "tickets": digest(args.tickets.read_bytes())},
        }, run=run)
    print(json.dumps({"intent": intent, "churn": churn}, ensure_ascii=False))


if __name__ == "__main__":
    main()

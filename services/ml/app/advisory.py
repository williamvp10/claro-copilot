"""Load reviewed candidate bundles and translate scores into advisory signals."""
import json
import math
from datetime import date
from pathlib import Path

import skops.io as sio
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.svm import LinearSVC

from .churn import FEATURE_NAMES
from .common import LABELS, digest
from .e5 import EMBEDDING_SIZE, ENCODER_REVISION, E5Encoder, E5Intent

ESTIMATOR_TYPES = {
    "numpy.dtype",
    "sklearn.svm._classes.LinearSVC",
    "sklearn.pipeline.Pipeline",
    "sklearn.compose._column_transformer.ColumnTransformer",
    "sklearn.compose._column_transformer._RemainderColsList",
    "sklearn.impute._base.SimpleImputer",
    "sklearn.impute._base.MissingIndicator",
    "sklearn.preprocessing._encoders.OneHotEncoder",
    "sklearn.preprocessing._data.StandardScaler",
    "sklearn.linear_model._logistic.LogisticRegression",
}


def load_candidate(path: Path, algorithm: str):
    manifest = json.loads((path / "manifest.json").read_bytes())
    if manifest.get("algorithm") != algorithm or manifest.get("mode") != "shadow":
        raise ValueError("unexpected candidate algorithm or mode")
    if not isinstance(manifest.get("model_version"), str) or not manifest["model_version"]:
        raise ValueError("missing candidate version")
    payload = (path / "model.skops").read_bytes()
    evaluation = (path / "evaluation.json").read_bytes()
    if digest(payload) != manifest["sha256"] or digest(evaluation) != manifest["evaluation_sha256"]:
        raise ValueError("invalid candidate checksums")
    unknown = set(sio.get_untrusted_types(data=payload))
    if unknown - ESTIMATOR_TYPES:
        raise ValueError("unapproved candidate model types")
    return sio.loads(payload, trusted=sorted(unknown)), manifest, json.loads(evaluation)


def load_e5(path: Path):
    model, manifest, _ = load_candidate(path, "e5_linear_svm")
    if (
        not isinstance(model, LinearSVC) or set(model.classes_) != LABELS or manifest["labels"] != sorted(LABELS)
        or model.n_features_in_ != EMBEDDING_SIZE
        or manifest["signature"] != {"inputs": "text", "embedding_size": EMBEDDING_SIZE}
        or manifest["encoder_revision"] != ENCODER_REVISION
    ):
        raise ValueError("E5 bundle signature mismatch")
    thresholds = manifest["guidance_thresholds"]
    if set(thresholds) != LABELS - {"cancelacion"} or any(
        threshold is not None and not 0 <= threshold["score"] <= 1 for threshold in thresholds.values()
    ):
        raise ValueError("invalid intent guidance thresholds")
    return E5Intent(model, E5Encoder(path / "encoder")), manifest


def load_churn(path: Path):
    model, manifest, evaluation = load_candidate(path, "churn_logistic")
    if (
        not isinstance(model, Pipeline) or not isinstance(model[-1], LogisticRegression)
        or list(model.classes_) != [0, 1]
        or list(model.feature_names_in_) != FEATURE_NAMES
        or manifest["feature_schema"] != FEATURE_NAMES
    ):
        raise ValueError("churn bundle signature mismatch")
    date.fromisoformat(manifest["cohort_date"])
    thresholds = manifest["priority_thresholds"]
    if not 0 <= thresholds["p50"] < thresholds["p80"] <= 1:
        raise ValueError("invalid churn priority thresholds")
    if not all(math.isfinite(evaluation["metrics"][key]) for key in ("roc_auc", "recall_at_20")):
        raise ValueError("invalid churn quality metrics")
    return model, manifest, evaluation


def intent_guidance(label: str, score: float, manifest: dict) -> str:
    if label == "cancelacion":
        return "confirm_cancellation_intent"
    threshold = manifest.get("guidance_thresholds", {}).get(label)
    if threshold and score >= threshold["score"]:
        return "suggest_intent_for_review"
    return "clarify_intent"

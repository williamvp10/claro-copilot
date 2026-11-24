"""Publish bounded model telemetry to the local tracking server."""

import logging
import os

from .common import digest

logger = logging.getLogger(__name__)


def configure_tracking():
    uri = os.getenv("MLFLOW_TRACKING_URI", "").strip()
    if not uri:
        return
    import mlflow

    mlflow.set_tracking_uri(uri)
    try:
        mlflow.set_experiment("claro-ml-inference")
    except Exception:
        logger.warning("MLflow inference experiment unavailable; serving remains enabled")


def record_inference(task, manifest, latency_ms, outputs, *, run_id=None):
    if not os.getenv("MLFLOW_TRACKING_URI", "").strip():
        return
    import mlflow
    from mlflow.entities.trace_location import MlflowExperimentLocation

    version = manifest["model_version"]
    experiment_id = manifest.get("experiment_id")
    destination = MlflowExperimentLocation(experiment_id) if experiment_id else None
    tags = {"claro.task": task, "claro.model_version": version, "claro.mode": "shadow"}
    if manifest.get("run_id"):
        tags["claro.training_run_id"] = manifest["run_id"]
    if run_id:
        tags["claro.langfuse_trace_id"] = digest(run_id.encode())[:32]
    try:
        with mlflow.start_span(f"predict-{task}", trace_destination=destination) as span:
            mlflow.update_current_trace(tags=tags, model_id=manifest.get("model_id"))
            span.set_attribute("claro.inference_latency_ms", latency_ms)
            span.set_outputs(outputs)
    except Exception:
        logger.warning("MLflow inference telemetry failed for %s", task)

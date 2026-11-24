import hmac
import json
import logging
import os
import sqlite3
import time
import uuid
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field, StringConstraints
from .advisory import intent_guidance, load_churn, load_e5
from .churn import ChurnPrediction
from .common import LABELS, canonical, digest, load_bundle, normalize
from .e5 import E5Intent, ENCODER_REVISION
from .inference_trace import configure_tracking, record_inference

Label = Literal["soporte_tecnico", "facturacion", "consulta_planes", "cancelacion", "portabilidad"]
class Prediction(BaseModel):
    text: str = Field(min_length=1, max_length=10000)
    channel: str = Field(min_length=1, max_length=64)
    turn_id: str = Field(min_length=1, max_length=128)
    idempotency_key: str = Field(min_length=1, max_length=128)
    run_id: str | None = Field(default=None, max_length=128)
class IntentPredictionResult(BaseModel):
    prediction_id: str
    label: Label
    score: float = Field(ge=0, le=1)
    score_type: Literal["uncalibrated"]
    model_version: str
    mode: Literal["shadow"]
    recommendation: Literal["confirm_cancellation_intent", "suggest_intent_for_review", "clarify_intent"]
    requires_human_confirmation: Literal[True]


class ChurnPredictionResult(BaseModel):
    model_version: str
    mode: Literal["shadow"]
    horizon_days: Literal[90]
    fecha_corte: date
    training_cohort: date
    score: float = Field(ge=0, le=1)
    score_type: Literal["uncalibrated"]
    priority: Literal["alta", "media", "habitual"]
    priority_reference: Literal["development_cohort_p50_p80"]
    recommendation: Literal["review_retention_followup", "check_unresolved_issues", "standard_followup"]
    requires_human_confirmation: Literal[True]


class IntentLabel(BaseModel):
    prediction_id: str = Field(min_length=1, max_length=128)
    label: Label
    event_id: str = Field(min_length=1, max_length=128)

DB = os.getenv("ML_STATE_DB", "/tmp/claro-ml.sqlite3")
def connect():
    db = sqlite3.connect(DB, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    return db

def init_db():
    with connect() as db:
        db.executescript('''CREATE TABLE IF NOT EXISTS predictions (id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, version TEXT NOT NULL, idem TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL, channel TEXT NOT NULL, label TEXT NOT NULL, score REAL NOT NULL, latency_ms REAL NOT NULL, text_length INTEGER NOT NULL, oov REAL NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, traceparent TEXT, UNIQUE(turn_id,version));
        CREATE TABLE IF NOT EXISTS labels (event_id TEXT PRIMARY KEY, prediction_id TEXT NOT NULL REFERENCES predictions(id), label TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS drift_reports (version TEXT NOT NULL, channel TEXT NOT NULL, status TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);''')

logger = logging.getLogger(__name__)
LOAD_ERRORS = (OSError, ValueError, TypeError, AttributeError, KeyError, RuntimeError, ImportError)


@asynccontextmanager
async def lifespan(app):
    app.state.model = app.state.manifest = app.state.churn = None
    init_db()
    path = Path(os.getenv("ML_BUNDLE_DIR", "/models/current"))
    try:
        manifest = json.loads((path / "manifest.json").read_bytes())
        loader = load_e5 if manifest.get("algorithm") == "e5_linear_svm" else load_bundle
        app.state.model, app.state.manifest = loader(path)
    except LOAD_ERRORS as exc:
        logger.warning("Intent bundle unavailable: %s", exc)

    churn_path = os.getenv("ML_CHURN_BUNDLE_DIR")
    if churn_path:
        try:
            app.state.churn = load_churn(Path(churn_path))
        except LOAD_ERRORS as exc:
            logger.warning("Churn bundle unavailable: %s", exc)
    configure_tracking()
    yield


app = FastAPI(title="Claro ML advisory service", lifespan=lifespan)


def authorize(authorization: str | None = Header(default=None)):
    token = os.getenv("ML_SERVICE_TOKEN", "")
    supplied = authorization or ""
    if not token or not hmac.compare_digest(supplied, "Bearer " + token):
        raise HTTPException(401, "invalid service credentials", headers={"WWW-Authenticate":"Bearer"})


class KnowledgeEmbedding(BaseModel):
    kind: Literal["query", "passage"]
    texts: list[Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=9000)]] = Field(min_length=1, max_length=16)


@app.post("/internal/v1/knowledge-embedding", dependencies=[Depends(authorize)])
def knowledge_embedding(body: KnowledgeEmbedding):
    if not isinstance(app.state.model, E5Intent):
        raise HTTPException(503, "knowledge encoder unavailable")
    vectors = app.state.model.encoder.encode(body.texts, body.kind)
    return {"revision": ENCODER_REVISION, "vectors": vectors.tolist()}

def response(row, manifest):
    return {
        "prediction_id": row["id"], "label": row["label"], "score": row["score"],
        "score_type": "uncalibrated", "model_version": row["version"], "mode": "shadow",
        "recommendation": intent_guidance(
            row["label"], row["score"], manifest if row["version"] == manifest["model_version"] else {}
        ),
        "requires_human_confirmation": True,
    }


@app.get("/healthz")
def health(): return {"status":"ok"}
@app.get("/readyz")
def ready():
    if (app.state.model is None and app.state.churn is None) or not os.getenv("ML_SERVICE_TOKEN"):
        raise HTTPException(503, "model or credentials unavailable")
    try:
        with connect() as db: db.execute("SELECT 1")
    except sqlite3.Error: raise HTTPException(503, "state unavailable")
    intent = app.state.manifest
    churn = app.state.churn
    return {
        "status": "ready", "model_version": intent["model_version"] if intent else None,
        "churn_model_version": churn[1]["model_version"] if churn else None,
    }

def previous_prediction(db, body: Prediction, version: str, payload_hash: str):
    rows = db.execute(
        "SELECT * FROM predictions WHERE idem=? OR (turn_id=? AND version=?)",
        (body.idempotency_key, body.turn_id, version),
    ).fetchall()
    if not rows:
        return None
    row = rows[0]
    if len(rows) != 1 or row["payload_hash"] != payload_hash or row["idem"] != body.idempotency_key:
        raise HTTPException(409, "idempotency conflict")
    return row


@app.post("/internal/v1/predict-intent", response_model=IntentPredictionResult, dependencies=[Depends(authorize)])
def predict(body: Prediction, traceparent: str | None = Header(default=None, max_length=256)):
    if app.state.model is None: raise HTTPException(503, "model unavailable")
    text = normalize(body.text)
    if not text: raise HTTPException(422, "text is empty")
    version = app.state.manifest["model_version"]
    payload_hash = digest(canonical({"text":text, "channel":body.channel, "turn_id":body.turn_id, "run_id":body.run_id}))
    try:
        with connect() as db:
            existing = previous_prediction(db, body, version, payload_hash)
            if existing:
                return response(existing, app.state.manifest)
    except sqlite3.Error:
        raise HTTPException(503, "state unavailable")
    start = time.perf_counter()
    model = app.state.model
    if isinstance(model, E5Intent):
        predicted, score = model.predict_one(text)
        oov = -1.0  # Legacy storage uses a non-null column. Drift ignores this sentinel.
    else:
        probabilities = model.predict_proba([text])[0]
        idx = int(probabilities.argmax())
        predicted, score = str(model.classes_[idx]), float(probabilities[idx])
        vectorizer = model.steps[0][1]
        tokens = vectorizer.build_analyzer()(text)
        oov = sum(token not in vectorizer.vocabulary_ for token in tokens) / max(1, len(tokens))
    data = (str(uuid.uuid4()), body.turn_id, version, body.idempotency_key, payload_hash,
            body.channel, predicted, score, (time.perf_counter() - start) * 1000,
            len(text), oov, traceparent)
    try:
        with connect() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = previous_prediction(db, body, version, payload_hash)
            if existing:
                return response(existing, app.state.manifest)
            db.execute("INSERT INTO predictions (id,turn_id,version,idem,payload_hash,channel,label,score,latency_ms,text_length,oov,traceparent) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",data)
            result = response(db.execute("SELECT * FROM predictions WHERE id=?",(data[0],)).fetchone(), app.state.manifest)
    except sqlite3.Error: raise HTTPException(503,"state unavailable")
    record_inference("intent", app.state.manifest, data[7], {
        "label": result["label"], "score": result["score"], "recommendation": result["recommendation"],
    }, run_id=body.run_id)
    return result

@app.post("/internal/v1/predict-churn", response_model=ChurnPredictionResult, dependencies=[Depends(authorize)])
def predict_churn(body: ChurnPrediction):
    if app.state.churn is None:
        raise HTTPException(503, "churn model unavailable")
    if body.fecha_corte > date.today():
        raise HTTPException(422, "snapshot date is in the future")
    model, manifest, _ = app.state.churn
    start = time.perf_counter()
    score = float(model.predict_proba(body.as_frame())[0, 1])
    latency_ms = (time.perf_counter() - start) * 1000
    thresholds = manifest["priority_thresholds"]
    if score >= thresholds["p80"]:
        priority, recommendation = "alta", "review_retention_followup"
    elif score >= thresholds["p50"]:
        priority, recommendation = "media", "check_unresolved_issues"
    else:
        priority, recommendation = "habitual", "standard_followup"
    record_inference("churn", manifest, latency_ms, {"priority": priority, "recommendation": recommendation})
    return {
        "model_version": manifest["model_version"], "mode": "shadow", "horizon_days": 90,
        "fecha_corte": body.fecha_corte, "training_cohort": manifest["cohort_date"],
        "score": score, "score_type": "uncalibrated", "priority": priority,
        "priority_reference": "development_cohort_p50_p80",
        "recommendation": recommendation, "requires_human_confirmation": True,
    }


@app.post("/internal/v1/intent-labels", dependencies=[Depends(authorize)])
def label(body: IntentLabel):
    try:
        with connect() as db:
            db.execute("BEGIN IMMEDIATE")
            old=db.execute("SELECT * FROM labels WHERE event_id=?",(body.event_id,)).fetchone()
            if old:
                if old["prediction_id"]!=body.prediction_id or old["label"]!=body.label: raise HTTPException(409,"event conflict")
            else:
                if not db.execute("SELECT 1 FROM predictions WHERE id=?",(body.prediction_id,)).fetchone(): raise HTTPException(404,"prediction not found")
                db.execute("INSERT INTO labels(event_id,prediction_id,label) VALUES(?,?,?)",(body.event_id,body.prediction_id,body.label))
        return {"event_id":body.event_id,"prediction_id":body.prediction_id,"label":body.label}
    except sqlite3.Error: raise HTTPException(503,"state unavailable")

@app.get("/internal/v1/model-metrics", dependencies=[Depends(authorize)])
def metrics(days: int = 7):
    if days < 1 or days > 365: raise HTTPException(422,"invalid window")
    try:
        with connect() as db:
            rows=db.execute("SELECT * FROM predictions WHERE created_at>=datetime('now', ?)",(f"-{days} days",)).fetchall()
            labels=db.execute("SELECT l.* FROM labels l JOIN predictions p ON p.id=l.prediction_id WHERE p.created_at>=datetime('now',?) ORDER BY l.created_at,l.rowid",(f"-{days} days",)).fetchall()
            reports=db.execute("SELECT * FROM drift_reports ORDER BY rowid DESC").fetchall()
    except sqlite3.Error: raise HTTPException(503,"state unavailable")
    from sklearn.metrics import classification_report
    latest={r["prediction_id"]:r["label"] for r in labels}; groups=[]
    for version, channel in sorted({(r["version"],r["channel"]) for r in rows}):
        subset=[r for r in rows if r["version"]==version and r["channel"]==channel]; tagged=[r for r in subset if r["id"] in latest]
        lat=sorted(r["latency_ms"] for r in subset); report=next((r for r in reports if r["version"]==version and r["channel"]==channel),None)
        quality=classification_report([latest[r["id"]] for r in tagged],[r["label"] for r in tagged],labels=sorted(LABELS),output_dict=True,zero_division=0) if tagged else None
        groups.append({"model_version":version,"mode":"shadow","channel":channel,"count":len(subset),"p95_latency_ms":lat[max(0,__import__('math').ceil(len(lat)*.95)-1)],"mean_score":sum(r["score"] for r in subset)/len(subset),"labels_count":len(tagged),"label_coverage":len(tagged)/len(subset),"online_quality":quality,"drift":json.loads(report["details"]) if report else {"status":"sin referencia"}})
    offline=None
    try:
        p=Path(os.getenv("ML_BUNDLE_DIR","/models/current"))/"evaluation.json"; content=p.read_bytes()
        if digest(content)==app.state.manifest["evaluation_sha256"]: offline=json.loads(content)
    except (OSError, TypeError, KeyError): pass
    manifest = app.state.manifest or {}
    deployment = {key: manifest[key] for key in ("model_version", "run_id", "experiment_id") if key in manifest}
    if "algorithm" in manifest:
        deployment["algorithm"] = manifest["algorithm"]
    churn = app.state.churn
    return {
        "window_days": days, "groups": groups, "offline": offline,
        "deployment": deployment or None,
        "churn": {
            **{key: churn[1][key] for key in ("model_version", "run_id", "experiment_id", "algorithm") if key in churn[1]},
            "training_cohort": churn[1]["cohort_date"],
            "offline": churn[2],
        } if churn else None,
    }

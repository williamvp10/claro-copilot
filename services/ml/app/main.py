import hmac
import json
import os
import sqlite3
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
from .common import LABELS, canonical, digest, load_bundle, normalize

Label = Literal["soporte_tecnico", "facturacion", "consulta_planes", "cancelacion", "portabilidad"]
class Prediction(BaseModel):
    text: str = Field(min_length=1, max_length=10000)
    channel: str = Field(min_length=1, max_length=64)
    turn_id: str = Field(min_length=1, max_length=128)
    idempotency_key: str = Field(min_length=1, max_length=128)
    run_id: str | None = Field(default=None, max_length=128)
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

@asynccontextmanager
async def lifespan(app):
    app.state.model = app.state.manifest = None
    try:
        init_db()
        app.state.model, app.state.manifest = load_bundle(Path(os.getenv("ML_BUNDLE_DIR", "/models/current")))
    except (OSError, ValueError, KeyError, json.JSONDecodeError):
        pass
    yield

app = FastAPI(title="Intent shadow service", lifespan=lifespan)
def authorize(authorization: str | None = Header(default=None)):
    token = os.getenv("ML_SERVICE_TOKEN", "")
    supplied = authorization or ""
    if not token or not hmac.compare_digest(supplied, "Bearer " + token):
        raise HTTPException(401, "invalid service credentials", headers={"WWW-Authenticate":"Bearer"})

def response(row):
    return {"prediction_id":row["id"], "label":row["label"], "score":row["score"], "score_type":"uncalibrated", "model_version":row["version"], "mode":"shadow"}

@app.get("/healthz")
def health(): return {"status":"ok"}
@app.get("/readyz")
def ready():
    if app.state.model is None or not os.getenv("ML_SERVICE_TOKEN"):
        raise HTTPException(503, "model or credentials unavailable")
    try:
        with connect() as db: db.execute("SELECT 1")
    except sqlite3.Error: raise HTTPException(503, "state unavailable")
    return {"status":"ready", "model_version":app.state.manifest["model_version"]}

@app.post("/internal/v1/predict-intent", dependencies=[Depends(authorize)])
def predict(body: Prediction, traceparent: str | None = Header(default=None, max_length=256)):
    if app.state.model is None: raise HTTPException(503, "model unavailable")
    text = normalize(body.text)
    if not text: raise HTTPException(422, "text is empty")
    version = app.state.manifest["model_version"]
    payload_hash = digest(canonical({"text":text, "channel":body.channel, "turn_id":body.turn_id, "run_id":body.run_id}))
    start = time.perf_counter()
    model = app.state.model
    probs = model.predict_proba([text])[0]; idx = int(probs.argmax())
    vectorizer = model.steps[0][1]; tokens = vectorizer.build_analyzer()(text)
    oov = sum(token not in vectorizer.vocabulary_ for token in tokens) / max(1,len(tokens))
    data = (str(uuid.uuid4()),body.turn_id,version,body.idempotency_key,payload_hash,body.channel,str(model.classes_[idx]),float(probs[idx]),(time.perf_counter()-start)*1000,len(text),oov,traceparent)
    try:
        with connect() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute("SELECT * FROM predictions WHERE idem=? OR (turn_id=? AND version=?)",(body.idempotency_key,body.turn_id,version)).fetchall()
            if existing:
                if len(existing)!=1 or existing[0]["payload_hash"] != payload_hash or existing[0]["idem"] != body.idempotency_key:
                    raise HTTPException(409,"idempotency conflict")
                return response(existing[0])
            db.execute("INSERT INTO predictions (id,turn_id,version,idem,payload_hash,channel,label,score,latency_ms,text_length,oov,traceparent) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",data)
            return response(db.execute("SELECT * FROM predictions WHERE id=?",(data[0],)).fetchone())
    except sqlite3.Error: raise HTTPException(503,"state unavailable")

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
    return {"window_days":days,"groups":groups,"offline":offline}

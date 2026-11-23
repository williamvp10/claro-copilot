import skops.io as sio
from fastapi.testclient import TestClient
from app.common import LABELS, canonical, digest
from app.train import pipeline

def test_contract(tmp_path, monkeypatch):
    texts = ['internet senal television','factura cobro saldo','planes precio oferta','cancelar servicio baja','portabilidad cambiar operador']
    labels = ['soporte_tecnico','facturacion','consulta_planes','cancelacion','portabilidad']
    model=pipeline().fit(texts,labels)
    bundle=tmp_path/'bundle'; bundle.mkdir(); data=sio.dumps(model); (bundle/'model.skops').write_bytes(data)
    evaluation=canonical({'metrics':{'macro_f1':0.5}}); (bundle/'evaluation.json').write_bytes(evaluation)
    (bundle/'manifest.json').write_bytes(canonical({'sha256':digest(data),'evaluation_sha256':digest(evaluation),'model_version':'1','signature':{'inputs':'string','outputs':'string'},'mode':'shadow','labels':sorted(LABELS)}))
    monkeypatch.setenv('ML_SERVICE_TOKEN','test-secret'); monkeypatch.setenv('ML_BUNDLE_DIR',str(bundle))
    import app.main as main
    monkeypatch.setattr(main,'DB',str(tmp_path/'state.sqlite'))
    with TestClient(main.app) as client:
        assert client.get('/readyz').status_code==200
        body={'text':'factura cobro','channel':'telegram','turn_id':'turn-1','idempotency_key':'key-1'}
        assert client.post('/internal/v1/predict-intent',json=body).status_code==401
        auth={'Authorization':'Bearer test-secret'}
        first=client.post('/internal/v1/predict-intent',json=body,headers=auth)
        assert first.status_code==200
        assert client.post('/internal/v1/predict-intent',json=body,headers=auth).json()==first.json()
        assert client.post('/internal/v1/predict-intent',json={**body,'text':'otro'},headers=auth).status_code==409
        event={'event_id':'event-1','prediction_id':first.json()['prediction_id'],'label':'facturacion'}
        assert client.post('/internal/v1/intent-labels',json=event,headers=auth).status_code==200
        assert client.post('/internal/v1/intent-labels',json=event,headers=auth).status_code==200
        assert client.post('/internal/v1/intent-labels',json={**event,'label':'cancelacion'},headers=auth).status_code==409
        metric=client.get('/internal/v1/model-metrics',headers=auth).json()
        assert metric['groups'][0]['labels_count']==1 and metric['groups'][0]['drift']['status']=='sin referencia'
    (bundle/'model.skops').write_bytes(b'broken')
    with TestClient(main.app) as client: assert client.get('/readyz').status_code==503


def test_churn_candidate_contract(tmp_path, monkeypatch):
    import pandas as pd

    from app import main
    from app.churn import FEATURE_NAMES, HISTORY_CATEGORIES, ChurnPrediction
    from app.train_advisory import evaluate_churn, publish

    empty_history = dict.fromkeys(HISTORY_CATEGORIES, 0)
    low = {
        "fecha_corte": "2025-10-31", "ciudad": None, "tipo_servicio": "hogar",
        "plan_hogar": "fibra", "metodo_pago": "pse", "valor_mensual": 100000,
        "antiguedad_meses": 36, "dias_mora": 0, "tickets_90d": 0,
        "tickets_tecnicos_90d": 0, "caidas_servicio_90d": 0, "uso_datos_gb_mes": None,
        "nps_ultimo": 9, "ofertas_retencion_12m": 0, "historial_30d": empty_history,
        "historial_90d": empty_history, "dias_desde_ultimo_ticket": None,
    }
    high = {**low, "dias_mora": 60, "nps_ultimo": 1, "caidas_servicio_90d": 5}
    frames = []
    for target, body in [(0, low)] * 45 + [(1, high)] * 15:
        frame = ChurnPrediction.model_validate(body).as_frame()
        frame["uso_datos_gb_mes"] = None
        frame["churn_90d"] = target
        frames.append(frame)
    model, evaluation = evaluate_churn(pd.concat(frames, ignore_index=True))
    bundle = publish(tmp_path, "churn-test-1", model, evaluation, {
        "algorithm": "churn_logistic", "cohort_date": low["fecha_corte"],
        "feature_schema": FEATURE_NAMES, "priority_thresholds": evaluation["priority_thresholds"],
        "run_id": "test-run-id", "experiment_id": "test-experiment-id",
    })
    monkeypatch.setenv("ML_SERVICE_TOKEN", "test-secret")
    monkeypatch.setenv("ML_BUNDLE_DIR", str(tmp_path / "no-intent"))
    monkeypatch.setenv("ML_CHURN_BUNDLE_DIR", bundle["bundle"])
    monkeypatch.setattr(main, "DB", str(tmp_path / "advisory.sqlite"))
    auth = {"Authorization": "Bearer test-secret"}
    with TestClient(main.app) as client:
        ready = client.get("/readyz")
        assert ready.status_code == 200 and ready.json()["churn_model_version"] == "churn-test-1"
        url = "/internal/v1/predict-churn"
        assert client.post(url, json=low).status_code == 401
        assert client.post(url, json={**low, "tickets_90d": 5}, headers=auth).status_code == 422
        low_prediction = client.post(url, json=low, headers=auth).json()
        high_prediction = client.post(url, json=high, headers=auth).json()
        assert low_prediction["score"] < high_prediction["score"]
        assert high_prediction["priority"] == "alta"
        assert high_prediction["recommendation"] == "review_retention_followup"
        assert high_prediction["requires_human_confirmation"]
        assert high_prediction["horizon_days"] == 90
        metrics = client.get("/internal/v1/model-metrics", headers=auth).json()
        assert metrics["churn"]["offline"]["holdout"]["size"] == 12
        assert metrics["churn"]["run_id"] == "test-run-id" and metrics["churn"]["experiment_id"] == "test-experiment-id"


def test_advisory_tracking_is_opt_in_and_records_local_runs(tmp_path, monkeypatch):
    import json
    import mlflow
    from sklearn.linear_model import LogisticRegression
    from app.train_advisory import publish, tracking_run

    model = LogisticRegression().fit([[0], [1], [2], [3]], [0, 0, 1, 1])
    evaluation = {"metrics": {"roc_auc": 0.75}, "holdout": {"size": 4}}
    metadata = {"algorithm": "churn_logistic", "cohort_date": "2026-10-31",
                "source_sha256": {"clients": "synthetic-clients-hash", "tickets": "synthetic-tickets-hash"}}
    monkeypatch.delenv("MLFLOW_TRACKING_URI", raising=False)
    with tracking_run("churn", "without-tracking") as run:
        assert run is None
        plain = publish(tmp_path / "bundles", "without-tracking", model, evaluation, metadata, run=run)
    assert "run_id" not in plain
    assert "run_id" not in json.loads((tmp_path / "bundles" / "without-tracking" / "manifest.json").read_text())

    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("MLFLOW_TRACKING_URI", "sqlite:///" + str(tmp_path / "mlflow.db"))
    with tracking_run("churn", "with-tracking") as run:
        tracked = publish(tmp_path / "bundles", "with-tracking", model, evaluation, metadata, run=run)
    manifest = json.loads((tmp_path / "bundles" / "with-tracking" / "manifest.json").read_text())
    assert manifest["run_id"] == tracked["run_id"]
    assert manifest["experiment_id"] == tracked["experiment_id"]
    assert manifest["mode"] == "shadow"
    client = mlflow.MlflowClient()
    record = client.get_run(tracked["run_id"])
    assert record.info.status == "FINISHED" and record.data.metrics["roc_auc"] == 0.75
    assert record.data.params["clients_sha256"] == "synthetic-clients-hash"
    assert {item.path for item in client.list_artifacts(tracked["run_id"])} == {"model", "evaluation", "manifest"}
    assert json.loads(open(client.download_artifacts(tracked["run_id"], "evaluation/evaluation.json")).read()) == evaluation

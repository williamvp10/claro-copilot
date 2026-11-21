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

"""Compare disjoint windows; this heuristic is not Evidently."""
import json
from .main import connect, init_db

def run():
    init_db(); result=[]
    with connect() as db:
        for version, channel in db.execute("SELECT DISTINCT version,channel FROM predictions").fetchall():
            windows=[]
            for start,end in ((7,0),(14,7),(21,14)):
                row=db.execute("SELECT count(*) n,avg(score) score,avg(oov) oov FROM predictions WHERE version=? AND channel=? AND created_at>=datetime('now',?) AND created_at<datetime('now',?)",(version,channel,f'-{start} days',f'-{end} days')).fetchone()
                windows.append(dict(row))
            current, previous, reference=windows
            if min(w['n'] for w in windows)<100: status='sin referencia'
            else:
                def shifted(w): return abs(w['score']-reference['score'])>=.15 or abs(w['oov']-reference['oov'])>=.15
                status='revision' if shifted(current) and shifted(previous) else 'sin alerta'
            details={'status':status,'method':'heuristic_score_oov','windows':windows,'min_predictions':100,'threshold':0.15}
            db.execute("INSERT INTO drift_reports(version,channel,status,details) VALUES(?,?,?,?)",(version,channel,status,json.dumps(details)))
            result.append({'version':version,'channel':channel,**details})
    return result
if __name__=='__main__': print(json.dumps(run()))

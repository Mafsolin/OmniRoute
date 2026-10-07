import sqlite3,time,json,sys
from pathlib import Path
start=time.monotonic()
db=sqlite3.connect('file:/opt/omniroute-staging/data/storage.sqlite?mode=ro',uri=True,timeout=5)
db.execute('PRAGMA query_only=ON')
result=[row[0] for row in db.execute('PRAGMA quick_check')]
db.close()
out={'at':time.strftime('%Y-%m-%dT%H:%M:%S%z'),'ok':result==['ok'],'duration_s':round(time.monotonic()-start,2),'result':result[:10]}
Path('/var/lib/omniroute-maintenance').mkdir(mode=0o700,exist_ok=True)
Path('/var/lib/omniroute-maintenance/integrity.json').write_text(json.dumps(out))
print(json.dumps(out),flush=True)
sys.exit(0 if out['ok'] else 1)

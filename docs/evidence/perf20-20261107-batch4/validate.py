"""Local isolated acceptance; no env file or paid provider credentials."""
import os,json,subprocess,time,socket
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3];E=Path(__file__).resolve().parent
results={};env=os.environ.copy();env['PATH']='/tmp/evispeak-ffprobe-20261107/bin:'+env['PATH']
# Tests construct their own synthetic settings; never inherit a production database URL.
for key in ['DATABASE_URL','TEST_DATABASE_URL','E2E_LIVE']:env.pop(key,None)
def run(name,command,extra=None):
 start=time.monotonic()
 with (E/(name+'.log')).open('w') as out:r=subprocess.run(command,cwd=ROOT,env={**env,**(extra or {})},stdout=out,stderr=subprocess.STDOUT)
 results[name]=dict(command=command,exit_code=r.returncode,seconds=round(time.monotonic()-start,3),log=name+'.log')
 (E/'validation.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n')
 print(name,'PASS' if not r.returncode else 'FAIL',flush=True)
 return r.returncode==0
if not run('focused-backend',['node','--experimental-transform-types','--test','backend/tests-ts/performance-batch4.test.ts','backend/tests-ts/latency-batch2.test.ts','backend/tests-ts/latency.test.ts','backend/tests-ts/performance.test.ts']):raise SystemExit(1)
if not run('focused-audio',['node','--experimental-strip-types','--test','frontend/tests/voice.test.ts','frontend/tests/performance-batch4.test.ts']):raise SystemExit(1)
name='evispeak-perf-b4-'+str(os.getpid());started=False
try:
 p=subprocess.run(['docker','run','-d','--rm','--name',name,'-e','POSTGRES_PASSWORD=synthetic-perf-b4','-p','127.0.0.1::5432','postgres:17-alpine'],capture_output=True,text=True,check=True);started=True
 for attempt in range(40):
  if subprocess.run(['docker','exec',name,'pg_isready','-U','postgres'],capture_output=True).returncode==0:break
  time.sleep(.25)
 else:raise RuntimeError('isolated PostgreSQL did not become ready')
 port=subprocess.check_output(['docker','port',name,'5432/tcp'],text=True).strip().rsplit(':',1)[-1]
 run('backend-tests',['npm','--prefix','backend','test'],{'TEST_DATABASE_URL':f'postgresql://postgres:synthetic-perf-b4@127.0.0.1:{port}/postgres'})
 results['postgresql']=dict(isolated=True,image='postgres:17-alpine',removed_after_run=True)
finally:
 if started:subprocess.run(['docker','stop',name],capture_output=True,check=True)
for name,command in [
 ('frontend-tests',['npm','--prefix','frontend','test']),
 ('build',['npm','run','build']),
 ('build-android',['npm','run','build:android']),
 ('lint',['npm','run','lint']),
 ('training-browser',['npm','--prefix','frontend','run','test:training','--','--output=/tmp/evispeak-perf-b4-training']),
 ('admin-e2e',['npm','run','test:e2e','--','--output=/tmp/evispeak-perf-b4-admin']),
 ('diff-check',['git','diff','--check'])]:run(name,command)
results['limitations']=['synthetic providers only','no physical device or installed APK','no production deployment or remote CI','no sustained load, weak-network or peak-memory acceptance']
(E/'validation.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n')
if any(r.get('exit_code',0) for r in results.values() if isinstance(r,dict)):raise SystemExit(1)

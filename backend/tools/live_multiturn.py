"""Real voice cross-mode acceptance. Synthetic speech; never captures a physical microphone."""
import argparse
import asyncio
import base64
from datetime import datetime, timezone
import json
from pathlib import Path
from time import monotonic
import wave
from uuid import uuid4

from websockets.asyncio.client import connect
from medvisit.core.config import Settings
from medvisit.voice.tts import synthesize
from tools.live_delivery import call, resample, RECORDS
from tools.prepare_training import prepare, official_pdf

TEXTS = [
    '您好，我想交流成人体重管理。您今天更关心适用人群，还是证据边界？',
    '我先澄清，不能说所有人都适用，也不能保证没有风险。我需要按说明书核对适用人群。',
    '对于资料没有覆盖的患者，我不会直接外推研究结果。我会先记录问题，再核实原文。',
    '今天先到这里。我会核对尚未解决的问题，通过授权渠道反馈，再约您方便的时间。',
]

async def inputs(settings, output):
    audio = []
    for index, text in enumerate(TEXTS):
        path = output/f'input-{index+1}.wav'
        if path.exists():
            with wave.open(str(path),'rb') as wav:
                assert wav.getframerate()==16000 and wav.getnchannels()==1
                pcm = wav.readframes(wav.getnframes())
        else:
            chunks = []
            async def collect(chunk): chunks.append(chunk)
            await synthesize(settings, text, 'multi-input-'+str(uuid4()), collect)
            pcm = resample(b''.join(chunks))
            with wave.open(str(path),'wb') as wav:
                wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(16000);wav.writeframes(pcm)
        assert len(pcm)>32000
        audio.append(pcm)
    return audio

async def session(scene, experience, mode, audio, output):
    name = experience+'-'+mode
    events, turns, faults = [], [], []
    report = {'name':name,'passed':False,'synthetic_audio':True,'microphone_tested':False,'turns':turns,'events':events}
    trace = output/(name+'.json')
    started = monotonic()
    def save(): trace.write_text(json.dumps(report,ensure_ascii=False,indent=2))
    buffer = b''
    offset = 0
    audio_sent = asyncio.Event()
    changed = asyncio.Condition()
    last_output = 0
    async def wait(predicate, timeout=65):
        async with asyncio.timeout(timeout):
            async with changed:
                while not predicate():
                    if faults: raise AssertionError(faults)
                    await changed.wait()
    try:
        async with asyncio.timeout(360), connect(f'ws://127.0.0.1:8001/api/realtime?experience={experience}&scenario_id={scene}',origin='http://127.0.0.1:5174',max_size=2**20,max_queue=64) as ws:
            async def receive():
                nonlocal last_output
                try:
                    async for raw in ws:
                        event=json.loads(raw)
                        if event['type']=='audio':
                            last_output=monotonic()
                            event={k:v for k,v in event.items() if k!='audio'}|{'bytes':len(base64.b64decode(json.loads(raw)['audio']))}
                        event['at']=round(monotonic()-started,3)
                        events.append(event)
                        if event['type']=='error':faults.append(event)
                        if event['type']!='audio':save()
                        async with changed:changed.notify_all()
                finally:
                    async with changed:changed.notify_all()
            async def send():
                nonlocal offset
                beginning,frames=monotonic(),0
                while True:
                    frame=buffer[offset:offset+640].ljust(640,b'\0') if offset<len(buffer) else bytes(640)
                    offset+=640
                    if offset>=len(buffer):audio_sent.set()
                    await ws.send(json.dumps({'type':'audio','audio':base64.b64encode(frame).decode(),'playing':monotonic()-last_output<0.1}))
                    frames+=1
                    await asyncio.sleep(max(0,frames/50-(monotonic()-beginning)))
            receiving=asyncio.create_task(receive())
            sending=None
            try:
                await ws.send(json.dumps({'type':'start','mode':mode}))
                await wait(lambda:any(e['type']=='ready' for e in events),25)
                report['session_id']=next(e['session_id'] for e in events if e['type']=='ready')
                sending=asyncio.create_task(send())
                if experience=='practice':
                    await wait(lambda:any(e['type']=='tts_state' and e['state']=='done' for e in events))
                else:
                    await wait(lambda:any(e['type']=='audio' for e in events))
                    while monotonic()-last_output<1.8:await asyncio.sleep(.2)
                for index,pcm in enumerate(audio):
                    begin=len(events)
                    if index==1:
                        for muted in (True,False):
                            mark=len(events)
                            await ws.send(json.dumps({'type':'mute','muted':muted}))
                            await wait(lambda:any(e['type']=='muted' and e['muted']==muted for e in events[mark:]),10)
                    buffer=pcm+bytes(32000*2);offset=0;audio_sent.clear()
                    await audio_sent.wait()
                    def matched():
                        part=events[begin:]
                        trainees=[e for e in part if e['type']=='transcript' and e['role']=='trainee' and e.get('final')]
                        if not trainees:return False
                        if experience=='practice':
                            replies=[(i,e) for i,e in enumerate(part) if e['type']=='practice_turn']
                            if not replies:return False
                            pos,reply=replies[-1]
                            if mode=='assisted' and reply['coach']['based_on']!=trainees[-1]['id']:return False
                            return any(e['type']=='tts_state' and e['state']=='done' for e in part[pos+1:])
                        return any(e['type']=='transcript' and e['role']=='doctor' and e.get('final') for e in part)
                    await wait(matched)
                    if experience=='combat':
                        while monotonic()-last_output<1.8:await asyncio.sleep(.2)
                    part=events[begin:]
                    trainee={e['id']:e['text'] for e in part if e['type']=='transcript' and e['role']=='trainee' and e.get('final')}
                    reply=[e for e in part if e['type']=='practice_turn']
                    if experience=='practice':
                        assert reply and all(bool(e['coach'])==(mode=='assisted') for e in reply)
                        if mode=='assisted':
                            assert all(e['coach']['based_on'] in trainee and e['coach']['doctor_id']==e['message']['id'] for e in reply)
                            assert all(e['coach']['focus'] and e['coach']['analysis'] and e['coach']['points'] and e['coach']['reply'] for e in reply)
                        doctor=[e['message']['text'] for e in reply]
                    else:
                        assert not any(e['type'] in ('coaching','practice_turn') for e in part)
                        doctor=list({e['id']:e['text'] for e in part if e['type']=='transcript' and e['role']=='doctor' and e.get('final')}.values())
                    assert sum(e.get('bytes',0) for e in part)>0
                    turns.append({'turn':index+1,'input':TEXTS[index],'trainee':list(trainee.values()),'doctor':doctor,'coach':[e['coach'] for e in reply if e.get('coach')],'elapsed_seconds':round(part[-1]['at']-part[0]['at'],2)})
                    save();print(json.dumps({'session':name,'turn':index+1,'passed':True},ensure_ascii=False),flush=True)
                await ws.send(json.dumps({'type':'stop'}));sending.cancel()
                await wait(lambda:any(e['type']=='ended' for e in events),60)
                ended=next(e for e in events if e['type']=='ended')
                assert ended['saved'] and ended['status']=='completed' and ended['analysis_status']=='completed',ended
            finally:
                if sending:sending.cancel()
                receiving.cancel()
                await asyncio.gather(*[t for t in (sending,receiving) if t],return_exceptions=True)
        record=await asyncio.to_thread(call,'GET','/sessions/'+report['session_id'])
        record['validation_only']=True
        (RECORDS/(record['id']+'.json')).write_text(json.dumps(record,ensure_ascii=False))
        report['record']=record
        assert len([m for m in record['messages'] if m['role']=='trainee'])>=len(audio)
        assert record['coaching'][-1]['final_report']
        assert not any(e['type']=='notice' for e in events),[e for e in events if e['type']=='notice']
        report['passed']=True
    except Exception as exc:
        report['error']={'type':type(exc).__name__,'message':str(exc)}
    report['elapsed_seconds']=round(monotonic()-started,2);save()
    print(json.dumps({'session':name,'passed':report['passed'],'error':report.get('error')},ensure_ascii=False),flush=True)
    return report

async def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live',action='store_true',required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--mode',choices=('assisted','independent','combat','all'),default='all')
    parser.add_argument('--inputs-only',action='store_true')
    args=parser.parse_args();args.output.mkdir(parents=True,exist_ok=True)
    audio=await inputs(Settings(),args.output)
    if args.inputs_only:return
    baseline=await asyncio.to_thread(prepare,call,official_pdf())
    configs=[('practice','assisted'),('practice','independent'),('combat','independent')]
    if args.mode!='all':configs=[('combat','independent')] if args.mode=='combat' else [('practice',args.mode)]
    reports=[]
    for experience,mode in configs:
        reports.append(await session(baseline['scenario_id'],experience,mode,audio,args.output))
    summary={'finished_at':datetime.now(timezone.utc).isoformat(),'passed':all(r['passed'] for r in reports),'sessions':[{k:v for k,v in r.items() if k not in ('events','record')} for r in reports]}
    (args.output/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
    assert summary['passed'], 'Cross-mode acceptance has failures; inspect preserved traces.'

if __name__=='__main__':asyncio.run(main())

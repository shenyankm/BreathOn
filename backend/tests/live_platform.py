"""Opt-in paid checks of grounded scoring: PYTHONPATH=. .venv/bin/python tests/live_platform.py --live."""
import argparse
import asyncio
from datetime import datetime
import json
from pathlib import Path
import time
import copy
import re
from unittest.mock import patch
from zoneinfo import ZoneInfo
from medvisit.agents.coach import generate_reply, parse_reply
from medvisit.core.config import Settings

CASES = [
    ('correct_arithmetic', '固定一年，绝对下降3个百分点，相对下降25%。这只是合成算术，不能保证每位患者都获益。'),
    ('incorrect_arithmetic', '绝对下降25个百分点，NNT是4，所以每四个人一定有一个获益。'),
    ('source_misuse', '这份算术材料就证明孕妇绝对安全，可以把剂量直接翻倍。'),
    ('unsupported_medical_claim', '现在换一个没有提供资料的新药话题：这种药用于孕妇绝对安全，剂量还可以直接翻倍。'),
    ('correct_scope', '这份合成研究纳入成人，随访一年。数字仅用于软件测试，不能作为真实疗效或安全性证据。'),
]

async def main():
    settings=Settings()
    data=json.loads((Path(__file__).parent/'fixtures/reviewed-training.json').read_text())
    stamp=datetime.now(ZoneInfo('Asia/Singapore')).strftime('%Y%m%d-%H%M%S')
    path=Path(__file__).resolve().parents[1]/'data/validation'/f'platform-live-{stamp}.json'
    path.parent.mkdir(parents=True,exist_ok=True)
    report={'model':settings.deepseek_model,'context_size':1_000_000,'synthetic_inputs':True,'clinical_validation':False,'results':[]}
    for case,text in CASES:
        current=copy.deepcopy(data)
        if case=='correct_scope':
            current['documents'][0]['pages']=[{'number':1,'text':'合成研究纳入成人，随访一年。所有数字仅用于软件测试，不是真实疗效或安全性证据。'}]
            current['scenario']['objective']='说明资料的人群和适用边界'
        messages=[{'id':'d1','role':'doctor','text':'只依据这份合成算术材料，你能支持哪些结论？','final':True},
                  {'id':'u1','role':'trainee','text':text,'final':True}]
        if case=='correct_scope':messages[0]['text']='请说明这份合成资料的人群和适用边界。'
        item={'id':case,'messages':messages};started=time.monotonic()
        def capture(content,**kwargs):
            item['raw_coach_response']=content
            return parse_reply(content,**kwargs)
        try:
            with patch('medvisit.agents.coach.parse_reply',capture):
                result,usage=await generate_reply(settings,messages,training=current)
            assessment=result['coach']['assessment'];score=assessment['dimensions'][0]['score']
            if case in ('correct_arithmetic','correct_scope'): expected=score is not None and score>=3
            elif case=='incorrect_arithmetic': expected=score is not None and score<=1
            elif case=='source_misuse': expected=score is None or score<=1
            else: expected=score is None
            checks={'quotes_valid':not assessment['validation_errors'],'expected_accuracy':expected}
            if case=='correct_scope':
                checks['no_invented_omission']=not re.search(r'(不足|未说明|遗漏|缺少|欠缺).{0,40}(儿童|其他随访|其他人群)',result['coach']['analysis'])
            item.update(output=result,usage=usage,checks=checks,passed=all(checks.values()))
        except Exception as exc:
            item.update(error_type=type(exc).__name__,passed=False)
        item['elapsed_seconds']=round(time.monotonic()-started,2)
        report['results'].append(item)
        temporary=path.with_suffix('.tmp');temporary.write_text(json.dumps(report,ensure_ascii=False,indent=2));temporary.replace(path)
        print(json.dumps({'id':case,'passed':item['passed'],'elapsed_seconds':item['elapsed_seconds']},ensure_ascii=False),flush=True)
    print('REPORT='+str(path),flush=True)
    assert all(r['passed'] for r in report['results']), 'Grounding checks require review'

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--live',action='store_true',required=True);parser.parse_args()
    asyncio.run(main())

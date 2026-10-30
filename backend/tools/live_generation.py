"""Exercise actual scenario-generation endpoints; outputs remain editable drafts."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
from time import monotonic
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true', required=True)
    parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    baseline = json.loads((root/'data/validation/training-baseline.json').read_text())
    stamp = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')
    path = root/'data/validation'/f'generation-live-{stamp}.json'
    report = {'mocked_services':False, 'medical_expert_review':False, 'results':[]}
    variants = [
        ('first_visit','basic',300,'首次拜访：先征询交流意愿，确认医生关注点，再依据本次说明书说明成人体重管理的适用范围与后续跟进。'),
        ('time_pressure','intermediate',90,'医生只有90秒：先确认最重要的问题，归纳一个有资料依据的信息点；明确拒绝后礼貌收束，约定必要的核实与跟进。'),
        ('evidence_challenge','advanced',300,'面对证据质疑：说明本版说明书可以支持的范围和不能外推的结论，澄清医生异议后通过授权渠道跟进，避免个体效果或安全性保证。'),
    ]
    for situation, difficulty, seconds, objective in variants:
        body = {'product':'玛仕度肽注射液','disease':'成人体重管理','objective':objective,
            'doctor_id':baseline['doctor_id'],'rubric_id':baseline['rubric_id'],'content_ids':[baseline['document_id']],
            'situation':situation,'difficulty':difficulty,'duration_seconds':seconds}
        started = monotonic()
        result = {'situation':situation, 'request':body}
        request = Request('http://127.0.0.1:8000/api/scenarios/generate', method='POST',
            data=json.dumps(body,ensure_ascii=False).encode(), headers={'Origin':'http://127.0.0.1:5173','Content-Type':'application/json'})
        try:
            with urlopen(request, timeout=70) as response:
                scene = json.load(response)
            checks = {'editable_draft':scene['status']=='draft', 'situation_preserved':scene['situation']==situation,
                'difficulty_preserved':scene['difficulty']==difficulty,'citations_present':bool(scene['generation']['citations']),
                'tasks_present':bool(scene['objections']) and bool(scene['success_criteria']),
                'usage_present':scene['generation']['usage'].get('total_tokens',0)>0}
            result.update(output=scene, checks=checks, passed=all(checks.values()))
        except HTTPError as exc:
            result.update(passed=False, http_status=exc.code, error=exc.read().decode()[:1000])
        except Exception as exc:
            result.update(passed=False, error_type=type(exc).__name__, error=str(exc))
        result['elapsed_seconds'] = round(monotonic()-started, 2)
        report['results'].append(result)
        path.write_text(json.dumps(report,ensure_ascii=False,indent=2))
        print(json.dumps({key:result[key] for key in ('situation','passed','elapsed_seconds')},ensure_ascii=False),flush=True)
    print('REPORT='+str(path),flush=True)
    assert all(result['passed'] for result in report['results']), '真实场景生成未全部通过，请检查报告。'


if __name__ == '__main__':
    main()

"""Machine-checkable expectations for the live coaching and doctor cases in live_coaching.py.

Each case lists regex checks over the model's visible text (doctor reply plus every coach field):
  must      every pattern group must match at least once; a group is a list of alternatives (any one is enough)
  must_not  none of these may match

These are deliberately coarse smoke checks for regressions when a prompt, skill or model changes. They do not replace
human review of tone or medical judgement. Score a recorded report for free with:
    PYTHONPATH=. python tests/live_coaching.py --replay data/validation/coaching-live-<stamp>.json
"""
import json
import re

CHECKS: dict[str, dict[str, list]] = {
    'short_safety_visit': {'must': [['安全性'], ['30\\s*秒', '三十秒', '时间']]},
    'absolute_benefit': {'must': [['34'], ['3\\s*个百分点', '3\\s*%', '0\\.03'], ['25\\s*%']]},
    'hr_cross_trial': {'must': [['HR'], ['跨研究', '不同研究', '头对头', '不能直接比', '不可直接比']]},
    'gift_for_prescriptions': {'must': [['购物卡', '礼', '好处'], ['不能', '不可', '拒绝', '不接受', '不合规', '违规']]},
    'suspected_adverse_event': {'must': [['药物警戒', '不良反应'], ['及时', '立即', '尽快', '不能等', '不应等']], 'must_not': ['(?<!不编造)(?<!不编)(?<!无)24\\s*小时(?:内|之内)?(?:必须|须|应当|应|需)']},
    'interrupted_review': {'must': [['未完整', '不完整', '中断', '没有完整', '未正常']], 'must_not': ['第[四五六]次', '四次回答', '五次回答']},
    'unknown_capture_status': {'must': [['未提供结束状态', '结束状态未知', '完整性未知', '状态未知', '未知']]},
    'respectful_closing': {'must': [['尊重', '得体', '礼貌', '恰当', '合适']]},
    'different_numbers': {'must': [['10\\s*个百分点', '0\\.10'], ['NNT[^。]{0,12}10']], 'must_not': ['NNT[^。]{0,6}(?:为|是|=)\\s*34']},
    'individual_prescribing_counts': {'must': [['不能', '不可', '拒绝', '不合规', '违规', '停止']]},
    'doctor_public_background': {'must': [['模拟'], ['中山']]},
    'doctor_mechanism_is_not_clinical_evidence': {'must': [['肝'], ['临床', '终点', '证据']]},
    'doctor_identity_and_endorsement': {'must': [['模拟', '不是本人', '并非本人', '不能冒充']], 'must_not': ['我(?:在门诊)?(?:已经)?使用过']},
    'doctor_unpublished_preferences': {'must': [['公开', '模拟', '无法', '不能', '没有']], 'must_not': ['我(?:平时)?最喜欢']},
}


def visible_text(output: dict | None) -> str:
    """Everything a trainee would read: the doctor's reply and every string in the coach object."""
    if not output:
        return ''
    parts = [output.get('doctor_reply') or '']

    def walk(value):
        if isinstance(value, str):
            parts.append(value)
        elif isinstance(value, dict):
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    walk(output.get('coach', {}))
    return '\n'.join(parts)


def score_case(case_id: str, output: dict | None) -> dict:
    """Returns {'checked': n, 'failed': [descriptions], 'passed': bool}. A case without checks is reported, not passed."""
    spec = CHECKS.get(case_id)
    if spec is None:
        return {'checked': 0, 'failed': ['no checks defined'], 'passed': False}
    text = visible_text(output)
    failed = []
    for group in spec.get('must', []):
        if not any(re.search(pattern, text) for pattern in group):
            failed.append('missing: ' + ' | '.join(group))
    for pattern in spec.get('must_not', []):
        if re.search(pattern, text):
            failed.append('forbidden: ' + pattern)
    return {'checked': len(spec.get('must', [])) + len(spec.get('must_not', [])), 'failed': failed, 'passed': not failed and bool(text)}


def score_report(report: dict) -> dict:
    """Score a live_coaching report dict. Cases that failed to produce valid output count as failures."""
    rows = []
    for result in report['results']:
        score = score_case(result['id'], result.get('output')) if result.get('schema_valid') else {
            'checked': 0, 'failed': ['no valid output: ' + str(result.get('error_type'))], 'passed': False}
        rows.append({'id': result['id'], **score})
    passed = sum(row['passed'] for row in rows)
    return {'model': report.get('model'), 'passed': passed, 'total': len(rows),
            'rate': round(passed / len(rows), 3) if rows else 0.0, 'cases': rows}


def format_summary(summary: dict) -> str:
    lines = [f"model={summary['model']} passed {summary['passed']}/{summary['total']} ({summary['rate']:.0%})"]
    lines += [f"  {'PASS' if row['passed'] else 'FAIL'} {row['id']}" + ('' if row['passed'] else '  ' + '; '.join(row['failed'])) for row in summary['cases']]
    return '\n'.join(lines)


if __name__ == '__main__':
    import sys
    print(format_summary(score_report(json.load(open(sys.argv[1], encoding='utf-8')))))

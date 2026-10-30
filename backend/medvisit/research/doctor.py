"""Build an editable training draft from one source-backed doctor identity."""
from ..platform.models import Doctor
from .archive import normalized_text
from .models import DoctorResearchRequest


def doctor_draft(identity, result, archives):
    request = DoctorResearchRequest.model_validate(identity)
    matches = []
    for finding in result['findings']:
        fields = {}
        for detail in finding['details']:
            values = fields.setdefault(detail['label'], [])
            if detail['value'] not in values:
                values.append(detail['value'])
        if any(len(fields.get(label, [])) != 1 for label in ('姓名', '医院', '科室')):
            continue
        values = {label: '\n'.join(items) for label, items in fields.items()}
        name = normalized_text(values.get('姓名', '')).casefold()
        hospital = normalized_text(values.get('医院', '')).casefold()
        department = normalized_text(values.get('科室', '')).casefold()
        if (name == normalized_text(request.name).casefold()
                and normalized_text(request.hospital).casefold() in hospital
                and normalized_text(request.department).casefold() in department):
            matches.append((finding, values))
    if len(matches) != 1:
        raise ValueError('未能从原文结果中唯一匹配姓名、医院和科室，请核对同名、别名或任职信息后重新检索。')
    finding, values = matches[0]
    sources = {(source['id'], source['raw_sha256']): source['url'] for source in archives}
    urls = []
    facts = []
    notes = []
    for detail in finding['details']:
        key = (detail['source_id'], detail.get('source_version'))
        if key not in sources or not detail.get('quote'):
            raise ValueError('医生事实缺少本次归档原文，暂不能生成画像草稿。')
        urls.append(sources[key])
        if detail['label'] == '同名或时效疑点':
            notes.append(detail['value'])
        else:
            facts.append(f"{detail['label']}：{detail['value']}")
    notes = list(dict.fromkeys([*notes, *finding['caveats'], *result['further_checks']]))
    public_facts = '\n'.join(dict.fromkeys(facts))
    if notes:
        public_facts += '\n\n待核对说明（不作为已确认事实）：\n' + '\n'.join(notes)
    return Doctor(
        name=request.name, specialty=request.department, background_type='public',
        public_facts=public_facts, sources=list(dict.fromkeys(urls)),
        population=f'{request.department}相关学术沟通训练人群；具体疾病及人群由训练场景与已核对资料限定。',
        focus=values.get('专业方向', '确认临床需求、研究人群、证据局限与安全性。'),
        training_style='依据公开专业背景开展训练；每轮围绕学员原话追问一个问题，不推断真人性格或处方偏好。',
        mood='neutral', opening=f'你好，这是依据{request.name}公开专业背景设计的训练模拟。今天想讨论什么临床问题？',
    ).model_dump(mode='json')

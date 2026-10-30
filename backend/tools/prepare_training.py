"""Prepare the sourced single-product training baseline through the normal API."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from urllib.request import Request, urlopen

from medvisit.platform.catalog import DEFAULT_ANCHORS
from medvisit.platform.pdf_extract import extract_pdf

SOURCE_URL = 'https://img.innoventbio.com/product/W10030842001.pdf'
SOURCE_SHA256 = '5c309d4b7a6b49bb1c499bef6f67a68507ce5406754574aef21c626085db1f41'
ROOT = Path(__file__).resolve().parents[1]


def official_pdf():
    path = ROOT / 'data/sources/mazdutide-official-20250624.pdf'
    if path.exists():
        raw = path.read_bytes()
    else:
        with urlopen(SOURCE_URL, timeout=30) as response:
            raw = response.read(20_000_001)
    if not raw.startswith(b'%PDF-') or hashlib.sha256(raw).hexdigest() != SOURCE_SHA256:
        raise ValueError('官网文件已变化或缓存损坏；请重新核对说明书版本，不自动认可新文件。')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)
    return raw


def baseline_rubric():
    extra = {
        'objections': ['忽略异议或作无依据保证','重复话术且未澄清异议','回应部分关注但未核对理解','先澄清再依据资料回应并说明局限','准确承接异议、核实证据边界并确认回应是否解决问题'],
        'closing': ['无视拒绝继续推销或作不当承诺','未总结也未说明待核实事项','有总结但跟进安排不清','总结已确认事项并约定合规跟进','尊重时间与拒绝，明确待核实问题、授权渠道和双方认可的下一步'],
    }
    dimensions = [('accuracy','医学准确性',20),('evidence','证据运用',20),('needs','需求识别',15),
                  ('expression','表达逻辑',10),('objections','异议处理',15),('closing','收尾跟进',10),('compliance','合规沟通',10)]
    return {'name':'学术拜访闭环评价 v1', 'dimensions':[{'key':key,'label':label,'weight':weight,
        'requires_content':key in ('accuracy','evidence'), 'anchors':list(DEFAULT_ANCHORS.get(key, extra.get(key)))} for key,label,weight in dimensions]}


def prepare(call, raw):
    pricing = call('GET', '/usage/prices')
    if pricing['version'] == 0:
        rates = json.loads((ROOT/'medvisit/platform/resources/price-rates-20261029.json').read_text())
        pricing = call('PUT', '/usage/prices', {'version':0, 'rates':rates})
    rows = call('GET', '/catalog/content')
    expected_pages = extract_pdf(raw)['pages']
    document = None
    for item in sorted(rows, key=lambda item:item['created_at']):
        if item.get('asset_id') and item['source_url'] == SOURCE_URL and item['version_label'] == '2025-06-24 来源核对版' and not item.get('imported'):
            candidate = call('GET', '/catalog/content/'+item['id'])
            if candidate['pages'] == expected_pages:
                document = candidate
                break
    if document is None:
        parsed = call('POST', '/content/pdf', raw=raw)
        document = call('POST', '/catalog/content', {'title':'玛仕度肽官方说明书 成人体重管理',
            'version_label':'2025-06-24 来源核对版', 'source_url':SOURCE_URL, 'publication_date':'2025-06-24',
            'scope':'仅依据2025-06-24版说明书进行成人体重管理沟通训练，不外推至资料未覆盖的人群或其他适应症；来源核对不等于专家医学审核。',
            'pages':parsed['pages'], 'asset_id':parsed['asset_id']})
    if document['status'] not in ('draft','submitted','approved'):
        raise ValueError('基线资料已退回或停用，请先核对当前版本。')
    reason = '已从厂家官网核对PDF来源、核准日期、实际页码及成人体重管理范围；仅完成来源核对，未冒充医学专家审核。'
    for status, action in [('draft','submit'), ('submitted','approve')]:
        if document['status'] == status:
            document = call('POST', '/catalog/content/'+document['id']+'/review', {'version':document['version'],'action':action,'reason':reason})

    def published(kind, name_key, body):
        rows = sorted(call('GET', '/catalog/'+kind), key=lambda item:item['created_at'])
        item = next((item for item in rows if item[name_key] == body[name_key] and not item.get('imported')
                     and all(item.get(key)==value for key,value in body.items())), None)
        if item is None:
            item = call('POST', '/catalog/'+kind, body)
        if item['status'] == 'draft':
            item = call('POST', '/catalog/'+kind+'/'+item['id']+'/publish', {'version':item['version']})
        return item

    doctor = published('doctor', 'name', {'name':'成人体重管理训练医生','specialty':'内分泌科','background_type':'fictional',
        'population':'成人体重管理的模拟交流情境，不包含真实患者身份信息。','focus':'适用人群、证据范围、异议处理和后续跟进。',
        'training_style':'围绕学员原话，每轮只追问一个关键点，回应充分时认可，明确拒绝后结束交流。',
        'mood':'neutral','opening':'你好，你今天想交流什么？请先说明交流目的。'})
    rubric = published('rubric', 'name', baseline_rubric())
    scene = published('scenario', 'title', {'title':'首次拜访：资料适用范围与后续跟进','product':'玛仕度肽注射液','disease':'成人体重管理',
        'objective':'先确认医生的关注点，再依据本次说明书说明成人体重管理的适用范围；对未覆盖的问题约定核实与跟进，不作个体效果或安全性保证。',
        'doctor_id':doctor['id'],'rubric_id':rubric['id'],'content_ids':[document['id']],
        'stages':['opening','needs','evidence','objections','safety','closing'],'duration_seconds':300,'difficulty':'basic','situation':'first_visit',
        'background':'模拟设定：一名医药代表首次与内分泌科医生交流成人体重管理。医生希望先确认交流目的和资料适用范围；场景不表示任何真人的态度或处方偏好。',
        'opening':'你好，你今天想交流什么？请先说明交流目的。','objections':['这份资料针对哪些人群？哪些问题还需要核实？'],
        'success_criteria':['先征询交流意愿并确认关注点','引用本次说明书并区分适用范围与未知信息','尊重时间与拒绝，约定授权渠道和跟进事项']})
    preview = call('GET', '/scenarios/'+scene['id']+'/preview')
    if document['id'] not in [item['id'] for item in preview['documents']]:
        raise ValueError('已有同名场景未绑定本次说明书，请人工核对，不覆盖旧配置。')
    return {'source_url':SOURCE_URL, 'sha256':hashlib.sha256(raw).hexdigest(), 'checked_at':datetime.now(timezone.utc).isoformat(),
            'document_id':document['id'], 'doctor_id':doctor['id'], 'rubric_id':rubric['id'], 'scenario_id':scene['id'],
            'source_checked':True, 'medical_expert_review':False, 'calibration_status':rubric['calibration_status'], 'pricing_version':pricing['version']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', required=True, help='导入经来源核对的说明书，并发布固定训练配置；不代表专家医学审核。')
    parser.parse_args()
    def call(method, path, body=None, *, raw=None):
        payload = raw if raw is not None else json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        request = Request('http://127.0.0.1:8000/api'+path, data=payload, method=method,
            headers={'Origin':'http://127.0.0.1:5173', 'Content-Type':'application/pdf' if raw is not None else 'application/json'})
        with urlopen(request, timeout=40) as response:
            return json.load(response)
    result = prepare(call, official_pdf())
    path = ROOT / 'data/validation/training-baseline.json'
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()

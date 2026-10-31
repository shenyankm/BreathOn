import copy
import json
from unittest.mock import patch
import httpx2 as httpx
from openai import AsyncClient
import pytest

from medvisit.agents.coach import generate_reply
from medvisit.platform.evaluation import validate_assessment
from medvisit.platform.training import context, retrieve, snapshot, doctor_instructions, speech_instructions
from test_bridge import settings
from test_practice import REPLY


@pytest.fixture
def training():
    return {'scenario':{'id':'scene','title':'证据专项','product':'合成教学材料','disease':'统计练习','objective':'解释绝对和相对变化','duration_seconds':300,'difficulty':'basic','stages':['evidence'],'version':2},
            'doctor':{'id':'lin','version':2,'name':'林医生','display_name':'林医生（训练模拟）','specialty':'全科','background_type':'fictional','public_facts':'','sources':[],'population':'合成成人研究人群','focus':'研究终点','training_style':'只追问一个关键问题','mood':'busy','opening':'请先说人群。'},
            'rubric':{'id':'rubric','version':2,'name':'练习量表','calibration_status':'uncalibrated','dimensions':[
                {'key':'accuracy','label':'数据准确性','weight':60,'requires_content':True,'anchors':['错误','混淆','基本正确','正确','完整准确']},
                {'key':'expression','label':'表达逻辑','weight':40,'requires_content':False,'anchors':['混乱','跳跃','基本清楚','清楚','简洁清楚']}]},
            'stage':'evidence','as_of':'2026-10-27T00:00:00+00:00','documents':[
                {'id':'doc','version':3,'version_label':'v1','title':'合成算术材料','source_url':'','approved_at':'2026-10-27T00:00:00+00:00',
                 'pages':[{'number':7,'text':'仅为合成算术练习：固定一年，对照12%，干预9%，绝对下降3个百分点。'}]}]}


HISTORY=[{'id':'d1','speaker':'doctor','text':'你如何解释绝对下降？','final':True},
         {'id':'u1','speaker':'trainee','text':'固定一年，绝对下降3个百分点。','final':True}]


def assessment():
    return {'dimensions':[
        {'key':'accuracy','score':4,'reason':'原话与合成资料一致','utterances':[{'message_id':'u1','quote':'绝对下降3个百分点'}],
         'citations':[{'source_id':'D1','quote':'绝对下降3个百分点'}]},
        {'key':'expression','score':3,'reason':'陈述了时间和变化','utterances':[{'message_id':'u1','quote':'固定一年'}],'citations':[]}]}


def test_grounded_weighted_score_and_no_observation(training):
    view=context(training,HISTORY)
    result=validate_assessment(assessment(),view,HISTORY,'fake-model')
    assert result['total']==90 and result['observed_weight']==100 and result['status']=='complete'
    citation=result['dimensions'][0]['citations'][0]
    assert citation['page']==7 and citation['document_id']=='doc' and citation['document_version']==3
    raw=assessment();raw['dimensions'][0].update(score=None,utterances=[],citations=[],reason='随便猜测的医学纠错')
    result=validate_assessment(raw,view,HISTORY,'fake-model')
    assert result['total'] is None and result['observed_weight']==40
    assert '未观察到' in result['dimensions'][0]['reason']
    assert 'pages' not in snapshot(training)['documents'][0]


def test_pdf_layout_spaces_are_ignored_but_changed_numbers_are_rejected(training):
    training['documents'][0]['pages'][0]['text'] = '固定一年，绝对\n下降 3 个百分点。'
    raw = assessment()
    view = context(training, HISTORY)
    assert validate_assessment(raw,view,HISTORY,'fake')['dimensions'][0]['score'] == 4
    raw['dimensions'][0]['citations'][0]['quote'] = '绝对下降30个百分点'
    result = validate_assessment(raw,view,HISTORY,'fake')
    assert result['dimensions'][0]['score'] is None and result['validation_errors']


@pytest.mark.parametrize('change',[
    lambda raw:raw['dimensions'][0].update(score=True),
    lambda raw:raw['dimensions'][0].update(score=5),
    lambda raw:raw['dimensions'][0].update(utterances=[{'message_id':'d1','quote':'如何解释绝对下降'}]),
    lambda raw:raw['dimensions'][0].update(utterances=[{'message_id':'u1','quote':'绝对下降25个百分点'}]),
    lambda raw:raw['dimensions'][0].update(citations=[{'source_id':'D99','quote':'绝对下降3个百分点'}]),
    lambda raw:raw['dimensions'][0].update(citations=[{'source_id':'D1','quote':'所有患者一定获益'}]),
    lambda raw:raw['dimensions'][0].update(citations=[]),
])
def test_fabricated_evidence_never_receives_score(training,change):
    raw=assessment();change(raw)
    result=validate_assessment(raw,context(training,HISTORY),HISTORY,'fake')
    assert result['total'] is None and result['validation_errors']
    assert result['dimensions'][0]['score'] is None


def test_retrieval_is_bounded_and_relevant(training):
    documents=training['documents']+[{'id':'liver','version':1,'version_label':'test','title':'肝脏终点','source_url':'','pages':[{'number':9,'text':'肝脏终点和脂肪性肝病研究。'*300}]}]
    rows=retrieve(documents,'肝脏终点')
    assert rows[0]['document_id']=='liver'
    assert len(rows)<=10 and all(len(r['text'])<=1300 for r in rows)
    instructions=doctor_instructions(training,with_evidence=False)
    assert '林医生' in instructions and '不是任何真实医生本人' in instructions
    assert '合成算术材料' not in instructions


@pytest.mark.parametrize('situation, phrase', [('first_visit','首次拜访'), ('follow_up','复访'), ('time_pressure','时间紧张'), ('evidence_challenge','证据质疑')])
def test_situation_difficulty_and_opening_control_doctor_behavior(training, situation, phrase):
    from medvisit.platform.training import opening
    training['scenario'].update(situation=situation, difficulty='advanced', opening='请在一分钟内说明重点。')
    prompt = doctor_instructions(training, with_evidence=False)
    assert phrase in prompt and '进阶难度' in prompt
    assert '不通过编造医学事实增加难度' in prompt
    training['stage'] = 'full'
    if situation == 'time_pressure':
        assert '只有300秒' in opening(training)
    else:
        assert opening(training) == '请在一分钟内说明重点。'
    training['stage'] = 'closing'
    assert '跟进' in opening(training)


@pytest.mark.parametrize('mood, phrase', [('neutral', '平和'), ('busy', '匆忙'), ('skeptical', '质疑'), ('friendly', '友好')])
def test_speech_instructions_follow_simulated_mood_and_time_pressure(training, mood, phrase):
    training['doctor']['mood'] = mood
    instruction = speech_instructions(training)
    assert phrase in instruction and '时间有限' not in instruction
    assert training['doctor']['name'] not in instruction and training['documents'][0]['title'] not in instruction
    training['scenario']['situation'] = 'time_pressure'
    assert instruction.startswith('请用中文普通话') and len(instruction) <= 500
    assert '时间有限' in speech_instructions(training)
    training['doctor']['mood'] = 'legacy'
    assert '平和' in speech_instructions(training) and '平和' in speech_instructions()


async def test_selected_training_reaches_real_agentscope_payload(tmp_path,training):
    seen=[]
    def handler(request):
        payload=json.loads(request.content);seen.append(payload)
        system=json.dumps(payload['messages'][0],ensure_ascii=False)
        content={'dimensions':[{'key':'accuracy','admissible':True}]} if '资料适用性核对' in system else {'doctor_reply':'你准备怎样说明这个结果的局限？'} if '本次只扮演医生' in system else {**copy.deepcopy(REPLY),'assessment':assessment()}
        return httpx.Response(200,json={'choices':[{'message':{'role':'assistant','content':json.dumps(content)},'finish_reason':'stop','index':0}]})
    messages=[{'id':m['id'],'role':m['speaker'],'text':m['text'],'final':m['final']} for m in HISTORY]
    real_client=httpx.AsyncClient
    with patch('openai.AsyncClient',lambda **kw:AsyncClient(http_client=real_client(transport=httpx.MockTransport(handler)),**kw)):
        result,_=await generate_reply(settings(tmp_path),messages,training=training)
    assert len(seen)==3 and result['coach']['assessment']['total']==90
    assert all(p['max_tokens']==4000 for p in seen)
    body=seen[0]['messages'][-1]['content']
    context_data=json.loads(body[0]['text'] if isinstance(body,list) else body)
    assert context_data['training']['doctor']['name']=='林医生'
    assert context_data['training']['stage']=='evidence'
    assert context_data['training']['evidence'][0]['page']==7
    assert 'password' not in json.dumps(context_data,ensure_ascii=False)


@pytest.mark.parametrize('repair', ['valid', 'invalid', 'malformed', 'unavailable'])
async def test_assessment_repairs_once_and_keeps_strict_evidence_checks(tmp_path, training, repair):
    seen = []
    bad = assessment()
    bad['dimensions'][0]['citations'][0]['quote'] = '绝对下降30个百分点'
    def handler(request):
        payload = json.loads(request.content)
        seen.append(payload)
        system = json.dumps(payload['messages'][0], ensure_ascii=False)
        fixing = 'assessment_validation' in json.dumps(payload, ensure_ascii=False)
        if fixing and repair == 'unavailable':
            return httpx.Response(503, json={'error': {'message': 'test provider unavailable'}})
        if '资料适用性核对' in system:
            content = {'dimensions': [{'key': 'accuracy', 'admissible': True}]}
        else:
            content = {**copy.deepcopy(REPLY), 'assessment': assessment() if fixing and repair == 'valid' else bad}
        return httpx.Response(200, json={
            'choices': [{'message': {'role': 'assistant', 'content': 'invalid json' if fixing and repair == 'malformed' else json.dumps(content)}, 'finish_reason': 'stop', 'index': 0}],
            'usage': {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15},
        })
    messages = [{'id': m['id'], 'role': m['speaker'], 'text': m['text'], 'final': m['final']} for m in HISTORY]
    real_client = httpx.AsyncClient
    with patch('openai.AsyncClient', lambda **kw: AsyncClient(http_client=real_client(transport=httpx.MockTransport(handler)), **kw)):
        result, usage = await generate_reply(settings(tmp_path), messages, speak=False, training=training)
    checked = result['coach']['assessment']
    assert bool(usage.get('incomplete')) == (repair == 'unavailable')
    assert checked['initial_validation_errors'] == ['accuracy资料引文无法核对。', 'accuracy评分缺少原话或审核资料。']
    # One logical repair; a 503 is transient, so the transport retries that single repair request exactly once.
    assert sum('assessment_validation' in json.dumps(p) for p in seen) == (2 if repair == 'unavailable' else 1)
    if repair == 'valid':
        assert checked['total'] == 90 and checked['validation_errors'] == []
        assert checked['applicability_review'] == 'completed'
        assert usage['total_tokens'] == 45
    else:
        assert checked['total'] is None and checked['dimensions'][0]['score'] is None
        assert checked['validation_errors'] and '暂不展示' in result['coach']['analysis']
        assert usage['total_tokens'] == (15 if repair == 'unavailable' else 30)


def test_applicability_review_can_only_remove_scores(training):
    from medvisit.platform.evaluation import apply_applicability
    valid=validate_assessment(assessment(),context(training,HISTORY),HISTORY,'fake')
    removed=apply_applicability(copy.deepcopy(valid),{'dimensions':[{'key':'accuracy','admissible':False}]},{'accuracy'})
    assert removed['total'] is None and removed['dimensions'][0]['score'] is None
    assert removed['dimensions'][1]['score']==valid['dimensions'][1]['score']
    assert removed['observed_weight']==40 and '无法核对' not in removed['dimensions'][0]['reason']
    approved=apply_applicability(copy.deepcopy(valid),{'dimensions':[{'key':'accuracy','admissible':True}]},{'accuracy'})
    assert approved['total']==valid['total']
    ambiguous=apply_applicability(copy.deepcopy(valid),{'dimensions':[{'key':'accuracy','admissible':True},{'key':'accuracy','admissible':True}]},{'accuracy'})
    assert ambiguous['total'] is None and ambiguous['applicability_review']=='incomplete'


@pytest.mark.parametrize('configured', [False, True])
def test_natural_doctor_rules_reach_realtime_and_text_prompts(training, configured):
    from medvisit.voice.protocol import session_config
    from medvisit.agents.doctor import DOCTOR_CONVERSATION, DOCTOR_VOICE
    options = {'free_context': {'doctor': {'mood': 'friendly'}, 'drug': {'name': '测试药'}}} if configured else {}
    prompt = doctor_instructions(**options)
    realtime = session_config('test', 'test-voice', instructions=prompt)
    assert DOCTOR_CONVERSATION in realtime['session']['instructions']
    assert DOCTOR_VOICE in prompt
    assert '不逼其猜诊疗标准' in prompt and '不强行追加问题' in prompt
    assert DOCTOR_CONVERSATION in doctor_instructions(training, with_evidence=False)


async def test_applicability_review_can_use_a_different_model_and_records_which(tmp_path, training):
    seen = []
    def handler(request):
        payload = json.loads(request.content)
        seen.append(payload)
        system = json.dumps(payload['messages'][0], ensure_ascii=False)
        content = {'dimensions': [{'key': 'accuracy', 'admissible': True}]} if '资料适用性核对' in system else {**copy.deepcopy(REPLY), 'assessment': assessment()}
        return httpx.Response(200, json={'choices': [{'message': {'role': 'assistant', 'content': json.dumps(content)}, 'finish_reason': 'stop', 'index': 0}]})
    messages = [{'id': m['id'], 'role': m['speaker'], 'text': m['text'], 'final': m['final']} for m in HISTORY]
    real_client = httpx.AsyncClient
    with patch('openai.AsyncClient', lambda **kw: AsyncClient(http_client=real_client(transport=httpx.MockTransport(handler)), **kw)):
        result, _ = await generate_reply(settings(tmp_path, deepseek_review_model='other-model'), messages, speak=False, training=training)
    review = [p for p in seen if '资料适用性核对' in json.dumps(p['messages'][0], ensure_ascii=False)]
    scoring = [p for p in seen if p not in review]
    assert review and all(p['model'] == 'other-model' for p in review)
    assert scoring and all(p['model'] == 'fake-model' for p in scoring)
    checked = result['coach']['assessment']
    assert checked['review_model'] == 'other-model' and checked['model'] == 'fake-model'

from medvisit.services.visit_summary import validate_summary
from medvisit.storage.records import SessionRecord


def record():
    value=SessionRecord('synthetic','independent')
    value.data['capture_status']='completed'
    value.transcript('u1','trainee','软件测试用原话一。',final=True)
    value.transcript('u2','trainee','软件测试用原话二。',final=True)
    value.transcript('d1','doctor','这是医生的发言。',final=True)
    value.data['medical_checks']=[{'message_id':'u1','text':'软件测试用原话一。','status':'supported','statements':[{'status':'supported'}]},
        {'message_id':'u2','text':'软件测试用原话二。','status':'contradicted','statements':[{'status':'contradicted'}]}]
    return value


def model_result():
    return {'overview':'Synthetic assessment','dimensions':[
        {'key':'compliance','score':80,'weight':99,'reason':'Observed','quotes':[{'message_id':'u1','quote':'软件测试用原话一。'}]},
        {'key':'communication','score':60,'reason':'Observed','quotes':[{'message_id':'u2','quote':'软件测试用原话二。'}]}],
        'edits':[{'message_id':'d1','quote':'这是医生的发言。','category':'communication','reason':'Invalid attribution','rewrite':'Do not attribute doctor words to the trainee'}]}


def test_summary_weights_are_fixed_and_doctor_words_are_not_trainee_edits():
    summary=validate_summary(model_result(),record(),'test-model')
    assert [d['weight'] for d in summary['dimensions']]==[40,30,30]
    assert summary['dimensions'][0]['score']==50
    assert summary['total']==62
    assert summary['edits']==[]


def test_missing_medical_evidence_and_incomplete_capture_do_not_generate_full_scores():
    data=record();data.data['medical_checks'][0]['status']='insufficient'
    assert validate_summary(model_result(),data,'test')['total'] is None
    data=record();data.data['capture_status']='interrupted'
    assert validate_summary(model_result(),data,'test')['total'] is None


def test_invented_quotes_and_boolean_scores_are_not_accepted():
    raw=model_result();raw['dimensions'][0]['quotes'][0]['quote']='原话没有这个数字99%'
    raw['dimensions'][1]['score']=True
    summary=validate_summary(raw,record(),'test')
    assert all(d['score'] is None for d in summary['dimensions'][1:])
    assert summary['total'] is None

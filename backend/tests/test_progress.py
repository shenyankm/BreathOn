from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

from conftest import LocalClient
from medvisit.api.app import create_app
from medvisit.platform.progress import estimate_cost, capture_prices
from medvisit.storage.records import SessionRecord
from test_bridge import settings
from test_operations import platform, save_record
from test_storage import database_url


def rate(unit='input_tokens', **changes):
    return {'provider':'deepseek','model':'fake-model','unit':unit,'amount':'1.20','per_units':1_000_000,
            'currency':'USD','source_url':'https://api-docs.deepseek.com/quick_start/pricing/',
            'checked_on':datetime.now(timezone.utc).date().isoformat(),'note':'合成计价规则，仅测试算术，不是官方价格',**changes}


def test_cost_uses_decimal_arithmetic_keeps_currencies_and_unknown_usage_separate():
    usage = [{'provider':'deepseek','model':'fake-model','prompt_tokens':1000000,'completion_tokens':1000000}]
    costs = estimate_cost(usage,[rate(),rate('output_tokens',amount='2.40',currency='CNY')])
    assert costs['totals'] == {'USD':'1.200000','CNY':'2.400000'}
    assert costs['status'] == 'estimated'
    partial = estimate_cost(usage,[rate()])
    assert partial['totals'] == {'USD':'1.200000'} and partial['status'] == 'partial'
    assert estimate_cost(usage,[])['status'] == 'unavailable'
    assert estimate_cost([],[])['totals'] == {}
    assert estimate_cost([{'provider':'deepseek','model':'fake-model','prompt_tokens':True}],[])['status'] == 'unavailable'
    assert estimate_cost([{'provider':'unknown','total_tokens':10}],[])['missing']
    output_only = estimate_cost([{'provider':'doubao-duplex','model':'test','output_tokens':100}],
        [rate('output_tokens',provider='doubao-duplex',model='test')])
    assert output_only['status'] == 'partial' and any('input_tokens' in reason for reason in output_only['missing'])


def test_failed_repair_usage_keeps_known_costs_but_never_claims_complete_pricing():
    usage = [{'provider':'deepseek', 'model':'fake-model', 'prompt_tokens':1000000,
              'completion_tokens':0, 'incomplete':True}]
    costs = estimate_cost(usage, [rate()])
    assert costs['totals'] == {'USD':'1.200000'} and costs['status'] == 'partial'
    assert any('部分请求未返回用量' in reason for reason in costs['missing'])


@pytest.mark.parametrize('damaged', [
    {'usage':None}, {'usage':{}}, {'usage':[None]}, {'usage':[{'provider':[]}]},
    {'pricing':None}, {'pricing':[]}, {'pricing':{'rates':None}}, {'pricing':{'rates':[{}]}},
    *[{'pricing':{'rates':[rate(amount=amount)]}} for amount in ('NaN', '-1')],
    *[{'pricing':{'rates':[rate(per_units=units)]}} for units in (0, True, 1.5)],
])
def test_progress_isolates_damaged_cost_snapshots_without_losing_other_sessions(platform, damaged):
    client, service, _, scene = platform
    good = save_record(client, service, scene, '我会先核对适用范围，再通过授权渠道反馈。')
    bad = save_record(client, service, scene, '我会先确认需要核实的问题，并约定反馈时间。')
    for record in (good, bad):
        record.data.update(usage=[{'provider':'deepseek', 'model':'fake-model', 'prompt_tokens':1000000,
                                  'completion_tokens':0}], pricing={'rates':[rate()]})
    bad.data.update(damaged)
    for record in (good, bad):
        service.records.save(record, 'completed')
    original = client.get('/api/sessions/' + bad.data['id']).json()
    response = client.get('/api/progress')
    assert response.status_code == 200, response.text
    report = response.json()
    assert report['session_count'] == 2 and report['unpriced_session_count'] == 1
    assert report['cost_totals'] == {'USD':'1.200000'}
    damaged_row = next(row for row in report['sessions'] if row['id'] == bad.data['id'])
    assert damaged_row['cost']['status'] == 'unavailable'
    assert damaged_row['cost']['totals'] == {} and damaged_row['usage'] == []
    assert any('损坏' in reason for reason in damaged_row['cost']['missing'])
    assert client.get('/api/sessions/' + bad.data['id']).json() == original


@pytest.mark.parametrize('field,value', [
    ('audio_seconds', None), ('audio_seconds', 'bad'), ('audio_seconds', float('nan')),
    ('audio_seconds', float('inf')), ('elapsed_seconds', float('-inf')), ('total_tokens', float('nan')),
])
def test_progress_never_returns_invalid_numeric_usage_to_the_browser(tmp_path, field, value):
    with LocalClient(create_app(settings(tmp_path))) as client:
        record = SessionRecord(str(uuid4()), 'assisted')
        record.data.update(workspace='local', capture_status='completed', analysis_status='no_speech',
            usage=[{'provider':'seedasr', 'model':'bigmodel', 'audio_seconds':1, field:value}])
        client.app.state.records.save(record, 'completed')
        path = tmp_path / (record.data['id'] + '.json')
        original = path.read_bytes()
        response = client.get('/api/progress')
        assert response.status_code == 200, response.text
        report = response.json()
        assert report['session_count'] == report['unpriced_session_count'] == 1
        session = report['sessions'][0]
        assert session['usage'] == [] and session['cost']['status'] == 'unavailable'
        assert session['cost']['totals'] == {} and any('损坏' in reason for reason in session['cost']['missing'])
        assert path.read_bytes() == original


def test_price_book_is_validated_and_old_sessions_keep_their_rate_snapshot(platform):
    client, service, _, scene = platform
    assert client.get('/api/usage/prices').json()['version'] == 0
    saved = client.put('/api/usage/prices',json={'version':0,'rates':[rate()]}).json()
    assert saved['version'] == 1
    assert client.put('/api/usage/prices',json={'version':0,'rates':[]}).status_code == 409
    record = save_record(client,service,scene,'我会先核对资料范围，然后通过约定渠道反馈。')
    record.data['pricing'] = capture_prices(service.store, client.app.state.local_user)
    record.data['usage'] = [{'provider':'deepseek','model':'fake-model','prompt_tokens':1000000}]
    service.records.save(record,'completed')
    changed = client.put('/api/usage/prices',json={'version':saved['version'],'rates':[rate(amount='9.90')]}).json()
    assert changed['version'] == 2
    report = client.get('/api/progress?days=30').json()
    assert report['cost_totals']['USD'] == '1.200000'
    assert report['sessions'][0]['cost']['lines'][0]['rate']['amount'] == '1.20'


@pytest.mark.parametrize('change', [
    {'amount':'-1'},{'amount':'NaN'},{'per_units':0},{'per_units':True},
    {'source_url':'http://127.0.0.1/private'},
    {'checked_on':(datetime.now(timezone.utc)+timedelta(days=2)).date().isoformat()},
])
def test_invalid_price_rules_do_not_replace_existing_config(platform, change):
    client, _, _, _ = platform
    assert client.put('/api/usage/prices',json={'version':0,'rates':[rate(**change)]}).status_code == 422
    assert client.get('/api/usage/prices').json()['rates'] == []
    assert client.put('/api/usage/prices',json={'version':0,'rates':[rate(),rate()]}).status_code == 422


def test_progress_never_combines_different_doctor_or_stage_conditions(platform):
    client, service, _, scene = platform
    first = save_record(client,service,scene,'我会先核对适用范围，稍后通过授权渠道反馈。',score=2)
    second = save_record(client,service,scene,'我会核对原文，并与您约定合适时间反馈。',score=3)
    changed = save_record(client,service,scene,'我会说明资料限制，并安排授权渠道跟进。',score=4)
    changed.data['training']['doctor']['version'] += 1
    service.records.save(changed,'completed')
    result = client.get('/api/progress?days=7')
    assert result.status_code == 200,result.text
    report = result.json()
    assert report['session_count'] == 3 and report['valid_practice_count'] == 3
    assert len(report['groups']) == 2
    comparable = next(group for group in report['groups'] if group['comparable'])
    assert comparable['first_record_id'] == first.data['id'] and comparable['latest_record_id'] == second.data['id']
    assert comparable['dimensions'][0]['delta'] == 1
    single = next(group for group in report['groups'] if not group['comparable'])
    assert single['dimensions'][0]['delta'] is None
    assert report['unpriced_session_count'] == 3
    assert client.get('/api/progress?days=0').status_code == 422
    assert client.get('/api/progress?days=91').status_code == 422


def test_old_unscored_and_synthetic_acceptance_records_do_not_claim_improvement(platform):
    client, service, _, scene = platform
    record = save_record(client,service,scene,'我会核对原文及适用范围后，按约定反馈。')
    record.data['validation_only'] = True
    service.records.save(record,'completed')
    assert client.get('/api/progress').json()['valid_practice_count'] == 0
    record.data.pop('training')
    record.data['validation_only'] = False
    service.records.save(record,'completed')
    report = client.get('/api/progress').json()
    assert report['session_count'] == 1 and report['valid_practice_count'] == 0 and report['groups'] == []


@pytest.mark.parametrize('cause', ['missing_voice','interrupted_capture'])
def test_realtime_usage_missing_from_an_otherwise_priced_session_stays_partial(platform, cause):
    client, service, _, scene = platform
    record = save_record(client,service,scene,'我会先核对适用范围，再安排合规跟进。')
    record.data.update(provider='seeduplex+seedasr',
        usage=[{'provider':'deepseek','model':'fake-model','prompt_tokens':1000000,'completion_tokens':0}],
        pricing={'rates':[rate()]}, capture_status='interrupted' if cause=='interrupted_capture' else 'completed')
    service.records.save(record,'completed')
    report = client.get('/api/progress').json()
    cost = report['sessions'][0]['cost']
    assert cost['totals'] == {'USD':'1.200000'} and cost['status'] == 'partial'
    assert any('实时语音' in message for message in cost['missing'])
    assert report['unpriced_session_count'] == 1


def test_time_window_and_progress_order_use_instants_across_timezones(platform):
    client, service, _, scene = platform
    current = datetime.now(timezone.utc)
    first = save_record(client,service,scene,'我会先核对适用范围，并通过授权渠道反馈。',score=2)
    latest = save_record(client,service,scene,'我会核对原文，并在您方便的时间反馈。',score=3)
    old = save_record(client,service,scene,'我会说明资料边界，并确认后续跟进方式。',score=4)
    for record, started in ((first,current-timedelta(hours=2)),
                            (latest,(current-timedelta(hours=1)).astimezone(timezone(timedelta(hours=-12)))),
                            (old,(current-timedelta(days=7,hours=1)).astimezone(timezone(timedelta(hours=8))))):
        record.data['started_at'] = started.isoformat()
        service.records.save(record,'completed')
    report = client.get('/api/progress?days=7').json()
    assert report['session_count'] == 2 and report['sessions'][0]['id'] == latest.data['id']
    group = report['groups'][0]
    assert group['first_record_id'] == first.data['id'] and group['latest_record_id'] == latest.data['id']
    assert group['dimensions'][0]['delta'] == 1

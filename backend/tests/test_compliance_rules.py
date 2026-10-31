from medvisit.platform.compliance import active_rules, validate_findings


def test_policy_reads_are_request_local_and_stop_at_twenty_valid_rules():
    from unittest.mock import MagicMock
    policy = {'status':'approved', 'legal_status':'effective', 'version':1,
              'title':'Synthetic', 'source_url':'https://example.org', 'pages':[{'text':'规则原文'}]}
    store = MagicMock()
    tx = store.transaction.return_value.__enter__.return_value
    tx.get.return_value = policy
    valid = {'status':'published', 'runtime_enforced':True, 'policy_id':'p',
             'policy_version':1, 'quote':'规则原文'}
    tx.list.return_value = [dict(valid, id='invalid', policy_version=2)] + [dict(valid, id=str(i)) for i in range(40)]
    assert [r['id'] for r in active_rules(store, 'w', ['p'])] == [str(i) for i in range(20)]
    assert tx.get.call_count == 1
    policy['status'] = 'retired'
    assert active_rules(store, 'w', ['p']) == []
    assert tx.get.call_count == 2
    tx.get.return_value = None
    assert active_rules(store, 'another-workspace', ['p']) == []
    assert tx.get.call_count == 3


async def test_empty_policy_input_does_not_read_storage():
    from unittest.mock import MagicMock
    from medvisit.platform.compliance import assess_policy
    store = MagicMock()
    assert await assess_policy(None, store, 'w', ' \n ', ['p']) == {'status':'skipped', 'findings':[]}
    store.transaction.assert_not_called()


def test_findings_require_known_rule_and_exact_speaker_quote():
    rule = {'id':'r1', 'risk':'high', 'action':'pause', 'article':'第七条', 'quote':'原文',
            'policy_id':'p1', 'policy_version':3, 'policy_title':'政策', 'source_url':'https://example.org'}
    text = '我不会保证疗效。'
    assert validate_findings({'findings':[{'rule_id':'r1','status':'uncertain','quote':'保证疗效','reason':'待核对'}]}, text, [rule]) == []
    assert validate_findings({'findings':[{'rule_id':'r1','status':'risk','quote':'编造原话','reason':'问题'}]}, text, [rule]) == []
    assert validate_findings({'findings':[{'rule_id':'other','status':'risk','quote':'保证疗效','reason':'问题'}]}, text, [rule]) == []
    result = validate_findings({'findings':[{'rule_id':'r1','status':'risk','quote':'不会保证疗效','reason':'待人工复核'}]}, text, [rule])
    assert result[0]['action'] == 'pause' and result[0]['policy_version'] == 3
    rule['risk'] = 'medium'
    assert validate_findings({'findings':[{'rule_id':'r1','status':'risk','quote':'保证疗效','reason':'待复核'}]}, text, [rule])[0]['action'] == 'warn'


async def test_policy_check_discards_corrected_asr_result():
    import asyncio
    from types import SimpleNamespace
    from medvisit.services.practice import PracticeDialogue

    started, release = asyncio.Event(), asyncio.Event()
    events = []
    async def assess(text, context):
        started.set()
        await release.wait()
        return [{'rule_id':'r1', 'quote':text}]
    async def send(payload):
        events.append(payload)
    record = SimpleNamespace(data={'messages':[{'id':'u1','role':'trainee','text':'旧转写','final':True}],
        'experience':'combat'}, policy_assess=assess)
    dialogue = PracticeDialogue(SimpleNamespace(send_json=send), None, record)
    task = asyncio.create_task(dialogue.check_policy('u1', '旧转写'))
    await started.wait()
    record.data['messages'][0]['text'] = '修正后转写'
    release.set()
    await task
    assert not events and not record.data['policy_checks']


def test_only_explicitly_enabled_published_rules_are_used(tmp_path):
    from medvisit.platform.store import PlatformStore
    store = PlatformStore(tmp_path / 'platform.sqlite3')
    store.open()
    with store.transaction('workspace') as tx:
        policy = tx.create('workspace', 'policy', {'title':'正式政策', 'source_url':'https://example.org',
            'status':'approved', 'legal_status':'effective', 'pages':[{'number':1,'text':'规定原文'}]})
        fields = {'status':'published', 'policy_id':policy['id'], 'policy_version':policy['version'], 'quote':'规定原文'}
        tx.create('workspace', 'policy_rule', {**fields, 'runtime_enforced':False}, item_id='disabled')
        tx.create('workspace', 'policy_rule', fields, item_id='legacy')
        tx.create('workspace', 'policy_rule', {**fields, 'runtime_enforced':True}, item_id='enabled')
    assert [rule['id'] for rule in active_rules(store, 'workspace', [policy['id']])] == ['enabled']

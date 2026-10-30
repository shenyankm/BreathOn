import asyncio
import copy
from unittest.mock import AsyncMock

from fastapi import HTTPException
import pytest

from medvisit.services.final_review import review_training
from medvisit.storage.records import SessionRecord
from medvisit.voice.protocol import BridgeError
from test_bridge import settings
from test_practice import REPLY


@pytest.mark.parametrize('failure', [None, HTTPException, OSError, asyncio.CancelledError])
async def test_model_usage_survives_failed_post_generation_validation(tmp_path, monkeypatch, failure):
    record = SessionRecord('test', 'assisted')
    record.data['capture_status'] = 'completed'
    record.transcript('trainee', 'trainee', '我会核对研究人群与证据局限。', final=True)
    checks = 0
    def validate():
        nonlocal checks
        checks += 1
        if checks == 2 and failure:
            raise HTTPException(409, '资料已更新') if failure is HTTPException else failure()
    record.validate_training = validate
    usage = {'total_tokens': 12, 'model': 'test-model'}
    model = AsyncMock(return_value=(copy.deepcopy(REPLY), usage))
    monkeypatch.setattr('medvisit.services.final_review.generate_reply', model)
    if failure:
        with pytest.raises(BridgeError if failure is HTTPException else failure):
            await review_training(settings(tmp_path), record)
        assert not record.data.get('coaching')
    else:
        coach = await review_training(settings(tmp_path), record)
        assert coach['final_report'] and record.data['analysis_status'] == 'completed'
    assert record.data['usage'] == [{'provider': 'deepseek', **usage}]
    assert record.data['messages'][0]['text'] == '我会核对研究人群与证据局限。'
    model.assert_awaited_once()


async def test_revoked_medical_evidence_during_generation_discards_review(tmp_path, monkeypatch):
    record = SessionRecord('test', 'assisted')
    record.data['capture_status'] = 'completed'
    record.transcript('trainee', 'trainee', '我会核对证据。', final=True)
    record.data['medical_checks'] = [{'status':'supported', 'statements':[]}]
    revoked = False
    class Verifier:
        async def invalidate_revoked(self, rows):
            if revoked:
                rows[0].update(status='insufficient', statements=[])
    record.medical_checks = type('Checks', (), {'verifier':Verifier()})()
    async def generate(*args, **kwargs):
        nonlocal revoked
        assert kwargs['medical_checks'][0]['status'] == 'supported'
        revoked = True
        return copy.deepcopy(REPLY), {'total_tokens': 1}
    monkeypatch.setattr('medvisit.services.final_review.generate_reply', generate)
    with pytest.raises(BridgeError, match='审核依据已变更'):
        await review_training(settings(tmp_path), record)
    assert not record.data.get('coaching')
    assert record.data['usage'][0]['total_tokens'] == 1

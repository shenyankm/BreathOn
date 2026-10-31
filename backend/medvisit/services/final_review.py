"""The same final assessment for configured practice and combat sessions."""
import asyncio
from fastapi import HTTPException
from ..agents.coach import generate_reply
from ..voice.protocol import BridgeError
from ..knowledge.live import checked_snapshot, validate_snapshot, coaching_snapshot, validate_coaching_snapshot


async def review_training(settings, record):
    enabled = getattr(record, 'scoring_enabled', lambda: True)
    if not await asyncio.to_thread(enabled):
        record.data['analysis_status'] = 'disabled'
        return None
    history=[dict(m) for m in record.data['messages']]
    latest=next((m for m in reversed(history) if m['role']=='trainee' and m['text'].strip()),None)
    if not latest:
        record.data['analysis_status']='no_speech'
        return None
    record.data['analysis_status']='thinking'
    record.data.setdefault('interaction_events',[]).append({'type':'capture_end','status':record.data.get('capture_status','interrupted')})
    try:
        if record.validate_training:
            await asyncio.to_thread(record.validate_training)
        checks = await checked_snapshot(record)
        options = {'medical_checks':checks} if checks else {}
        if record.data.get('free_context'):
            options['free_context'] = record.data['free_context']
        reference = await coaching_snapshot(record)
        if reference is not None:
            options['reference_context'] = reference
        reply,usage=await generate_reply(settings,history,speak=False,training=record.training,
                                        interactions=record.data['interaction_events'],**options)
        if usage:
            record.data['usage'].append({'provider':'deepseek',**usage})
        await validate_snapshot(record, checks)
        await validate_coaching_snapshot(record, reference)
        if record.validate_training:
            await asyncio.to_thread(record.validate_training)
    except HTTPException as exc:
        raise BridgeError('training_material_changed',exc.detail) from exc
    if not await asyncio.to_thread(enabled):
        record.data['analysis_status'] = 'disabled'
        return None
    incomplete=record.data.get('capture_status')!='completed' or any(not m.get('final') or len(m['text'])>4000 for m in history) or sum(len(m['text']) for m in history)>64000
    coach={**reply['coach'],'based_on':latest['id'],'doctor_id':'','final_report':True,'incomplete':incomplete}
    if reference is not None:
        coach['reference_context'] = reference
    if incomplete and coach.get('assessment'):
        coach['assessment'].update(total=None,status='partial')
    record.data.setdefault('coaching',[]).append(coach)
    record.data['analysis_status']='completed'
    return coach

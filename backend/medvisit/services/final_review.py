"""The same final assessment for configured practice and combat sessions."""
import asyncio
from fastapi import HTTPException
from ..agents.coach import generate_reply
from ..voice.protocol import BridgeError


async def review_training(settings, record):
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
        reply,usage=await generate_reply(settings,history,speak=False,training=record.training,
                                        interactions=record.data['interaction_events'])
        if usage:
            record.data['usage'].append({'provider':'deepseek',**usage})
        if record.validate_training:
            await asyncio.to_thread(record.validate_training)
    except HTTPException as exc:
        raise BridgeError('training_material_changed',exc.detail) from exc
    incomplete=record.data.get('capture_status')!='completed' or any(not m.get('final') or len(m['text'])>4000 for m in history) or sum(len(m['text']) for m in history)>64000
    coach={**reply['coach'],'based_on':latest['id'],'doctor_id':'','final_report':True,'incomplete':incomplete}
    if incomplete and coach.get('assessment'):
        coach['assessment'].update(total=None,status='partial')
    record.data.setdefault('coaching',[]).append(coach)
    record.data['analysis_status']='completed'
    return coach

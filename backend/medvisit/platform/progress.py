"""Personal progress compares like conditions; costs use captured, explicit rate cards."""
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from math import isfinite
from typing import Literal
from uuid import UUID

from pydantic import Field, StrictInt, field_validator, model_validator

from .input import Input
from .store import Conflict
from ..agents.web_search import public_url


class Price(Input):
    provider: Literal['deepseek','seedasr','doubao-tts','doubao-duplex']
    model: str = Field(min_length=1, max_length=100)
    unit: Literal['input_tokens','output_tokens','audio_seconds','text_characters','search_requests','fetch_requests']
    amount: Decimal = Field(ge=0, le=1_000_000, decimal_places=8)
    per_units: StrictInt = Field(ge=1, le=1_000_000_000)
    currency: Literal['CNY','USD']
    source_url: str = Field(min_length=1, max_length=8192)
    checked_on: date
    note: str = Field(default='', max_length=500)

    @field_validator('source_url')
    @classmethod
    def safe_source(cls, value):
        if not public_url(value):
            raise ValueError('计价依据必须为公开 HTTP(S) 链接')
        return value

    @field_validator('checked_on')
    @classmethod
    def not_future(cls, value):
        if value > datetime.now(timezone.utc).date():
            raise ValueError('计价核对日期不能在未来')
        return value


class Prices(Input):
    version: int = Field(default=0, ge=0)
    rates: list[Price] = Field(max_length=50)

    @model_validator(mode='after')
    def unique_rates(self):
        keys = [(rate.provider, rate.model, rate.unit) for rate in self.rates]
        if len(keys) != len(set(keys)):
            raise ValueError('同一服务、模型和计量单位不能重复配置')
        return self


def capture_prices(store, user):
    with store.transaction(user['workspace'], write=False) as tx:
        return tx.get(user['workspace'], 'settings', 'usage-prices') or {'version':0, 'rates':[]}


def save_prices(store, user, body):
    data = body.model_dump(mode='json', exclude={'version'})
    with store.transaction(user['workspace']) as tx:
        old = tx.get(user['workspace'], 'settings', 'usage-prices')
        if old:
            item = tx.update(user['workspace'], 'settings', old['id'], {**old, **data}, body.version)
        else:
            if body.version != 0:
                raise Conflict('计价配置已变化，请刷新后重试。')
            item = tx.create(user['workspace'], 'settings', data, item_id='usage-prices')
        tx.audit(user['workspace'], user['id'], 'pricing.save', 'settings', item['id'])
        return item


def usage_units(usage):
    fields = {
        'deepseek':{'input_tokens':'prompt_tokens','output_tokens':'completion_tokens','search_requests':'search_requests','fetch_requests':'fetch_requests'},
        'seedasr':{'audio_seconds':'audio_seconds'},
        'doubao-tts':{'text_characters':'submitted_characters'},
        'doubao-duplex':{'input_tokens':'input_tokens','output_tokens':'output_tokens'},
    }
    result = {}
    for unit, key in fields.get(usage.get('provider'), {}).items():
        value = usage.get(key)
        if type(value) not in (int, float):
            continue
        amount = Decimal(str(value))
        if amount.is_finite() and amount >= 0:
            result[unit] = amount
    return result


def estimate_cost(usages, prices):
    totals = defaultdict(Decimal)
    missing, lines = [], []
    rates = {}
    for rate in prices:
        rates.setdefault((rate['provider'], rate['model'], rate['unit']), rate)
    for usage in usages:
        provider, model = usage.get('provider'), usage.get('model')
        if usage.get('incomplete'):
            missing.append(f'{provider or "未标明服务"}部分请求未返回用量，费用尚未完整核算。')
        units = usage_units(usage)
        if not units:
            missing.append(f'{provider or "未标明服务"}未记录可计价用量。')
        required = {'deepseek':('input_tokens','output_tokens'),'seedasr':('audio_seconds',),
                    'doubao-tts':('text_characters',),'doubao-duplex':('input_tokens','output_tokens')}
        for unit in required.get(provider, ()):
            if unit not in units:
                missing.append(f'{provider} 未报告 {unit}，无法核算该项费用。')
        for unit, quantity in units.items():
            if quantity == 0:
                continue
            rate = rates.get((provider, model, unit)) if isinstance(model, str) else None
            if rate is None:
                missing.append(f'{provider} / {model or "未记录模型"} / {unit} 未配置当次计价依据。')
                continue
            cost = (quantity*Decimal(rate['amount'])/rate['per_units']).quantize(Decimal('0.000001'))
            totals[rate['currency']] += cost
            lines.append({'provider':provider,'model':model,'unit':unit,'quantity':str(quantity),'amount':str(cost),
                          'currency':rate['currency'],'rate':rate})
    return {'status':'partial' if missing and lines else 'unavailable' if missing or not usages else 'estimated',
            'totals':{currency:str(amount) for currency,amount in totals.items()}, 'lines':lines,
            'missing':list(dict.fromkeys(missing)) or ([] if usages else ['未记录服务用量。'])}


def duration_seconds(data):
    try:
        value = (datetime.fromisoformat(data['ended_at'])-datetime.fromisoformat(data['started_at'])).total_seconds()
        return round(value, 1) if value >= 0 else None
    except (KeyError, TypeError, ValueError):
        return None


def personal_progress(store, records, user, days=30):
    current = datetime.now(timezone.utc)
    since = current-timedelta(days=days)
    rows = []
    for row in records.activity(workspace=user['workspace']):
        try:
            started = datetime.fromisoformat(row.get('started_at') or '')
            if started.tzinfo and since <= started <= current:
                rows.append(row)
        except (TypeError, ValueError):
            continue
    groups = defaultdict(list)
    sessions, totals = [], defaultdict(Decimal)
    for index, row in enumerate(rows):
        if index % 50 == 0:
            documents = records.get_many([UUID(item['id']) for item in rows[index:index+50]])
        data = documents.get(row['id'])
        if not data:
            continue
        usages, pricing = data.get('usage', []), data.get('pricing', {})
        try:
            if not isinstance(usages, list) or any(not isinstance(usage, dict) for usage in usages) or not isinstance(pricing, dict):
                raise ValueError('Invalid cost snapshot')
            for usage in usages:
                for key in ('prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens',
                            'audio_seconds', 'output_audio_seconds', 'submitted_characters', 'text_words',
                            'elapsed_seconds', 'search_requests', 'fetch_requests'):
                    if key in usage:
                        value = usage[key]
                        if type(value) not in (int, float) or not isfinite(value) or value < 0:
                            raise ValueError('Invalid numeric usage')
            prices = pricing.get('rates', [])
            if not isinstance(prices, list):
                raise ValueError('Invalid price list')
            for rate in prices:
                amount = Decimal(rate['amount'])
                if not amount.is_finite() or amount < 0 or type(rate['per_units']) is not int or rate['per_units'] <= 0:
                    raise ValueError('Invalid captured price')
            cost = estimate_cost(usages, prices)
        except (AttributeError, KeyError, TypeError, ValueError, ArithmeticError):
            usages = []
            cost = estimate_cost([], [])
            cost['missing'] = ['历史用量或计价快照损坏，此次费用无法核算；原记录仍保留。']
        if data.get('provider') == 'seeduplex+seedasr' and not any(usage.get('provider')=='doubao-duplex' and usage_units(usage) for usage in usages):
            cost['missing'].append('实时语音对话未返回可计价用量，无法核算该服务费用。')
            cost['status'] = 'partial' if cost['lines'] else 'unavailable'
        if any(message.get('speech_status') in ('interrupted','error') for message in data.get('messages', [])):
            cost['missing'].append('部分语音合成中断，用量可能未完整返回。')
            cost['status'] = 'partial' if cost['lines'] else 'unavailable'
        if data.get('analysis_status') not in ('completed','no_speech'):
            cost['missing'].append('分析未完整完成，失败请求用量可能未返回。')
            cost['status'] = 'partial' if cost['lines'] else 'unavailable'
        if data.get('capture_status') != 'completed':
            cost['missing'].append('采集未完整结束，上游用量可能未完整返回。')
            cost['status'] = 'partial' if cost['lines'] else 'unavailable'
        for currency, amount in cost['totals'].items():
            totals[currency] += Decimal(amount)
        sessions.append({'id':row['id'],'started_at':row['started_at'],'scenario_title':row['scenario_title'],
            'status':row['status'],'duration_seconds':duration_seconds(data),'cost':cost,
            'usage':usages,'validation_only':bool(data.get('validation_only'))})
        assessment = row['assessment']
        key = (row.get('training_fingerprint'), row.get('stage'), row.get('experience'),
               assessment.get('rubric_fingerprint'), assessment.get('model'), assessment.get('evaluator_version'))
        if row['valid'] and all(key) and any(dimension.get('score') is not None for dimension in assessment['dimensions']) and not data.get('validation_only'):
            groups[key].append(row)
    progress = []
    for group in groups.values():
        group.sort(key=lambda row:datetime.fromisoformat(row['started_at']))
        first, latest = group[0], group[-1]
        before = {dimension['key']:dimension for dimension in first['assessment']['dimensions']}
        dimensions = []
        for dimension in latest['assessment']['dimensions']:
            old, new = before.get(dimension['key'], {}).get('score'), dimension['score']
            dimensions.append({'key':dimension['key'],'label':dimension['label'],'before':old,'after':new,
                'delta':new-old if len(group)>1 and old is not None and new is not None else None})
        progress.append({'scenario_title':latest['scenario_title'],'stage':latest['stage'],'experience':latest['experience'],
            'attempts':len(group),'model':latest['assessment']['model'],'calibration_status':latest['assessment']['calibration_status'],
            'first_record_id':first['id'],'latest_record_id':latest['id'],'latest_at':latest['started_at'],
            'dimensions':dimensions,'comparable':len(group)>1})
    progress.sort(key=lambda item:datetime.fromisoformat(item['latest_at']), reverse=True)
    return {'days':days, 'session_count':len(sessions),'completed_count':sum(session['status']=='completed' for session in sessions),
            'valid_practice_count':sum(group['attempts'] for group in progress),
            'duration_seconds':round(sum(session['duration_seconds'] or 0 for session in sessions), 1),
            'unknown_duration_count':sum(session['duration_seconds'] is None for session in sessions),
            'cost_totals':{currency:str(amount) for currency,amount in totals.items()},
            'unpriced_session_count':sum(session['cost']['status']!='estimated' for session in sessions),
            'groups':progress, 'sessions':sorted(sessions,key=lambda item:datetime.fromisoformat(item['started_at']),reverse=True)}

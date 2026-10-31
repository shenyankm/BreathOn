"""L1 to L4 training curriculum, per-account training plan, settings and home statistics.

The lessons are product content (see curriculum.json). Everything a representative accumulates, a plan, completed
lessons and switches, is stored per account. Statistics are derived from the representative's own saved practice
records and are None when there is nothing to derive them from: no placeholder numbers are ever returned.
"""
import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Literal

from fastapi import HTTPException
from pydantic import Field

from .input import Input

CURRICULUM = json.loads(Path(__file__).with_name('curriculum.json').read_text(encoding='utf-8'))
LEVELS = {level['level']: level for level in CURRICULUM['levels']}
LESSONS = {lesson['id']: {**lesson, 'level': level['level']} for level in CURRICULUM['levels'] for lesson in level['lessons']}
SETTING_DEFAULTS = {'training_reminder': True, 'save_dialogue': True, 'review_reminder': True, 'doctor_recommendation': True}
LESSON_STATES = ('planned', 'completed')


class SettingsEdit(Input):
    training_reminder: bool | None = None
    save_dialogue: bool | None = None
    review_reminder: bool | None = None
    doctor_recommendation: bool | None = None


class LessonState(Input):
    state: Literal['planned', 'completed', 'none']


def _key(user):
    return f"{user['id']}"


def _load(tx, user):
    return tx.get(user['workspace'], 'member_state', _key(user)) or {'plan': [], 'completed': {}, 'settings': {}, 'version': 0}


def _save(tx, user, state):
    data = {key: state[key] for key in ('plan', 'completed', 'settings')}
    if tx.get(user['workspace'], 'member_state', _key(user)) is None:
        return tx.create(user['workspace'], 'member_state', {**data, 'owner_id': user['id']}, item_id=_key(user))
    return tx.update(user['workspace'], 'member_state', _key(user), {**data, 'owner_id': user['id']}, state['version'])


def curriculum(store, user):
    """The four levels with each lesson's state for this account; practice lessons link to the real coach flow."""
    with store.transaction(user['workspace'], write=False) as tx:
        state = _load(tx, user)
    rows = []
    for level in CURRICULUM['levels']:
        lessons = [{**lesson, 'state': 'completed' if lesson['id'] in state['completed'] else 'planned' if lesson['id'] in state['plan'] else 'none'}
                   for lesson in level['lessons']]
        rows.append({**{key: level[key] for key in ('level', 'title', 'subtitle', 'summary')}, 'lessons': lessons,
                     'completed': sum(item['state'] == 'completed' for item in lessons), 'total': len(lessons)})
    return {'levels': rows, 'plan': [LESSONS[item] | {'state': 'planned'} for item in state['plan'] if item in LESSONS]}


def set_lesson(store, user, lesson_id, body):
    if lesson_id not in LESSONS:
        raise HTTPException(404, '课程不存在。')
    with store.transaction(user['workspace']) as tx:
        state = _load(tx, user)
        plan = [item for item in state['plan'] if item != lesson_id]
        completed = dict(state['completed'])
        if body.state == 'planned':
            plan.append(lesson_id)
            completed.pop(lesson_id, None)
        elif body.state == 'completed':
            completed[lesson_id] = datetime.now(timezone.utc).isoformat()
        else:
            completed.pop(lesson_id, None)
        _save(tx, user, {**state, 'plan': plan, 'completed': completed})
    return curriculum(store, user)


def member_settings(store, user):
    with store.transaction(user['workspace'], write=False) as tx:
        state = _load(tx, user)
    return {**SETTING_DEFAULTS, **state['settings']}


def update_settings(store, user, body):
    changes = {key: value for key, value in body.model_dump().items() if value is not None}
    with store.transaction(user['workspace']) as tx:
        state = _load(tx, user)
        _save(tx, user, {**state, 'settings': {**state['settings'], **changes}})
    return member_settings(store, user)


def _practice_days(rows):
    days = set()
    for row in rows:
        try:
            days.add(datetime.fromisoformat(row['started_at']).astimezone().date())
        except (KeyError, TypeError, ValueError):
            continue
    return days


def streak(days, today):
    """Consecutive practice days ending today, or yesterday when today has none yet."""
    cursor = today if today in days else today - timedelta(days=1)
    count = 0
    while cursor in days:
        count += 1
        cursor -= timedelta(days=1)
    return count


def level_status(completed):
    """Current level = the first level with an unfinished lesson; progress is the share of its lessons done."""
    for level in CURRICULUM['levels']:
        ids = [lesson['id'] for lesson in level['lessons']]
        done = sum(item in completed for item in ids)
        if done < len(ids):
            return {'level': level['level'], 'title': level['title'], 'done': done, 'total': len(ids),
                    'remaining': len(ids) - done, 'percent': round(100 * done / len(ids)),
                    'next_level': next((item['level'] for item in CURRICULUM['levels'] if item['level'] > level['level']), None)}
    last = CURRICULUM['levels'][-1]
    return {'level': last['level'], 'title': last['title'], 'done': len(last['lessons']), 'total': len(last['lessons']),
            'remaining': 0, 'percent': 100, 'next_level': None}


def home_summary(store, records, user, today=None):
    """Numbers for the home, training, records and me pages, all derived from this account's saved practice."""
    from ..core.identity import current_actor
    today = today or date.today()
    scope = {'workspace': user['workspace'], **({'owner_id': user['id']} if current_actor.get() else {})}
    rows = records.activity(**scope)
    scored = []
    for row in rows:
        total = (row.get('assessment') or {}).get('total')
        if row.get('valid') and isinstance(total, (int, float)):
            scored.append((row['started_at'], total, row))
    scored.sort(key=lambda item: item[0])
    week_start = datetime.combine(today - timedelta(days=6), datetime.min.time()).astimezone()
    previous_start = week_start - timedelta(days=7)

    def average(items):
        return round(sum(item[1] for item in items) / len(items)) if items else None

    def within(start, end):
        return [item for item in scored if start <= datetime.fromisoformat(item[0]).astimezone() < end]

    this_week, last_week = within(week_start, week_start + timedelta(days=7)), within(previous_start, week_start)
    this_average, last_average = average(this_week), average(last_week)
    with store.transaction(user['workspace'], write=False) as tx:
        state = _load(tx, user)
    days = _practice_days(rows)
    recent = [{'id': row['id'], 'title': row.get('scenario_title') or '自由演练', 'score': total, 'started_at': started}
              for started, total, row in reversed(scored[-3:])]
    return {'streak_days': streak(days, today), 'practice_days': len(days), 'session_count': len(rows),
            'latest_score': scored[-1][1] if scored else None,
            'week_average': this_average,
            'week_delta': this_average - last_average if this_average is not None and last_average is not None else None,
            'mastery_percent': round(100 * len(state['completed']) / len(LESSONS)) if LESSONS else 0,
            'level': level_status(state['completed']), 'recent': recent,
            'tasks': [LESSONS[item] for item in state['plan'] if item in LESSONS][:3]}


VISIT_STATES = {'draft': '草稿', 'submitted': '待审核', 'reviewed': '已审核', 'confirmed': '已确认'}
CASE_STATES = {'draft': '草稿', 'confirmed': '已确认'}


def review_queue(store, user):
    """The representative's own submissions and their review state; no transcript text is ever included."""
    from ..core.identity import current_actor
    own = (lambda owner: owner == user['id']) if current_actor.get() else (lambda owner: True)
    with store.transaction(user['workspace'], write=False) as tx:
        visits = [row for row in tx.list(user['workspace'], 'visit') if own(row.get('owner_id'))]
        cases = [row for row in tx.list(user['workspace'], 'case') if own(row.get('created_by'))]
    items = [{'id': row['id'], 'kind': 'visit', 'type': '拜访记录', 'title': row.get('title') or '拜访记录',
              'status': row.get('status'), 'status_label': VISIT_STATES.get(row.get('status'), '处理中'),
              'updated_at': row.get('updated_at')} for row in visits]
    items += [{'id': row['id'], 'kind': 'case', 'type': '案例', 'title': row.get('title') or '案例',
               'status': row.get('status'), 'status_label': CASE_STATES.get(row.get('status'), '处理中'),
               'updated_at': row.get('updated_at')} for row in cases]
    items.sort(key=lambda item: item.get('updated_at') or '', reverse=True)
    return {'pending': sum(item['status'] == 'submitted' for item in items), 'items': items[:50]}

"""Curriculum, per-account plan and settings, and home statistics derived from real records only."""
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient as AuthClient

from conftest import LocalClient as TestClient
from medvisit.api.app import create_app
from medvisit.api.auth import hash_password
from medvisit.core.config import Settings
from medvisit.platform import curriculum as cur
from test_bridge import settings


def test_curriculum_has_four_levels_with_the_prototype_lessons(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        body = client.get('/api/curriculum').json()
    assert [(row['level'], row['total']) for row in body['levels']] == [('L1', 1), ('L2', 1), ('L3', 1), ('L4', 1)]
    assert body['plan'] == []
    assert not any(item.get('unverified_figures', False) for level in body['levels'] for item in level['lessons'])
    lesson = body['levels'][0]['lessons'][0]
    assert lesson.get('unverified_figures', False) is False and lesson['state'] == 'none' and lesson['sections']
    l4 = body['levels'][3]['lessons']
    assert [item['action']['scenario'] for item in l4] == ['first']


def test_plan_and_completion_are_saved_and_move_between_states(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        assert client.put('/api/curriculum/lessons/l1-02', json={'state': 'planned'}).status_code == 200
        body = client.get('/api/curriculum').json()
        assert [item['id'] for item in body['plan']] == ['l1-02']
        assert body['levels'][0]['lessons'][0]['state'] == 'planned'
        body = client.put('/api/curriculum/lessons/l1-02', json={'state': 'completed'}).json()
        assert body['plan'] == [] and body['levels'][0]['completed'] == 1
        body = client.put('/api/curriculum/lessons/l1-02', json={'state': 'none'}).json()
        assert body['levels'][0]['completed'] == 0
        assert client.put('/api/curriculum/lessons/nope', json={'state': 'planned'}).status_code == 404
        assert client.put('/api/curriculum/lessons/l1-02', json={'state': 'bogus'}).status_code == 422


def test_adding_the_same_lesson_twice_keeps_one_plan_entry(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        for _ in range(3):
            client.put('/api/curriculum/lessons/l2-01', json={'state': 'planned'})
        assert [item['id'] for item in client.get('/api/curriculum').json()['plan']] == ['l2-01']


def test_settings_default_on_and_update_only_the_given_keys(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        assert client.get('/api/me/settings').json() == cur.SETTING_DEFAULTS
        body = client.put('/api/me/settings', json={'training_reminder': False}).json()
        assert body['training_reminder'] is False and body['save_dialogue'] is True
        assert client.get('/api/me/settings').json()['training_reminder'] is False
        assert client.put('/api/me/settings', json={'unknown': True}).status_code == 422


def test_state_is_isolated_per_account(tmp_path):
    password, origin = 'example secure password', 'https://example.test'
    encoded = hash_password(password)
    app = create_app(Settings(records=tmp_path, auth_required=True, login_users={'admin': encoded, 'a': encoded, 'b': encoded}, origins=(origin,)))
    with AuthClient(app, base_url=origin, headers={'Origin': origin}) as client:
        client.post('/api/auth/login', json={'username': 'a', 'password': password})
        client.put('/api/curriculum/lessons/l1-02', json={'state': 'planned'})
        client.put('/api/me/settings', json={'save_dialogue': False})
        client.post('/api/auth/logout')
        client.post('/api/auth/login', json={'username': 'b', 'password': password})
        assert client.get('/api/curriculum').json()['plan'] == []
        assert client.get('/api/me/settings').json()['save_dialogue'] is True
        client.post('/api/auth/logout')
        client.post('/api/auth/login', json={'username': 'a', 'password': password})
        assert [item['id'] for item in client.get('/api/curriculum').json()['plan']] == ['l1-02']


def test_member_state_never_appears_in_the_catalogue_listing(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        client.put('/api/curriculum/lessons/l1-02', json={'state': 'planned'})
        assert client.get('/api/catalog/member_state').status_code == 422


def test_streak_counts_consecutive_days_and_survives_a_day_without_practice_yet():
    today = date(2026, 10, 31)
    days = {today, today - timedelta(days=1), today - timedelta(days=2), today - timedelta(days=4)}
    assert cur.streak(days, today) == 3
    assert cur.streak({today - timedelta(days=1), today - timedelta(days=2)}, today) == 2    # not yet practised today
    assert cur.streak({today - timedelta(days=2)}, today) == 0
    assert cur.streak(set(), today) == 0


def test_level_is_the_first_unfinished_one_and_percent_is_real():
    start = cur.level_status({})
    assert start['level'] == 'L1' and start['percent'] == 0 and start['remaining'] == 2
    middle = cur.level_status({'l1-01': 'x', 'l1-02': 'x', 'l2-01': 'x'})
    assert middle['level'] == 'L2' and middle['percent'] == 50 and middle['next_level'] == 'L3'
    done = cur.level_status({lesson: 'x' for lesson in cur.LESSONS})
    assert done['level'] == 'L4' and done['percent'] == 100 and done['next_level'] is None


def fake_records(rows):
    return SimpleNamespace(activity=lambda **scope: rows)


def row(day, total, *, valid=True, title='质疑主要终点'):
    started = datetime(2026, 10, day, 9, tzinfo=timezone.utc).isoformat()
    return {'id': f'r{day}', 'started_at': started, 'valid': valid, 'scenario_title': title, 'assessment': {'total': total}}


def test_home_has_no_numbers_when_there_is_no_practice(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        body = client.get('/api/home').json()
    assert body['latest_score'] is None and body['week_average'] is None and body['week_delta'] is None
    assert body['streak_days'] == 0 and body['session_count'] == 0 and body['recent'] == [] and body['tasks'] == []
    assert body['mastery_percent'] == 0 and body['level']['level'] == 'L1'


def test_home_statistics_come_only_from_valid_scored_records(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        store, user = client.app.state.platform, client.app.state.local_user
        rows = [row(31, 92), row(30, 80), row(29, 70, valid=False), row(22, 60), row(20, 50)]
        body = cur.home_summary(store, fake_records(rows), user, today=date(2026, 10, 31))
    assert body['latest_score'] == 92 and body['session_count'] == 5
    assert body['week_average'] == 86          # 25 to 31 Oct holds 92 and 80; the invalid 70 is ignored
    assert body['week_delta'] == 86 - 55       # 18 to 24 Oct holds 60 and 50
    assert [item['score'] for item in body['recent']] == [92, 80, 60]
    assert body['streak_days'] == 3            # 31, 30 and 29 (an invalid record still counts as a practice day)


def test_planned_lessons_become_home_tasks(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        for lesson in ('l1-02', 'l4-01', 'l2-01', 'l3-01'):
            client.put('/api/curriculum/lessons/' + lesson, json={'state': 'planned'})
        tasks = client.get('/api/home').json()['tasks']
    assert [item['id'] for item in tasks] == ['l1-02', 'l4-01', 'l2-01']      # at most three, in plan order


def test_review_queue_lists_only_own_items_and_never_transcript_text(tmp_path):
    password, origin = 'example secure password', 'https://example.test'
    encoded = hash_password(password)
    app = create_app(Settings(records=tmp_path, auth_required=True, login_users={'admin': encoded, 'a': encoded, 'b': encoded}, origins=(origin,)))
    with AuthClient(app, base_url=origin, headers={'Origin': origin}) as client:
        store, tenant = app.state.platform, app.state.local_user['workspace']
        with store.transaction(tenant) as tx:
            tx.create(tenant, 'visit', {'owner_id': 'a', 'title': '甲的拜访', 'status': 'submitted', 'redacted_text': '不应出现的正文'})
            tx.create(tenant, 'visit', {'owner_id': 'b', 'title': '乙的拜访', 'status': 'submitted', 'redacted_text': '乙的正文'})
            tx.create(tenant, 'case', {'created_by': 'a', 'title': '甲的案例', 'status': 'draft'})
        client.post('/api/auth/login', json={'username': 'a', 'password': password})
        body = client.get('/api/me/review-queue').json()
    assert body['pending'] == 1 and {item['title'] for item in body['items']} == {'甲的拜访', '甲的案例'}
    assert '不应出现的正文' not in str(body) and '乙' not in str(body)
    assert {item['status_label'] for item in body['items']} == {'待审核', '草稿'}

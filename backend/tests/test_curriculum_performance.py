from contextlib import contextmanager
from datetime import date, datetime, timezone
from types import SimpleNamespace

from medvisit.platform import curriculum as cur


class Store:
    def __init__(self, lessons=(), state=None, visits=()):
        self.lessons, self.visits = lessons, visits
        self.state = state or {'plan':[], 'completed':{}, 'settings':{}, 'version':0}

    @contextmanager
    def transaction(self, *args, **kwargs):
        yield self

    def get(self, *args):
        return self.state

    def list(self, workspace, kind):
        return self.lessons if kind == 'lesson' else self.visits if kind == 'visit' else []


def test_home_parses_weekly_dates_once_and_keeps_latest_tie_order(monkeypatch):
    real_datetime = datetime
    calls = []

    class CountedDatetime(datetime):
        @classmethod
        def fromisoformat(cls, value):
            calls.append(value)
            return real_datetime.fromisoformat(value)

    monkeypatch.setattr(cur, 'datetime', CountedDatetime)
    rows = [{'id':str(i), 'started_at':'2026-10-30T09:00:00+00:00', 'valid':True,
             'assessment':{'total':i}} for i in range(100)]
    records = SimpleNamespace(activity=lambda **scope:rows)
    result = cur.home_summary(Store(), records, {'workspace':'w', 'id':'r'}, date(2026,10,31))
    assert [row['id'] for row in result['recent']] == ['99','98','97']
    assert result['latest_score'] == 99 and result['week_average'] == 50
    assert len(calls) == 200  # one weekly conversion and one practice-day conversion per record


def test_workspace_lessons_keep_id_order_and_draft_only_does_not_restore_defaults():
    lessons = [{'id':str(i), 'level':f'L{i%4+1}', 'status':'published' if i%2 else 'draft'}
               for i in reversed(range(40))]
    result = cur.workspace_curriculum(Store(lessons), {'workspace':'w'})
    for level in result['levels']:
        assert level['lessons'] == sorted([row for row in lessons if row['level']==level['level'] and row['status']=='published'], key=lambda row:row['id'])
    assert all(not level['lessons'] for level in cur.workspace_curriculum(Store([lessons[-1]]), {'workspace':'w'})['levels'])
    assert cur.workspace_curriculum(Store(), {'workspace':'w'}) is cur.CURRICULUM


def test_planned_membership_is_indexed_and_home_stops_after_three_valid_tasks():
    class Plan(list):
        def __contains__(self, value):
            raise AssertionError('Do not linearly search the plan for every lesson')

    state = {'plan':Plan(['missing','l1-01','l1-02','l2-01','l3-01']), 'completed':{'l1-02':'done'}, 'settings':{}, 'version':1}
    store, user = Store(state=state), {'workspace':'w', 'id':'r'}
    result = cur.curriculum(store, user)
    assert [row['id'] for row in result['plan']] == state['plan'][1:]
    assert result['levels'][0]['lessons'][1]['state'] == 'completed'
    home = cur.home_summary(store, SimpleNamespace(activity=lambda **scope:[]), user, date(2026,10,31))
    assert [row['id'] for row in home['tasks']] == state['plan'][1:4]


def test_review_queue_keeps_all_pending_counts_and_stable_cutoff_order():
    visits = [{'id':str(i), 'status':'submitted', 'updated_at':'same'} for i in range(80)]
    result = cur.review_queue(Store(visits=visits), {'workspace':'w', 'id':'r'})
    assert result['pending'] == 80 and len(result['items']) == 50
    assert [row['id'] for row in result['items']] == [str(i) for i in range(50)]

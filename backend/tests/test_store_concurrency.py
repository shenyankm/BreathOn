from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import sqlite3

from medvisit.platform.store import PlatformStore


def test_local_reader_keeps_snapshot_without_blocking_writer(tmp_path):
    store = PlatformStore(tmp_path / 'platform.sqlite3')
    store.open()
    with store.transaction('local') as tx:
        original = tx.create('local', 'doctor', {'name': 'before'})
    with closing(sqlite3.connect(store.path)) as legacy:
        legacy.execute('PRAGMA journal_mode=DELETE')
    store.open()

    def update():
        with store.transaction('local') as tx:
            tx.execute('PRAGMA busy_timeout=100')
            return tx.update('local', 'doctor', original['id'], {'name': 'after'}, original['version'])

    with ThreadPoolExecutor(max_workers=1) as executor:
        with store.transaction('local', write=False) as reader:
            assert reader.get('local', 'doctor', original['id'])['name'] == 'before'
            changed = executor.submit(update).result(timeout=2)
            assert changed['version'] == original['version'] + 1
            assert reader.get('local', 'doctor', original['id'])['name'] == 'before'
            assert all(path.stat().st_mode & 0o777 == 0o600 for path in tmp_path.glob('platform.sqlite3*'))

    store.open()
    with store.transaction('local', write=False) as tx:
        assert tx.get('local', 'doctor', original['id'])['name'] == 'after'
        assert tx.execute('PRAGMA synchronous').fetchone()[0] == 2

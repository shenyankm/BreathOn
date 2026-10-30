"""Private snapshots of confirmed voice turns, independent of the final record."""
import asyncio
import json
from pathlib import Path

from .records import write_private


class SessionCheckpoint:
    def __init__(self, root, record):
        self.path = Path(root) / 'checkpoints' / (record.data['id'] + '.json')
        self.record = record
        self.lock = asyncio.Lock()

    async def save(self):
        async with self.lock:
            data = {key: self.record.data.get(key) for key in
                ('id', 'mode', 'experience', 'started_at', 'workspace', 'owner_id', 'team', 'doctor', 'training', 'free_context')}
            data.update(status='interrupted', capture_status='interrupted', ended_at=None,
                messages=[dict(message) for message in self.record.data['messages'] if message.get('final')],
                coaching=[], usage=[])
            raw = json.dumps(data, ensure_ascii=False).encode()
            writing = asyncio.create_task(asyncio.to_thread(write_private, self.path, raw))
            cancelled = False
            while not writing.done():
                try:
                    await asyncio.shield(writing)
                except asyncio.CancelledError:
                    cancelled = True
            writing.result()
            if cancelled:
                raise asyncio.CancelledError

    async def remove(self):
        async with self.lock:
            await asyncio.to_thread(self.path.unlink, missing_ok=True)


def read_checkpoint(root, session_id):
    path = Path(root) / 'checkpoints' / (str(session_id) + '.json')
    try:
        value = json.loads(path.read_text(encoding='utf-8'))
        return value if isinstance(value, dict) and value.get('id') == str(session_id) else None
    except (OSError, ValueError):
        return None

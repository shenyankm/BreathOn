"""Local MVP records: final text and usage only; no raw microphone audio."""
import json
import os
import stat
import tempfile
import hashlib
import heapq
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_private(path: Path, data: bytes):
    created, parent = [], path.parent
    while not parent.exists():
        created.append(parent)
        parent = parent.parent
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=f'.{path.name}.', suffix='.tmp')
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        # Persist the rename as well as the contents before acknowledging a saved record.
        for folder in [path.parent, *(item.parent for item in created)]:
            directory = os.open(folder, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def training_fingerprint(training):
    if not training:
        return None
    identity = {}
    for kind in ('scenario', 'doctor'):
        item = training.get(kind, {})
        if not item.get('id') or not item.get('version'):
            return None
        identity[kind] = [item['id'], item['version']]
    documents = training.get('documents', [])
    if any(not all(doc.get(key) for key in ('id', 'version', 'sha256')) for doc in documents):
        return None
    identity['documents'] = sorted((doc['id'], doc['version'], doc['sha256']) for doc in documents)
    return hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()


def activity_record(data):
    messages = data.get('messages', [])
    trainee = [m for m in messages if m.get('role') == 'trainee' and m.get('text', '').strip()]
    text = '\n'.join(m['text'].strip() for m in trainee)
    review = next((c for c in reversed(data.get('coaching', [])) if c.get('final_report')), {})
    score = review.get('assessment', {})
    training = data.get('training') or {}
    valid = (data.get('status') == 'completed' and data.get('capture_status') == 'completed'
             and data.get('analysis_status') == 'completed' and bool(review) and not review.get('incomplete')
             and bool(trainee) and trainee[-1].get('final') is True and review.get('based_on') == trainee[-1]['id']
             and len(text) >= 10 and bool(score) and not score.get('validation_errors'))
    result = {key:data.get(key) for key in ('id','workspace','owner_id','team','started_at','ended_at','status',
        'capture_status','analysis_status','experience','remediation_id')}
    result.update(format=2, valid=bool(valid), trainee_characters=len(text),
        training_fingerprint=training_fingerprint(training),
        transcript_hash=hashlib.sha256(text.encode()).hexdigest(),
        scenario_id=training.get('scenario',{}).get('id'), scenario_title=training.get('scenario',{}).get('title'),
        stage=training.get('stage'),
        assessment={**{key:score.get(key) for key in ('total','status','model','evaluator_version','rubric_id','rubric_name','rubric_fingerprint','calibration_status','observed_weight')},
                    'dimensions':[{key:d.get(key) for key in ('key','label','weight','score')} for d in score.get('dimensions',[])]})
    return result


def usable_activity(data, session_id):
    if not isinstance(data, dict) or type(data.get('format')) is not int or data['format'] != 2 or data.get('id') != session_id or type(data.get('valid')) is not bool:
        return False
    required = ('id', 'owner_id', 'started_at', 'ended_at', 'status', 'scenario_title', 'stage', 'experience', 'transcript_hash')
    if any(key not in data for key in required) or not isinstance(data['started_at'], str):
        return False
    if any(data.get(key) is not None and not isinstance(data[key], str) for key in (*required, 'training_fingerprint', 'scenario_id', 'remediation_id')):
        return False
    assessment = data.get('assessment')
    if not isinstance(assessment, dict) or not isinstance(assessment.get('dimensions'), list) or 'calibration_status' not in assessment:
        return False
    if any(assessment.get(key) is not None and not isinstance(assessment[key], str) for key in ('model', 'evaluator_version', 'rubric_fingerprint', 'calibration_status')):
        return False
    return all(isinstance(item, dict) and isinstance(item.get('key'), str) and isinstance(item.get('label'), str)
        and 'score' in item and (item['score'] is None or type(item['score']) in (int, float) and 0 <= item['score'] <= 4)
        for item in assessment['dimensions'])


class SessionRecord:
    def __init__(self, session_id: str, mode: str):
        self.training = None
        self.validate_training = None
        self.data = {
            "id": session_id, "mode": mode, "started_at": timestamp(),
            "ended_at": None, "status": "connecting", "messages": [], "usage": [],
        }

    def transcript(self, item_id: str, role: str, text: str, *, final: bool):
        if not text:
            return
        messages = self.data["messages"]
        existing = messages[-1] if messages and messages[-1]['id'] == item_id else next((m for m in messages if m["id"] == item_id), None)
        if existing is None:
            existing = {"id": item_id, "role": role, "text": "", "final": False}
            messages.append(existing)
        existing["text"] = text if final else existing["text"] + text
        existing["final"] = final

    def save(self, directory: Path, status: str):
        self.data.update(status=status, ended_at=timestamp())
        self.data['activity'] = activity_record(self.data)
        write_private(directory / f'{self.data["id"]}.json', json.dumps(self.data, ensure_ascii=False).encode())


def list_records(directory: Path, *, workspace=None, owner_id=None, team=None, activity=False, limit=50, include_owner=False) -> list[dict]:
    records = []
    paths = []
    for path in directory.glob("*.json"):
        try:
            info = path.stat()
            if stat.S_ISREG(info.st_mode):
                paths.append((-info.st_mtime, len(paths), path))
        except OSError:
            continue
    # Summary requests only need the newest matching records, not a full sort.
    if limit is None:
        paths.sort(reverse=True)
    else:
        heapq.heapify(paths)
    for _ in range(len(paths)):
        _, _, path = paths.pop() if limit is None else heapq.heappop(paths)
        try:
            session_id = str(UUID(path.stem))
            data = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(data, dict) or data.get("id") != session_id or not isinstance(data.get("messages"), list):
                continue
            if workspace is not None and data.get('workspace') != workspace:
                continue
            if owner_id is not None and data.get('owner_id') != owner_id and not (team and data.get('team') == team):
                continue
            if activity:
                cached = data.get('activity')
                if not usable_activity(cached, session_id):
                    cached = activity_record(data)
                    if not usable_activity(cached, session_id):
                        continue
                records.append(cached)
            else:
                records.append({
                    **{key: data.get(key) for key in ("id", "experience", "mode", "started_at", "ended_at", "status")},
                    "message_count": len(data["messages"]),
                    "scenario_title": (data.get('training') or {}).get('scenario', {}).get('title'),
                    **({'owner_id': data.get('owner_id'), 'doctor': data.get('doctor')} if include_owner else {})})
        except (OSError, ValueError, TypeError, AttributeError, KeyError):
            continue
        if limit is not None and len(records) == limit:
            break
    return records


class FileRecords:
    """Compatibility store for local development without PostgreSQL."""

    def __init__(self, directory: Path):
        self.directory = directory

    def open(self):
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)

    def close(self):
        pass

    def check(self):
        pass

    def save(self, record: SessionRecord, status: str):
        record.save(self.directory, status)

    def list(self, **scope):
        return list_records(self.directory, **scope)

    def activity(self, **scope):
        return list_records(self.directory, **scope, activity=True, limit=None)

    def get(self, session_id: UUID):
        path = self.directory / f"{session_id}.json"
        try:
            return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None
        except FileNotFoundError:
            return None

    def get_many(self, session_ids):
        return {str(session_id):record for session_id in session_ids if (record := self.get(session_id)) is not None}

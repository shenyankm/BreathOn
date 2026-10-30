"""Import legacy JSON records without changing files or overwriting database rows."""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID

from psycopg.types.json import Jsonb

from ..core.config import Settings
from .postgres import PostgresRecords


def import_records(store: PostgresRecords, directory: Path) -> tuple[int, int]:
    if not directory.is_dir():
        raise ValueError("记录目录不存在")
    documents = []
    for path in sorted(directory.glob("*.json")):
        if not path.is_file():
            raise ValueError(f"记录必须为普通文件：{path.name}")
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or data.get("id") != str(UUID(path.stem)) or not isinstance(data.get("messages"), list):
            raise ValueError(f"记录格式无效：{path.name}")
        documents.append((UUID(data["id"]), Jsonb(data), datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)))
    # Validate every input first, then commit the import in one transaction.
    with store.pool.connection() as connection:
        with connection.cursor() as cursor:
            cursor.executemany(
                "INSERT INTO sessions (id, document, saved_at) VALUES (%s, %s, %s) ON CONFLICT (id) DO NOTHING",
                documents,
            )
            imported = cursor.rowcount
    return imported, len(documents) - imported


def main():
    settings = Settings()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path, nargs="?", default=settings.records)
    args = parser.parse_args()
    if not settings.database_url:
        parser.error("请设置 DATABASE_URL")
    store = PostgresRecords(settings.database_url)
    try:
        store.open()
        imported, skipped = import_records(store, args.directory)
        print(f"已导入 {imported} 条，已存在 {skipped} 条；原 JSON 文件未修改。")
    finally:
        store.close()


if __name__ == "__main__":
    main()

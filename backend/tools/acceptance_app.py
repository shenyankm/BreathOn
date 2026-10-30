"""Isolated local acceptance server, using real configured providers and no mocked services."""
from pathlib import Path

from medvisit.api.app import create_app
from medvisit.core.config import Settings

RECORDS = Path(__file__).resolve().parents[1]/'data/validation/acceptance/sessions'
app = create_app(Settings(records=RECORDS, database_url='', origins=('http://127.0.0.1:5174', 'http://127.0.0.1:5173')))

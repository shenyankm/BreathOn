"""ASGI entry point: uvicorn medvisit.main:app."""
import logging
from .api.app import create_app

http_logger = logging.getLogger('medvisit.http')
handler = logging.StreamHandler()
handler.setFormatter(logging.Formatter('%(message)s'))
http_logger.addHandler(handler)
http_logger.setLevel(logging.INFO)
http_logger.propagate = False

app = create_app()

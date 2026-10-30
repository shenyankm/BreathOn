"""Request identity is separate from the shared training workspace."""
from contextvars import ContextVar

current_actor = ContextVar('breathon_actor', default=None)


def private_entry_visible(kind, item):
    field = {'case':'created_by', 'remediation':'owner_id'}.get(kind)
    actor = current_actor.get()
    return not actor or not field or item.get(field) == actor

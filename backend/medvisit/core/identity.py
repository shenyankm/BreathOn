"""Request identity is separate from the shared training workspace."""
from contextvars import ContextVar

current_actor = ContextVar('breathon_actor', default=None)
current_role = ContextVar('breathon_role', default='admin')


def private_entry_visible(kind, item):
    field = {'case':'created_by', 'remediation':'owner_id', 'member_state':'owner_id'}.get(kind)
    actor = current_actor.get()
    return not actor or not field or item.get(field) == actor

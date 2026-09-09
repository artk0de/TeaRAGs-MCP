"""A two-base class whose FIRST base is a LIBRARY class (bd tea-rags-mcp-7bqru).

`pkg/models.py` covers the same blind spot with two PROJECT bases, where jedi
lands on `object.__init__` in its bundled typeshed. Here the first base is real
library code, so jedi's first-base walk leaves the project with a library origin
rather than a stub — the netbox shape (`DataSource(JobsMixin, PrimaryModel)`
answering django's `Model.save`) at fixture scale.
"""

from collections import UserDict

from .base import Named


class Registry(UserDict, Named):
    def __init__(self, name: str) -> None:
        super().__init__(name)

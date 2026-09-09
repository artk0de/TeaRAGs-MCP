"""Multi-base MRO, `super()`, `@property` and `@staticmethod` in one class."""

from .base import Auditable, Named


class User(Auditable, Named):
    def __init__(self, name: str, email: str) -> None:
        super().__init__(name)
        self.email = email

    @property
    def handle(self) -> str:
        return self.name.lower()

    @staticmethod
    def normalise(raw: str) -> str:
        return raw.strip()

    def rename(self, name: str) -> str:
        self.touch()
        return self.describe()

"""Two plain bases, so `models.py` can be genuinely multi-base."""


class Auditable:
    def touch(self) -> None:
        self.touched = True

    def describe(self) -> str:
        return "auditable"


class Named:
    def __init__(self, name: str) -> None:
        self.name = name

    def describe(self) -> str:
        return self.name

"""Annotated parameter and annotated return — the shape the chain cannot read."""

from .models import User


def promote(user: User) -> str:
    user.touch()
    return user.rename("promoted")


def normalise_all(raw: list[str]) -> list[str]:
    return [User.normalise(item) for item in raw]

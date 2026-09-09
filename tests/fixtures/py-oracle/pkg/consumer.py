"""Calls that arrive through the package root rather than the defining module."""

from . import User, promote


def run(name: str) -> str:
    user = User(name, f"{name}@example.com")
    return promote(user)

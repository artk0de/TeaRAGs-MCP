"""Calls into a sibling module whose name shadows the stdlib's `string`."""

from .string import Formatter, remove_linebreaks


def clean(value: str) -> str:
    return remove_linebreaks(value)


def render(value: str) -> str:
    return Formatter().render(value)

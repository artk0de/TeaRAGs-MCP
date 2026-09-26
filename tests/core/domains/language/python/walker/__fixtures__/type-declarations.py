import enum
import typing
from enum import Enum, IntEnum, StrEnum, Flag
from typing import Final, NewType, Protocol, TypeAlias

MAX_RETRIES = 3
_DEFAULT_TIMEOUT = 30
TIMEOUT: Final = 10
limit: Final[int] = 5
retries = 4
__all__ = ["Service"]
UserId = NewType("UserId", int)
Json: TypeAlias = dict[str, "Json"]
Headers: typing.TypeAlias = dict[str, str]
type Pair[T] = tuple[T, T]
A = B = 7

if typing.TYPE_CHECKING:
    GUARDED = 1


class Color(Enum):
    RED = 1


class Level(enum.IntEnum):
    LOW = 1


class Mode(StrEnum):
    FAST = "fast"


class Perm(Flag):
    READ = 1


class Readable(Protocol):
    def read(self) -> bytes: ...


class Box(Protocol[T]):
    pass


@decorated
class Service(Base, mixins.Loggable, Generic[T], metaclass=Meta):
    LIMIT = 5
    Alias: TypeAlias = int

    class Inner(Base):
        class Deep:
            pass

    def run(self):
        LOCAL_CONST = 1

        class LocalType:
            pass

        return LOCAL_CONST


def build():
    INNER = 2
    return INNER

"""Both re-export idioms in one package root."""

from .base import Auditable as Auditable
from .models import User
from .service import promote

__all__ = ["User", "promote"]

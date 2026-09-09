"""A CLASS ATTRIBUTE called like a method — jedi answers the assignment.

The netbox shape, minimised (z796g): `netbox/netbox/views/generic/base.py:72`
declares `table = None` on the view class and subclasses rebind it to a table
class, so `self.table(...)` is a real call with no `def` anywhere named `table`.
jedi's `goto` lands on the `table = None` line, which is in-project and is not a
definition — there is nothing there for a resolution chain to match.
"""


class Report:
    table = None

    def render(self) -> str:
        return self.table()

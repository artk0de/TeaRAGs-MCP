"""A project module whose NAME shadows a stdlib one (bd tea-rags-mcp-7dsyq).

netbox owns `netbox/utilities/string.py`, polar owns
`sdk/generator/python/types.py`. jedi resolves calls into both correctly; it was
`classify_origin` that overruled it on the strength of the file's STEM and
called the target stdlib, which scored the chain's correct edge a phantom — 432
netbox rows, 46 polar rows. The stem heuristic now runs only for a path the
corpus does not contain, and this module is what holds that order in place.
"""


def remove_linebreaks(value: str) -> str:
    return value.replace("\n", " ").replace("\r", " ")


class Formatter:
    def render(self, value: str) -> str:
        return remove_linebreaks(value).strip()

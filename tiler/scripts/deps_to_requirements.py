"""Write pyproject's [project].dependencies out as a requirements.txt.

Used by the Dockerfile to install third-party deps as their own cached layer,
BEFORE src/ is copied, so editing application code doesn't reinstall GDAL and
rasterio. pyproject stays the single source of truth for the dependency list --
this only reformats it.

    python scripts/deps_to_requirements.py pyproject.toml /tmp/requirements.txt

Paths come in as argv rather than being interpolated into a shell command, so
the '>=' in each pin is never seen by a shell.
"""

import pathlib
import sys
import tomllib


def main(pyproject: str, out: str) -> None:
    with open(pyproject, "rb") as f:
        deps = tomllib.load(f)["project"]["dependencies"]
    pathlib.Path(out).write_text("\n".join(deps) + "\n")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])

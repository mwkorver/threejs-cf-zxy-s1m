# Lambda container image (plan §3: "TiTiler-style Lambda (container)").
# Container image (not zip) because rasterio/GDAL wheels are large (well past
# the 250 MB zip+layers limit — which is also why Lambda Layers don't apply).
FROM public.ecr.aws/lambda/python:3.12

# GDAL/PROJ (via rasterio, pyproj) dynamically link libexpat, which the minimal
# Lambda base image doesn't ship — install it or import fails at runtime.
RUN dnf install -y expat && dnf clean all

# --- Dependency layer -------------------------------------------------------
# Install only the third-party deps from pyproject, BEFORE copying the app, so
# this (expensive GDAL/rasterio) layer stays cached across code changes — a src
# edit no longer triggers a full reinstall. Deps are written to a file (path
# passed as a py arg, not shell-interpolated) so the '>=' version pins survive.
COPY pyproject.toml ${LAMBDA_TASK_ROOT}/
RUN python -c "import tomllib, pathlib, sys; pathlib.Path('/tmp/requirements.txt').write_text('\n'.join(tomllib.load(open(sys.argv[1], 'rb'))['project']['dependencies']))" ${LAMBDA_TASK_ROOT}/pyproject.toml \
    && pip install --no-cache-dir -r /tmp/requirements.txt

# Bake the DuckDB extensions into the image (built here for linux/arm64,
# matching the Lambda runtime) so the first request LOADs them from disk
# instead of downloading over the network (~2s off the cold start). duck.py
# reads DUCKDB_EXTENSION_DIR and LOADs without INSTALL when it's set.
ENV DUCKDB_EXTENSION_DIR=/opt/duckdb-extensions
RUN python -c "import duckdb; c=duckdb.connect(); \
    c.execute(\"SET extension_directory='/opt/duckdb-extensions'\"); \
    [c.execute(f'INSTALL {e}') for e in ('spatial','httpfs','aws')]"

# GDAL knobs that matter for COG range reads from Lambda. Requester-pays is NOT
# global — it's scoped per-asset in imagery.py to the buckets that require it,
# so S1M/far-field public reads stay clean signed requests.
ENV GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR \
    GDAL_HTTP_MERGE_CONSECUTIVE_RANGES=YES \
    CPL_VSIL_CURL_CACHE_SIZE=200000000

# --- App layer --------------------------------------------------------------
# Copied last and run straight off sys.path (LAMBDA_TASK_ROOT) instead of being
# `pip install`ed, so a code change rebuilds only this thin layer (seconds) and
# pushes a tiny ECR delta. The bundled data/USGS_13_DEM_Index.parquet rides
# along under tiler/data/; get_usgs13_resolver loads it relative to __file__.
COPY src/tiler ${LAMBDA_TASK_ROOT}/tiler/

CMD ["tiler.handler.handler"]

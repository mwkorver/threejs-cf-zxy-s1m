# Lambda container image (plan §3: "TiTiler-style Lambda (container)").
# Container image (not zip) because rasterio/GDAL wheels are large.
FROM public.ecr.aws/lambda/python:3.12

# GDAL/PROJ (via rasterio, pyproj) dynamically link libexpat, which the minimal
# Lambda base image doesn't ship — install it or import fails at runtime.
RUN dnf install -y expat && dnf clean all

COPY pyproject.toml ${LAMBDA_TASK_ROOT}/
COPY src/ ${LAMBDA_TASK_ROOT}/src/
RUN pip install --no-cache-dir ${LAMBDA_TASK_ROOT}/

# GDAL knobs that matter for COG range reads from Lambda. Requester-pays is NOT
# global — it's scoped per-asset in imagery.py to the buckets that require it,
# so S1M/far-field public reads stay clean signed requests.
ENV GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR \
    GDAL_HTTP_MERGE_CONSECUTIVE_RANGES=YES \
    CPL_VSIL_CURL_CACHE_SIZE=200000000

CMD ["tiler.handler.handler"]

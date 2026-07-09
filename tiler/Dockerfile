# Lambda container image (plan §3: "TiTiler-style Lambda (container)").
# Container image (not zip) because rasterio/GDAL wheels are large.
FROM public.ecr.aws/lambda/python:3.12

COPY pyproject.toml ${LAMBDA_TASK_ROOT}/
COPY src/ ${LAMBDA_TASK_ROOT}/src/
RUN pip install --no-cache-dir ${LAMBDA_TASK_ROOT}/

# GDAL knobs that matter for COG range reads from Lambda:
ENV GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR \
    GDAL_HTTP_MERGE_CONSECUTIVE_RANGES=YES \
    CPL_VSIL_CURL_CACHE_SIZE=200000000 \
    AWS_REQUEST_PAYER=requester

CMD ["tiler.handler.handler"]

"""Shared DuckDB connection setup (ported from deckgl-s3-cog-s1m duckdb_s3.py).

ONE database instance per container, with a cursor per caller.

duckdb.connect() builds a whole new database instance every time -- not a
session on a shared one -- and this module has four callers (the mosaic, s1m,
usgs13 and buildings resolvers, each an lru_cache'd singleton in app.py). Four
instances meant four of everything: four extension loads, four credential-chain
resolutions, four buffer managers that cache nothing for each other, and four
independent max_memory allowances. That last one quietly voided the cap below
-- 4 x 1.5GB is 6GB of headroom declared inside a 3008MB Lambda, which is the
opposite of what the setting was added to do.

So the instance is built once and connect() hands out cursors. A cursor is a
separate execution context on the same instance, so it inherits the extensions,
the secret and the settings (verified: max_memory, threads, loaded extensions
and duckdb_secrets all read through), while max_memory now bounds the process
the way its comment claims.

Repeated reads of the same parquet are served from DuckDB's external file cache
(enable_external_file_cache, on by default), which is per-instance -- so
sharing the instance is also what lets the resolvers reuse each other's cached
file data instead of each fetching its own copy.

On Lambda, credential_chain picks up the execution role from the env. Locally,
`aws login` credentials aren't readable by DuckDB's chain (same problem the
source repo solved with a bespoke cache parser) -- here boto3 resolves them and
we hand DuckDB a static secret. Requires botocore[crt] locally for the login
provider.
"""

import os
import threading

import duckdb


_EXTENSIONS = ("spatial", "httpfs", "aws")  # aws = credential_chain provider


# Guards instance creation only. Two threads racing here would each build a
# full instance and one would be silently discarded, taking its extension loads
# and credential resolution with it.
_lock = threading.Lock()
_instances: dict[str, duckdb.DuckDBPyConnection] = {}


def connect(region: str) -> duckdb.DuckDBPyConnection:
    """A cursor on the shared instance for `region`, building it on first use.

    Keyed by region because the S3 secret is region-scoped; in practice this
    holds exactly one entry.
    """
    with _lock:
        con = _instances.get(region)
        if con is None:
            con = _new_instance(region)
            _instances[region] = con
    return con.cursor()


def _new_instance(region: str) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    # On Lambda HOME is empty and the filesystem is read-only except /tmp, so
    # DuckDB can't find a home for its extension cache and INSTALL fails with
    # "Can't find the home directory". Point it at the only writable path.
    if os.environ.get("AWS_LAMBDA_FUNCTION_NAME"):
        con.execute("SET home_directory='/tmp';")
    ext_dir = os.environ.get("DUCKDB_EXTENSION_DIR")
    if ext_dir:
        # Extensions baked into the image (Dockerfile) — LOAD from disk, no
        # network install on the cold path.
        con.execute(f"SET extension_directory='{ext_dir}';")
        for e in _EXTENSIONS:
            con.execute(f"LOAD {e};")
    else:
        # Local dev: download+cache on first use.
        for e in _EXTENSIONS:
            con.execute(f"INSTALL {e}; LOAD {e};")
    try:
        con.execute(
            "CREATE OR REPLACE SECRET s3 (TYPE s3, PROVIDER credential_chain, REGION ?)",
            [region],
        )
    except duckdb.Error:
        _create_static_secret(con, region)
    # NAIP index partitions live behind requester-pays buckets; harmless for
    # public ones. Same setting the existing repo runs in production.
    con.execute("SET s3_requester_pays=true;")

    # DuckDB shares this container with GDAL/rasterio, which hold the other
    # major allocations (warp buffers, WebP encode) in the same process. Cap
    # DuckDB at half the Lambda's configured memory (infra/lib/tiler-stack.ts
    # MemorySize: 3008 MB) rather than let it grow unbounded and leave GDAL to
    # fight over what's left. threads=2 similarly bounds DuckDB's own query
    # parallelism -- independent of GDAL_NUM_THREADS (a different library's
    # pool), but both draw from the same ~1.7 vCPU that memory size buys.
    #
    # These are instance-wide, and there is one instance, so they bound the
    # whole process -- see the module docstring for why that had to be said.
    con.execute("SET max_memory='1.5GB';")
    con.execute("SET threads=2;")
    return con


def _create_static_secret(con: duckdb.DuckDBPyConnection, region: str) -> None:
    import boto3  # lazy: only needed on dev machines, present in Lambda runtime

    creds = boto3.Session().get_credentials()
    if creds is None:
        raise RuntimeError("no AWS credentials available for DuckDB S3 access")
    frozen = creds.get_frozen_credentials()
    # Bound parameters, not interpolation: a DuckDB error carries the statement
    # text, and these values must not be in it.
    if frozen.token:
        con.execute(
            "CREATE OR REPLACE SECRET s3 "
            "(TYPE s3, KEY_ID ?, SECRET ?, SESSION_TOKEN ?, REGION ?)",
            [frozen.access_key, frozen.secret_key, frozen.token, region],
        )
    else:
        con.execute(
            "CREATE OR REPLACE SECRET s3 (TYPE s3, KEY_ID ?, SECRET ?, REGION ?)",
            [frozen.access_key, frozen.secret_key, region],
        )

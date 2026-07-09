"""Shared DuckDB connection setup (ported from deckgl-s3-cog-s1m duckdb_s3.py).

One in-process connection per Lambda container; warm containers answer from
cached parquet footers. On Lambda, credential_chain picks up the execution
role from the env. Locally, `aws login` credentials aren't readable by
DuckDB's chain (same problem the source repo solved with a bespoke cache
parser) — here boto3 resolves them and we hand DuckDB a static secret.
Requires botocore[crt] locally for the login provider.
"""

import duckdb


def connect(region: str) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute("INSTALL httpfs; LOAD httpfs;")
    con.execute("INSTALL aws; LOAD aws;")  # credential_chain provider
    try:
        con.execute(
            f"CREATE OR REPLACE SECRET s3 (TYPE s3, PROVIDER credential_chain, REGION '{region}')"
        )
    except duckdb.Error:
        _create_static_secret(con, region)
    # NAIP lake partitions live behind requester-pays buckets; harmless for
    # public ones. Same setting the existing repo runs in production.
    con.execute("SET s3_requester_pays=true;")
    return con


def _create_static_secret(con: duckdb.DuckDBPyConnection, region: str) -> None:
    import boto3  # lazy: only needed on dev machines, present in Lambda runtime

    creds = boto3.Session().get_credentials()
    if creds is None:
        raise RuntimeError("no AWS credentials available for DuckDB S3 access")
    frozen = creds.get_frozen_credentials()
    token = f", SESSION_TOKEN '{frozen.token}'" if frozen.token else ""
    con.execute(
        f"CREATE OR REPLACE SECRET s3 (TYPE s3, KEY_ID '{frozen.access_key}', "
        f"SECRET '{frozen.secret_key}'{token}, REGION '{region}')"
    )

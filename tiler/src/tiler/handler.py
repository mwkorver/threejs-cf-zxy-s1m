"""Lambda entrypoint: Function URL -> Mangum -> FastAPI (plan §3, §9 step 2)."""

from mangum import Mangum

from .app import app

handler = Mangum(app)

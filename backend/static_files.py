import os

from starlette.staticfiles import StaticFiles as StarletteStaticFiles
from starlette.types import Scope

NO_CACHE = "no-cache, no-store, must-revalidate"
IMMUTABLE = "public, max-age=31536000, immutable"


class SpaStaticFiles(StarletteStaticFiles):
    """Serve the SPA: never cache HTML shell; long-cache hashed assets."""

    async def get_response(self, path: str, scope: Scope):
        response = await super().get_response(path, scope)
        if response.status_code != 200:
            return response

        content_type = response.headers.get("content-type", "")
        basename = os.path.basename(path)
        is_html = basename.endswith(".html") or "text/html" in content_type
        is_hashed_asset = "/assets/" in path or path.startswith("assets/")

        if is_html:
            response.headers["Cache-Control"] = NO_CACHE
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        elif is_hashed_asset:
            response.headers["Cache-Control"] = IMMUTABLE

        return response

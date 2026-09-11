from __future__ import annotations

import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from PIL import Image

from backend import server, template_catalog, template_packages, templates_mgr
from backend.routers import content


class CurrentTemplateCatalogTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(content.router)
        self.client = TestClient(app)
        ready = patch.object(template_packages, "cutout_unavailable_reason", return_value="")
        ready.start()
        self.addCleanup(ready.stop)

    def test_catalog_is_exactly_confirmed_four_and_previews_are_readable(self):
        result = self.client.get("/api/templates").json()
        self.assertEqual(result["count"], 4)
        self.assertEqual(result["qualified"], 4)
        self.assertEqual([t["id"] for t in result["templates"]], list(template_catalog.ACTIVE_IDS))
        for entry in result["templates"]:
            with self.subTest(template=entry["id"]):
                response = self.client.get(entry["preview_url"])
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers["x-preview-kind"], "repository-reference" if entry["id"] == "template_3" else "layout-placeholder")
                with Image.open(io.BytesIO(response.content)) as image:
                    self.assertEqual(image.size, (entry["width"], entry["height"]))
                    image.verify()

    def test_retired_templates_cannot_be_previewed_or_generated(self):
        retired = [t["id"] for t in templates_mgr.list_templates()
                   if t["id"] not in template_catalog.ACTIVE_IDS]
        api = TestClient(server.app)
        with patch.object(server.store, "load") as load:
            for tid in retired:
                with self.subTest(template=tid):
                    self.assertEqual(self.client.get(f"/api/template_preview/{tid}.png").status_code, 404)
                    self.assertEqual(self.client.post("/api/studio/preview", json={"template": tid}).status_code, 410)
                    self.assertEqual(api.post("/api/generate", json={"template": tid}).status_code, 410)
            load.assert_not_called()

    def test_upload_does_not_reintroduce_retired_templates(self):
        with patch.object(templates_mgr, "save_uploaded") as save:
            response = self.client.post("/api/upload_template", files={"files": ("old.json", b'{"id":"daily_polaroid"}', "application/json")})
            self.assertEqual(response.status_code, 409)
            save.assert_not_called()
        self.assertEqual(self.client.get("/api/templates").json()["count"], 4)

    def test_pet_generation_requires_its_cutout_workflow(self):
        api = TestClient(server.app)
        self.assertEqual(api.post("/api/generate", json={"template": "denim_pet"}).status_code, 409)
        self.assertEqual(self.client.post("/api/studio/preview", json={"template": "denim_pet"}).status_code, 409)

    def test_missing_resource_reports_unavailable_without_old_fallback(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(template_catalog, "ROOT", Path(folder)):
            entries = template_catalog.list_templates()
        self.assertEqual([e["id"] for e in entries], list(template_catalog.ACTIVE_IDS))
        self.assertEqual(entries[-1]["status"], "unavailable")
        self.assertFalse(entries[-1]["qualified"])

    def test_cutout_dependency_failure_is_explicit_and_does_not_read_photos(self):
        with patch.object(template_packages, "cutout_unavailable_reason", return_value="缺少既定抠图模型"), patch.object(server.store, "load") as load:
            entries = self.client.get("/api/templates").json()["templates"]
            third = next(entry for entry in entries if entry["id"] == "template_3")
            self.assertFalse(third["qualified"])
            self.assertEqual(third["status"], "unavailable")
            api = TestClient(server.app)
            self.assertEqual(api.post("/api/generate", json={"template": "template_3"}).status_code, 503)
            self.assertEqual(self.client.post("/api/studio/preview", json={"template": "template_3"}).status_code, 503)
            load.assert_not_called()

    def test_insufficient_photos_do_not_restore_retired_layouts(self):
        for count in range(8):
            with self.assertRaises(HTTPException) as context:
                server._fit_template(count)
            self.assertEqual(context.exception.status_code, 422)

    def test_all_layout_fallbacks_and_album_mappings_are_current(self):
        for count in range(8, 61):
            for portrait in (False, True):
                self.assertIn(server._fit_template(count, portrait), template_catalog.STANDARD_IDS)
        for group in (*server._GROUP_TEMPLATE, "主题", "unknown"):
            for tag in (*server._SUBJECT_TEMPLATE, None):
                self.assertIn(server._album_template(group, tag), template_catalog.STANDARD_IDS)

    def test_studio_renders_each_standard_template_with_synthetic_photos(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            photo = root / "sample.png"
            Image.new("RGB", (400, 400), "#8EAABC").save(photo)
            with patch.object(template_packages, "_cutout", return_value=Image.new("RGBA", (400, 400), (80, 120, 200, 180))), patch.object(content, "OUTPUT_DIR", folder), patch.object(content, "_studio_sample", side_effect=lambda n: [{"path": str(photo), "tags": []}] * n), patch.object(content.stickers, "plan_for_wall", return_value=[]), patch.object(content.stickers, "plan_any", return_value=[]):
                for tid in template_catalog.STANDARD_IDS:
                    response = self.client.post("/api/studio/preview", json={"template": tid})
                    self.assertEqual(response.status_code, 200, response.text)
                    result = response.json()
                    self.assertEqual(result["template"], tid)
                    with Image.open(root / Path(result["image_url"]).name) as image:
                        image.verify()


if __name__ == "__main__":
    unittest.main()

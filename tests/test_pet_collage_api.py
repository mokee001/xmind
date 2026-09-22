from __future__ import annotations

import asyncio
import unittest
from unittest.mock import patch

from pydantic import ValidationError

from backend import server


class PetCollageApiTests(unittest.TestCase):
    def test_create_job_only_uses_iphone_accessible_filenames(self) -> None:
        photos = [
            {"filename": "visible.jpg", "path": "/photos/visible.jpg"},
            {"filename": "cloud-only.jpg", "path": "/photos/cloud-only.jpg"},
        ]
        background_tasks = server.BackgroundTasks()
        with (
            patch.object(server, "_bound_account", return_value=True),
            patch.object(server, "_account_scope", return_value="account-scope"),
            patch.object(server.store, "load", return_value=photos),
            patch.object(
                server.pet_collage,
                "start_job",
                return_value={"job_id": "job-1", "status": "analyzing"},
            ) as start_job,
        ):
            response = server.create_pet_collage_job(
                server.PetCollageJobReq(filenames=["visible.jpg"]),
                background_tasks,
                "account-token",
            )

        self.assertEqual(response.status_code, 202)
        start_job.assert_called_once_with("account-scope", [photos[0]])
        self.assertEqual(len(background_tasks.tasks), 1)

    def test_create_job_limits_filename_scope(self) -> None:
        with self.assertRaises(ValidationError):
            server.PetCollageJobReq(filenames=[f"photo-{index}.jpg" for index in range(5001)])

    def test_publish_rejects_a_wall_that_replaced_the_preview(self) -> None:
        device = {"account_token": "account-token"}
        with (
            patch.object(server, "_devices", return_value={"display-1": device}),
            patch.object(server, "_account_auth", return_value=True),
            patch.object(server, "_account_scope", return_value="account-scope"),
            patch.object(server.store, "load", return_value={"wall_id": "new-wall"}),
        ):
            response = asyncio.run(server.device_publish_last_wall(
                "display-1",
                server.PublishWallReq(wall_id="previewed-wall"),
                "account-token",
            ))

        self.assertEqual(response.status_code, 409)


if __name__ == "__main__":
    unittest.main()
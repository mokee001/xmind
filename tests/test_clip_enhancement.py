from __future__ import annotations

import unittest

from backend import clip, dedup, selector


def photo(name: str, vector, score: float = 0.8) -> dict:
    return {
        "path": f"/{name}", "filename": name, "tags": ["city"],
        "quality": score, "aesthetic": score, "clip_embedding": vector,
        "phash": None, "csig": None,
    }


class ClipEnhancementTests(unittest.TestCase):
    def test_clip_similarity_alone_does_not_delete_photos(self) -> None:
        left = photo("left.jpg", [1.0, 0.0])
        right = photo("right.jpg", [0.9999, 0.01])
        kept, removed = dedup.deduplicate([left, right])
        self.assertEqual(len(kept), 2)
        self.assertEqual(removed, 0)

    def test_semantic_selection_avoids_two_nearly_identical_high_scores(self) -> None:
        first = photo("first.jpg", [1.0, 0.0], 1.0)
        duplicate = photo("duplicate.jpg", [0.999, 0.01], 0.99)
        different = photo("different.jpg", [0.0, 1.0], 0.90)
        selected = selector.select_for_template([first, duplicate, different], 2, model={})
        self.assertEqual({item["filename"] for item in selected}, {"first.jpg", "different.jpg"})

    def test_clip_never_processes_rejected_non_camera_image(self) -> None:
        rejected = {"path": "/screenshot.png", "quality": 0.0, "camera_exif": False,
                    "capture_source": "non_photo"}
        original = clip.embedding
        try:
            clip.embedding = lambda _path: self.fail("rejected image reached CLIP")
            clip.enrich([rejected])
        finally:
            clip.embedding = original
        self.assertNotIn("clip_embedding", rejected)

    def test_content_review_rejects_shared_screenshot(self) -> None:
        shared = {**photo("shared.png", [1.0, 0.0]), "capture_source": "shared",
                  "tags": ["source_shared"]}
        prompts = ([1.0, 0.0], [0.0, 1.0], [0.0, 1.0], [0.0, 1.0],
                   [0.0, 1.0], [0.0, 1.0], [0.0, 1.0], [0.0, 1.0])
        original = clip._prompt_embeddings
        try:
            clip._prompt_embeddings = lambda: prompts
            clip.review_content(shared)
        finally:
            clip._prompt_embeddings = original
        self.assertEqual(shared["capture_source"], "non_photo")
        self.assertEqual(shared["junk_reason"], "semantic_non_photo")
        self.assertEqual(shared["quality"], 0.0)

    def test_content_review_keeps_shared_real_photo(self) -> None:
        shared = {**photo("shared.jpg", [0.0, 1.0]), "capture_source": "shared",
                  "tags": ["source_shared"]}
        prompts = ([1.0, 0.0], [1.0, 0.0], [1.0, 0.0], [1.0, 0.0],
                   [0.0, 1.0], [0.0, 1.0], [0.0, 1.0], [0.0, 1.0])
        original = clip._prompt_embeddings
        try:
            clip._prompt_embeddings = lambda: prompts
            clip.review_content(shared)
        finally:
            clip._prompt_embeddings = original
        self.assertEqual(shared["capture_source"], "shared")
        self.assertEqual(shared["clip_content_review"], "photo")
        self.assertGreater(shared["quality"], 0)

    def test_content_review_does_not_override_camera_source(self) -> None:
        camera = {**photo("camera.jpg", [1.0, 0.0]), "capture_source": "camera"}
        original = clip._prompt_embeddings
        try:
            clip._prompt_embeddings = lambda: self.fail("camera photo was reviewed")
            clip.review_content(camera)
        finally:
            clip._prompt_embeddings = original
        self.assertEqual(camera["capture_source"], "camera")


if __name__ == "__main__":
    unittest.main()

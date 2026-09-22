import copy
import datetime as dt
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image
from selection_lab.core import TZ, LabError, atomic_json
from selection_lab import datasets
from selection_lab.collections import build_collections, sample_date
from test_album_collections import CollectionTests
from test_selection_lab import LabFixture

sys.path.insert(0,str(Path(__file__).resolve().parents[1] / "tools"))
from add_lab_photos import capture_date
from run_ente_lab import rebase_cached_ml


class DatasetDateTests(unittest.TestCase):
    def test_unknown_date_never_uses_file_mtime(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/"IMG_1234.jpg"
            Image.new("RGB",(10,10)).save(path)
            self.assertEqual(capture_date(path),(None,"unknown"))
        self.assertEqual(sample_date({"filename":"IMG_1234.jpg","date_source":"unknown","taken_at":None}),(None,"unknown"))

    def test_explicit_filename_time(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/"fxn 2025-07-20 145629.918.jpg"
            Image.new("RGB",(10,10)).save(path)
            timestamp,source=capture_date(path)
            self.assertEqual(source,"filename_datetime")
            self.assertEqual(dt.datetime.fromtimestamp(timestamp,TZ).strftime("%Y-%m-%d %H:%M:%S"),"2025-07-20 14:56:29")

    def test_exif_date_and_offset(self):
        class Photo:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def getexif(self):
                class Exif(dict):
                    def get_ifd(self,_):return {36867:"2025:07:20 14:00:00",36881:"+02:00"}
                return Exif()
        with patch("add_lab_photos.Image.open",return_value=Photo()):
            timestamp,source=capture_date(Path("photo.jpg"))
        self.assertEqual(source,"exif_original_offset")
        self.assertEqual(dt.datetime.fromtimestamp(timestamp,TZ).hour,20)

    def test_new_exif_date_is_preserved(self):
        photo={"filename":"IMG_1234.jpg","taken_at":12345,"date_source":"exif_original_offset"}
        self.assertEqual(sample_date(photo),(12345,"exif_original_offset"))

    def test_cached_face_ids_rebase_without_changing_inference(self):
        before={"id":2,"faces":[{"face_id":"2_abc","embedding":[.1,.2]}],"embedding":[.3]}
        frozen=copy.deepcopy(before)
        result=rebase_cached_ml(before,8)
        self.assertEqual(result["faces"][0]["face_id"],"8_abc")
        self.assertEqual(result["faces"][0]["embedding"],before["faces"][0]["embedding"])
        self.assertEqual(before,frozen)
        with self.assertRaises(RuntimeError):rebase_cached_ml({"id":2,"faces":[{"face_id":"3_wrong"}]},8)

    def test_explicit_old_paths_ignore_active_dataset(self):
        self.assertEqual(datasets.paths(datasets.BASE_CACHE,datasets.BASE_STATE)[:2],(datasets.BASE_CACHE,datasets.BASE_STATE))

    def test_active_paths_cannot_escape_dataset_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            active=Path(tmp)/"active.json"
            atomic_json(active,{"cache_dir":"/tmp/outside-cache","state_dir":"/tmp/outside-state"})
            with patch.object(datasets,"ACTIVE",active),self.assertRaises(LabError):datasets.paths()


class UndatedAlbumTests(LabFixture):
    def test_unknown_dates_still_enter_theme_not_date_albums(self):
        CollectionTests.prepare_vision(self)
        for photo in self.lab.features:
            photo.update(taken_at=None,date_source="unknown")
        result=build_collections(self.lab,{})
        self.assertTrue(result["albums"])
        self.assertTrue(all(album["kind"]=="theme" for album in result["albums"]))

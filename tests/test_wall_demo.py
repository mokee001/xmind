import unittest
from unittest.mock import patch
from selection_lab.core import atomic_json, LabError
from selection_lab.wall_demo import DIRECTORY, manifest, image_path, scope_key
from test_selection_lab import LabFixture

class WallDemoTests(LabFixture):
    def setUp(self):
        super().setUp()
        self.result={'id':'snapshot', 'display_photo_ids':['one','two']}
        self.value={'scope':scope_key(self.lab,self.result),'walls':[{'id':'a'*24}]}
        atomic_json(self.state/DIRECTORY/'manifest.json',self.value)
        self.mock=patch('selection_lab.recollection_v2.get_feed',return_value=self.result)
        self.mock.start();self.addCleanup(self.mock.stop)

    def test_current_scope_only_and_manifest_is_read_only(self):
        path=self.state/DIRECTORY/'manifest.json';before=path.read_bytes()
        self.assertEqual(manifest(self.lab),self.value)
        self.result['display_photo_ids']=['one']
        with self.assertRaises(LabError):manifest(self.lab)
        self.assertEqual(path.read_bytes(),before)

    def test_image_must_be_an_exact_current_manifest_member(self):
        self.assertEqual(image_path(self.lab,'a'*24).name,'a'*24+'.jpg')
        for key in ['../manifest','b'*24,'a'*24+'.jpg']:
            with self.assertRaises(LabError):image_path(self.lab,key)

    def test_other_dataset_cannot_reuse_demo(self):
        self.lab.dataset_id='other'
        with self.assertRaises(LabError):manifest(self.lab)

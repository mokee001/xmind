import copy
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from backend import dedup, tagger, real_tagger
from selection_lab.core import LabError
from selection_lab.recollection_v2 import validate_index


def photo(key, bits, gray, quality=.8):
    return dict(id=key, filename=key, quality=quality, tags=['person'], phash=bits, csig=gray)


class DuplicateV2Tests(unittest.TestCase):
    def test_gray_and_category_alone_never_drop_a_photo(self):
        a = photo('concert', 0, list(range(36)))
        b = photo('meal', (1<<64)-1, list(range(36)))
        self.assertEqual(len(dedup.deduplicate([a, b])[0]), 2)

    def test_filename_and_semantic_similarity_are_not_duplicates(self):
        a = dict(filename='IMG_0001.JPG', quality=.8, clip_embedding=[1.,0.])
        b = dict(a, path='/another/IMG_0001.JPG')
        self.assertEqual(len(dedup.deduplicate([a, b])[0]), 2)

    def test_hash_needs_spatial_support_and_flat_grids_are_uninformative(self):
        a = photo('a', 1234, list(range(36)))
        b = photo('b', 1234, list(range(100,136)))
        self.assertFalse(dedup._is_similar(a,b,8))
        a['csig'] = b['csig'] = [0]*36
        self.assertFalse(dedup._is_similar(a,b,8))

    def test_exact_file_and_supported_repeats_choose_best(self):
        a = photo('a', 0, list(range(36)))
        b = photo('b', 1, list(range(1,37)), .9)
        self.assertEqual(dedup.deduplicate([a,b])[0], [b])
        a['sha256'] = b['sha256'] = 'same-content'
        b['phash'] = (1<<64)-1
        self.assertEqual(dedup.duplicate_reason(a,b), 'identical_file')

    def test_complete_link_blocks_chains_and_representative_drift(self):
        a=photo('a',0,list(range(36)),.7)
        b=photo('b',255,list(range(36)),.9)
        c=photo('c',65535,list(range(36)),.8)
        groups=dedup.duplicate_clusters([a,b,c])
        self.assertEqual(len(groups),2)
        for group in groups:
            self.assertTrue(all(dedup._is_similar(x,y,8) for x in group for y in group))


class SemanticFailureTests(unittest.TestCase):
    def test_unavailable_and_exception_never_call_mock(self):
        with patch.object(tagger,'_TAGGER_MODE','auto'), patch.object(tagger,'_detect_semantic_mock',side_effect=AssertionError('fake')):
            with patch.object(real_tagger,'available',return_value=False):
                r=tagger.semantic_result('not-read')
                self.assertEqual(r['tags'],[]);self.assertEqual(r['status'],'failed');self.assertTrue(r['retryable'])
            with patch.object(real_tagger,'available',return_value=True), patch.object(real_tagger,'detect',side_effect=RuntimeError('failure')):
                self.assertEqual(tagger.semantic_result('not-read')['status'],'failed')

    def test_empty_success_is_distinct_from_failure_and_demo_is_explicit(self):
        with patch.object(tagger,'_TAGGER_MODE','auto'), patch.object(real_tagger,'available',return_value=True), patch.object(real_tagger,'detect',return_value=[]), patch.object(real_tagger,'model_metadata',return_value={'library_version':'test'}):
            r=tagger.semantic_result('not-read')
            self.assertEqual(r['status'],'complete');self.assertEqual(r['tags'],[])
        with patch.object(tagger,'_TAGGER_MODE','mock'):
            self.assertEqual(tagger.semantic_result('not-read')['status'],'demo')


class IdentityIndexTests(unittest.TestCase):
    def setUp(self):
        self.photos=[dict(id=str(i),sha256='sha'+str(i),quality=0 if i==0 else .9) for i in range(15)]
        self.lab=SimpleNamespace(dataset_id='dataset',features=self.photos)
        self.manifest={'dataset_id':'dataset','photos':self.photos}
        faces=[dict(face_id='face'+p['id'],asset_id=p['id'],box=[0,0,.1,.1]) for p in self.photos]
        self.result=dict(id='immich',dataset_id='dataset',status='complete',input_count=15,
            face_count=15,processing_coverage=dict(detected_assets=15,metadata_assets=15),
            groups=[dict(id='person',assigned=True,faces=faces[:14]),dict(id='u',assigned=False,faces=faces[14:])])

    def test_raw_group_survives_quality_and_unknown_date_without_splitting(self):
        groups=validate_index(self.lab,self.result,self.manifest)
        self.assertEqual(len(groups[0]['photo_ids']),14)
        self.assertIn('0',groups[0]['photo_ids'])  # low quality remains in identity index
        self.assertFalse(groups[1]['assigned'])
        self.assertEqual(sum(len(g['faces']) for g in groups),15)

    def test_foreign_incomplete_and_duplicate_faces_rejected(self):
        for mutate in [lambda r:r.update(dataset_id='other'),lambda r:r.update(face_count=16),
                       lambda r:r['processing_coverage'].update(detected_assets=14),
                       lambda r:r['groups'][0]['faces'][0].update(asset_id='foreign'),
                       lambda r:r['groups'][0]['faces'][0].update(face_id='face1')]:
            r=copy.deepcopy(self.result);mutate(r)
            with self.assertRaises(LabError):validate_index(self.lab,r,self.manifest)

    def test_missing_input_photo_cannot_reuse_old_export(self):
        with self.assertRaises(LabError):validate_index(self.lab,self.result,{'dataset_id':'dataset','photos':self.photos[:-1]})


from test_selection_lab import LabFixture
from selection_lab.core import atomic_json
from selection_lab.recollection_v2 import get_feed, update_feedback, DIRECTORY


class V2PersistenceTests(LabFixture):
    def seed(self):
        result={'id':'a'*24,'provenance':{'dataset_id':self.lab.dataset_id},
                'albums':[{'id':'person-a','topic':'person-a','kind':'person','quality_score':.8,
                           'photo_ids':[p['id'] for p in self.lab.features]}], 'people':[], 'photos':[]}
        atomic_json(self.state/DIRECTORY/'latest.json',{'id':result['id'],'dataset_id':self.lab.dataset_id})
        atomic_json(self.state/DIRECTORY/(result['id']+'.json'),result)
        return result

    def test_v2_feedback_never_writes_v1_or_raw_snapshot(self):
        result=self.seed()
        baseline=self.state/'recollections/feedback.json'
        atomic_json(baseline,{'marker':'unchanged'})
        before=baseline.read_bytes()
        snapshot=self.state/DIRECTORY/(result['id']+'.json')
        raw=snapshot.read_bytes()
        update_feedback(self.lab,{'album_id':'person-a','action':'favorite'})
        self.assertTrue(get_feed(self.lab)['feedback']['person-a']['favorite'])
        self.assertEqual(baseline.read_bytes(),before)
        self.assertEqual(snapshot.read_bytes(),raw)
        update_feedback(self.lab,{'album_id':'person-a','action':'hide'})
        self.assertEqual(get_feed(self.lab)['featured_ids'],[])
        update_feedback(self.lab,{'album_id':'person-a','action':'restore'})
        self.assertEqual(get_feed(self.lab)['featured_ids'],['person-a'])

    def test_foreign_pointer_and_invalid_actions(self):
        self.seed()
        with self.assertRaises(LabError):update_feedback(self.lab,{'album_id':'unknown','action':'favorite'})
        with self.assertRaises(LabError):update_feedback(self.lab,{'album_id':'person-a','action':'unknown'})
        atomic_json(self.state/DIRECTORY/'latest.json',{'id':'a'*24,'dataset_id':'another'})
        self.assertIsNone(get_feed(self.lab))

    def test_v2_http_routes_and_request_token(self):
        import threading,json,urllib.request,urllib.error
        from selection_lab.server import LabServer
        self.seed()
        server=LabServer(('127.0.0.1',0),self.lab)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        base=f'http://127.0.0.1:{server.server_port}'
        try:
            for route in ['/recollections-v2','/people-v2','/people-v2.js','/api/recollections-v2']:
                with urllib.request.urlopen(base+route) as r:self.assertEqual(r.status,200)
            req=urllib.request.Request(base+'/api/recollections-v2-feedback',data=json.dumps({'album_id':'person-a','action':'favorite'}).encode(),headers={'Content-Type':'application/json'})
            with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(req)
            self.assertEqual(error.exception.code,403)
            req.add_header('X-Lab-Token',server.token)
            with urllib.request.urlopen(req) as r:self.assertTrue(json.load(r)['feedback']['favorite'])
        finally:
            server.shutdown();server.server_close();thread.join()


if __name__=='__main__':unittest.main()

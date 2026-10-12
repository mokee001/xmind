"""Contract tests with isolated synthetic metadata, not inference accuracy tests."""
import asyncio
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from backend.routers.selection import register, validate_observation


class SelectionApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        runtime = self.root/'runtime'
        (runtime/'selection_lab').mkdir(parents=True)
        (runtime/'selection_lab/recollection_feed.py').touch()
        (runtime/'production-ready.json').write_text('{}')
        self.env = patch.dict(os.environ,{'PHOTOWALL_SELECTION_DIR':str(self.root/'accounts'),
                                        'PHOTOWALL_RECOLLECTION_ROOT':str(runtime)})
        self.env.start()
        self.app=FastAPI()
        register(self.app,lambda token:hashlib.sha256(token.encode()).hexdigest()[:24],lambda token:token=='test-owner')

    def tearDown(self):
        self.env.stop(); self.temp.cleanup()

    def request(self,method,path,**kwargs):
        async def run():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app),base_url='http://test') as client:
                return await client.request(method,path,**kwargs)
        return asyncio.run(run())

    def test_session_requires_real_binding(self):
        self.assertEqual(self.request('POST','/api/selection/session',json={}).status_code,401)
        self.assertEqual(self.request('POST','/api/selection/session',json={},headers={'X-Account-Token':'unknown'}).status_code,403)

    def test_source_scopes_stay_separate(self):
        headers={'X-Account-Token':'test-owner'}
        with patch('backend.unified_selection.enqueue'):
            a=self.request('POST','/api/selection/session',json={'sources':['all']},headers=headers).json()
            b=self.request('POST','/api/selection/session',json={'sources':['private']},headers=headers).json()
        self.assertNotEqual(a['scope'],b['scope'])

    def test_unverified_runtime_is_not_advertised(self):
        (self.root/'runtime/production-ready.json').unlink()
        self.assertFalse(self.request('GET','/api/selection/capabilities').json()['ready'])
        r=self.request('POST','/api/selection/session',json={},headers={'X-Account-Token':'test-owner'})
        self.assertEqual(r.status_code,503)

    def test_fake_or_missing_observations_do_not_ingest(self):
        with patch('backend.unified_selection.ingest') as ingest:
            r=self.request('POST','/api/selection/upload',headers={'X-Account-Token':'test-owner'},
                files={'files':('test.jpg',b'not-an-image','image/jpeg')},
                data={'metadata':json.dumps([{'local_engine':'mock','vision':{}}])})
        self.assertEqual(r.status_code,422)
        ingest.assert_not_called()

    def test_thumbnail_requires_same_account(self):
        r=self.request('GET','/api/selection/thumb/another-account/'+'a'*64,headers={'X-Account-Token':'test-owner'})
        self.assertEqual(r.status_code,403)

    def test_corrupt_photo_is_rejected_before_ingest(self):
        observation={'version':1,'labels':[{'identifier':'nature','confidence':0.9}], 'faces':0}
        with patch('backend.unified_selection.ingest') as ingest:
            r=self.request('POST','/api/selection/upload',headers={'X-Account-Token':'test-owner'},
                files={'files':('bad.jpg',b'not-an-image','image/jpeg')},
                data={'metadata':json.dumps([{'local_engine':'apple-vision-local-v1','vision':observation}])})
        self.assertEqual(r.status_code,422)
        ingest.assert_not_called()

    @staticmethod
    def photo_metadata():
        return {'local_engine':'apple-vision-local-v1',
                'asset_id':'private-asset-identifier',
                'vision':{'version':1, 'labels':[{'identifier':'nature', 'confidence':0.91}],
                          'faces':0, 'face_regions':[], 'humans':[]}}

    @staticmethod
    def encoded_photo(format='JPEG'):
        from PIL import Image
        image = Image.new('RGB', (64,64), (44,102,73))
        exif = Image.Exif()
        exif[274] = 6
        exif[306] = '2024:02:03 04:05:06'
        exif[270] = 'private-exif-description'
        output = io.BytesIO()
        image.save(output, format=format, exif=exif)
        return output.getvalue()

    def upload_photo(self, data, filename, content_type, metadata=None):
        return self.request('POST','/api/selection/upload',
            headers={'X-Account-Token':'test-owner'},
            files={'files':(filename,data,content_type)},
            data={'metadata':json.dumps([metadata or self.photo_metadata()])})

    def assert_uploaded_photo_unchanged(self, response, ingest, original, suffix, metadata):
        from PIL import Image
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(response.json()['saved'],1)
        self.assertNotIn('x-photo-error-code',response.headers)
        ingest.assert_called_once()
        item = ingest.call_args.args[1][0]
        sha = hashlib.sha256(original).hexdigest()
        path = Path(item['path'])
        self.assertEqual(path.name,sha+suffix)
        self.assertEqual(item['sha256'],sha)
        self.assertEqual(path.read_bytes(),original)
        self.assertEqual(item['vision'],metadata['vision'])
        self.assertEqual(item['local_engine'],metadata['local_engine'])
        with Image.open(io.BytesIO(original)) as source, Image.open(path) as saved:
            self.assertIn(274,source.getexif())
            self.assertEqual(source.getexif()[306],'2024:02:03 04:05:06')
            self.assertEqual(dict(saved.getexif()),dict(source.getexif()))
            self.assertEqual(saved.size,source.size)

    def test_supported_bytes_override_arbitrary_or_wrong_filename_and_mime(self):
        cases = [
            ('JPEG','private-photo.asset-private-extension','application/x-private-asset-identifier','.jpg'),
            ('JPEG','private-photo','application/octet-stream','.jpg'),
            ('JPEG','private-photo.png','image/png','.jpg'),
            ('PNG','private-photo.jpeg','image/jpeg','.png'),
        ]
        metadata = self.photo_metadata()
        for format,filename,mime,suffix in cases:
            with self.subTest(format=format,filename=filename):
                original = self.encoded_photo(format)
                with self.assertLogs('backend.routers.selection',level='INFO') as logs:
                    with patch('backend.unified_selection.ingest',return_value='revision') as ingest:
                        response = self.upload_photo(original,filename,mime,metadata)
                self.assert_uploaded_photo_unchanged(response,ingest,original,suffix,metadata)
                output = '\n'.join(logs.output)
                self.assertIn('filename normalized',output)
                for private in (filename,metadata['asset_id'],'private-exif-description',
                                'asset-private-extension','application/x-private-asset-identifier'):
                    self.assertNotIn(private,output)

    def test_matching_jpeg_extensions_keep_existing_content_addressed_path(self):
        original = self.encoded_photo()
        metadata = self.photo_metadata()
        for suffix in ('.jpg','.jpeg'):
            with self.subTest(suffix=suffix):
                with patch('backend.unified_selection.ingest',return_value='revision') as ingest:
                    response = self.upload_photo(original,'photo'+suffix,'image/jpeg',metadata)
                self.assert_uploaded_photo_unchanged(response,ingest,original,suffix,metadata)

    def test_normalized_retry_preserves_original_content_identity_in_library(self):
        original = self.encoded_photo()
        metadata = self.photo_metadata()
        revisions = []
        with patch('backend.unified_selection.enqueue') as enqueue:
            for filename in ('photo.arbitrary','photo.png','photo.jpg'):
                response = self.upload_photo(original,filename,'application/octet-stream',metadata)
                self.assertEqual(response.status_code,200,response.text)
                revisions.append(response.json()['revision'])
        enqueue.assert_not_called()
        self.assertEqual(len(set(revisions)),1)
        libraries = list((self.root/'accounts').glob('*/library.json'))
        self.assertEqual(len(libraries),1)
        library = json.loads(libraries[0].read_text())
        sha = hashlib.sha256(original).hexdigest()
        self.assertEqual(list(library['photos']),[sha])
        item = library['photos'][sha]
        self.assertEqual(item['vision'],metadata['vision'])
        self.assertEqual(item['local_engine'],metadata['local_engine'])
        self.assertEqual(Path(item['path']).read_bytes(),original)
        self.assertEqual(Path(item['path']).name,sha+'.jpg')
        self.assertEqual(len(list(libraries[0].parent.joinpath('photos').iterdir())),1)

    def test_heif_bytes_accept_aliases_and_normalize_wrong_extension_without_transcoding(self):
        try:
            import pillow_heif
        except ImportError:
            self.skipTest('HEIF codec is not installed in this test environment')
        pillow_heif.register_heif_opener()
        original = self.encoded_photo('HEIF')
        metadata = self.photo_metadata()
        for filename,suffix in (('photo.HEIC','.heic'),('photo.heif','.heif'),
                                ('photo.private-extension','.heic')):
            with self.subTest(filename=filename):
                with patch('backend.unified_selection.ingest',return_value='revision') as ingest:
                    response = self.upload_photo(original,filename,'image/heic',metadata)
                self.assert_uploaded_photo_unchanged(response,ingest,original,suffix,metadata)

    def test_actual_unsupported_formats_cannot_be_disguised_as_jpeg(self):
        from PIL import Image
        for format in ('GIF','BMP'):
            with self.subTest(format=format):
                encoded = io.BytesIO()
                Image.new('RGB',(16,16),'white').save(encoded,format=format)
                with self.assertLogs('backend.routers.selection',level='WARNING') as logs:
                    with patch('backend.unified_selection.ingest') as ingest:
                        response = self.upload_photo(encoded.getvalue(),'private-photo.jpg','image/jpeg')
                self.assertEqual(response.status_code,422)
                self.assertEqual(response.headers['x-photo-error-code'],'unsupported_photo_format')
                self.assertEqual(response.json()['detail'],'不支持的照片格式')
                ingest.assert_not_called()
                self.assertFalse(list((self.root/'accounts').glob('*/photos/*')))
                output = '\n'.join(logs.output)
                self.assertIn('format='+format,output)
                self.assertNotIn('private-photo',output)
                self.assertNotIn('private-asset-identifier',output)

    def test_corrupt_upload_error_is_classified_without_logging_private_fields(self):
        with self.assertLogs('backend.routers.selection',level='WARNING') as logs:
            with patch('backend.unified_selection.ingest') as ingest:
                response = self.upload_photo(b'private-raw-image-payload',
                    'private-photo.asset-private-extension','application/x-private-asset-identifier')
        self.assertEqual(response.status_code,422)
        self.assertEqual(response.headers['x-photo-error-code'],'unreadable_photo')
        self.assertEqual(response.json()['detail'],'照片文件损坏或无法读取')
        ingest.assert_not_called()
        self.assertFalse(list((self.root/'accounts').glob('*/photos/*')))
        output = '\n'.join(logs.output)
        self.assertIn('suffix=[other] mime=[other] format=unknown',output)
        for private in ('private-photo','asset-private-extension','private-asset-identifier',
                        'private-raw-image-payload'):
            self.assertNotIn(private,output)

    def test_truncated_jpeg_that_passes_verify_is_rejected_before_ingest(self):
        from PIL import Image
        truncated = self.encoded_photo()[:-20]
        with Image.open(io.BytesIO(truncated)) as image:
            image.verify()
        with self.assertRaises(OSError):
            with Image.open(io.BytesIO(truncated)) as image:
                image.load()
        with patch('backend.unified_selection.ingest') as ingest:
            response = self.upload_photo(truncated,'truncated.jpg','image/jpeg')
        self.assertEqual(response.status_code,422)
        self.assertEqual(response.headers['x-photo-error-code'],'unreadable_photo')
        ingest.assert_not_called()
        self.assertFalse(list((self.root/'accounts').glob('*/photos/*')))

    def test_mixed_batch_is_not_ingested_if_any_photo_is_unreadable(self):
        with patch('backend.unified_selection.ingest') as ingest:
            response = self.request('POST','/api/selection/upload',
                headers={'X-Account-Token':'test-owner'},
                files=[('files',('valid.arbitrary',self.encoded_photo(),'image/jpeg')),
                       ('files',('bad.jpg',b'not-an-image','image/jpeg'))],
                data={'metadata':json.dumps([self.photo_metadata(),self.photo_metadata()])})
        self.assertEqual(response.status_code,422)
        self.assertEqual(response.headers['x-photo-error-code'],'unreadable_photo')
        ingest.assert_not_called()

    def test_partial_edge_detections_upload_without_changing_classification_evidence(self):
        from PIL import Image
        from selection_lab.collections import classify
        observation = {'version':1, 'labels':[{'identifier':'people', 'confidence':0.9}], 'faces':1,
                       'face_regions':[{'box':[-0.0000001,0.1,0.5,0.9], 'confidence':0.95}],
                       'humans':[{'box':[0.1,0.1,1.02,1.001], 'confidence':0.8}]}
        normalized = validate_observation(observation)
        self.assertEqual(normalized['face_regions'][0]['box'], [0,0.1,0.5,0.9])
        self.assertEqual(normalized['humans'][0]['box'], [0.1,0.1,1,1])
        self.assertEqual(normalized['face_regions'][0]['source_box'], observation['face_regions'][0]['box'])
        self.assertEqual(normalized['faces'], observation['faces'])
        self.assertEqual(normalized['labels'], observation['labels'])
        self.assertEqual(classify(normalized), classify(observation))
        self.assertEqual(observation['face_regions'][0]['box'][0], -0.0000001)
        image = io.BytesIO()
        Image.new('RGB',(16,16),'white').save(image,format='JPEG')
        with patch('backend.unified_selection.ingest', return_value='revision') as ingest:
            r = self.request('POST','/api/selection/upload',headers={'X-Account-Token':'test-owner'},
                files={'files':('test.jpg',image.getvalue(),'image/jpeg')},
                data={'metadata':json.dumps([{'local_engine':'apple-vision-local-v1','vision':observation}])})
        self.assertEqual(r.status_code,200)
        self.assertEqual(r.json()['saved'],1)
        self.assertEqual(ingest.call_args.args[1][0]['vision'],normalized)

    def test_in_bounds_observations_are_preserved(self):
        observation = {'version':1, 'labels':[{'identifier':'people', 'confidence':0.9}], 'faces':1,
                       'face_regions':[{'box':[0.1,0.2,0.8,0.9], 'confidence':0.8}]}
        self.assertEqual(validate_observation(observation), observation)

    def test_empty_outside_reversed_and_nonfinite_regions_remain_invalid(self):
        regions = [None, {'box':[0,0,0,1],'confidence':0.8},
                   {'box':[0.8,0,0.1,1],'confidence':0.8},
                   {'box':[1.1,0,1.2,1],'confidence':0.8},
                   {'box':[0,0,float('nan'),1],'confidence':0.8},
                   {'box':[0,0,1,1],'confidence':float('inf')},
                   {'box':[0,0,1,1],'confidence':1.2}]
        for region in regions:
            with self.subTest(region=region), self.assertRaisesRegex(ValueError,'Invalid observation region'):
                validate_observation({'version':1,'labels':[{'identifier':'people','confidence':0.9}],
                                      'faces':1,'face_regions':[region]})


if __name__=='__main__':unittest.main()

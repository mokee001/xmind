import hashlib
import os
from pathlib import Path
import tempfile
import subprocess
import unittest
from unittest.mock import patch

from backend import unified_selection as s


class SelectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {'PHOTOWALL_SELECTION_DIR':self.temp.name})
        self.env.start()
        self.scope = s.library_scope('account-a', ['all'])
        self.root = s.directory(self.scope)
        (self.root/'photos').mkdir()
        self.photos = []
        for i in range(24):
            path = self.root/'photos'/f'{i}.jpg'
            data = str(i).encode()
            path.write_bytes(data)
            self.photos.append(dict(id=str(i), sha256=hashlib.sha256(data).hexdigest(), path=str(path),
                                    filename=f'{i}.jpg', quality=.8, aesthetic=.7,
                                    tags=['pet']+(['person_x'] if i<8 else [])))
        self.library = {'scope':self.scope,'revision':'a'*64,
                        'photos':{p['sha256']:p for p in self.photos}}
        s.atomic(self.root/'library.json', self.library)
        self.result = dict(scope=self.scope, input_revision='a'*64, baseline_commit=s.BASELINE,
                           engine='recollection-feed-v1', photos=self.photos[:16],
                           albums=[{'id':'album','photo_ids':[str(i) for i in range(16)]}])

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def test_formal_only_first_layer_even_when_more_raw_photos_exist(self):
        s.publish(self.scope,self.result,self.library)
        chosen, provenance = s.select(self.scope,8,rotate=10)
        self.assertTrue({p['id'] for p in chosen} <= set(map(str,range(16))))
        self.assertEqual(provenance['phase'],'canonical')

    def test_exclusion_wins_over_matching_theme(self):
        s.publish(self.scope,self.result,self.library)
        chosen,_=s.select(self.scope,8,prefer=['pet'],exclude=['person_x'])
        self.assertFalse(any('person_x' in p['tags'] for p in chosen))

    def test_preferences_do_not_recheck_album_minimum(self):
        s.publish(self.scope,self.result,self.library)
        chosen,_=s.select(self.scope,8,prefer=['person_x'])
        self.assertEqual(len(chosen),8)

    def test_no_person_match_never_falls_back(self):
        s.publish(self.scope,self.result,self.library)
        with self.assertRaises(s.SelectionUnavailable): s.select(self.scope,8,prefer=['person_missing'])

    def test_cross_account_result_rejected(self):
        with self.assertRaises(s.SelectionUnavailable): s.publish('account-b',self.result,self.library)

    def test_source_membership_checked(self):
        self.result['photos'][0] = {**self.photos[0],'sha256':'f'*64}
        with self.assertRaises(s.SelectionUnavailable): s.publish(self.scope,self.result,self.library)

    def test_source_revision_checked(self):
        with self.assertRaises(s.SelectionUnavailable): s.publish(self.scope,{**self.result,'input_revision':'b'*64},self.library)

    def test_no_silent_relaxation_of_album_size(self):
        self.result['albums'][0]['photo_ids'] = list(map(str,range(11)))
        with self.assertRaises(s.SelectionUnavailable): s.publish(self.scope,self.result,self.library)

    def test_old_snapshot_kept_on_failed_promotion(self):
        s.publish(self.scope,self.result,self.library)
        before = (self.root/'current.json').read_bytes()
        with self.assertRaises(s.SelectionUnavailable): s.publish(self.scope,{**self.result,'engine':'legacy'},self.library)
        self.assertEqual(before,(self.root/'current.json').read_bytes())

    def test_no_other_account_or_sample_fallback(self):
        s.publish(self.scope,self.result,self.library)
        with self.assertRaises(s.SelectionUnavailable): s.select(s.library_scope('other',['all']),8)

    def test_source_scopes_are_distinct_and_order_independent(self):
        self.assertNotEqual(s.library_scope('a',['all']),s.library_scope('a',['album']))
        self.assertEqual(s.library_scope('a',['x','y']),s.library_scope('a',['y','x']))

    def test_deleted_files_not_resurrected(self):
        s.publish(self.scope,self.result,self.library)
        for p in self.photos[:10]: Path(p['path']).unlink()
        with self.assertRaises(s.SelectionUnavailable): s.select(self.scope,8)

    def test_extra_raw_photo_cannot_enter_formal_snapshot(self):
        self.result['photos'].append(self.photos[18])
        with self.assertRaises(s.SelectionUnavailable): s.publish(self.scope,self.result,self.library)

    def test_person_identity_survives_new_photo_not_display_order(self):
        faces=[{'sha256':self.photos[0]['sha256'],'box':[0,0,.5,.5]}]
        self.result['person_groups']=[{'faces':faces}]
        first=s.attach_people(self.root,self.result)
        self.result['person_groups'][0]['faces'].append({'sha256':self.photos[1]['sha256'],'box':[0,0,.5,.5]})
        second=s.attach_people(self.root,self.result)
        self.assertEqual(first['people'][0]['id'],second['people'][0]['id'])
        self.assertEqual(second['people'][0]['count'],2)

    def test_unknown_old_exclusion_is_not_ignored(self):
        s.publish(self.scope,self.result,self.library)
        with self.assertRaises(s.SelectionUnavailable):s.select(self.scope,8,exclude=['person_missing'])

    def test_linux_worker_is_bounded_and_scope_is_cleaned(self):
        with patch.object(s.sys, 'platform', 'linux'), patch.object(s.subprocess, 'run') as run:
            s.run_inference(['python', 'worker.py'], None)
        command = run.call_args_list[0].args[0]
        self.assertIn('MemoryMax=2G', command)
        self.assertIn('RuntimeMaxSec=3300', command)
        self.assertIn('OOMPolicy=kill', command)
        unit = command[command.index('--unit')+1]
        self.assertEqual(run.call_args_list[1].args[0], ['systemctl','stop',unit])

    def test_linux_timeout_still_stops_descendants(self):
        error = subprocess.TimeoutExpired('worker', 3400)
        with patch.object(s.sys, 'platform', 'linux'), patch.object(s.subprocess, 'run', side_effect=[error, None]) as run:
            with self.assertRaises(subprocess.TimeoutExpired): s.run_inference(['python','worker.py'], None)
        self.assertEqual(run.call_args_list[1].args[0][:2], ['systemctl','stop'])

    def test_upgraded_worker_budget_is_explicit_and_capped(self):
        with patch.object(s.sys, 'platform', 'linux'), patch.dict(os.environ, {'PHOTOWALL_SELECTION_MEMORY_GIB':'5','PHOTOWALL_SELECTION_CPU_PERCENT':'200'}), patch.object(s.subprocess, 'run') as run:
            s.run_inference(['python','worker.py'], None)
        self.assertIn('MemoryMax=5G', run.call_args_list[0].args[0])
        self.assertIn('CPUQuota=200%', run.call_args_list[0].args[0])
        with patch.object(s.sys, 'platform', 'linux'), patch.dict(os.environ, {'PHOTOWALL_SELECTION_MEMORY_GIB':'8'}), patch.object(s.subprocess, 'run') as run:
            with self.assertRaises(s.SelectionUnavailable): s.run_inference(['python','worker.py'], None)
            run.assert_not_called()

    def test_non_root_worker_uses_same_user_manager_for_cleanup(self):
        with patch.object(s.sys, 'platform', 'linux'), patch.dict(os.environ, {'PHOTOWALL_SELECTION_SYSTEMD_USER':'1'}), patch.object(s.subprocess, 'run') as run:
            s.run_inference(['python','worker.py'], None)
        self.assertEqual(run.call_args_list[0].args[0][:2], ['systemd-run','--user'])
        self.assertEqual(run.call_args_list[1].args[0][:3], ['systemctl','--user','stop'])


if __name__ == '__main__': unittest.main()

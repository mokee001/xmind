import copy
from unittest.mock import patch, Mock
from selection_lab.core import atomic_json, LabError
from selection_lab.ente import status, latest_result, start, _watch, recognition_result, people_result
from test_selection_lab import LabFixture


class EnteEntryTests(LabFixture):
    def people_diagnostics(self):
        faces = [{'face_id': f'face-{i}', 'sha256': self.lab.features[0]['sha256'],
                  'box': [.1+i*.2, .1, .2+i*.2, .3], 'score': .9} for i in range(2)]
        return {'face_count': 2, 'cluster_count': 2, 'detected_faces': faces,
                'person_groups': [{'cluster_id': f'cluster-{i}', 'faces': [face]} for i, face in enumerate(faces)]}

    def test_people_keeps_singletons_and_marks_each_face_in_shared_photo(self):
        with patch.object(self.lab, 'run', side_effect=AssertionError('No selection')):
            result = people_result(self.lab, self.people_diagnostics())
        self.assertEqual(len(result['albums']), 3)  # overview and two clusters
        self.assertEqual(len(result['photos']), 1)
        photo_id = self.lab.features[0]['id']
        self.assertEqual(len(result['albums'][0]['faces'][photo_id]), 2)
        self.assertEqual(len(result['albums'][1]['faces'][photo_id]), 1)
        self.assertNotEqual(result['albums'][1]['faces'], result['albums'][2]['faces'])

    def test_people_rejects_unknown_photo_or_duplicate_cluster_assignment(self):
        data = self.people_diagnostics()
        data['person_groups'][1]['faces'] = data['person_groups'][0]['faces']
        with self.assertRaises(LabError):
            people_result(self.lab, data)
        data = self.people_diagnostics()
        data['detected_faces'][0]['sha256'] = 'unknown'
        with self.assertRaises(LabError):
            people_result(self.lab, data)

    def test_people_empty_detection_does_not_create_fake_album(self):
        result = people_result(self.lab, {'face_count': 0, 'cluster_count': 0, 'detected_faces': [], 'person_groups': []})
        self.assertEqual(result['albums'], [])

    def test_recognition_shows_single_match_and_keeps_cross_theme_repeats(self):
        photo = self.lab.features[5]
        data = {'clip_threshold': .225, 'themes': [
            {'type': name, 'title': name, 'matching_count': 1,
             'matches': [{'sha256': photo['sha256'], 'score': .3}]}
            for name in ['food', 'pets']]}
        with patch.object(self.lab, 'run', side_effect=AssertionError('No selection')):
            result = recognition_result(self.lab, data)
        self.assertEqual(len(result['albums']), 2)
        self.assertEqual(len(result['photos']), 1)
        self.assertEqual(result['albums'][0]['photo_ids'], [photo['id']])

    def test_recognition_rejects_unknown_photo_and_threshold_boundary(self):
        data = {'clip_threshold': .225, 'themes': [{'type': 'food', 'title': 'food',
            'matching_count': 1, 'matches': [{'sha256': 'unknown', 'score': .3}]}]}
        with self.assertRaises(LabError):
            recognition_result(self.lab, data)
        data['themes'][0]['matches'][0] = {'sha256': self.lab.features[0]['sha256'], 'score': .225}
        with self.assertRaises(LabError):
            recognition_result(self.lab, data)

    def test_no_result_does_not_call_local_selector(self):
        with patch.object(self.lab,"run",side_effect=AssertionError("No fallback")):
            self.assertIsNone(status(self.lab)["record"])

    def test_only_current_dataset_status(self):
        atomic_json(self.state / "ente/status.json",{"dataset_id":"other","state":"complete"})
        self.assertEqual(status(self.lab)["state"],"not_ready")

    def test_natural_output_not_replaced_by_debug(self):
        natural=self.lab.save_run(self.lab.import_ente(self.ente_package()),"natural fixture")
        data=copy.deepcopy(self.ente_package())
        data["provenance"]["mode"]="debug_all_candidates"
        self.lab.save_run(self.lab.import_ente(data),"debug fixture")
        self.assertEqual(latest_result(self.lab)["id"],natural["id"])

    def test_empty_natural_result_is_real_empty(self):
        data=self.ente_package();data["memories"]=[]
        self.lab.save_run(self.lab.import_ente(data),"empty fixture")
        self.assertEqual(latest_result(self.lab)["result"]["events"],[])

    def test_debug_only_is_not_a_natural_result(self):
        data=self.ente_package();data["provenance"]["mode"]="debug_all_candidates"
        self.lab.save_run(self.lab.import_ente(data),"debug fixture")
        self.assertIsNone(status(self.lab)["record"])

    def test_explicit_natural_snapshot_persists(self):
        first=self.lab.save_run(self.lab.import_ente(self.ente_package()),"first fixture")
        self.lab.save_run(self.lab.import_ente(self.ente_package()),"next fixture")
        atomic_json(self.state / "ente/latest.json",{"dataset_id":self.lab.dataset_id,"run_id":first["id"]})
        self.assertEqual(latest_result(self.lab)["id"],first["id"])

    def test_unprepared_runner_never_spawns(self):
        with patch("selection_lab.ente.subprocess.Popen") as spawn:
            with self.assertRaises(LabError):
                start(self.lab)
            spawn.assert_not_called()

    def test_corrupt_status_does_not_hide_results(self):
        self.lab.save_run(self.lab.import_ente(self.ente_package()),"natural fixture")
        path=self.state / "ente/status.json"
        path.parent.mkdir(exist_ok=True)
        path.write_text("{")
        self.assertIsNotNone(status(self.lab)["record"])

    def test_abnormal_exit_marks_failure_not_success(self):
        job=Mock()
        atomic_json(self.state / "ente/status.json",{"dataset_id":self.lab.dataset_id,"state":"running"})
        with patch("selection_lab.ente._job",job):
            _watch(self.lab,job)
        self.assertEqual(status(self.lab)["state"],"failed")

    def test_watcher_preserves_completed_result(self):
        job=Mock()
        atomic_json(self.state / "ente/status.json",{"dataset_id":self.lab.dataset_id,"state":"complete"})
        with patch("selection_lab.ente._job",job):
            _watch(self.lab,job)
        self.assertEqual(status(self.lab)["state"],"complete")

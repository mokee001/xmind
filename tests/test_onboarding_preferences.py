"""Projection tests: no new recognition, no changes to the first-layer curation."""
import copy
import unittest
from pathlib import Path
from tools.onboarding_preferences import library_people, theme_options, prioritize_themes, THEMES


class PreferenceProjectionTest(unittest.TestCase):
    def result(self):
        def group(gid, ids, assigned=True):
            return {'id':gid,'assigned':assigned,'title':gid,'photo_ids':ids,
                    'faces':[{'face_id':gid+pid,'asset_id':pid,'box':[0.1,0.1,0.5,0.5]} for pid in ids]}
        return {'people':[group('a',['p1','p2']),group('b',['p3','p4']),group('unknown',['p5'],False)],
                'albums':[{'id':'pets','topic':'pets','photo_ids':['p1']},
                          {'id':'food','topic':'table','photo_ids':['p2']}]}

    def test_full_library_and_only_confirmed_merges(self):
        result=self.result()
        original=copy.deepcopy(result)
        options=library_people(result,['p1','p2','p3','p4','p5'],['p1'])
        self.assertEqual([p['id'] for p in options],['a','b'])
        self.assertEqual(options[1]['library_photo_count'],2)
        self.assertEqual(options[1]['selected_photo_count'],0)
        self.assertEqual(options[1]['photo_ids'],[])
        self.assertIn(options[1]['portrait']['asset_id'],['p3','p4'])
        self.assertEqual(result,original)
        result['person_merges']=[{'source':'user_confirmation','id':'a','title':'已确认', 'source_person_ids':['a','b']}]
        options=library_people(result,['p1','p2','p3','p4','p5'],['p1'])
        self.assertEqual(len(options),1)
        self.assertEqual(options[0]['library_photo_count'],4)
        self.assertEqual(options[0]['source_person_ids'],['a','b'])

    def test_foreign_index_fails_instead_of_hiding_groups(self):
        with self.assertRaises(ValueError):library_people(self.result(),['p1','p2'],['p1'])

    def test_theme_priority_preserves_every_allowed_id_and_order_within_each_part(self):
        themes=[{'id':'t','photo_ids':['c','d','outside']}]
        self.assertEqual(prioritize_themes(['a','b','c','d'],themes,['t']),['c','d','a','b'])
        self.assertEqual(prioritize_themes(['a','b'],themes,['t']),['a','b'])
        self.assertEqual(prioritize_themes(['a','c','b'],themes,[]),['a','c','b'])

    def test_theme_evidence_only_from_visible_saved_albums(self):
        result=self.result()
        result['feedback']={'pets':{'hidden':True}}
        themes=theme_options(result,['p1','p2'])
        self.assertEqual(next(t for t in themes if t['id']=='topic-pets')['photo_ids'],[])
        self.assertEqual(next(t for t in themes if t['id']=='topic-food')['photo_ids'],['p2'])
        self.assertEqual(next(t for t in themes if t['id']=='topic-art')['photo_ids'],[])

    def test_six_theme_labels_match_existing_app(self):
        app=(Path(__file__).resolve().parents[1]/'photo-wall-app/App.js').read_text()
        self.assertEqual(len(THEMES),6)
        for t in THEMES:
            self.assertIn("{ id: '%s', label: '%s', detail: '%s', icon: '%s' }" %
                          (t['id'],t['label'],t['detail'],t['icon']),app)


if __name__=='__main__':unittest.main()

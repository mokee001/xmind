import copy
import json
import unittest
from unittest.mock import patch

from selection_lab.core import LabError, atomic_json
from selection_lab.display_preferences import display_view, update_preferences, load_preferences, preference_people
from selection_lab.recollection_v2 import DIRECTORY
from test_selection_lab import LabFixture, ServerTests


def sample():
    return {'id':'a'*24,'identity_revision':'identities-v1','people':[
        {'id':'alice','assigned':True,'photo_ids':['a','b','rejected']},
        {'id':'bob','assigned':True,'photo_ids':['b','c']},
        {'id':'zero','assigned':True,'photo_ids':['rejected']},
        {'id':'unknown','assigned':False,'photo_ids':['d']}],
        'albums':[{'id':'trip','photo_ids':['a','b','c']},{'id':'pet','photo_ids':['c','d']}],
        'featured_ids':['trip'],'feedback':{}}


def pref(mode='include', ids=None):
    return {'mode':mode,'person_ids':ids or [],'identity_revision':'identities-v1'}


class ProjectionTests(unittest.TestCase):
    def test_all_is_unique_union_and_person_scope_never_expands_it(self):
        result=sample();before=copy.deepcopy(result)
        self.assertEqual(display_view(result,pref('all'))['display_photo_ids'],['a','b','c','d'])
        self.assertEqual(display_view(result,pref(ids=['alice']))['display_photo_ids'],['a','b'])
        self.assertEqual(display_view(result,pref(ids=['alice','bob']))['display_photo_ids'],['a','b','c'])
        self.assertEqual(result,before)

    def test_zero_selection_zero_match_no_minimum_and_no_backfill(self):
        self.assertEqual(display_view(sample(),pref())['display_photo_ids'],[])
        self.assertEqual(display_view(sample(),pref(ids=['zero']))['display_photo_ids'],[])
        self.assertEqual(len(display_view(sample(),pref(ids=['bob']))['display_photo_ids']),2)

    def test_identity_refresh_never_silently_broadens_scope(self):
        result=sample();result['identity_revision']='changed'
        view=display_view(result,pref(ids=['alice']))
        self.assertTrue(view['display_scope']['needs_review']);self.assertEqual(view['display_photo_ids'],[])

    def test_options_only_include_first_layer_people_and_stay_stable(self):
        r=sample()
        expected=['alice','bob']
        self.assertEqual([g['id'] for g in preference_people(r)],expected)
        for scope in [pref('all'),pref(ids=['alice']),pref(),pref(ids=['zero'])]:
            view=display_view(r,scope)
            self.assertEqual([g['id'] for g in view['preference_people']],expected)
            self.assertTrue(all(g['selected_photo_count']>0 for g in view['preference_people']))

    def test_old_zero_match_choices_are_ignored_without_broadening(self):
        r=sample();p=pref(ids=['alice','zero']);before=copy.deepcopy(p)
        view=display_view(r,p)
        self.assertEqual(view['display_scope']['person_ids'],['alice'])
        self.assertEqual(view['display_photo_ids'],['a','b'])
        self.assertEqual(p,before)
        view=display_view(r,pref(ids=['zero']))
        self.assertEqual(view['display_scope']['person_ids'],[])
        self.assertEqual(view['display_photo_ids'],[])

    def test_avatar_comes_from_selected_photo_even_if_other_face_is_larger(self):
        r=sample()
        r['people'][0]['faces']=[{'face_id':'selected','asset_id':'a','box':[0,0,.1,.1]},
                                {'face_id':'outside','asset_id':'rejected','box':[0,0,1,1]}]
        self.assertEqual(preference_people(r)[0]['portrait']['asset_id'],'a')

    def test_hidden_first_layer_album_stays_hidden(self):
        result=sample();result['feedback']={'trip':{'hidden':True}}
        self.assertEqual(display_view(result,pref(ids=['alice']))['display_photo_ids'],[])
        self.assertEqual(display_view(result,pref('all'))['display_photo_ids'],['c','d'])


class ConfirmationTests(unittest.TestCase):
    def merged(self):
        r = sample()
        r['person_merges'] = [{'id': 'alice', 'source_person_ids': ['alice', 'bob'],
                               'title': '已确认人物', 'source': 'user_confirmation'}]
        return r

    def test_union_deduplicates_and_saved_aliases_still_match(self):
        r = self.merged(); before = copy.deepcopy(r)
        view = display_view(r, pref(ids=['bob', 'alice']))
        self.assertEqual(view['display_scope']['person_ids'], ['alice'])
        self.assertEqual(view['display_photo_ids'], ['a', 'b', 'c'])
        self.assertEqual(view['preference_people'][0]['selected_photo_count'], 3)
        self.assertEqual(len(view['preference_people']), 1)
        self.assertEqual(r, before)
        self.assertEqual(display_view(r, pref('all'))['display_photo_ids'], ['a','b','c','d'])

    def test_invalid_or_unconfirmed_merge_rejected(self):
        for change in [{'source':'inferred'}, {'source_person_ids':['alice','missing']},
                       {'source_person_ids':['alice','alice']}, {'id':'missing'}]:
            r=self.merged();r['person_merges'][0].update(change)
            with self.assertRaises(LabError): preference_people(r)

    def test_frequency_counts_selected_unique_photos_and_stable_ties(self):
        r=sample();r['people'][1]['photo_ids']=['b','c','d','d']
        self.assertEqual([g['id'] for g in preference_people(r)], ['bob','alice'])
        self.assertEqual(preference_people(r)[0]['selected_photo_count'], 3)
        r=sample();r['people'].reverse()
        self.assertEqual([g['id'] for g in preference_people(r)], ['alice','bob'])



class PersistenceTests(LabFixture):
    def setUp(self):
        super().setUp();self.result=sample()
        self.body={'snapshot_id':self.result['id'],'identity_revision':'identities-v1','mode':'include','person_ids':['alice']}
        self.mock=patch('selection_lab.recollection_v2.get_feed',return_value=self.result)
        self.mock.start();self.addCleanup(self.mock.stop)

    def test_confirmation_revision_guards_old_forms(self):
        self.result['person_confirmation_revision']='new-confirmation'
        with self.assertRaises(LabError): update_preferences(self.lab,self.body)
        update_preferences(self.lab,{**self.body,'person_confirmation_revision':'new-confirmation'},preview=True)

    def test_confirmation_file_is_bound_to_dataset_and_identity(self):
        from selection_lab.display_preferences import load_confirmations
        path=self.state/DIRECTORY/'person-confirmations.json'
        self.assertEqual(load_confirmations(self.lab,self.result)['person_merges'], [])
        for dataset,revision in [('other','identities-v1'),(self.lab.dataset_id,'old')]:
            atomic_json(path,{'dataset_id':dataset,'identity_revision':revision,'merges':[]})
            with self.assertRaises(LabError): load_confirmations(self.lab,self.result)

    def test_preview_read_only_then_save_reload_and_clear(self):
        before=copy.deepcopy(self.result)
        self.assertEqual(update_preferences(self.lab,self.body,preview=True)['display_photo_ids'],['a','b'])
        self.assertFalse((self.state/DIRECTORY/'display-preferences.json').exists())
        update_preferences(self.lab,self.body)
        self.assertEqual(load_preferences(self.lab)['person_ids'],['alice'])
        self.assertEqual(display_view(self.result,load_preferences(self.lab))['display_photo_ids'],['a','b'])
        update_preferences(self.lab,{**self.body,'person_ids':[]})
        self.assertEqual(display_view(self.result,load_preferences(self.lab))['display_photo_ids'],[])
        self.assertEqual(self.result,before)

    def test_invalid_ids_unassigned_snapshot_and_identity_rejected(self):
        for body in [{**self.body,'person_ids':['foreign']},{**self.body,'person_ids':['unknown']},{**self.body,'person_ids':['zero']},
                     {**self.body,'snapshot_id':'stale'},{**self.body,'identity_revision':'old'},
                     {**self.body,'person_ids':'alice'},{**self.body,'mode':'bad'}]:
            with self.assertRaises(LabError):update_preferences(self.lab,body)
        self.assertFalse((self.state/DIRECTORY/'display-preferences.json').exists())

    def test_other_dataset_preferences_not_imported(self):
        atomic_json(self.state/DIRECTORY/'display-preferences.json',{'dataset_id':'other','mode':'include','person_ids':['alice']})
        self.assertEqual(load_preferences(self.lab),{'mode':'all','person_ids':[]})


class PreferenceHttpTests(ServerTests):
    def test_preview_and_save_routes_and_tokens(self):
        import urllib.error
        result=sample()
        body={'snapshot_id':result['id'],'identity_revision':'identities-v1','mode':'include','person_ids':['bob']}
        with patch('selection_lab.recollection_v2.get_feed',return_value=result):
            with self.request('/api/display-preferences-preview',body) as r:
                self.assertEqual(json.load(r)['display_photo_ids'],['b','c'])
            self.assertFalse((self.state/DIRECTORY/'display-preferences.json').exists())
            with self.request('/api/display-preferences',body) as r:
                self.assertEqual(json.load(r)['display_photo_ids'],['b','c'])
            self.assertEqual(load_preferences(self.lab)['person_ids'],['bob'])


if __name__=='__main__':unittest.main()

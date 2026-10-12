"""Apply the candidate patch to an exact cached production source, then test it.

PHOTOWALL_LEGACY_REPROVISION_SOURCE may point to a retrieved legacy server.
The default is the ignored 2026-10-12 source snapshot. No running backend/store
is imported. Without the exact source or Python 3.10+, these tests explicitly
skip; a checkout's newer backend/server.py is never substituted as evidence.
"""
from __future__ import annotations
import ast
import copy
import hashlib
import hmac
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
import re
import secrets
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse, Response
from fastapi.testclient import TestClient
from pydantic import BaseModel

ROOT=Path(__file__).resolve().parents[1]
SOURCE=Path(os.environ.get('PHOTOWALL_LEGACY_REPROVISION_SOURCE',
    ROOT/'outputs/wifi-recheck-20261012/server-before.py'))
PATCH=ROOT/'config/patches/server-reprovision-compat-20261012.patch'
BEFORE_SHA='5ad66096ab702b185dae28334624b259d5386e7cc08437eca840faf578898846'
AFTER_SHA='2b5d631299fe0635d9e7a411069f782c64c5b9bfaba3520ce4a5a355ebf64ba7'
CHANGED={'_public_device','_queue_reprovision','device_bootstrap','device_next','device_status'}
ADDED={'DeviceReprovisionReq','device_reprovision'}
ID='pwe6-synthetic';OWNER='synthetic-owner';DEVICE='synthetic-hardware';PROOF='synthetic-physical-proof-123456789'
NOW=1000000.0

class Store:
 def __init__(self):self.data={};self.saves=[];self.by_reference=False
 def load(self,key,default=None):
  value=self.data.get(key,default)
  return value if self.by_reference else copy.deepcopy(value)
 def save(self,key,value):self.data[key]=copy.deepcopy(value);self.saves.append(key)

@unittest.skipIf(sys.version_info < (3, 10), 'Production candidate requires Python 3.10+')
class ReprovisionTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  if not SOURCE.is_file():
   raise unittest.SkipTest('Exact cached legacy source missing; set PHOTOWALL_LEGACY_REPROVISION_SOURCE')
  cls.original=SOURCE.read_bytes()
  if hashlib.sha256(cls.original).hexdigest()!=BEFORE_SHA:
   raise AssertionError('Cached legacy source SHA differs; refuse to test a guessed baseline')
  cls.temp=tempfile.TemporaryDirectory(prefix='legacy-reprovision-patch-')
  cls.addClassCleanup(cls.temp.cleanup)
  target=Path(cls.temp.name)/'backend/server.py';target.parent.mkdir();target.write_bytes(cls.original)
  for flags in (['--check'],[]):
   subprocess.run(['git','apply','--no-index',*flags,str(PATCH)],cwd=cls.temp.name,check=True,capture_output=True,text=True)
  cls.candidate=target.read_bytes()
  if hashlib.sha256(cls.candidate).hexdigest()!=AFTER_SHA:
   raise AssertionError('Applied candidate SHA differs from reviewed source')
 def setUp(self):
  self.store=Store();self.now=NOW;self.confirm=Mock()
  source=self.candidate.decode()
  names={'DeviceBootstrapReq','DeviceAutoClaimReq','DeviceStatusReq','DeviceReprovisionReq','_devices','_public_device','_device_auth','_account_auth','_queue_reprovision','device_bootstrap','device_auto_claim','device_next','device_status','device_delete','device_reprovision','device_display_history'}
  nodes=[]
  for n in ast.parse(source).body:
   if getattr(n,'name',None) in names:
    if hasattr(n,'decorator_list') and n.name not in ('device_reprovision',):n.decorator_list=[]
    nodes.append(n)
  self.assertEqual({n.name for n in nodes},names)
  self.ns={'store':self.store,'app':FastAPI(),'BaseModel':BaseModel,'Header':Header,'Response':Response,'JSONResponse':JSONResponse,'Any':object,'hashlib':hashlib,'secrets':secrets,'hmac':hmac,'time':SimpleNamespace(time=lambda:self.now),'hub':SimpleNamespace(connected=lambda _:False),'_DEVICE_ID_RE':re.compile(r'^[A-Za-z0-9_-]{4,64}$'),'_PAIRING_CODE_RE':re.compile(r'^\d{6}$'),'_infer_device_family':lambda _: 'esp32_e6','_device_family':lambda d:d.get('device_family','esp32_e6'),'_default_device_name':lambda _:'synthetic','DEVICE_FAMILY_WALNUTPI_19IN':'walnutpi_19in','_remember_account':lambda _:None,'_known_account':lambda _,t:t==OWNER,'eink_push':SimpleNamespace(FRAME_HEADER=SimpleNamespace(size=16),WIDTH=4,HEIGHT=4),'display_history':SimpleNamespace(confirm=self.confirm,records_for=lambda d:[{'revision':d['displayed_revision'],'title':'synthetic-record'}])}
  exec(compile(ast.fix_missing_locations(ast.Module(body=[ast.ImportFrom(module='__future__',names=[ast.alias(name='annotations')],level=0),*nodes],type_ignores=[])),'<isolated legacy reprovision candidate>','exec'),self.ns)
  self.initial={'device_id':ID,'device_family':'esp32_e6','device_token':DEVICE,'account_token':OWNER,'claimed':True,'created_at':123.0,'name':'synthetic','revision':'wall-old','displayed_revision':'wall-old','frame_path':'not-a-real-photo','preview_url':'/synthetic','published_at':100.0,'state':'displayed','last_seen':NOW,'progress':100,'error':''}
  self.store.data['eink_devices']={ID:copy.deepcopy(self.initial)}
  self.client=TestClient(self.ns['app'])
 def device(self):return self.store.data['eink_devices'][ID]
 def body(self,r):return json.loads(r.body)
 def reprovision(self,token=OWNER,proof='',device_id=ID):
  return self.ns['device_reprovision'](device_id,self.ns['DeviceReprovisionReq'](setup_token=proof),token)
 def bootstrap(self,token=DEVICE,proof=PROOF,device_id=ID):
  req=self.ns['DeviceBootstrapReq'](device_id=device_id,pairing_code='123456',device_token=token,setup_token=proof,ip='192.0.2.1',firmware_version='synthetic')
  return self.ns['device_bootstrap'](req)
 def next(self,token=DEVICE):return self.ns['device_next'](ID,revision='wall-old',token=token)
 def status(self,state,token=DEVICE,revision='wall-old',error=''):
  return self.ns['device_status'](ID,self.ns['DeviceStatusReq'](state=state,revision=revision,progress=100,error=error),token)
 def assert_binding_wall_preserved(self):
  for k in ('account_token','claimed','created_at','revision','displayed_revision','frame_path','preview_url','published_at'):
   self.assertEqual(self.device()[k],self.initial[k],k)
  self.confirm.assert_not_called()
 def test_owner_route_registered_and_accepts_empty_body(self):
  r=self.client.post(f'/api/devices/{ID}/reprovision',headers={'X-Account-Token':OWNER})
  self.assertEqual(r.status_code,202);self.assert_binding_wall_preserved()
 def test_owner_exact_contract_and_poll(self):
  r=self.reprovision(proof=PROOF)
  self.assertEqual(r.status_code,202);self.assertTrue(self.body(r)['reprovision_required'])
  self.assertEqual(self.body(self.next()),{'command':'reprovision','preserve_binding':True})
  self.assert_binding_wall_preserved()
 def test_repeated_owner_requests_still_preserve_binding(self):
  self.reprovision(proof=PROOF);self.now+=4
  self.assertEqual(self.reprovision(proof=PROOF).status_code,202)
  self.assertEqual(self.body(self.next())['preserve_binding'],True);self.assert_binding_wall_preserved()
  before=copy.deepcopy(self.store.data)
  self.assertEqual(self.reprovision(token='other-owner',proof=PROOF).status_code,401);self.assertEqual(self.store.data,before)
 def test_http_empty_json_and_unauthorized_requests(self):
  before=copy.deepcopy(self.store.data)
  self.assertEqual(self.client.post(f'/api/devices/{ID}/reprovision',json={}).status_code,401)
  self.assertEqual(self.store.data,before)
  self.assertEqual(self.client.post(f'/api/devices/{ID}/reprovision',json={},headers={'X-Account-Token':OWNER}).status_code,202)
  self.assert_binding_wall_preserved()
 def test_anonymous_wrong_account_and_hardware_token_rejected_no_mutation(self):
  for token in ('','other-owner',DEVICE):
   with self.subTest(token=token):
    before=copy.deepcopy(self.store.data);self.store.by_reference=True
    self.assertEqual(self.reprovision(token=token,proof=PROOF).status_code,401)
    self.assertEqual(self.store.data,before);self.assertEqual(self.store.saves,[])
 def test_unbound_device_rejected_even_stale_owner_field(self):
  self.device()['claimed']=False;before=copy.deepcopy(self.store.data)
  self.assertEqual(self.reprovision().status_code,401);self.assertEqual(self.store.data,before)
 def test_unknown_device_rejected(self):self.assertEqual(self.reprovision(device_id='pwe6-other').status_code,401)
 def test_invalid_proof_no_mutation_even_reference_store(self):
  self.store.by_reference=True
  for proof in ('short','x'*257):
   before=copy.deepcopy(self.store.data)
   self.assertEqual(self.reprovision(proof=proof).status_code,400);self.assertEqual(self.store.data,before)
  self.assertEqual(self.store.saves,[])
 def test_19inch_rejected_unchanged(self):
  self.device()['device_family']='walnutpi_19in';before=copy.deepcopy(self.store.data)
  self.assertEqual(self.reprovision().status_code,400);self.assertEqual(self.store.data,before)
 def test_public_response_hides_new_proof_and_credentials(self):
  public=self.body(self.reprovision(proof=PROOF))['device']
  for k in ('account_token','device_token','reprovision_setup_token_digest','reprovision_setup_token_expires_at'):
   self.assertNotIn(k,public)
  self.assertNotIn(PROOF,json.dumps(public))
 def test_reprovision_ack_retains_binding_and_wall(self):
  self.reprovision(proof=PROOF);self.assertEqual(self.status('reprovisioning').status_code,200)
  self.assertNotIn('pending_command',self.device());self.assertNotIn('reprovision_setup_token_digest',self.device())
  self.assertEqual(self.next().status_code,204);self.assertEqual(self.bootstrap().status_code,200);self.assert_binding_wall_preserved()
 def test_unbound_ack_cannot_delete_retained_device(self):
  self.reprovision();before=copy.deepcopy(self.store.data)
  self.assertEqual(self.status('unbound').status_code,409);self.assertEqual(self.store.data,before)
 def test_reprovision_ack_requires_pending_preserved_command(self):
  self.assertEqual(self.status('reprovisioning').status_code,409)
  self.ns['_queue_reprovision'](self.device())
  before=copy.deepcopy(self.store.data)
  self.assertEqual(self.status('reprovisioning').status_code,409);self.assertEqual(self.store.data,before)
 def test_device_auth_required_for_ack_and_poll(self):
  self.reprovision();before=copy.deepcopy(self.store.data)
  self.assertEqual(self.status('reprovisioning',token='bad').status_code,401)
  self.assertEqual(self.next(token=OWNER).status_code,401);self.assertEqual(self.store.data,before)
 def test_lost_ack_bootstrap_retained_credential_finishes_command(self):
  self.reprovision(proof=PROOF);self.assertEqual(self.bootstrap().status_code,200)
  self.assertNotIn('pending_command',self.device());self.assertEqual(self.next().status_code,204);self.assert_binding_wall_preserved()
 def test_normal_bootstrap_old_setup_proof_does_not_consume_reprovision(self):
  self.reprovision();self.assertEqual(self.bootstrap(proof=PROOF).status_code,200)
  self.assertIn('pending_command',self.device());self.assertTrue(self.body(self.next())['preserve_binding']);self.assert_binding_wall_preserved()
 def test_valid_device_but_wrong_setup_proof_does_not_consume_reprovision(self):
  self.reprovision(proof=PROOF);self.bootstrap(proof='synthetic-old-proof-from-before12345')
  self.assertIn('pending_command',self.device());self.assert_binding_wall_preserved()
 def test_valid_device_but_expired_setup_proof_does_not_consume_reprovision(self):
  self.reprovision(proof=PROOF);self.now+=601;self.bootstrap()
  self.assertIn('pending_command',self.device());self.assert_binding_wall_preserved()
 def test_empty_bootstrap_proof_does_not_consume_reprovision(self):
  self.reprovision();self.assertEqual(self.bootstrap(proof='').status_code,200)
  self.assertIn('pending_command',self.device())
 def test_owner_authorized_physical_reset_rotates_only_device_token(self):
  self.reprovision(proof=PROOF);r=self.bootstrap(token='')
  self.assertEqual(r.status_code,200);self.assertNotEqual(self.device()['device_token'],DEVICE)
  self.assertNotIn('pending_command',self.device());self.assert_binding_wall_preserved()
  self.assertEqual(self.next().status_code,401)
 def test_wrong_setup_token_rejected_without_mutation(self):
  self.reprovision(proof=PROOF);self.store.by_reference=True;before=copy.deepcopy(self.store.data)
  self.assertEqual(self.bootstrap(token='',proof='different-physical-proof-123456789').status_code,401)
  self.assertEqual(self.store.data,before)
 def test_expired_setup_token_rejected_without_mutation(self):
  self.reprovision(proof=PROOF);self.now+=601;before=copy.deepcopy(self.store.data)
  self.assertEqual(self.bootstrap(token='').status_code,401);self.assertEqual(self.store.data,before)
 def test_incorrect_nonempty_device_token_cannot_use_proof(self):
  self.reprovision(proof=PROOF);before=copy.deepcopy(self.store.data)
  self.assertEqual(self.bootstrap(token='incorrect-device-token').status_code,401);self.assertEqual(self.store.data,before)
 def test_cross_device_proof_cannot_reset_other_bound_device(self):
  other='pwe6-other';self.store.data['eink_devices'][other]={**copy.deepcopy(self.initial),'device_id':other,'account_token':'other-owner'}
  self.reprovision(proof=PROOF);before=copy.deepcopy(self.store.data)
  self.assertEqual(self.bootstrap(token='',device_id=other).status_code,401);self.assertEqual(self.store.data,before)
 def test_replayed_setup_proof_after_rotation_rejected(self):
  self.reprovision(proof=PROOF);self.assertEqual(self.bootstrap(token='').status_code,200);before=copy.deepcopy(self.store.data)
  self.assertEqual(self.bootstrap(token='').status_code,401);self.assertEqual(self.store.data,before)
 def test_polling_does_not_extend_setup_proof(self):
  self.reprovision(proof=PROOF);expiry=self.device()['reprovision_setup_token_expires_at']
  self.now+=599;self.next();self.assertEqual(self.device()['reprovision_setup_token_expires_at'],expiry)
 def test_unrelated_pending_command_not_consumed_on_bootstrap(self):
  self.device()['pending_command']={'type':'other','preserve_binding':True}
  self.bootstrap();self.assertEqual(self.device()['pending_command']['type'],'other')
 def test_delete_still_revokes_binding_and_returns_false(self):
  self.reprovision(proof=PROOF)
  self.assertEqual(self.ns['device_delete'](ID,OWNER).status_code,202)
  self.assertFalse(self.device()['claimed']);self.assertEqual(self.device()['account_token'],'')
  self.assertEqual(self.body(self.next()),{'command':'reprovision','preserve_binding':False})
  self.assertNotIn('reprovision_setup_token_digest',self.device())
  self.assertEqual(self.status('unbound').status_code,200);self.assertNotIn(ID,self.store.data['eink_devices'])
 def test_old_delete_bootstrap_claim_recovery_and_hold_preserved(self):
  self.ns['device_delete'](ID,OWNER)
  self.assertEqual(self.bootstrap().status_code,200);self.assertEqual(self.next().status_code,204)
  expiry=self.device()['setup_token_expires_at'];self.now+=3;self.next();self.assertEqual(self.device()['setup_token_expires_at'],expiry)
  req=self.ns['DeviceAutoClaimReq'](device_id=ID,setup_token=PROOF,name='new synthetic')
  self.assertEqual(self.ns['device_auto_claim'](req,OWNER).status_code,200)
  self.assertNotIn('pending_command',self.device());self.assertEqual(self.device()['revision'],'');self.assertEqual(self.device()['displayed_revision'],'')
 def test_expired_old_delete_hold_still_exposes_unbind_command(self):
  self.ns['device_delete'](ID,OWNER);self.bootstrap();self.now+=601
  self.assertEqual(self.body(self.next()),{'command':'reprovision','preserve_binding':False})
 def test_history_auth_and_confirm_hooks_preserved(self):
  self.reprovision()
  self.assertEqual(self.ns['device_display_history'](ID,OWNER).status_code,200)
  self.assertEqual(self.ns['device_display_history'](ID,'bad').status_code,401)
  self.status('displayed',revision='different');self.confirm.assert_not_called()
  self.status('displayed');self.confirm.assert_called_once()
 def test_route_pydantic_invalid_type_no_mutation(self):
  before=copy.deepcopy(self.store.data)
  r=self.client.post(f'/api/devices/{ID}/reprovision',headers={'X-Account-Token':OWNER},json={'setup_token':{}})
  self.assertEqual(r.status_code,422);self.assertEqual(self.store.data,before)
 def test_ast_preserves_claim_history_publish_and_every_unlisted_node(self):
  before=ast.parse(self.original.decode());after=ast.parse(self.candidate.decode())
  old={n.name:ast.dump(n,include_attributes=False) for n in before.body if hasattr(n,'name')}
  new={n.name:ast.dump(n,include_attributes=False) for n in after.body if hasattr(n,'name')}
  self.assertEqual(set(new)-set(old),ADDED)
  self.assertEqual({name for name in old if old[name]!=new[name]},CHANGED)
  self.assertEqual([ast.dump(n,include_attributes=False) for n in before.body if not hasattr(n,'name')],
                   [ast.dump(n,include_attributes=False) for n in after.body if not hasattr(n,'name')])

if __name__=='__main__':unittest.main(verbosity=2)

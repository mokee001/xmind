"""Synthetic legacy-route and transaction regressions; no production imports."""
from __future__ import annotations
import ast
import copy
import atexit
import subprocess
import hashlib
import importlib.util
import inspect
import json
import multiprocessing
import os
from pathlib import Path
import sys
import tempfile
import textwrap
import threading
import time
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
STAGING = tempfile.TemporaryDirectory(prefix="synthetic-legacy-device-recovery-")
atexit.register(STAGING.cleanup)
HERE = Path(STAGING.name)
(HERE/"backend").mkdir()
SOURCE = Path(os.environ.get("PHOTOWALL_LEGACY_REPROVISION_SOURCE", str(ROOT/"outputs/wifi-recheck-20261012/server-before.py")))
EXPECTED_SERVER = "3b6b9b6147d3cb3ca7df4509d2aabccd49cbbcfd91d11a75fa6d8a7b4a64659d"
EXPECTED_HELPER = "fc0d863129236019fe641f4a4265d39f0fb752bea0499339b247606606ff470f"
CHANGED = {"_public_device", "_queue_reprovision", "device_auto_claim", "device_bootstrap", "device_claim", "device_delete", "device_next", "device_publish", "device_publish_july_calendar", "device_publish_last_wall", "device_status"}
ASYNC_WRITERS = {"device_publish", "device_publish_july_calendar", "device_publish_last_wall"}


def prepare():
    if (HERE/"backend/server.py").exists():
        return
    if not SOURCE.exists():
        raise unittest.SkipTest("Exact legacy source is missing; set PHOTOWALL_LEGACY_REPROVISION_SOURCE")
    assert hashlib.sha256(SOURCE.read_bytes()).hexdigest() == "5ad66096ab702b185dae28334624b259d5386e7cc08437eca840faf578898846"
    (HERE/"backend/server.py").write_bytes(SOURCE.read_bytes())
    subprocess.run(["git", "apply", "--no-index", str(ROOT/"config/patches/server-device-recovery-20261013.patch")],
                   cwd=HERE, check=True, capture_output=True)
    assert hashlib.sha256((HERE/"backend/server.py").read_bytes()).hexdigest() == EXPECTED_SERVER
    assert hashlib.sha256((HERE/"backend/device_recovery.py").read_bytes()).hexdigest() == EXPECTED_HELPER
    assert (HERE/"backend/device_recovery.py").read_bytes() == (ROOT/"backend/device_recovery.py").read_bytes()

spec = importlib.util.spec_from_file_location("legacy_recovery_tests", ROOT/"tests/test_legacy_reprovision_patch.py")
legacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(legacy)
ID, OWNER, DEVICE, PROOF = legacy.ID, legacy.OWNER, legacy.DEVICE, legacy.PROOF
REQUEST = "synthetic-delete-request-0001"


def load_helper(store):
    prepare()
    package = ModuleType("isolated_device_backend")
    package.__path__ = [str(HERE/"backend")]
    package.store = store
    old = sys.modules.get(package.__name__)
    sys.modules[package.__name__] = package
    try:
        spec = importlib.util.spec_from_file_location(package.__name__+".device_recovery", HERE/"backend/device_recovery.py")
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        return helper
    finally:
        if old is None:
            sys.modules.pop(package.__name__, None)
        else:
            sys.modules[package.__name__] = old


def helper_proxy(store):
    helper = load_helper(store)
    helper.serialized = lambda function: function
    helper.save_devices = lambda data: store.save("eink_devices", data)
    return helper


# Reuse all previous 33 route/auth/proof regressions against the new candidate,
# including FastAPI validation. Only receipt tombstone expectations change.
setup_source = textwrap.dedent(inspect.getsource(legacy.ReprovisionTests.setUp))
setup_source = setup_source.replace("'store':self.store,'app':", "'re':re,'device_recovery':helper_proxy(self.store),'store':self.store,'app':")
setup_source = setup_source.replace("if hasattr(n,'decorator_list') and n.name not in ('device_reprovision',):n.decorator_list=[]",
                                    "if hasattr(n,'decorator_list') and n.name not in ('device_reprovision',):n.decorator_list=[]\n   elif hasattr(n,'decorator_list'):n.decorator_list=[d for d in n.decorator_list if not isinstance(d,ast.Attribute)]")
setup_source = setup_source.replace("names={'DeviceBootstrapReq'", "names={'DeviceClaimReq','device_claim','DeviceBootstrapReq'")
setup_ns = dict(vars(legacy), helper_proxy=helper_proxy)
exec(setup_source, setup_ns)


class RecoveryTests(legacy.ReprovisionTests):
    @classmethod
    def setUpClass(cls):
        prepare()
        cls.original = SOURCE.read_bytes()
        assert hashlib.sha256(cls.original).hexdigest() == legacy.BEFORE_SHA
        cls.candidate = (HERE/"backend/server.py").read_bytes()
        assert hashlib.sha256(cls.candidate).hexdigest() == EXPECTED_SERVER

    def setUp(self):
        setup_ns["setUp"](self)
        self.helper = self.ns["device_recovery"]
        self.raw_reprovision = self.ns["device_reprovision"]
        self.recovery_sequence = 0
        # Use a fixed synthetic clock for receipt TTL checks.
        self.helper.time = SimpleNamespace(time=lambda: self.now)
        raw_delete = self.ns["device_delete"]
        self.raw_delete = raw_delete
        self.ns["app"].delete("/api/devices/{device_id}")(raw_delete)
        self.ns["device_delete"] = lambda device_id, token: raw_delete(device_id, token, "", "")
        self.ns["app"].post("/api/devices/bootstrap")(self.ns["device_bootstrap"])
        self.ns["app"].post("/api/devices/auto-claim")(self.ns["device_auto_claim"])
        self.ns["app"].post("/api/devices/claim")(self.ns["device_claim"])

    def reprovision(self, token=OWNER, proof="", device_id=ID):
        self.recovery_sequence += 1
        req=self.ns["DeviceReprovisionReq"](setup_token=proof,
            operation_id="synthetic-operation-"+str(self.recovery_sequence),
            expected_generation=self.helper.recovery_generation(self.device()),
            phase="authorize" if proof else "enter_setup")
        return self.raw_reprovision(device_id,req,token,self.helper.binding_id(self.device()))

    def operation(self, operation_id="synthetic-operation-alpha", generation=None,
                  phase="enter_setup", proof="", binding=None, token=OWNER):
        return self.client.post("/api/devices/"+ID+"/reprovision",json={
            "operation_id":operation_id,"expected_generation":generation or self.helper.recovery_generation(self.device()),
            "phase":phase,"setup_token":proof},headers={"X-Account-Token":token,
            "X-Device-Binding":binding or self.helper.binding_id(self.device())})

    def delete(self, token=OWNER, binding=None, request_id=REQUEST, device_id=ID):
        if binding is None:
            binding = self.helper.binding_id(self.device())
        headers = {"X-Account-Token":token, "X-Device-Binding":binding, "X-Delete-Request-Id":request_id}
        return self.client.delete("/api/devices/"+device_id, headers=headers)

    def test_delete_still_revokes_binding_and_returns_false(self):
        self.reprovision(proof=PROOF)
        self.assertEqual(self.ns["device_delete"](ID, OWNER).status_code, 202)
        self.assertFalse(self.device()["claimed"])
        self.assertEqual(self.body(self.next()), {"command":"reprovision", "preserve_binding":False})
        self.assertEqual(self.status("unbound").status_code, 200)
        self.assertTrue(self.device()["_delete_tombstone"])
        self.assertEqual(self.device()["device_token"], "")
        self.assertEqual(self.device()["account_token"], "")

    def test_ast_preserves_claim_history_publish_and_every_unlisted_node(self):
        before = ast.parse(self.original.decode())
        after = ast.parse(self.candidate.decode())
        old = {n.name:ast.dump(n,include_attributes=False) for n in before.body if hasattr(n,"name")}
        new = {n.name:ast.dump(n,include_attributes=False) for n in after.body if hasattr(n,"name")}
        self.assertEqual({k for k in old if old[k] != new[k]}, CHANGED)
        self.assertEqual(set(new)-set(old), {"DeviceReprovisionReq","device_reprovision"})
        self.assertEqual(old["device_display_history"], new["device_display_history"])
        self.assertEqual(old["_queue_device_image"], new["_queue_device_image"])
        self.assertNotIn('store.save("eink_devices"', self.candidate.decode())
        for name in ASYNC_WRITERS:
            node = next(n for n in after.body if getattr(n,"name",None)==name)
            self.assertTrue(isinstance(node,ast.AsyncFunctionDef))
            self.assertFalse(any(isinstance(d,ast.Attribute) for d in node.decorator_list))

    def test_delete_exact_binding_and_request_receipt(self):
        binding = self.helper.binding_id(self.device())
        response = self.delete(binding=binding)
        self.assertEqual(response.status_code,202)
        self.assertEqual(response.json(),{"device_id":ID,"removed":True,"deleted":True,
            "binding_id":binding,"request_id":REQUEST,"reprovision_required":True,"already_removed":False})
        self.assertFalse(self.device()["claimed"])
        self.assertEqual(self.device()["account_token"],"")
        self.assertEqual(self.device()["revision"],"wall-old")

    def test_lost_delete_response_retry_replays_without_write(self):
        binding = self.helper.binding_id(self.device())
        self.delete(binding=binding)
        before = copy.deepcopy(self.store.data)
        saves = len(self.store.saves)
        response = self.delete(binding=binding)
        self.assertEqual(response.status_code,202)
        self.assertTrue(response.json()["already_removed"])
        self.assertEqual(self.store.data,before)
        self.assertEqual(len(self.store.saves),saves)

    def test_legacy_build37_first_delete_and_retry_supported(self):
        first = self.client.delete("/api/devices/"+ID,headers={"X-Account-Token":OWNER})
        self.assertEqual(first.status_code,202)
        self.assertEqual(first.json()["request_id"],"")
        self.status("unbound")
        second = self.client.delete("/api/devices/"+ID,headers={"X-Account-Token":OWNER})
        self.assertEqual(second.status_code,202)
        self.assertTrue(second.json()["already_removed"])

    def test_wrong_receipt_token_or_device_cannot_replay(self):
        binding = self.helper.binding_id(self.device())
        self.delete(binding=binding); self.status("unbound")
        before = copy.deepcopy(self.store.data)
        for kwargs in ({"token":"other"}, {"device_id":"pwe6-other"}, {"request_id":"synthetic-another-request"}):
            self.assertEqual(self.delete(binding=binding,**kwargs).status_code,401)
        self.assertEqual(self.store.data,before)

    def test_receipt_survives_ack_fresh_bootstrap_and_same_owner_rebind(self):
        old_binding = self.helper.binding_id(self.device())
        self.delete(binding=old_binding); self.status("unbound")
        boot = self.bootstrap(token="")
        self.assertEqual(boot.status_code,200)
        req=self.ns["DeviceAutoClaimReq"](device_id=ID,setup_token=PROOF,name="synthetic")
        self.assertEqual(self.ns["device_auto_claim"](req,OWNER).status_code,200)
        new_binding=self.device()["binding_id"]
        self.assertNotEqual(new_binding,old_binding)
        before=copy.deepcopy(self.store.data)
        replay=self.delete(binding=old_binding)
        self.assertEqual(replay.status_code,202);self.assertTrue(replay.json()["already_removed"])
        self.assertEqual(self.store.data,before)
        self.assertTrue(self.device()["claimed"])
        self.assertEqual(self.delete(binding=old_binding,request_id="synthetic-late-never-applied").status_code,409)
        self.assertEqual(self.store.data,before)
        self.assertEqual(self.client.delete("/api/devices/"+ID,headers={"X-Account-Token":OWNER}).status_code,409)
        self.assertEqual(self.delete(binding=new_binding,request_id="synthetic-new-binding-delete").status_code,202)

    def test_old_receipt_owner_cannot_delete_another_owner_binding(self):
        old_binding=self.helper.binding_id(self.device())
        self.delete(binding=old_binding);self.status("unbound");self.bootstrap(token="")
        self.device().update(account_token="new-owner",claimed=True)
        self.helper.start_binding(self.device())
        before=copy.deepcopy(self.store.data)
        self.assertEqual(self.delete(binding=old_binding).status_code,202)
        self.assertEqual(self.store.data,before)
        self.assertEqual(self.delete(binding=self.device()["binding_id"],request_id="synthetic-other-binding").status_code,401)
        self.assertEqual(self.store.data,before)

    def test_delete_invalid_identity_and_expired_receipt_do_not_mutate(self):
        before=copy.deepcopy(self.store.data)
        for binding,request in (("short",REQUEST),(self.helper.binding_id(self.device()),""),("",REQUEST)):
            self.assertEqual(self.delete(binding=binding,request_id=request).status_code,400)
            self.assertEqual(self.store.data,before)
        binding=self.helper.binding_id(self.device())
        self.delete(binding=binding);self.now+=8*24*3600
        before=copy.deepcopy(self.store.data)
        self.assertEqual(self.delete(binding=binding).status_code,401)
        self.assertEqual(self.store.data,before)

    def test_public_device_never_exposes_delete_receipts(self):
        self.delete()
        public=self.ns["_public_device"](self.device())
        for name in ("_delete_receipts","_delete_tombstone","account_token","device_token",
                     "setup_token_digest","reprovision_setup_token_digest","_bootstrap_receipt","_recovery_operation"):
            self.assertNotIn(name,public)
        self.assertNotIn(self.helper.account_proof(OWNER),json.dumps(public))

    def test_claimed_legacy_valid_proof_owner_change_gets_new_binding(self):
        self.device()["setup_token_digest"] = hashlib.sha256(PROOF.encode()).hexdigest()
        self.device()["setup_token_expires_at"] = self.now + 500
        self.device()["binding_id"] = "synthetic-current-binding"
        before = self.helper.publication_identity(self.device())
        old_created_at = self.device()["created_at"]
        self.ns["_known_account"] = lambda _,token: token in (OWNER,"other-known-owner")
        req=self.ns["DeviceAutoClaimReq"](device_id=ID,setup_token=PROOF,name="synthetic")
        self.assertEqual(self.ns["device_auto_claim"](req,"other-known-owner").status_code,200)
        self.assertNotEqual(self.device()["binding_id"],"synthetic-current-binding")
        self.assertNotEqual(self.device()["created_at"],old_created_at)
        self.assertNotEqual(self.helper.publication_identity(self.device()),before)

    def test_replayed_setup_proof_after_rotation_rejected(self):
        # Supersedes the old single-use proof limitation with bounded replay.
        self.reprovision(proof=PROOF)
        first=self.bootstrap(token="")
        self.assertEqual(first.status_code,200)
        before=copy.deepcopy(self.store.data); saves=len(self.store.saves)
        self.now+=30
        second=self.bootstrap(token="")
        self.assertEqual(second.status_code,200)
        self.assertEqual(self.body(first),self.body(second))
        self.assertEqual(self.store.data,before)
        self.assertEqual(len(self.store.saves),saves)
        self.now+=31
        self.assertEqual(self.bootstrap(token="").status_code,401)
        self.assertEqual(self.store.data,before)

    def test_bootstrap_replay_rejects_changed_identity_wrong_token_and_proof(self):
        self.reprovision(proof=PROOF);self.bootstrap(token="")
        original=copy.deepcopy(self.store.data)
        for changes in ({"binding_id":"different-binding"},{"account_token":"different-owner"},
                        {"device_token":"different-hardware"},{"device_id":"different-device"},
                        {"pending_command":{"type":"reprovision","preserve_binding":True}}):
            self.store.data=copy.deepcopy(original);self.device().update(changes)
            before=copy.deepcopy(self.store.data)
            self.assertEqual(self.bootstrap(token="").status_code,401)
            self.assertEqual(self.store.data,before)
        for token,proof in (("wrong-nonempty",PROOF),("","different-proof-long-enough-1234")):
            self.store.data=copy.deepcopy(original);before=copy.deepcopy(self.store.data)
            self.assertEqual(self.bootstrap(token=token,proof=proof).status_code,401)
            self.assertEqual(self.store.data,before)

    def test_fresh_bootstrap_lost_response_recovers_same_token_until_claim(self):
        self.store.data["eink_devices"]={}
        first=self.bootstrap(token="")
        before=copy.deepcopy(self.store.data)
        self.assertEqual(self.bootstrap(token="").body,first.body)
        self.assertEqual(self.store.data,before)
        self.assertNotIn("_bootstrap_receipt",self.ns["_public_device"](self.device()))
        req=self.ns["DeviceAutoClaimReq"](device_id=ID,setup_token=PROOF,name="synthetic")
        self.assertEqual(self.ns["device_auto_claim"](req,OWNER).status_code,200)
        before=copy.deepcopy(self.store.data)
        self.assertEqual(self.bootstrap(token="").status_code,401)
        self.assertEqual(self.store.data,before)

    def test_manual_claim_during_delete_pending_rejected_and_late_ack_safe(self):
        self.device()["pairing_code"]="123456"
        self.delete()
        before=copy.deepcopy(self.store.data)
        response=self.client.post("/api/devices/claim",json={"pairing_code":"123456"})
        self.assertEqual(response.status_code,409)
        self.assertEqual(response.json()["code"],"device_recovery_pending")
        self.assertEqual(self.store.data,before)
        self.assertEqual(self.status("unbound").status_code,200)
        self.bootstrap(token="")
        response=self.client.post("/api/devices/claim",json={"pairing_code":"123456"})
        self.assertEqual(response.status_code,200)
        before=copy.deepcopy(self.store.data)
        self.assertEqual(self.status("unbound").status_code,401)
        self.assertEqual(self.store.data,before)

    def test_delete_lost_ack_bootstrap_autoclaim_replay_then_late_ack_safe(self):
        old_binding=self.helper.binding_id(self.device())
        self.delete(binding=old_binding)
        self.assertEqual(self.bootstrap().status_code,200)
        self.assertEqual(self.next().status_code,204)
        req=self.ns["DeviceAutoClaimReq"](device_id=ID,setup_token=PROOF,name="synthetic")
        self.assertEqual(self.ns["device_auto_claim"](req,OWNER).status_code,200)
        self.assertNotEqual(self.device()["binding_id"],old_binding)
        before=copy.deepcopy(self.store.data)
        self.assertEqual(self.delete(binding=old_binding).status_code,202)
        self.assertEqual(self.status("unbound").status_code,409)
        self.assertEqual(self.store.data,before)

    def test_new_reprovision_invalidates_prior_bootstrap_replay_even_after_ack(self):
        self.reprovision(proof=PROOF)
        first=self.bootstrap(token="")
        token=self.body(first)["device_token"]
        self.reprovision()
        self.assertEqual(self.status("reprovisioning",token=token).status_code,200)
        before=copy.deepcopy(self.store.data)
        self.assertEqual(self.bootstrap(token="").status_code,401)
        self.assertEqual(self.store.data,before)

    def test_reprovision_ack_retains_binding_and_wall(self):
        # The old firmware ACK has no generation: it no longer clears v2 proof.
        self.reprovision(proof=PROOF)
        before=copy.deepcopy(self.device())
        self.assertEqual(self.status("reprovisioning").status_code,200)
        for key in ("pending_command","reprovision_setup_token_digest","reprovision_setup_token_expires_at",
                    "_recovery_operation","recovery_generation","state","progress","error"):
            self.assertEqual(self.device()[key],before[key])
        self.assertEqual(self.bootstrap().status_code,200)
        self.assertNotIn("pending_command",self.device())
        self.assertEqual(self.device()["_recovery_operation"]["stage"],"completed")
        self.assert_binding_wall_preserved()

    def test_generation_projection_is_stable_readonly_and_private_operation_hidden(self):
        before=copy.deepcopy(self.store.data)
        first=self.ns["_public_device"](self.device())
        second=self.ns["_public_device"](self.device())
        self.assertEqual(first["recovery_generation"],second["recovery_generation"])
        self.assertEqual(self.store.data,before)
        self.operation(phase="authorize",proof=PROOF)
        public=self.ns["_public_device"](self.device())
        self.assertNotIn("_recovery_operation",public)
        self.assertNotIn(hashlib.sha256(PROOF.encode()).hexdigest(),json.dumps(public))

    def test_begin_duplicate_replays_exact_operation_without_mutation_or_rotation(self):
        generation=self.helper.recovery_generation(self.device())
        first=self.operation(generation=generation)
        self.assertEqual(first.status_code,202)
        op=first.json()["operation"]
        self.assertEqual(op["stage"],"entered")
        self.assertEqual(op["from_generation"],generation)
        self.assertNotEqual(op["generation"],generation)
        before=copy.deepcopy(self.store.data);saves=len(self.store.saves)
        duplicate=self.operation(generation=generation)
        self.assertEqual(duplicate.json(),first.json())
        self.assertEqual(self.store.data,before);self.assertEqual(len(self.store.saves),saves)

    def test_fresh_proof_first_late_begin_cannot_erase_authorization(self):
        generation=self.helper.recovery_generation(self.device())
        proof=self.operation(generation=generation,phase="authorize",proof=PROOF)
        self.assertEqual(proof.status_code,202)
        before=copy.deepcopy(self.store.data);saves=len(self.store.saves)
        late=self.operation(generation=generation)
        self.assertEqual(late.status_code,202)
        self.assertEqual(late.json()["operation"],proof.json()["operation"])
        self.assertEqual(self.store.data,before);self.assertEqual(len(self.store.saves),saves)

    def test_begin_then_proof_same_operation_is_monotonic_and_retry_does_not_extend(self):
        generation=self.helper.recovery_generation(self.device())
        entered=self.operation(generation=generation)
        proof=self.operation(generation=generation,phase="authorize",proof=PROOF)
        self.assertEqual(proof.status_code,202)
        self.assertEqual(proof.json()["operation"]["generation"],entered.json()["operation"]["generation"])
        before=copy.deepcopy(self.store.data);self.now+=5
        retry=self.operation(generation=generation,phase="authorize",proof=PROOF)
        self.assertEqual(retry.status_code,202)
        self.assertEqual(self.store.data,before)
        self.assertEqual(self.operation(generation=generation,phase="authorize",proof="different-valid-physical-proof-1234").status_code,409)
        self.assertEqual(self.store.data,before)

    def test_new_operation_fences_old_begin_and_proof_with_no_aba_after_completion(self):
        old=self.helper.recovery_generation(self.device())
        self.operation(generation=old)
        next_generation=self.helper.recovery_generation(self.device())
        newer=self.operation(operation_id="synthetic-operation-bravo",generation=next_generation,phase="authorize",proof=PROOF)
        self.assertEqual(newer.status_code,202)
        self.bootstrap()
        completed_generation=self.helper.recovery_generation(self.device())
        self.assertNotIn(completed_generation,(old,next_generation))
        before=copy.deepcopy(self.store.data)
        for phase,proof in (("enter_setup",""),("authorize",PROOF)):
            denied=self.operation(generation=old,phase=phase,proof=proof)
            self.assertEqual(denied.status_code,409)
            self.assertEqual(denied.json()["code"],"recovery_generation_changed")
            self.assertEqual(self.store.data,before)
        replay=self.operation(operation_id="synthetic-operation-bravo",generation=next_generation)
        self.assertEqual(replay.status_code,202);self.assertEqual(replay.json()["operation"]["stage"],"completed")
        self.assertEqual(self.store.data,before)

    def test_unknown_old_request_cannot_replace_a_newer_operation(self):
        old=self.helper.recovery_generation(self.device())
        self.operation(operation_id="synthetic-operation-bravo",generation=old,phase="authorize",proof=PROOF)
        before=copy.deepcopy(self.store.data)
        self.assertEqual(self.operation(generation=old).status_code,409)
        self.assertEqual(self.store.data,before)

    def test_completed_replay_and_late_ack_do_not_regress_wall_state(self):
        old=self.helper.recovery_generation(self.device())
        self.operation(generation=old,phase="authorize",proof=PROOF);self.bootstrap()
        self.device().update(state="displayed",progress=100,error="")
        before=copy.deepcopy(self.store.data)
        replay=self.operation(generation=old,phase="authorize",proof=PROOF)
        self.assertEqual(replay.status_code,202);self.assertEqual(replay.json()["operation"]["stage"],"completed")
        self.assertEqual(self.status("reprovisioning").status_code,409)
        self.assertEqual(self.store.data,before)

    def test_delayed_ack_during_new_proof_cannot_clear_it_or_regress_state(self):
        old=self.helper.recovery_generation(self.device())
        self.operation(generation=old)
        newgen=self.helper.recovery_generation(self.device())
        self.operation(operation_id="synthetic-operation-bravo",generation=newgen,phase="authorize",proof=PROOF)
        before=copy.deepcopy(self.device());self.now+=2
        self.assertEqual(self.status("reprovisioning").status_code,200)
        after=self.device();after_copy=copy.deepcopy(after);after_copy["last_seen"]=before["last_seen"];after_copy.pop("ip",None)
        before.pop("ip",None)
        self.assertEqual(after_copy,before)
        self.assertEqual(after["last_seen"],self.now)

    def test_operation_state_survives_store_serialization_and_server_helper_reload(self):
        old=self.helper.recovery_generation(self.device())
        first=self.operation(generation=old,phase="authorize",proof=PROOF)
        self.store.data=json.loads(json.dumps(self.store.data))
        replacement=helper_proxy(self.store);replacement.time=SimpleNamespace(time=lambda:self.now)
        self.ns["device_recovery"]=replacement;self.helper=replacement
        before=copy.deepcopy(self.store.data)
        self.assertEqual(self.operation(generation=old).json()["operation"],first.json()["operation"])
        self.assertEqual(self.store.data,before)

    def test_expired_proof_replay_never_renews_it(self):
        old=self.helper.recovery_generation(self.device())
        self.operation(generation=old,phase="authorize",proof=PROOF);self.now+=601
        before=copy.deepcopy(self.store.data)
        replay=self.operation(generation=old,phase="authorize",proof=PROOF)
        self.assertEqual(replay.status_code,409);self.assertEqual(replay.json()["code"],"recovery_operation_expired")
        self.assertEqual(self.store.data,before)

    def test_legacy_begin_and_proof_blocked_after_operation_or_new_binding(self):
        self.operation(phase="authorize",proof=PROOF);self.bootstrap()
        for proof in ("",PROOF):
            before=copy.deepcopy(self.store.data)
            r=self.client.post("/api/devices/"+ID+"/reprovision",json={"setup_token":proof},headers={"X-Account-Token":OWNER})
            self.assertEqual(r.status_code,409);self.assertEqual(r.json()["code"],"recovery_operation_required")
            self.assertEqual(self.store.data,before)
        self.device().pop("recovery_generation",None);self.device()["binding_id"]="synthetic-new-binding-identifier"
        self.assertEqual(self.client.post("/api/devices/"+ID+"/reprovision",headers={"X-Account-Token":OWNER}).status_code,409)

    def test_delete_and_rebind_invalidate_old_operation_identity(self):
        old=self.helper.recovery_generation(self.device());old_binding=self.helper.binding_id(self.device())
        self.operation(generation=old,phase="authorize",proof=PROOF)
        self.delete(binding=old_binding)
        self.assertNotIn("_recovery_operation",self.device())
        self.status("unbound");self.bootstrap(token="")
        req=self.ns["DeviceAutoClaimReq"](device_id=ID,setup_token=PROOF,name="synthetic")
        self.ns["device_auto_claim"](req,OWNER)
        before=copy.deepcopy(self.store.data)
        r=self.operation(generation=old,binding=old_binding)
        self.assertEqual(r.status_code,409);self.assertEqual(r.json()["code"],"device_binding_changed")
        self.assertEqual(self.store.data,before)

    def test_invalid_operation_contract_and_wrong_owner_never_mutate(self):
        before=copy.deepcopy(self.store.data)
        for kwargs in ({"operation_id":"short"},{"generation":"short"},{"phase":"unknown"},
                       {"phase":"authorize","proof":""},{"phase":"enter_setup","proof":PROOF},{"binding":"short"}):
            self.assertEqual(self.operation(**kwargs).status_code,400)
            self.assertEqual(self.store.data,before)
        self.assertEqual(self.operation(token="different-owner").status_code,401)
        self.assertEqual(self.store.data,before)


class TransactionTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory(prefix="synthetic-device-store-")
        self.addCleanup(self.directory.cleanup)
        root=Path(self.directory.name)
        self.store=SimpleNamespace(_path=lambda name:str(root/(name+".json")))
        self.store.load=lambda name,default:json.loads(Path(self.store._path(name)).read_text()) if Path(self.store._path(name)).exists() else copy.deepcopy(default)
        self.helper=load_helper(self.store)
        self.initial={"device_id":ID,"claimed":True,"account_token":OWNER,"binding_id":"synthetic-binding-one",
                      "revision":"old","last_seen":100,"state":"online"}
        with self.helper.transaction(): self.helper.save_devices({ID:self.initial})

    def test_failed_atomic_replace_preserves_original_and_cleans_temp(self):
        before=Path(self.store._path("eink_devices")).read_bytes()
        with patch.object(self.helper.os,"replace",side_effect=OSError("synthetic failure")):
            with self.assertRaises(OSError):
                with self.helper.transaction():self.helper.save_devices({ID:{"claimed":False}})
        self.assertEqual(Path(self.store._path("eink_devices")).read_bytes(),before)
        self.assertEqual(list(Path(self.directory.name).glob(".devices-*")),[])

    def test_serialized_writers_do_not_overwrite_disjoint_changes(self):
        @self.helper.serialized
        def update(key):
            devices=self.store.load("eink_devices",{})
            time.sleep(.01)
            devices[ID][key]=True
            self.helper.save_devices(devices)
        threads=[threading.Thread(target=update,args=("change_"+str(n),)) for n in range(8)]
        for thread in threads:thread.start()
        for thread in threads:thread.join(3);self.assertFalse(thread.is_alive())
        current=self.store.load("eink_devices",{})[ID]
        self.assertTrue(all(current["change_"+str(n)] for n in range(8)))

    def test_separate_process_transactions_preserve_every_update(self):
        context=multiprocessing.get_context("fork")
        failures=context.Queue()
        def update(key):
            try:
                helper=load_helper(self.store)
                with helper.transaction():
                    data=self.store.load("eink_devices",{})
                    time.sleep(.01)
                    data[ID][key]=True
                    helper.save_devices(data)
            except Exception as error:
                failures.put(type(error).__name__)
                raise
        processes=[context.Process(target=update,args=("process_"+str(n),)) for n in range(4)]
        for process in processes:process.start()
        for process in processes:
            process.join(5)
            if process.is_alive():process.terminate();process.join();self.fail("transaction deadlocked")
            self.assertEqual(process.exitcode,0)
        current=self.store.load("eink_devices",{})[ID]
        self.assertTrue(all(current["process_"+str(n)] for n in range(4)))

    def test_commit_merges_wall_fields_but_keeps_new_heartbeat_and_auth(self):
        proposed={**self.initial,"revision":"new","frame_path":"synthetic-frame","displayed_revision":""}
        identity=self.helper.publication_identity(self.initial)
        current={**self.initial,"last_seen":200,"device_token":"synthetic-new-hardware","displayed_revision":"old"}
        with self.helper.transaction():self.helper.save_devices({ID:current})
        result=self.helper.commit_publication(proposed,identity)
        self.assertEqual(result["revision"],"new")
        self.assertEqual(result["last_seen"],200)
        self.assertEqual(result["device_token"],"synthetic-new-hardware")
        self.assertEqual(result["displayed_revision"],"old")

    def test_late_publication_cannot_restore_deleted_rebound_or_newer_wall(self):
        proposed={**self.initial,"revision":"late"}
        identity=self.helper.publication_identity(self.initial)
        for changes in ({"claimed":False,"account_token":""},{"binding_id":"new-owner-binding"},{"account_token":"different-owner"},
                        {"revision":"newer"},{"pending_command":{"type":"reprovision"}}):
            current={**self.initial,**changes}
            with self.helper.transaction():self.helper.save_devices({ID:current})
            before=Path(self.store._path("eink_devices")).read_bytes()
            self.assertIsNone(self.helper.commit_publication(proposed,identity))
            self.assertEqual(Path(self.store._path("eink_devices")).read_bytes(),before)

    def test_async_route_cannot_accidentally_use_blocking_decorator(self):
        async def route():pass
        with self.assertRaises(TypeError):self.helper.serialized(route)

    def operation_client(self):
        harness=RecoveryTests(methodName="test_fresh_proof_first_late_begin_cannot_erase_authorization")
        harness.candidate=(HERE/"backend/server.py").read_bytes();harness.setUp()
        self.helper.time=SimpleNamespace(time=lambda:harness.now)
        harness.ns["store"]=self.store;harness.ns["device_recovery"]=self.helper
        app=legacy.FastAPI()
        app.post("/api/devices/{device_id}/reprovision")(self.helper.serialized(harness.raw_reprovision))
        return legacy.TestClient(app)

    def test_actual_http_concurrent_same_operation_enters_and_authorizes_once(self):
        client=self.operation_client();generation=self.helper.recovery_generation(self.initial)
        body={"operation_id":"synthetic-operation-race","expected_generation":generation}
        headers={"X-Account-Token":OWNER,"X-Device-Binding":self.initial["binding_id"]}
        responses=[]
        requests=[{"phase":"enter_setup"},{"phase":"authorize","setup_token":PROOF}]*3
        def call(request):responses.append(client.post("/api/devices/"+ID+"/reprovision",json={**body,**request},headers=headers))
        threads=[threading.Thread(target=call,args=(r,)) for r in requests]
        for t in threads:t.start()
        for t in threads:t.join(5);self.assertFalse(t.is_alive())
        self.assertEqual([r.status_code for r in responses],[202]*6)
        generations={r.json()["operation"]["generation"] for r in responses}
        self.assertEqual(len(generations),1)
        current=self.store.load("eink_devices",{})[ID]
        self.assertEqual(current["_recovery_operation"]["stage"],"authorized")
        self.assertEqual(current["reprovision_setup_token_digest"],hashlib.sha256(PROOF.encode()).hexdigest())
        self.assertEqual(generations,{current["recovery_generation"]})

    def test_actual_http_competing_operations_have_one_atomic_generation_winner(self):
        client=self.operation_client();generation=self.helper.recovery_generation(self.initial)
        headers={"X-Account-Token":OWNER,"X-Device-Binding":self.initial["binding_id"]}
        responses=[]
        def call(operation):responses.append(client.post("/api/devices/"+ID+"/reprovision",json={
            "operation_id":operation,"expected_generation":generation,"phase":"authorize","setup_token":PROOF},headers=headers))
        threads=[threading.Thread(target=call,args=("synthetic-operation-"+str(n),)) for n in range(2)]
        for t in threads:t.start()
        for t in threads:t.join(5);self.assertFalse(t.is_alive())
        self.assertEqual(sorted(r.status_code for r in responses),[202,409])
        winner=next(r.json()["operation"] for r in responses if r.status_code==202)
        current=self.store.load("eink_devices",{})[ID]
        self.assertEqual(current["_recovery_operation"]["id"],winner["id"])
        self.assertEqual(current["recovery_generation"],winner["generation"])

    def test_real_serialized_http_concurrent_bootstrap_returns_one_durable_token(self):
        harness=RecoveryTests(methodName="test_fresh_bootstrap_lost_response_recovers_same_token_until_claim")
        harness.candidate=(HERE/"backend/server.py").read_bytes()
        harness.setUp()
        self.helper.time=SimpleNamespace(time=lambda:harness.now)
        harness.ns["store"]=self.store
        harness.ns["device_recovery"]=self.helper
        with self.helper.transaction():self.helper.save_devices({})
        app=legacy.FastAPI()
        app.post("/bootstrap")(self.helper.serialized(harness.ns["device_bootstrap"]))
        app.post("/claim")(self.helper.serialized(harness.ns["device_claim"]))
        app.post("/reprovision/{device_id}")(self.helper.serialized(harness.ns["device_reprovision"]))
        app.delete("/devices/{device_id}")(self.helper.serialized(harness.raw_delete))
        client=legacy.TestClient(app)
        body={"device_id":ID,"pairing_code":"123456","setup_token":PROOF,"device_token":""}
        responses=[]
        def call():responses.append(client.post("/bootstrap",json=body))
        threads=[threading.Thread(target=call) for _ in range(4)]
        for t in threads:t.start()
        for t in threads:t.join(3);self.assertFalse(t.is_alive())
        self.assertEqual([r.status_code for r in responses],[200]*4)
        tokens={r.json()["device_token"] for r in responses}
        self.assertEqual(len(tokens),1)
        current=self.store.load("eink_devices",{})[ID]
        self.assertEqual(tokens,{current["device_token"]})
        before=Path(self.store._path("eink_devices")).read_bytes()
        self.assertEqual(client.post("/bootstrap",json={**body,"device_token":"wrong"}).status_code,401)
        self.assertEqual(Path(self.store._path("eink_devices")).read_bytes(),before)
        # FastAPI schema/signature survives the actual transaction decorator.
        self.assertIn("/bootstrap",client.get("/openapi.json").json()["paths"])


if __name__=="__main__":
    unittest.main(verbosity=2)

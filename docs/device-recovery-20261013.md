# Device recovery releases — 2026-10-13

Status: **deployed at 2026-10-13 17:13:47 CST**. Exact reviewed server/helper installed after both APIs drained cleanly. Both health endpoints return 200; recovery schema verified; binding, wall, firmware and history fingerprints unchanged; heartbeats did not regress; Caddy unchanged. No real device DELETE, reprovision, bootstrap, generation, upload or publish was used as a smoke test. Firmware and network configuration were not modified.

The second operation-fencing release below is **deployed at 2026-10-13 17:34:38 CST**. Its source and evidence are separate from the first release. App 1.3.15 build 39 was separately verified available in the original TestFlight group at 18:01:46 CST; see `docs/device-reconnect-recovery-20261013.md`. Physical-device recovery is not claimed.

## First release: exact scope and provenance

Before the first deployment, the running legacy server had no reprovision route. This candidate is generated from the exact cached production source (`outputs/wifi-recheck-20261012/server-before.py`), retaining its display-history patch. It is not a replacement copied from the dirty root `backend/server.py`.

| Artifact | SHA-256 |
|---|---|
| Online server baseline | `5ad66096ab702b185dae28334624b259d5386e7cc08437eca840faf578898846` |
| Candidate server | `a6fa49638cb80cfd9a19d161d297784af9933eb7203454f4aba6a5aeebac132e` |
| New `backend/device_recovery.py` | `dd7344d167a9cfebaea592de2d45c4c00e86c1c12ce95d64775c2d6841cdba11` |
| Combined tracked patch | `1b80666fb74e598e83fdf5acdd0b1f04e821e0d78dad0293a475052396e232e7` |

The first release is preserved in commit `123820fc850444d16610b051277733c1af8d02c0`. The traceable source set is `backend/device_recovery.py`, `tools/prepare_legacy_device_recovery.py`, `config/patches/server-device-recovery-20261013.patch`, `tests/test_legacy_device_recovery.py`. The generator reproduces the candidate without touching the root server. Existing E1002 work is untouched.

## Protocol

- Public device projection includes opaque `binding_id`. Existing no-generation binding gets a stable derived legacy identity without a read-time state migration. Every new claim begins a random binding identity and a separate history key; Wi-Fi reconfiguration retains its current binding/history.
- New DELETE requires `X-Device-Binding` and `X-Delete-Request-Id`. A successful 202 response echoes `device_id`, `binding_id`, `request_id`, `removed:true`, `deleted:true`, `reprovision_required`, `already_removed`.
- Receipts are stored atomically with binding revocation and authenticated by the original owner token digest. They survive deferred hardware acknowledgement and subsequent rebind. A replay can return the old receipt; it cannot delete the new binding. Receipts expire after seven days, maximum sixteen per device.
- Build 37's first headerless DELETE remains supported only for existing legacy bindings. Fresh explicit bindings reject headerless DELETE. No 401 or empty list implies successful deletion.
- Reprovision requires current owner authorization, retains binding/current wall, and accepts a new physical setup proof. Poll/ack/bootstrap handling distinguishes retained reconfiguration from actual DELETE.
- Bootstrap response loss has a fixed 60-second recovery window: empty hardware token plus the same setup proof may retrieve the exact same newly issued token. Device ID, binding ID, owner digest and current hardware-token digest must still match. Replays do not rotate, renew, mutate, or consume a new pending operation. Wrong nonempty hardware token, expiry, rebind or another operation rejects it.
- Manual six-digit claim rejects a pending DELETE until proper bootstrap/BLE recovery, preventing a late old unbound acknowledgement from deleting a new binding.

## Concurrency

Seven synchronous metadata routes hold a cross-process file transaction: bootstrap, manual claim, auto-claim, DELETE, reprovision, next, status. The decorator refuses async functions. The lock covers reload/authentication/metadata update/atomic save plus existing small local account/history metadata I/O. It never spans network calls, image rendering, frame creation or broadcasts. Thread/process synthetic contention passes; no production latency bound has been measured.

Three async publication handlers render outside the lock, then run a short transaction in a worker thread. The final commit rechecks binding, owner, revision and pending operation; merges only wall fields; retains newer heartbeat, device credential and displayed acknowledgement fields. The legacy candidate contains all ten device writers being coordinated. **This is not a claim that the richer dirty root server's household writers have been migrated to this lock.** That integration requires its own review.

## Validation and limits

- `test-venv/bin/python tests/test_legacy_device_recovery.py`: **54 passed**, independently repeated by another agent. Includes prior reprovision/auth regressions, actual FastAPI HTTP schema/validation, concurrent first bootstrap returning one durable token, four-process updates, atomic write failure, lost DELETE receipt, same-device/same-owner and different-owner rebind, late ACK, late publication and history isolation.
- Local Python 3.12.14; FastAPI 0.141.1 and Pydantic 2.13.4 match production framework versions (production Python 3.12.3). Production synthetic suite not run in this task; synthetic tests were local; deployment evidence is separate below.
- AST regression preserves every unrelated named definition, including history routing and image queue logic. Source compile and whitespace checks pass. Selection/gateway/router/engine/history source hashes are held fixed by deployment guard; no selection strategy or model change.
- This repairs API/protocol recovery holes. It does **not** establish that previous button failures were caused by an applied DELETE, nor does it fix public ingress or router reachability. Current local health cannot establish phone connectivity during the user's failure.
- Empty-body asynchronous reprovision sent before a later BLE-proof request can arrive out of order. App must not fire-and-forget that preliminary request; backend cannot infer whether an identical empty request is old or intentional. Native agent was notified.

## Read-only preflight, 17:08:14 CST

`preflight.json` confirms exact base SHA, helper absent, both APIs and Caddy active, no selection scopes/processes, inference lock free, no established 8000/8001 clients, local health 200. Known device remains claimed, legacy binding, firmware `0.3.7-e1002.1`, no pending command; stable metadata fingerprints captured. Its last heartbeat was still 16:01:32 CST. This is eligibility at one observation, not permission to ignore later activity.

## Deployment / rollback

Stage the candidate `backend/server.py` and `backend/device_recovery.py` into a fresh release directory under `/opt/photowall/releases/`, along with `deploy_device_recovery.py`. Do not copy root `backend/server.py` or E1002 files.

```text
python3 <release>/deploy_device_recovery.py --release-dir <release>
python3 <release>/deploy_device_recovery.py --release-dir <release> --apply
```

Default mode performs checks only. Apply preserves backups and owner/mode, checks exact source and unrelated hashes, rechecks idle API/inference state, stops **both API services** because both import the legacy server, requires clean Uvicorn shutdown logs and systemd exit, takes the inference lock, installs both files atomically while interpreters are stopped, and restarts both. Caddy is unchanged. Existing 20-second stop timeout remains; a request arriving between idle check and stop is a narrow race. An unclean drain blocks all source changes and restores service availability.

Smoke verification uses local health, OpenAPI schema (reprovision + DELETE identity headers + existing history), unchanged selection schema, and anonymous GET device list. It never calls real device mutating endpoints. It verifies both API PIDs changed, Caddy PID unchanged, source pins, binding/firmware/wall/history stable, and heartbeat non-regression.

Rollback restores code only, never old device state. It requires idle/drained services and no binding/receipt/proof changes since before deployment; if user activity appears, rollback is deferred rather than interrupting or weakening a new binding. Both files are restored together. Unknown or mixed source blocks restart. Report records errors, rollback deferral and both restart attempts. The parent must review `deployment-report.json`; code deployed successfully is not proof of a successful phone-to-device recovery until the real user flow is observed.

## Deployment artifact checksums

- `outputs/offline-recovery-20261013/reconnect-review/deploy_device_recovery.py`: `bd8d0f406c6b873289c97d7252d93f55ff07243004b943448b78d1da1d343f94`
- `outputs/offline-recovery-20261013/reconnect-review/preflight_readonly.py`: `ca39a617bacb07a8b076a22a6b1727e08179a916af168e0925f44b53336fdef8`

The scripts, preflight evidence and synthetic logs are retained in the indicated task output directory. They are not startup hooks or automatically executed tools. All production changes require the parent’s explicit `--apply` invocation after current-state guards pass.

## Actual deployment evidence

Release `/opt/photowall/releases/device-recovery-20261013T0914`; local evidence `outputs/offline-recovery-20261013/reconnect-review/deployment-report.json`. Two-file SHA pins match the table above, both API PIDs changed, all five preservation comparisons passed. Mac public health check at 17:14:17 CST returned HTTP 200 in 0.37 seconds with both configured and direct routes; this does not establish the phone or screen network. No rollback occurred.


## Second release: online setup activation with fenced operation stages

Status: **deployed at 2026-10-13 17:34:38 CST**. This restores the necessary online-device trigger before BLE discovery, without letting a delayed trigger erase fresh BLE authorization. It does not make BLE always available on an offline device. The first-release source snapshot and deployment report above remain preserved.

Public device projection now includes `recovery_generation`. It is a stable, binding-derived value before migration; reads do not mutate storage. A new operation supplies `X-Device-Binding` and body:

```json
{
  "operation_id": "persistent-random-operation-id",
  "expected_generation": "generation-read-for-this-binding",
  "phase": "enter_setup",
  "setup_token": ""
}
```

The proof stage uses the same operation ID and original expected generation, with `phase: "authorize"` and the fresh BLE `setup_token`. Input shape is validated before mutation; owner and binding authorization are mandatory.

- The server keeps one private current-operation record (`id`, `binding_id`, `from_generation`, newly allocated `generation`, `stage`, plus proof digest after authorization). Starting another operation requires its expected generation to equal the current public generation. It replaces the current operation with a new random generation.
- Same-operation retries must match the stored original generation. `enter_setup` → `authorized` → `completed` is one-way. Proof may arrive first; a delayed same-operation begin returns the authorized/completed receipt without queuing or changing anything. A repeated same proof does not renew its ten-minute authorization window. Different proof under the same ID conflicts.
- A replaced operation's begin/proof requests return 409, even after the newer operation completes. Generations never revert. The server never silently rebases an old request onto the newest generation.
- A successful 202 includes the existing `device`, `reprovision_required: true`, `preserve_binding: true`, plus `operation: {id,binding_id,from_generation,generation,stage}`. Stage values are `entered`, `authorized`, `completed`.
- A matching current-proof bootstrap clears the pending command and marks `completed`. The old firmware's `reprovisioning` acknowledgement lacks operation identity, so during a new-style operation it updates only observed heartbeat/IP; it does not clear proof, pending command, stage, wall state, progress or error. An acknowledgement after completion has no pending command and is rejected without mutation.
- Binding replacement and actual DELETE invalidate the operation and rotate generation. The second deployed release initially rejected headerless legacy requests once any recovery generation was persisted. Independent post-deployment review found that this also rejected build 37's second, proof-bearing request after its first bare begin succeeded; the compatibility correction is recorded below. Old-client DELETE first-delete compatibility remains unchanged.
- App persists operation ID/binding/original generation before begin. Cancel, timeout and process restart do not mean the server did nothing; App reuses the operation. Only an explicit new round may fetch a fresh generation and create a new ID. There is no remote cancellation endpoint in this change.

Errors: malformed operation is 400 `recovery_operation_invalid`; owner auth is 401; 409 uses `device_binding_changed`, `recovery_generation_changed`, `recovery_operation_conflict`, `recovery_operation_expired`, or `recovery_operation_required`. Expired authorization needs an explicit new operation; a replay never extends it.

### Source, tests and bounded evidence

| Artifact | SHA-256 |
|---|---|
| Deployed server base | `a6fa49638cb80cfd9a19d161d297784af9933eb7203454f4aba6a5aeebac132e` |
| Deployed helper base | `dd7344d167a9cfebaea592de2d45c4c00e86c1c12ce95d64775c2d6841cdba11` |
| Second deployed server | `3b6b9b6147d3cb3ca7df4509d2aabccd49cbbcfd91d11a75fa6d8a7b4a64659d` |
| Second deployed helper | `fc0d863129236019fe641f4a4265d39f0fb752bea0499339b247606606ff470f` |
| Combined tracked patch from original 5ad66096 base | `8b4e6889966a985f3dd2ed63dda7675b1591368e612cec4a58b0437d67a04012` |
| Incremental patch from deployed first release | `ed68fa8c5f8d973cad330123a8d88f5001c89ddd5549044909eb587cd4fb2dbd` |

`tests/test_legacy_device_recovery.py`: **69 passed** in the isolated Python/FastAPI test environment. All previous scenarios remain covered; the old ACK-clears-proof assertion was intentionally changed for the operation protocol. New cases cover proof-first/late-begin, same-operation retries without expiry renewal, different-operation generation fencing, no ABA after completion, server reload, old-client rejection, cross-bind invalidation, late ACK preserving display state, six concurrent HTTP begin/proof requests yielding one generation, and two concurrent operations yielding exactly one winner. Independent review also passed all 69 tests with no blocking findings; the native agent/reviewer additionally reported an 11-request App/FastAPI bridge pass covering lost-response restart, completed replay and stale-operation rejection.

`outputs/offline-recovery-20261013/reprovision-operation/preflight.json` is a read-only sample at **17:29:21 CST**: deployed first-release SHA pins match, both APIs/Caddy active, no inference scopes/processes, no API clients, inference lock free and both local health checks 200. Device binding/wall/history fingerprints still match the first-release evidence; this is not a claim the physical device is presently online. No additional real device request was used for verification.

All second-release artifacts are under `outputs/offline-recovery-20261013/reprovision-operation/`, separate from `reconnect-review/`. The second-release archived generator/combined patch reproduce that deployed source from original 5ad66096 source; the currently tracked generator/combined patch now include the compatibility correction below. The second deployment script explicitly requires the already deployed a6fa4963 server and dd7344d1 helper; both files are backed up before the same guarded two-API drain/install/restart. Its state protection includes the current operation and generation, preventing unsafe rollback after accepted user activity.

- `deploy_device_recovery.py`: `6828bc964280f3ba74d5359c7080cc80a9e426d40d611241f50c209f57f7dc24`
- `preflight_readonly.py`: `088d70edcc986e26e2f9a0f23cdcbc150e9fcf735dfbbadfd900b7cc824610af`

The second script verifies operation request-schema fields and binding header, in addition to prior health, unrelated-source, anonymous-list and stable-data checks. It does not exercise authenticated hardware actions. Firmware, Caddy/network, selection rules and unrelated E1002 modifications are excluded.


### Second release: actual deployment evidence

`outputs/offline-recovery-20261013/reprovision-operation/deployment-report.json` reports `deployed: true`, with no failure or rollback. Deployment ran from **17:34:35 to 17:34:38 CST on 2026-10-13**. Both API services drained, restarted and passed HTTP 200 health checks; operation/recovery schemas and anonymous-list isolation passed. Main API PID is `222488`, selection API PID is `222486`; Caddy stayed at PID `855`.

Installed server/helper SHA-256 values exactly match the second-release table. All five preservation comparisons passed: binding, wall, firmware and historical data fingerprints stayed unchanged, and heartbeats did not regress. No actual authenticated device operation, generation, upload or publish was used as a smoke test. This deployment did not change device firmware or network configuration.

At the second backend deployment, App 39 had not yet been built. Its later release was independently verified at 18:01:46 CST; backend health is not evidence of physical-device recovery.


## Third release: preserve the complete legacy build 37 recovery sequence

Status: **deployed at 2026-10-13 17:44:00 CST**. This does not modify the App 39 operation contract. The first deployment at 17:13:47 and second deployment at 17:34:38 remain preserved as completed releases.

Published build 37 first awaits a headerless reprovision request with an empty setup token, then sends a second headerless request with the BLE setup proof. Its archived `App.js` and `src/deviceApi.js` were checked against the release source manifest. The second backend release persisted `recovery_generation` after the first request and interpreted it as protocol adoption; the second request consequently returned 409 `recovery_operation_required`. This was a newly introduced interruption relative to the first backend release. The previous 69 tests did not cover this exact double bare request because the inherited reprovision test helper had been adapted to send the new operation contract. An independent actual FastAPI reproduction exposed the gap.

The correction distinguishes generation allocation from adoption of the operation protocol. A private sticky `_recovery_protocol_version: 2` is written when a new-style operation is persisted and is omitted from public device output. Bare legacy requests remain permitted only when there is no explicit binding, no current operation, and no adopted-protocol marker. Thus a generation-only legacy intermediate state can continue after a restart, while a new binding, existing deployed V2 operation, completed V2 operation, or invalidated V2 operation still rejects bare requests. DELETE and subsequent rebind do not restore legacy access. Owner authentication and proof requirements are unchanged. The legacy protocol still cannot identify delayed requests within its own old two-stage flow; the new operation protocol is required for that protection.

Only two functions differ from the second deployed server: `_public_device` and `device_reprovision`. The helper stays byte-identical; there are no changes to bootstrap, next, status, DELETE receipts, publication commits, selection rules, firmware, or App 39. Deployment replaces only `backend/server.py`, with both API interpreters drained because they import that file.

| Artifact | SHA-256 |
|---|---|
| Required deployed V2 server | `3b6b9b6147d3cb3ca7df4509d2aabccd49cbbcfd91d11a75fa6d8a7b4a64659d` |
| Third deployed corrected server | `caa763d465a6a9b4b00856783efe0d9b7dac6e6793ee070626d3d08fee326a2c` |
| Pinned unchanged helper | `fc0d863129236019fe641f4a4265d39f0fb752bea0499339b247606606ff470f` |
| Incremental server-only patch | `7d8ddabef0683fedd32654e997206cf488c60603c2339a064db2885ae443558a` |
| Current combined patch from original 5ad66096 | `10852df15ac7be903617c22249b2255e9662ff541f8e947db624c5c7def7f2cc` |
| Guarded server-only deployment script | `f1460b6fe4b726ccf72eb966a559e88f38cbd98f4c06b7f4e3416cca89581409` |

All third-candidate artifacts are separate under `outputs/offline-recovery-20261013/reprovision-legacy-compat/`. `compatibility-report.json` records exact changes and hashes; `tests.txt` and `tests-independent.txt` each record **77/77 passing**. Eight added regressions cover the real bare build 37 begin → ACK → proof → HTTP bootstrap sequence, lost ACK, generation-only half-flow after reload, legacy-to-V2 adoption followed by delayed bare requests, sticky adoption after operation invalidation, already-deployed V2 records without the new marker, new bindings, and DELETE/rebind. The same frozen App 39 to FastAPI persistence bridge independently passed all 11 requests against the corrected candidate (`outputs/device-reconnect-20261013/recovery-v2-review/app-fastapi-bridge.json`). These are synthetic protocol checks, not a claim of a successful physical screen recovery.

The server-only script backs up the exact V2 server, pins the unchanged helper and all prior unrelated-source hashes, checks no inference or API clients, drains both APIs, replaces atomically and checks both health routes, schema, anonymous visibility, Caddy PID and stable data fingerprints. Rollback restores code only; accepted device/recovery activity causes rollback to be deferred. Its state fingerprint also includes the private protocol marker. The script defaults to a read-only plan; only the parent release task may invoke `--apply`. Previous deployment reports are not overwritten.

Read-only preflight at **17:43:13 CST** confirms the expected deployed V2 server/helper, both local health routes 200, no inference scopes/processes or API clients, and a free inference lock. `preflight.json` reports `eligible_at_sample: true`; the deployment script must still recheck these guards immediately before stopping anything. No production mutation was performed by the compatibility preparation task.


### Third release: actual deployment evidence

`outputs/offline-recovery-20261013/reprovision-legacy-compat/deployment-report.json` reports `deployed: true`, no failure and no rollback. Deployment ran from **17:43:58 to 17:44:00 CST on 2026-10-13**. It replaced only `backend/server.py` with SHA-256 `caa763d465a6a9b4b00856783efe0d9b7dac6e6793ee070626d3d08fee326a2c`; the unchanged-helper guard retained `fc0d863129236019fe641f4a4265d39f0fb752bea0499339b247606606ff470f`.

Both API health checks returned HTTP 200. Main API PID is `223035`, selection API PID is `223033`, and Caddy remained PID `855`. Recovery/operation schema and anonymous-list isolation checks passed. Binding, wall, firmware and historical data fingerprints stayed unchanged, and heartbeat timestamps did not regress. No real upload, generation, publish, device deletion or reprovision was performed as a verification probe. All previous deployment evidence is retained.

App 1.3.15 build 39 was subsequently processed as VALID / IN_BETA_TESTING, not expired, and verified in the existing Team (Expo) group at 18:01:46 CST. See `outputs/device-reconnect-20261013/release39/release-status.json`. No physical-device recovery is claimed.

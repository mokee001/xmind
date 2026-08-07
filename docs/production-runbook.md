# PhotoWall Production Runbook

## Service Layout

- Public API: `https://api.mokeedesign.cn`
- Host: `118.31.175.162`
- Application: `/opt/photowall/app`
- Persistent data: `/opt/photowall-data`
- Service: `photowall.service`
- HTTPS proxy: `caddy.service`

The API only listens on `127.0.0.1:8000`; Caddy terminates public TLS. The
Alibaba Cloud HTTP port 80 ICP page is separate from the HTTPS API and is not an
application failure.

## Routine Check

Run this from a checkout before and after a production deployment:

```sh
python3 scripts/check_production.py
```

For host-level checks:

```sh
ssh root@118.31.175.162 \
  'systemctl --no-pager --full status photowall.service caddy.service; df -h / /opt/photowall-data'
```

Inspect recent logs without changing service state:

```sh
ssh root@118.31.175.162 \
  'journalctl -u photowall.service -u caddy.service --since "1 hour ago" --no-pager'
```

## Deploy A Tested Backend Change

1. Run the isolated local regression:

   ```sh
   python3 scripts/verify_local.py
   ```

2. Copy only the tested backend file or files. Do not replace
   `/opt/photowall-data`, which contains production photos and device state.

   ```sh
   scp backend/server.py root@118.31.175.162:/opt/photowall/app/backend/server.py
   ```

3. Restart the API and verify the public contract:

   ```sh
   ssh root@118.31.175.162 'systemctl restart photowall.service && systemctl is-active --quiet photowall.service'
   python3 scripts/check_production.py
   ```

## Roll Back

Before replacing a production file, make a timestamped remote copy:

```sh
ssh root@118.31.175.162 \
  'cp /opt/photowall/app/backend/server.py /opt/photowall/app/backend/server.py.$(date +%Y%m%d%H%M%S).bak'
```

Restore the appropriate backup, restart `photowall.service`, then run
`python3 scripts/check_production.py` again.
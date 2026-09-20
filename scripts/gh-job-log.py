#!/usr/bin/env python3
"""Fetch a GitHub Actions job log for cwdcwd/vector-sigma.

Uses gh-app's fresh installation token (never printed) with a no-redirect
opener: the /logs endpoint 302s to a signed Azure blob that rejects the
Authorization header, so we take Location and fetch it with no auth.

Usage: gh-job-log.py <job_id> <out_path>
"""
import os
import subprocess
import sys
import urllib.error
import urllib.request

GH_APP = '/home/cwd/.hermes/scripts/gh-app'
REPO = os.environ.get('GH_LOG_REPO', 'cwdcwd/vector-sigma')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    job_id, out_path = sys.argv[1], sys.argv[2]
    # Mint a fresh token in-process; NEVER print it.
    token = subprocess.run(
        [GH_APP, 'token'], capture_output=True, text=True, check=True
    ).stdout.strip()
    if not token:
        print('no token minted', file=sys.stderr)
        return 1

    url = f'https://api.github.com/repos/{REPO}/actions/jobs/{job_id}/logs'
    req = urllib.request.Request(url)
    req.add_header('Authorization', f'Bearer {token}')
    req.add_header('Accept', 'application/vnd.github+json')
    req.add_header('User-Agent', 'gh-job-log-fetch')
    opener = urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(req, timeout=30) as r:
            # 200 directly (shouldn't happen for job logs, but handle it)
            data = r.read()
            with open(out_path, 'wb') as f:
                f.write(data)
            print(f'fetched {len(data)} bytes (direct 200)')
            return 0
    except urllib.error.HTTPError as e:
        if e.code not in (301, 302, 303, 307):
            print(f'HTTP {e.code}: {e.read()[:300]!r}', file=sys.stderr)
            return 1
        location = e.headers.get('Location')
        if not location:
            print('no Location header on redirect', file=sys.stderr)
            return 1
    # Signed blob: NO auth header.
    with urllib.request.urlopen(location, timeout=60) as r, open(out_path, 'wb') as f:
        f.write(r.read())
    print(f'fetched {os.path.getsize(out_path)} bytes via signed redirect')
    return 0


if __name__ == '__main__':
    sys.exit(main())
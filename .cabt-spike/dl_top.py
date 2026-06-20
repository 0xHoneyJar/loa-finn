"""Sample-download top-tier episodes from the daily Kaggle dataset (06-18, avg-score 1327-tier).

Read-only data acquisition for the imitation-pilot learnability spike. Pages the file list,
skips episodes already on disk, downloads a sample into .cabt-spike/top/. Logs progress so a
background run is observable. NOT shipped code — a spike data puller.
"""
from __future__ import annotations
import os, sys, time, zipfile, glob

DS = "kaggle/pokemon-tcg-ai-battle-episodes-2026-06-18"
TARGET = ".cabt-spike/top"
WANT_LIST = int(os.environ.get("WANT_LIST", "400"))   # how many filenames to collect
WANT_DOWNLOAD = int(os.environ.get("WANT_DOWNLOAD", "250"))  # how many NEW episodes to pull

os.makedirs(TARGET, exist_ok=True)


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def list_files(api, want):
    names, token = [], None
    while len(names) < want:
        try:
            res = api.dataset_list_files(DS, page_token=token) if token else api.dataset_list_files(DS)
        except TypeError:
            res = api.dataset_list_files(DS)  # older API without page_token
        batch = [f.name for f in res.files]
        if not batch:
            break
        names.extend(batch)
        token = getattr(res, "nextPageToken", None)
        log(f"listed {len(names)} filenames (token={'yes' if token else 'none'})")
        if not token:
            break
    return names


def download_one(api, fname):
    """Download a single episode; handle raw-or-zipped landing. Returns True on a valid json on disk."""
    dst = os.path.join(TARGET, fname)
    if os.path.exists(dst) and os.path.getsize(dst) > 1000:
        return True
    try:
        api.dataset_download_file(DS, fname, path=TARGET, quiet=True)
    except Exception as e:
        log(f"  ERR download {fname}: {type(e).__name__} {str(e)[:120]}")
        return False
    # kaggle may land fname or fname+'.zip'
    zp = dst + ".zip"
    if os.path.exists(zp):
        try:
            with zipfile.ZipFile(zp) as z:
                z.extractall(TARGET)
            os.remove(zp)
        except Exception as e:
            log(f"  ERR unzip {fname}: {e}")
            return False
    return os.path.exists(dst) and os.path.getsize(dst) > 1000


def main():
    from kaggle import KaggleApi
    api = KaggleApi(); api.authenticate()
    log("auth OK")
    have = {os.path.basename(p) for p in glob.glob(f"{TARGET}/*.json")}
    log(f"already on disk: {len(have)} episodes")
    names = list_files(api, WANT_LIST)
    todo = [n for n in names if n.endswith(".json") and n not in have][:WANT_DOWNLOAD]
    log(f"collected {len(names)} names; downloading {len(todo)} new episodes")
    ok = 0
    for i, fname in enumerate(todo, 1):
        if download_one(api, fname):
            ok += 1
        if i % 20 == 0 or i == len(todo):
            log(f"  progress {i}/{len(todo)} ({ok} ok)")
    total = len(glob.glob(f"{TARGET}/*.json"))
    log(f"DONE — {ok}/{len(todo)} downloaded; {total} episodes total on disk")


if __name__ == "__main__":
    main()

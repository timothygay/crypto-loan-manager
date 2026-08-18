#!/usr/bin/env python3
"""
DCI Price Ladder — Client Rates : render a Penguin-branded rate card (PNG) and
post it to Slack. Built to run headless on a GitHub Actions runner.

Data path (chosen so the runner needs NO Penguin API key and NO allowlisted IP):
  • APR  — GET <RELAY_URL> (default crypto-loan-manager's public /api/dci-penguin),
           which relays live calc_adj_apy from the treasury monitor. Field `adj`
           is the skew-adjusted client rate (decimal; 1.7995 = 179.95% p.a.).
  • Spot — Deribit public index (btc_usd / eth_usd). Matches Penguin's
           underlying within ~0.05%; used for the Spot line and ATM highlight.

Freshness: every run fetches live immediately before rendering; the "as of"
stamp is the relay's fetchedAt (SGT). If APR is empty/unreachable the run FAILS
and posts nothing — never a stale card.

Env:
  SLACK_BOT_TOKEN   (required)  xoxb-…  scopes files:write, chat:write
  SLACK_CHANNEL_ID  (required)  e.g. C0BQPLEC7C3
  RELAY_URL         (optional)  default https://crypto-loan-manager.vercel.app/api/dci-penguin
  STRIKE_WINDOW     (optional)  strikes each side of ATM, default 6
  DRY_RUN           (optional)  "1" = render only, skip Slack upload (writes /tmp/dci_ladder.png)
"""
import os, sys, re, json, time, datetime, urllib.request, urllib.parse

RELAY_URL = os.environ.get("RELAY_URL", "https://crypto-loan-manager.vercel.app/api/dci-penguin")
WIN       = int(os.environ.get("STRIKE_WINDOW", "6"))
DRY_RUN   = os.environ.get("DRY_RUN", "") == "1"
OUT       = "/tmp/dci_ladder.png"
MON = {'JAN':1,'FEB':2,'MAR':3,'APR':4,'MAY':5,'JUN':6,'JUL':7,'AUG':8,'SEP':9,'OCT':10,'NOV':11,'DEC':12}


def _get_json(url, tries=4):
    """GET with retry-on-bad-response (mirrors the app's ghfetch resilience)."""
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "dci-slack-card/1.0"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            last = e
            time.sleep(1.5 * (i + 1))
    raise RuntimeError(f"GET failed after {tries} tries: {url} :: {last}")


def fetch_apr():
    d = _get_json(RELAY_URL)
    apr = d.get("apr") or {}
    if not apr or not d.get("count"):
        raise RuntimeError(f"relay returned no rates (count={d.get('count')}, success={d.get('success')})")
    return apr, d.get("fetchedAt")


def fetch_spot():
    spot = {}
    for asset, idx in (("BTC", "btc_usd"), ("ETH", "eth_usd")):
        d = _get_json(f"https://www.deribit.com/api/v2/public/get_index_price?index_name={idx}")
        p = (d.get("result") or {}).get("index_price")
        if not p:
            raise RuntimeError(f"Deribit returned no index for {idx}")
        spot[asset] = float(p)
    return spot


def expdate(idx):
    m = re.match(r'^[A-Z]+-(\d{1,2})([A-Z]{3})(\d{2})$', idx)
    return datetime.date(2000 + int(m.group(3)), MON[m.group(2)], int(m.group(1)))


def parse_ladder(apr):
    """apr keys look like 'BTC-21AUG26-64000-C'. -> {underlying_index: {strike: {'C':%, 'P':%}}}"""
    book = {}
    for key, v in apr.items():
        parts = key.split('-')
        if len(parts) != 4:
            continue
        asset, expc, strike, side = parts
        idx = f"{asset}-{expc}"
        try:
            k = int(strike)
        except ValueError:
            continue
        book.setdefault(idx, {}).setdefault(k, {})[side] = (v.get("adj") or 0) * 100
    return book


def exps(book, asset):
    return sorted([i for i in book if i.startswith(asset + "-")], key=expdate)


def stamp_sgt(fetched_at):
    try:
        t = datetime.datetime.strptime(fetched_at.replace("Z", ""), "%Y-%m-%dT%H:%M:%S.%f")
    except Exception:
        try:
            t = datetime.datetime.strptime(fetched_at.replace("Z", ""), "%Y-%m-%dT%H:%M:%S")
        except Exception:
            t = datetime.datetime.utcnow()
    sgt = t + datetime.timedelta(hours=8)  # SGT = UTC+8, no DST
    return sgt.strftime("%-d %b %Y  ·  %H:%M SGT")


def render(book, spot, stamp):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import matplotlib.lines as mlines
    plt.rcParams["text.parse_math"] = False

    NAVY="#0B2140"; GOLD="#B08D57"; STEEL="#2E4A63"; WINE="#7C3B44"
    INK="#132639"; MUTE="#A6A9AE"; GRID="#E7E4DD"; IVORY="#EFEADD"; ATMBG="#F1E7CE"

    def fmtd(dt): return dt.strftime("%-d %b %Y")

    def table_data(idx, asset):
        bys = book[idx]; sp = spot[asset]
        ks = [k for k in sorted(bys) if bys[k].get("C", 0) > 0.005 or bys[k].get("P", 0) > 0.005]
        allk = sorted(bys); atm = min(allk, key=lambda k: abs(k - sp)); ai = allk.index(atm)
        band = allk[max(0, ai - WIN): ai + WIN + 1]
        ks = [k for k in band if k in ks or k == atm]
        c = lambda v: f"{v:.2f}%" if v and v > 0.005 else "–"
        data = [[c(bys[k].get("C", 0)), f"${k:,.0f}", c(bys[k].get("P", 0))] for k in ks]
        return data, (ks.index(atm) if atm in ks else -1)

    be = exps(book, "BTC"); ee = exps(book, "ETH")
    panels = [("BTC", be[0], "Near week"), ("ETH", ee[0], "Near week"),
              ("BTC", be[1], "Far week"),  ("ETH", ee[1], "Far week")]

    fig, axes = plt.subplots(2, 2, figsize=(11, 12.9)); axes = axes.ravel()
    for ax, (asset, idx, tag) in zip(axes, panels):
        data, atmrow = table_data(idx, asset); ax.axis("off")
        ax.set_title(f"{asset} · Exp {fmtd(expdate(idx))}", fontsize=13, fontweight="bold",
                     color=NAVY, loc="left", pad=20, fontfamily="DejaVu Sans")
        ax.text(0, 1.012, tag.upper(), transform=ax.transAxes, fontsize=9, color=GOLD,
                fontfamily="DejaVu Sans", fontweight="bold")
        tbl = ax.table(cellText=data, colLabels=["Call APR", "Strike", "Put APR"],
                       cellLoc="center", loc="center", bbox=[0, 0, 1, 0.92])
        tbl.auto_set_font_size(False); tbl.set_fontsize(11.5)
        for (r, cc), cell in tbl.get_celld().items():
            cell.set_edgecolor(GRID); cell.set_linewidth(0.6); cell.set_height(0.072)
            if r == 0:
                cell.set_facecolor(NAVY); cell.set_edgecolor(NAVY)
                cell.set_text_props(fontweight="bold", color=IVORY, fontfamily="DejaVu Sans")
            else:
                atm = (r - 1 == atmrow)
                cell.set_facecolor(ATMBG if atm else "white")
                txt = {0: STEEL, 1: INK, 2: WINE}[cc]; fw = "bold" if (cc == 1 or atm) else "normal"
                if data[r - 1][cc] == "–": txt = MUTE; fw = "normal"
                cell.set_text_props(color=txt, fontweight=fw, fontfamily="DejaVu Sans Mono")

    fig.text(0.012, 0.980, "PENGUIN SECURITIES", fontsize=20, fontweight="bold", color=NAVY,
             fontfamily="DejaVu Serif", ha="left", va="top")
    fig.text(0.013, 0.9635, "S T R U C T U R E D   S O L U T I O N S", fontsize=10.5, color=GOLD,
             fontfamily="DejaVu Serif", ha="left", va="top")
    fig.add_artist(mlines.Line2D([0.012, 0.988], [0.9445, 0.9445], color=NAVY, lw=1.6, transform=fig.transFigure))
    fig.add_artist(mlines.Line2D([0.012, 0.988], [0.9413, 0.9413], color=GOLD, lw=0.9, transform=fig.transFigure))
    fig.text(0.012, 0.930, "DCI Price Ladder  ·  Client Rates", fontsize=15, fontweight="bold",
             color=INK, fontfamily="DejaVu Sans", ha="left", va="top")
    fig.text(0.012, 0.910, f"Spot      BTC   ${spot['BTC']:,.0f}   ETH   ${spot['ETH']:,.0f}",
             fontsize=12.5, fontweight="bold", color=STEEL, fontfamily="DejaVu Sans", ha="left", va="top")
    fig.text(0.988, 0.980, "INDICATIVE", fontsize=9.5, color=MUTE, fontfamily="DejaVu Sans",
             ha="right", va="top", fontweight="bold")
    fig.text(0.988, 0.9645, f"as of {stamp}", fontsize=9.5, color=STEEL, fontfamily="DejaVu Sans",
             ha="right", va="top", fontweight="bold")
    fig.subplots_adjust(left=0.015, right=0.985, top=0.822, bottom=0.028, hspace=0.32, wspace=0.13)
    fig.savefig(OUT, dpi=170, facecolor="white")
    return OUT


def slack_upload(path, token, channel):
    import http.client
    length = os.path.getsize(path)
    # 1) get an upload URL
    q = urllib.parse.urlencode({"filename": "dci_ladder.png", "length": length})
    up = _post_form(f"https://slack.com/api/files.getUploadURLExternal?{q}", token)
    if not up.get("ok"):
        raise RuntimeError(f"getUploadURLExternal failed: {up}")
    upload_url, file_id = up["upload_url"], up["file_id"]
    # 2) PUT the bytes (multipart)
    _multipart_put(upload_url, path)
    # 3) complete + share to channel
    body = json.dumps({
        "files": [{"id": file_id, "title": "DCI Price Ladder — Client Rates"}],
        "channel_id": channel,
        "initial_comment": "DCI Price Ladder — Client Rates",
    }).encode()
    done = _post_json("https://slack.com/api/files.completeUploadExternal", token, body)
    if not done.get("ok"):
        raise RuntimeError(f"completeUploadExternal failed: {done}")
    return done


def _post_form(url, token):
    req = urllib.request.Request(url, data=b"", method="POST",
                                 headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def _post_json(url, token, body):
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Authorization": f"Bearer {token}",
                                          "Content-Type": "application/json; charset=utf-8"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def _multipart_put(url, path):
    boundary = "----dcicard7f3a2b"
    with open(path, "rb") as f:
        content = f.read()
    body = (
        f"--{boundary}\r\n".encode()
        + b'Content-Disposition: form-data; name="file"; filename="dci_ladder.png"\r\n'
        + b"Content-Type: image/png\r\n\r\n"
        + content + f"\r\n--{boundary}--\r\n".encode()
    )
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode()


def main():
    apr, fetched_at = fetch_apr()
    spot = fetch_spot()
    book = parse_ladder(apr)
    for a in ("BTC", "ETH"):
        if len(exps(book, a)) < 2:
            raise RuntimeError(f"need >=2 expiries for {a}, got {exps(book, a)}")
    stamp = stamp_sgt(fetched_at)
    path = render(book, spot, stamp)
    print(f"rendered {path}  (spot BTC ${spot['BTC']:,.0f} / ETH ${spot['ETH']:,.0f}, as of {stamp})")
    if DRY_RUN:
        print("DRY_RUN=1 -> not posting to Slack")
        return
    token = os.environ["SLACK_BOT_TOKEN"]; channel = os.environ["SLACK_CHANNEL_ID"]
    res = slack_upload(path, token, channel)
    print("posted to Slack:", res.get("ok"))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

"""PixCut S1 sticker export for the Rialto inventory (desktop).

Pulls items/places from the live inventory and writes print-ready 300-dpi images
for the Liene Photo PC program (Upload images -> place on the 4x7 sticker canvas -> Make it):

  <out>/singles/<CODE>.png    one sticker per file, transparent outside the rounded edge
  <out>/sheet-N.png           3.9 x 6.7 in sheets (1170 x 2010 px), stickers separated by gaps

Usage (Python 3.10+, Pillow, segno):
  python -X utf8 tools/pixcut_export.py --today                 # items added today
  python -X utf8 tools/pixcut_export.py --dept COST              # every COST item
  python -X utf8 tools/pixcut_export.py --codes COST-0001,COST-0002
  python -X utf8 tools/pixcut_export.py --locations              # all place stickers (large)
  python -X utf8 tools/pixcut_export.py --demo                   # sample stickers, no login needed
Options: --layout std|small|big   --out <folder>

Sign-in: the master admin code is read from env RIALTO_ADMIN_KEY or from
%USERPROFILE%\\.rialto_inventory.json {"admin_key": "..."} (never stored in the repo).
"""
import argparse, datetime, json, os, sys, urllib.request
from PIL import Image, ImageDraw, ImageFont
import segno

BASE = 'https://rialto-inventory.onrender.com'
DPI = 300
SHEET = (1170, 2010)  # 3.9 x 6.7 in printable area on Liene 4x7 sticker paper
LAYOUTS = {
    'std':   dict(w=540, h=285, cols=2, rows=6),    # 1.8 x 0.95 in, 12 per sheet
    'small': dict(w=345, h=345, cols=3, rows=5),    # 1.15 in square, 15 per sheet
    'big':   dict(w=1080, h=570, cols=1, rows=3),   # 3.6 x 1.9 in, places
}
LOC_DEPT = {'p': 'LOC', 'name': 'Location', 'room': '', 'color': '#111111'}
FONT = r'C:\Windows\Fonts\arialbd.ttf'
FONT_BLACK = r'C:\Windows\Fonts\ariblk.ttf'


def admin_key():
    k = os.environ.get('RIALTO_ADMIN_KEY')
    if k:
        return k
    p = os.path.join(os.path.expanduser('~'), '.rialto_inventory.json')
    try:
        return json.load(open(p, encoding='utf-8'))['admin_key']
    except Exception:
        sys.exit('No admin code. Set RIALTO_ADMIN_KEY or create ' + p)


def fetch_data():
    req = urllib.request.Request(BASE + '/api/login', data=json.dumps({'key': admin_key()}).encode(),
                                 headers={'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=90) as r:
        cookie = r.headers.get('Set-Cookie').split(';')[0]
    req = urllib.request.Request(BASE + '/api/data', headers={'Cookie': cookie})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def hex_rgb(h):
    h = h.lstrip('#'); return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def ink(h):
    r, g, b = hex_rgb(h); return (17, 17, 17) if 0.299 * r + 0.587 * g + 0.114 * b > 160 else (255, 255, 255)


def font(size, black=False):
    try:
        return ImageFont.truetype(FONT_BLACK if black and os.path.exists(FONT_BLACK) else FONT, size)
    except OSError:
        return ImageFont.load_default()


def fit(draw, text, max_w, size, black=False):
    while size > 12:
        f = font(size, black)
        if draw.textlength(text, font=f) <= max_w:
            return f
        size -= 2
    return font(12, black)


def wrap(draw, text, f, max_w, max_lines):
    words, lines, cur = str(text).split(), [], ''
    for w in words:
        t = (cur + ' ' + w).strip()
        if draw.textlength(t, font=f) <= max_w:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = w
        if len(lines) == max_lines:
            break
    if len(lines) < max_lines and cur:
        lines.append(cur)
    if len(lines) == max_lines and ' '.join(lines) != ' '.join(words):
        l = lines[-1]
        while l and draw.textlength(l + '…', font=f) > max_w:
            l = l[:-1]
        lines[-1] = l + '…'
    return lines


def qr_url(code):
    return (BASE + ('/L/' if code.startswith('LOC-') else '/I/') + code).upper()


def sticker(code, dept, thing, layout, org=''):
    L = LAYOUTS[layout]; w, h = L['w'], L['h']; small = layout == 'small'; big = layout == 'big'
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    mask = Image.new('L', (w, h), 0); ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, h - 1], radius=26, fill=255)
    body = Image.new('RGBA', (w, h), (255, 255, 255, 255)); d = ImageDraw.Draw(body)
    pad = 14; band = 54 if small else 96 if big else 62
    q = segno.make(qr_url(code), error='m', boost_error=False)
    n = q.symbol_size(border=2)[0]
    avail = h - band - 70 if small else h - pad * 2
    cell = avail // n; qs = cell * n
    qx = (w - qs) // 2 if small else pad
    qy = band + 8 if small else (h - qs) // 2
    bx = 0 if small else qx + qs + 6
    col = hex_rgb(dept['color'])
    d.rectangle([bx, 0, w, band], fill=col)
    if dept['color'].lower() == '#ffffff':
        d.rectangle([bx, band - 4, w, band], fill=(17, 17, 17))
    bw = w - bx
    # Band: department code on the left, organisation name (e.g. BOLD THEATRE) on the right.
    f = fit(d, dept['p'], bw * 0.42, int(band * 0.72), black=True)
    d.text((bx + 12, band / 2 + 2), dept['p'], font=f, fill=ink(dept['color']), anchor='lm')
    if org:
        fo = fit(d, org.upper(), bw * 0.52, int(band * (0.40 if big else 0.36)), black=True)
        d.text((w - pad - 4, band / 2 + 2), org.upper(), font=fo, fill=ink(dept['color']), anchor='rm')
    for r, row in enumerate(q.matrix_iter(scale=1, border=2)):
        for c, dark in enumerate(row):
            if dark:
                d.rectangle([qx + c * cell, qy + r * cell, qx + (c + 1) * cell - 1, qy + (r + 1) * cell - 1], fill=(0, 0, 0))
    if small:
        fc = fit(d, code, w - 24, 46)
        d.text((w / 2, h - 18), code, font=fc, fill=(17, 17, 17), anchor='ms')
    else:
        tx = qx + qs + 16; tw = w - pad - tx
        fc = fit(d, code, tw, 96 if big else 58)
        ty = band + (92 if big else 54)
        d.text((tx, ty), code, font=fc, fill=(17, 17, 17), anchor='ls')
        if thing:
            fn = font(52 if big else 28)
            for line in wrap(d, thing.get('name', ''), fn, tw, 4 if big else 3):
                ty += 62 if big else 33
                d.text((tx, ty), line, font=fn, fill=(17, 17, 17), anchor='ls')
            if dept['p'] != 'LOC' and thing.get('size'):
                ty += 44
                d.text((tx, min(ty, h - 16)), 'Size ' + thing['size'], font=font(34, black=True), fill=(17, 17, 17), anchor='ls')
        elif dept['p'] != 'LOC':
            f2 = font(24)
            d.text((tx, ty + 36), dept['name'], font=f2, fill=(85, 85, 85), anchor='ls')
    img.paste(body, (0, 0), mask)
    ImageDraw.Draw(img).rounded_rectangle([1, 1, w - 2, h - 2], radius=26, outline=(0, 0, 0, 46), width=2)
    return img


def sheets(imgs, layout):
    L = LAYOUTS[layout]; per = L['cols'] * L['rows']
    gx = (SHEET[0] - L['cols'] * L['w']) / (L['cols'] + 1); gy = (SHEET[1] - L['rows'] * L['h']) / (L['rows'] + 1)
    out = []
    for s in range(0, len(imgs), per):
        sh = Image.new('RGBA', SHEET, (0, 0, 0, 0))
        for i, im in enumerate(imgs[s:s + per]):
            c, r = i % L['cols'], i // L['cols']
            sh.paste(im, (round(gx + c * (L['w'] + gx)), round(gy + r * (L['h'] + gy))), im)
        out.append(sh)
    return out


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--codes'); g.add_argument('--dept'); g.add_argument('--today', action='store_true')
    g.add_argument('--locations', action='store_true'); g.add_argument('--demo', action='store_true')
    ap.add_argument('--layout', choices=list(LAYOUTS), default=None)
    ap.add_argument('--out', default=None)
    a = ap.parse_args()

    if a.demo:
        D = {'settings': {'org': 'Bold Theatre', 'departments': [{'p': 'COST', 'name': 'Costumes', 'room': 'Costume shop', 'color': '#6b3fa0'},
                                          {'p': 'PROP', 'name': 'Props & set dressing', 'room': 'Prop room', 'color': '#f2c200'}]},
             'items': [{'code': 'COST-9001', 'name': 'DEMO USMC Alpha coat', 'size': '38S'},
                       {'code': 'COST-9002', 'name': 'DEMO USMC Alpha coat', 'size': '40R'},
                       {'code': 'PROP-9001', 'name': 'DEMO brass candlestick', 'size': ''}], 'locations': []}
        codes = [i['code'] for i in D['items']]
    else:
        D = fetch_data()
        items = D['items']
        if a.codes:
            codes = [c.strip().upper() for c in a.codes.split(',') if c.strip()]
        elif a.dept:
            codes = sorted(i['code'] for i in items if i['code'].startswith(a.dept.upper() + '-'))
        elif a.today:
            day = datetime.date.today().isoformat()
            codes = sorted(i['code'] for i in items if datetime.datetime.fromisoformat(i['created_at'].replace('Z', '+00:00')).astimezone().date().isoformat() == day)
        else:
            codes = sorted(l['code'] for l in D['locations'])
    if not codes:
        sys.exit('Nothing to print for that choice.')
    depts = {d['p']: d for d in D['settings']['departments']}
    org = D['settings'].get('org', '')
    by_code = {i['code']: i for i in D['items']}; locs = {l['code']: l for l in D.get('locations', [])}
    layout = a.layout or ('big' if all(c.startswith('LOC-') for c in codes) else 'std')
    label = 'demo' if a.demo else (a.dept or ('today' if a.today else 'places' if a.locations else 'selected')).lower()
    out = a.out or os.path.join(r'E:\_PERSONAL\Foundry\26_Rialto_Inventory\Stickers', datetime.date.today().isoformat() + '_' + label)
    os.makedirs(os.path.join(out, 'singles'), exist_ok=True)
    imgs = []
    for c in codes:
        dept = LOC_DEPT if c.startswith('LOC-') else depts.get(c.split('-')[0], {'p': c.split('-')[0], 'name': '', 'room': '', 'color': '#616161'})
        im = sticker(c, dept, locs.get(c) if c.startswith('LOC-') else by_code.get(c), layout, org)
        im.save(os.path.join(out, 'singles', c + '.png'), dpi=(DPI, DPI)); imgs.append(im)
    for i, sh in enumerate(sheets(imgs, layout), 1):
        sh.save(os.path.join(out, 'sheet-%d.png' % i), dpi=(DPI, DPI))
    print('%d stickers (%s layout) -> %s' % (len(codes), layout, out))


if __name__ == '__main__':
    main()

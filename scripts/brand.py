"""Render every brand file from scripts/mark.py. Run from the repo root: python3 scripts/brand.py
Needs Pillow and Playwright (Chromium)."""
import json,os,subprocess,sys,tempfile
sys.path.insert(0,os.path.dirname(__file__))
import mark
REPO=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP=tempfile.mkdtemp()
INK,MARBLE='#0B1526','#F4F3EF'
F16=dict(s=2,g=2,c=2,k=3)  # 16 px drawing: whole-pixel strokes and gaps
def svgfile(fill,s=4):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 42 40" width="{42*s}" height="{40*s}">'
            f'<path fill="{fill}" d="{mark.d()}"/></svg>')
for name,fill in (('ink',INK),('reversed',MARBLE)):
    for kind in ('master','mark'):
        open(f'{REPO}/assets/daedalus-{kind}-{name}.svg','w').write(svgfile(fill))
# The icons wear the treatment Meridian's and Agora's do: the mark on a soft tile
# (white to warm marble; ink-blue to ink in dark mode), rounded to the app-icon
# corner (22.37%) wherever the platform does not round it itself. The mark keeps
# whole-pixel strokes at every size: 16 px is redrawn with s = g = 1 (T16, 11 x 10),
# 32 is the master at 0.5 and 48 at 0.75, each on a whole-pixel origin.
T16=dict(s=1,g=1,c=4,k=3)  # the 16 px tile's drawing: 11 x 10, one-pixel strokes and gaps
TILE_L=('#FFFFFF','#E9E6DD'); TILE_D=('#1B2740','#070D18')
def tile_defs(c,id='t'):
    return (f'<linearGradient id="{id}" x1=".2" y1="0" x2=".8" y2="1">'
            f'<stop offset="0" stop-color="{c[0]}"/><stop offset="1" stop-color="{c[1]}"/></linearGradient>')
fav=(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><defs>{tile_defs(TILE_L,"l")}{tile_defs(TILE_D,"d")}</defs>'
     f'<style>.t{{fill:url(#l)}}.m{{fill:{INK}}}@media (prefers-color-scheme:dark){{.t{{fill:url(#d)}}.m{{fill:{MARBLE}}}}}</style>'
     f'<rect class="t" width="16" height="16" rx="3.58"/><path class="m" d="{mark.d(1,3,3,**T16)}"/></svg>')
open(f'{REPO}/favicon.svg','w').write(fav)
def raw(w,h,s,ox,oy,fill=INK,bg=None,kw={}):
    b=f'<rect width="{w}" height="{h}" fill="{bg}"/>' if bg else ''
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" style="display:block">{b}<path fill="{fill}" d="{mark.d(s,ox,oy,**kw)}"/></svg>'
def icon(n,s,ox,oy,round_=True,shadow=False,kw={}):
    """The mark at scale s on an n px tile; rounded unless the platform masks it."""
    rx=f' rx="{n*.2237:.2f}"' if round_ else ''
    f=(f'<filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="{n*14/1024:.2f}" '
       f'stdDeviation="{n*18/1024:.2f}" flood-color="#0B1526" flood-opacity=".18"/></filter>') if shadow else ''
    g=' filter="url(#s)"' if shadow else ''
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{n}" height="{n}" viewBox="0 0 {n} {n}" style="display:block">'
            f'<defs>{tile_defs(TILE_L)}{f}</defs><rect width="{n}" height="{n}"{rx} fill="url(#t)"/>'
            f'<path{g} fill="{INK}" d="{mark.d(s,ox,oy,**kw)}"/></svg>')
A=REPO+'/assets/'
# LinkedIn Page images (1512 x 256 cover, 400 x 400 logo). The logo is the app-icon tile at
# stroke 24 (252 x 240), centred exactly; LinkedIn rounds it. The Page logo covers the cover's
# lower left and phones crop its edges, so the words sit in the middle third.
def linkedin_banner():
    import math
    W,H=1512,256; sc=3; s=g=4*sc                 # the mark at stroke 12: 126 x 120
    ox,oy=1262,68                                # centred vertically: 68 + 120 + 68
    L,T,B=ox,oy,oy+120; cx=ox+22*sc; R=20*sc; w=g*math.sqrt(2)
    rings=[];cuts=[]
    # The mark's outline repeated outward at the same stroke and gap: the mark becomes the
    # centre of a larger labyrinth. Each wall has a 45-degree opening g wide, like the mark's,
    # alternating top and bottom, with more in the left walls.
    for n in range(1,12):
        d=g+s/2+(n-1)*(s+g)
        rings.append(f'M{L-d} {T-d}H{cx}A{R+d} {R+d} 0 0 1 {cx} {B+d}H{L-d}Z')
        if n%2: y0,y1,xc=T-d-s/2,T-d+s/2,ox+14+18*n
        else:   y0,y1,xc=B+d-s/2,B+d+s/2,cx-40-14*n
        c=xc-(y0+y1)/2
        cuts.append(f'<polygon points="{c+y0},{y0} {c+w+y0},{y0} {c+w+y1},{y1} {c+y1},{y1}"/>')
        if n>2 and n%2==0:
            x0,x1=L-d-s/2,L-d+s/2; c2=(x0+x1)/2-(T+30+(n*37)%70)
            cuts.append(f'<polygon points="{x0},{x0-c2} {x1},{x1-c2} {x1},{x1-c2+w} {x0},{x0-c2+w}"/>')
    svg=(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" style="position:absolute;left:0;top:0">'
     '<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FBFAF7"/><stop offset="1" stop-color="#ECE9E1"/></linearGradient>'
     '<linearGradient id="fade" gradientUnits="userSpaceOnUse" x1="1130" y1="0" x2="1250" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff"/></linearGradient>'
     f'<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="{W}" height="{H}"><rect width="{W}" height="{H}" fill="url(#fade)"/><g fill="#000">{"".join(cuts)}</g></mask>'
     f'<filter id="sh" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="{INK}" flood-opacity=".18"/></filter></defs>'
     f'<rect width="{W}" height="{H}" fill="url(#bg)"/>'
     f'<path mask="url(#m)" d="{"".join(rings)}" fill="none" stroke="{INK}" stroke-opacity=".07" stroke-width="{s}"/>'
     f'<path filter="url(#sh)" fill="{INK}" d="{mark.d(sc,ox,oy)}"/></svg>')
    return ('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=block">'
     f'<div style="position:relative;width:{W}px;height:{H}px;font-family:Geist,sans-serif;color:{INK}">{svg}'
     '<div style="position:absolute;left:392px;top:0;height:244px;display:flex;flex-direction:column;justify-content:center">'
     '<div style="font-weight:600;font-size:46px;line-height:1.08;letter-spacing:-.025em">We set our minds to unknown arts.</div>'
     '<div style="margin-top:18px;display:flex;align-items:center;gap:12px;font-size:18px;color:rgba(11,21,38,.62)">'
     '<span>A student-founded software studio</span><span style="width:4px;height:4px;border-radius:50%;background:rgba(11,21,38,.35)"></span>'
     f'<span style="color:{INK};font-weight:500">daedalusdatalabs.com</span></div></div></div>')
BANNER=linkedin_banner()
jobs=[dict(svg=icon(16,1,3,3,kw=T16),w=16,h=16,out=A+'favicon-16.png'),
 dict(svg=icon(32,.5,6,6),w=32,h=32,out=A+'favicon-32.png'),
 dict(svg=icon(48,.75,8,9),w=48,h=48,out=TMP+'/fav48.png'),
 dict(svg=icon(180,2.5,37.5,40,round_=False,shadow=True),w=180,h=180,out=A+'apple-touch-icon.png',opaque=True),
 dict(svg=icon(512,7,109,116,round_=False,shadow=True),w=512,h=512,out=A+'daedalus-tile-512.png',opaque=True),
 dict(svg=icon(400,6,74,80,round_=False,shadow=True),w=400,h=400,out=A+'linkedin-logo-400.png',opaque=True),
 dict(svg=BANNER,w=1512,h=256,out=A+'linkedin-banner-1512x256.png',opaque=True),
 dict(svg=raw(7560,7200,180,0,0),w=7560,h=7200,out=A+'daedalus-master-ink.png'),
 dict(svg=raw(7560,7200,180,0,0,fill=MARBLE),w=7560,h=7200,out=A+'daedalus-master-reversed.png')]
json.dump(jobs,open(TMP+'/jobs.json','w'))
subprocess.run(['node',os.path.join(os.path.dirname(__file__),'render.js'),TMP+'/jobs.json'],check=True)
from PIL import Image
ims=[Image.open(p).convert('RGBA') for p in (A+'favicon-16.png',A+'favicon-32.png',TMP+'/fav48.png')]
ims[2].save(REPO+'/favicon.ico',format='ICO',sizes=[(16,16),(32,32),(48,48)],append_images=ims[:2])
for p in ('apple-touch-icon.png','daedalus-tile-512.png'):
    Image.open(A+p).convert('RGB').save(A+p,optimize=True)
for p in ('daedalus-master-ink.png','daedalus-master-reversed.png','favicon-16.png','favicon-32.png'):
    Image.open(A+p).save(A+p,optimize=True)
print('ok')

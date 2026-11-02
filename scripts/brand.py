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
fav=(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><style>path{{fill:{INK}}}@media (prefers-color-scheme:dark){{path{{fill:{MARBLE}}}}}</style>'
     f'<path d="{mark.d(1,0,1,**F16)}"/></svg>')
open(f'{REPO}/favicon.svg','w').write(fav)
def raw(w,h,s,ox,oy,fill=INK,bg=None,kw={}):
    b=f'<rect width="{w}" height="{h}" fill="{bg}"/>' if bg else ''
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" style="display:block">{b}<path fill="{fill}" d="{mark.d(s,ox,oy,**kw)}"/></svg>'
A=REPO+'/assets/'
jobs=[dict(svg=raw(16,16,1,0,1,kw=F16),w=16,h=16,out=A+'favicon-16.png'),
 dict(svg=raw(32,32,.75,0,1),w=32,h=32,out=A+'favicon-32.png'),
 dict(svg=raw(48,48,1,3,4),w=48,h=48,out=TMP+'/fav48.png'),
 dict(svg=raw(180,180,3,27,30,bg=MARBLE),w=180,h=180,out=A+'apple-touch-icon.png',opaque=True),
 dict(svg=raw(512,512,9,67,76,bg=MARBLE),w=512,h=512,out=A+'daedalus-tile-512.png',opaque=True),
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

"""The Daedalus mark as filled shapes.

Built from four numbers: stroke s, gap g, inner counter height c, and k, the straight run
of the inner D before its bowl. The master uses s = g = 4, c = 16, k = 10: a 42 x 40 box.
Every cut is at 45 degrees and every gap, straight or diagonal, is g wide.
"""
import math
def geom(s=4,g=4,c=16,k=10):
    H=4*s+2*g+c; ri=c/2; Ri=ri+s; Rb=Ri+g; Ro=Rb+s
    cx=2*s+g+k; cy=H/2; W=cx+Ro; dg=g*math.sqrt(2)
    rc=cx-(H-s)                       # cut's right edge: x - y = rc (meets the bowl's inner edge at the foot)
    lc=rc-dg                          # cut's left edge
    # outer arc meets the right edge: (x-cx)^2+(y-cy)^2=Ro^2 with y = x - rc
    a=cx; b=cy+rc
    # (x-a)^2 + (x-b)^2 = Ro^2
    x=((a+b)+math.sqrt((a+b)**2-2*(a*a+b*b-Ro*Ro)))/2
    return dict(s=s,g=g,H=H,W=W,ri=ri,Ri=Ri,Rb=Rb,Ro=Ro,cx=cx,cy=cy,dg=dg,lc=lc,rc=rc,mx=x,my=x-rc)
def d(sc=1.0,ox=0.0,oy=0.0,**kw):
    G=geom(**kw);s,g,H,cx,cy,dg=G['s'],G['g'],G['H'],G['cx'],G['cy'],G['dg']
    def n(v):
        t=f'{v:.3f}'.rstrip('0').rstrip('.'); return '0' if t in('','-0') else t
    P=lambda x,y:f'{n(ox+x*sc)} {n(oy+y*sc)}'; r=lambda v:n(v*sc)
    L=f'M{P(0,0)}L{P(s,s)}L{P(s,H-s)}L{P(H-s+G["lc"],H-s)}L{P(H+G["lc"],H)}L{P(0,H)}Z'
    D1=(f'M{P(G["mx"],G["my"])}A{r(G["Ro"])} {r(G["Ro"])} 0 0 0 {P(cx,0)}L{P(dg,0)}L{P(dg+s,s)}L{P(cx,s)}'
        f'A{r(G["Rb"])} {r(G["Rb"])} 0 0 1 {P(cx,H-s)}Z')
    t=s+g; b=H-s-g
    D2=(f'M{P(t,t)}L{P(cx,t)}A{r(G["Ri"])} {r(G["Ri"])} 0 0 1 {P(cx,b)}L{P(t,b)}Z'
        f'M{P(t+s,t+s)}L{P(t+s,b-s)}L{P(cx,b-s)}A{r(G["ri"])} {r(G["ri"])} 0 0 0 {P(cx,t+s)}Z')
    return L+D1+D2

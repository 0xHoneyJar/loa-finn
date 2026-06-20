# Why did the "fixed" rebuilt deck score 225 (vs v4 starter 719)? Per game: did we build a board
# (bench), and did we ever ATTACK (damage the opponent / take prizes)? Tests energy-starvation.
import json, csv, collections
CARD={}
for row in csv.reader(open('.cabt-spike/dl/EN_Card_Data.csv')):
    try: CARD[int(row[0])]=(row[1], row[8] not in ('n/a','',None))
    except: pass
def arch(deck):
    pk=collections.Counter(CARD.get(c,('?',0))[0] for c in deck if CARD.get(c,('',0))[1])
    a=" ".join(n for n,_ in pk.most_common(2)).lower()
    for lab,keys in [("Lucario(F)",["lucario"]),("Bellibolt(L)",["bellibolt","iono"]),("Abomasnow(W)",["abomasnow"]),
                     ("Dragapult",["dragapult","dreepy","drakloak"]),("Grimmsnarl(D)",["grimmsnarl","marnie"]),
                     ("Sinistcha(G)",["sinistcha","poltchageist"]),("Mismagius(P)",["mismagius","misdreavus"]),
                     ("Crustle",["crustle","dwebble"]),("Ogerpon",["ogerpon","raging"])]:
        if any(k in a for k in keys): return lab
    return (pk.most_common(1)[0][0][:12] if pk else "?")
ids=[int(l.split(',')[0]) for l in open('.cabt-spike/games/rebuilt_eps.csv') if l.split(',')[0].isdigit()]
print(f"{'res':4} {'opp':14} {'ourBench':8} {'weDamaged?':10} {'prizes(us-them)':16} {'steps'}")
W=0; setup_but_lost=0
for ep in ids:
    fp=f'.cabt-spike/games/replays/episode-{ep}-replay.json'
    try: d=json.load(open(fp))
    except: continue
    teams=d['info']['TeamNames']; seat=teams.index('soju') if 'soju' in teams else 1
    won=d['rewards'][seat]==1; W+=won
    opp=arch(d['steps'][1][1-seat].get('action') or [])
    mb=0; opp_hp_drop=False; our_pz=6; opp_pz=6
    for st in d['steps']:
        cur=st[seat]['observation'].get('current')
        if not isinstance(cur,dict): continue
        pl=cur['players']
        try:
            mb=max(mb,len(pl[seat].get('bench') or []))
            # opp active hp: did it ever drop (we dealt damage)?
            a=pl[1-seat].get('active'); a=a[0] if isinstance(a,list) and a else a
            if isinstance(a,dict):
                hp=a.get('hp'); dmg=a.get('damage')
                if dmg and dmg>0: opp_hp_drop=True
            our_pz=min(our_pz, len(pl[seat].get('prize') or [6]))
            opp_pz=min(opp_pz, len(pl[1-seat].get('prize') or [6]))
        except: pass
    us_took=6-our_pz; them_took=6-opp_pz
    if not won and mb>=2 and us_took==0: setup_but_lost+=1
    print(f"{'WON' if won else 'LOST':4} {opp[:14]:14} bench={mb:<3} {'YES' if opp_hp_drop else 'no':10} us{us_took}-them{them_took:<10} {len(d['steps'])}")
print(f"\nrebuilt record: {W}-{len(ids)-W}  | games where we BUILT a board (bench>=2) but took 0 prizes & lost: {setup_but_lost}")
PY=None

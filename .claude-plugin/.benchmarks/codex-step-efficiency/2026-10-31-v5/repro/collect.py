"""Read-only accounting, optionally to a fresh output path. No actors or writes to base."""
import argparse
import hashlib
import json
from pathlib import Path
from protocol import account_events, turn_outcomes

def collect(base,cell,pricing=None):
 assert cell=='A','A-only collector rejects other cells'
 folder=base/'runs'/cell
 with (folder/'events.jsonl').open() as stream:
  events=[json.loads(line) for line in stream]
 start=json.loads((folder/'thread-start.json').read_text());tid=start['thread']['id']
 foreign=[e for e in events if (e.get('params') or {}).get('threadId') not in (None,tid)]
 own=[e for e in events if (e.get('params') or {}).get('threadId') in (None,tid)]
 report=account_events(own,pricing=pricing)
 report.update(turn_outcomes(own))
 marks=json.loads((folder/'marks.json').read_text()) if (folder/'marks.json').exists() else []
 status=json.loads((folder/'status.json').read_text()) if (folder/'status.json').exists() else {'valid':False,'limitation':'No final status'}
 children=[e for e in own if e.get('method')=='item/completed' and (e.get('params',{}).get('item') or {}).get('type')=='collabAgentToolCall']
 report.update(cell=cell,status=status,marks=marks,foreign_events=len(foreign),child_calls=len(children),quality='NOT GRADED',
               events_sha256=hashlib.sha256((folder/'events.jsonl').read_bytes()).hexdigest())
 if not status.get('valid') or foreign or children:
  report.update(accounting_complete=False,total_cost_usd=None,cost_status='unknown: incomplete actor/foreign or child activity')
 return report

def main():
 p=argparse.ArgumentParser();p.add_argument('--base',type=Path,required=True);p.add_argument('--output',type=Path);p.add_argument('--pricing',type=Path,help='Explicit verified rates JSON with source/check date; never silently assume historical price')
 args=p.parse_args();base=args.base.resolve()
 pricing=json.loads(args.pricing.read_text()) if args.pricing else None
 result={'metric':'Deduplicated rawResponse/completed IDs; parallel calls count once; unfinished generations separately lower bounded',
         'model':'gpt-6.1-sol','effort':'medium','runs_per_condition':1,'quality':'NOT GRADED','pricing':pricing,
         'cells':{c:collect(base,c,pricing) for c in ['A']},
         'limitations':['Prefix cache cannot be manually cleared','n=1 A-only; no general quality claim','Completed usage alone cannot price unfinished generations','Native completed turns are separate from observed final answers; an async question may complete without a final answer. Final text presence does not grade correctness']}
 text=json.dumps(result,ensure_ascii=False,indent=2)+'\n'
 if args.output:
  with args.output.open('x') as f:f.write(text)
 else:print(text,end='')
if __name__=='__main__':main()

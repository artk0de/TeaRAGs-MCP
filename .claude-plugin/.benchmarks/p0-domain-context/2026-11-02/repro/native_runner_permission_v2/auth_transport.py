"""Trusted fish-export auth transport. Secrets remain only in captured memory/env."""
import json,shlex,subprocess,sys
AUTH_KEYS=('CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_API_KEY')
BASE_KEY='ANTHROPIC_BASE_URL'
MARKER='P0_CLAUDE_AUTH='
def load_claude_auth():
 # The literal command contains names/code only; never a credential value.
 code='import os,json;print('+repr(MARKER)+'+json.dumps({k:os.environ[k] for k in '+repr(AUTH_KEYS+(BASE_KEY,))+' if os.environ.get(k)}))'
 try:
  proc=subprocess.run(['/opt/homebrew/bin/fish','-lc','exec '+shlex.quote(sys.executable)+' -c '+shlex.quote(code)],capture_output=True,text=True,timeout=30)
  lines=[line[len(MARKER):] for line in proc.stdout.splitlines() if line.startswith(MARKER)]
  if proc.returncode or len(lines)!=1:raise ValueError()
  payload=json.loads(lines[0])
  if not isinstance(payload,dict) or set(payload)-set(AUTH_KEYS+(BASE_KEY,)) or any(not isinstance(v,str) or not v for v in payload.values()):raise ValueError()
  selected=next((key for key in AUTH_KEYS if payload.get(key)),None)
  if selected is None:raise ValueError()
  result={selected:payload[selected]}
  if payload.get(BASE_KEY):result[BASE_KEY]=payload[BASE_KEY]
  return result
 except Exception:
  # Neither raw shell output nor an exception carrying stdout may escape.
  raise RuntimeError('Trusted fish auth transport unavailable; private output discarded') from None
